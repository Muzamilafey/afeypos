import { Router, type Request } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { AssistantConfig, AssistantRequest } from '../../models/index.js';
import { parse } from '../../http/validate.js';
import { requirePermission } from '../../http/auth.js';
import { AppError, badRequest } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { decrypt, encrypt } from '../../lib/crypto.js';
import { logger } from '../../lib/logger.js';
import { runTool, toolsFor, today, type ToolContext } from './tools.js';
import { askProvider, DEFAULT_MODELS, type ChatTurn, type ProviderKey } from './providers.js';
import { builtinAnswer, SUGGESTIONS } from './builtin.js';

const router = Router();
const keyAad = (tenantId: unknown) => `assistant:${tenantId}`;

function toolContext(req: Request): ToolContext {
  return { tz: req.tenant!.settings?.timezone ?? 'Africa/Nairobi', branchIds: req.auth!.branchIds.length ? req.auth!.branchIds.map((b) => new Types.ObjectId(String(b))) : null, permissions: req.auth!.permissions };
}

function systemPrompt(req: Request, ctx: ToolContext) {
  return [
    `You are the business assistant inside Afey POS for ${req.tenant!.name}, a Kenyan retail business. You talk to ${req.auth!.name}, a manager or owner.`,
    `Today is ${today(ctx.tz)} (time zone ${ctx.tz}). Money is Kenya shillings (KES).`,
    ctx.branchIds ? 'This user only sees some branches; every figure you get is already limited to them.' : 'This user sees all branches.',
    'Answer only from the tools\' results. Never make up a figure; if the tools do not have the data, say what is missing. Use a tool for any number you give.',
    'Revenue is sales before tax. Gross profit is revenue minus the recorded cost of the goods sold. Net profit also subtracts operating expenses, which these tools do not include: say so if asked for net profit.',
    'Forecasts and reorder suggestions are estimates from past sales, not promises. You cannot change anything in the system: you only read.',
    'Reply briefly, in plain English (or Swahili if the user writes in Swahili), with the key figures first. Use short lists or a small table when it helps.',
  ].join('\n');
}

async function usage(req: Request, cfg: { userDailyLimit?: number | null; dailyLimit?: number | null } | null) {
  const since = new Date(Date.now() - 86400_000);
  const [mine, all] = await Promise.all([AssistantRequest.countDocuments({ userId: req.auth!.userId, at: { $gte: since }, mode: 'ai' }), AssistantRequest.countDocuments({ at: { $gte: since }, mode: 'ai' })]);
  return { mine, all, userLimit: cfg?.userDailyLimit ?? 50, limit: cfg?.dailyLimit ?? 500 };
}

router.get('/assistant/status', requirePermission('assistant.use'), async (req, res) => {
  const cfg = await AssistantConfig.findOne({}).select('+keyEnc').lean();
  const ready = Boolean(cfg?.enabled && cfg.keyEnc && (cfg.model || DEFAULT_MODELS[cfg.provider as ProviderKey]));
  const u = await usage(req, cfg);
  res.json({ data: { mode: ready ? 'ai' : 'builtin', provider: ready ? cfg!.provider : null, model: ready ? cfg!.model || DEFAULT_MODELS[cfg!.provider as ProviderKey] : null, suggestions: SUGGESTIONS, tools: toolsFor(req.auth!.permissions).map((t) => t.name), usage: u } });
});

router.post('/assistant/ask', requirePermission('assistant.use'), async (req, res) => {
  const body = parse(z.object({ question: z.string().trim().min(2).max(1000), history: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(4000) })).max(12).default([]) }), req.body);
  const ctx = toolContext(req);
  const cfg = await AssistantConfig.findOne({}).select('+keyEnc').lean();
  const provider = (cfg?.provider ?? 'anthropic') as ProviderKey;
  const model = cfg?.model || DEFAULT_MODELS[provider];
  const useAi = Boolean(cfg?.enabled && cfg.keyEnc && model);
  const log = { userId: req.auth!.userId, question: body.question, provider: useAi ? provider : undefined, model: useAi ? model : undefined };
  if (useAi) {
    const u = await usage(req, cfg);
    if (u.mine >= u.userLimit || u.all >= u.limit) {
      const b = await builtinAnswer(body.question, ctx);
      await AssistantRequest.create({ ...log, mode: 'builtin', answer: b.answer, tools: b.tools, ok: true, error: 'daily AI limit reached' });
      return void res.json({ data: { answer: `${b.answer}\n\n(Today's AI question limit is reached, so this is the built-in answer.)`, mode: 'builtin', tools: b.tools.map((t) => t.name) } });
    }
    try {
      const out = await askProvider(provider, {
        key: decrypt(cfg!.keyEnc!, keyAad(req.tenant!._id)), model: model!, system: systemPrompt(req, ctx), history: body.history as ChatTurn[], question: body.question,
        tools: toolsFor(ctx.permissions), call: (name, input) => runTool(name, input, ctx),
      });
      await AssistantRequest.create({ ...log, model: out.model, mode: 'ai', answer: out.answer, tools: out.tools, inputTokens: out.inputTokens, outputTokens: out.outputTokens, ok: true });
      return void res.json({ data: { answer: out.answer, mode: 'ai', model: out.model, tools: out.tools.map((t) => t.name) } });
    } catch (err) {
      // The AI being down never blocks anyone: fall back to the built-in answers.
      const message = (err as Error).message?.slice(0, 300) ?? 'error';
      logger.warn({ err: message, provider }, 'assistant provider failed');
      const b = await builtinAnswer(body.question, ctx);
      await AssistantRequest.create({ ...log, mode: 'builtin', answer: b.answer, tools: b.tools, ok: false, error: message });
      return void res.json({ data: { answer: `${b.answer}\n\n(The AI service did not answer, so this is the built-in answer.)`, mode: 'builtin', tools: b.tools.map((t) => t.name), aiError: message } });
    }
  }
  const b = await builtinAnswer(body.question, ctx);
  await AssistantRequest.create({ ...log, mode: 'builtin', answer: b.answer, tools: b.tools, ok: true });
  res.json({ data: { answer: b.answer, mode: 'builtin', tools: b.tools.map((t) => t.name) } });
});

router.get('/assistant/config', requirePermission('settings.manage'), async (_req, res) => {
  const cfg = await AssistantConfig.findOne({}).select('+keyEnc').lean();
  res.json({ data: { enabled: Boolean(cfg?.enabled), provider: cfg?.provider ?? 'anthropic', model: cfg?.model ?? '', hasKey: Boolean(cfg?.keyEnc), userDailyLimit: cfg?.userDailyLimit ?? 50, dailyLimit: cfg?.dailyLimit ?? 500, defaults: DEFAULT_MODELS } });
});

router.put('/assistant/config', requirePermission('settings.manage'), async (req, res) => {
  const body = parse(z.object({
    enabled: z.boolean(), provider: z.enum(['anthropic', 'openai', 'gemini']), model: z.string().trim().max(80).regex(/^[\w.\-:/]*$/, 'Model ids use letters, digits, dots and dashes').optional(),
    apiKey: z.string().trim().min(10).max(400).optional(), clearKey: z.boolean().optional(),
    userDailyLimit: z.number().int().min(1).max(10_000).default(50), dailyLimit: z.number().int().min(1).max(100_000).default(500),
  }), req.body);
  if (body.enabled && body.provider !== 'anthropic' && !body.model) throw badRequest('Enter the model name for this provider');
  const current = await AssistantConfig.findOne({}).select('+keyEnc');
  const keyEnc = body.clearKey ? undefined : body.apiKey ? encrypt(body.apiKey, keyAad(req.tenant!._id)) : current?.keyEnc;
  if (body.enabled && !keyEnc) throw new AppError(422, 'ASSISTANT_KEY_REQUIRED', 'Enter the API key from your AI provider to turn the AI on');
  const set = { enabled: body.enabled, provider: body.provider, model: body.model || undefined, userDailyLimit: body.userDailyLimit, dailyLimit: body.dailyLimit, updatedBy: req.auth!.userId };
  await AssistantConfig.updateOne({}, keyEnc ? { $set: { ...set, keyEnc } } : { $set: set, $unset: { keyEnc: 1 } }, { upsert: true });
  await audit(req, { action: 'assistant.config_updated', details: { enabled: body.enabled, provider: body.provider, model: body.model ?? null, keyChanged: Boolean(body.apiKey || body.clearKey) } });
  res.json({ ok: true });
});

router.get('/assistant/log', requirePermission('settings.manage'), async (_req, res) => {
  const rows = await AssistantRequest.find({}).sort({ at: -1 }).limit(100).lean();
  const since = new Date(Date.now() - 30 * 86400_000);
  const [tot] = await AssistantRequest.aggregate([{ $match: { at: { $gte: since } } }, { $group: { _id: null, n: { $sum: 1 }, ai: { $sum: { $cond: [{ $eq: ['$mode', 'ai'] }, 1, 0] } }, input: { $sum: { $ifNull: ['$inputTokens', 0] } }, output: { $sum: { $ifNull: ['$outputTokens', 0] } }, failed: { $sum: { $cond: ['$ok', 0, 1] } } } }]);
  res.json({ data: rows, last30Days: tot ? { questions: tot.n, aiQuestions: tot.ai, inputTokens: tot.input, outputTokens: tot.output, failed: tot.failed } : { questions: 0, aiQuestions: 0, inputTokens: 0, outputTokens: 0, failed: 0 } });
});

export const assistantRoutes = router;
