/**
 * AI providers for the business assistant. Each runs the same loop: the model may call the read-only tools, the
 * server runs them, and the model answers from their results. Claude goes through the official Anthropic SDK;
 * OpenAI and Gemini through their HTTP APIs. Keys stay on the server.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { AssistantTool } from './tools.js';
import { toolSchema } from './tools.js';

export type ProviderKey = 'anthropic' | 'openai' | 'gemini';
export const DEFAULT_MODELS: Record<ProviderKey, string | null> = { anthropic: 'claude-opus-5-5', openai: null, gemini: null };
/** Claude models that accept the server-side refusal fallback chain. */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-1']);
const MAX_ROUNDS = 8;

export interface ChatTurn { role: 'user' | 'assistant'; text: string }
export interface AskInput {
  key: string;
  model: string;
  system: string;
  history: ChatTurn[];
  question: string;
  tools: AssistantTool[];
  call: (name: string, input: unknown) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
}
export interface AskOutput { answer: string; tools: { name: string; ok: boolean; error?: string }[]; inputTokens: number; outputTokens: number; model: string }

const stringify = (r: { ok: boolean; result?: unknown; error?: string }) => JSON.stringify(r.ok ? r.result : { error: r.error }).slice(0, 20_000);

async function askAnthropic(i: AskInput): Promise<AskOutput> {
  const client = new Anthropic({ apiKey: i.key, maxRetries: 2, timeout: 90_000 });
  const tools: Anthropic.Beta.BetaTool[] = i.tools.map((t) => ({ name: t.name, description: t.description, input_schema: toolSchema(t) as Anthropic.Beta.BetaTool['input_schema'] }));
  const messages: Anthropic.Beta.BetaMessageParam[] = [...i.history.map((h) => ({ role: h.role, content: h.text })), { role: 'user', content: i.question }];
  const used: AskOutput['tools'] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let served = i.model;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await client.beta.messages.create({
      model: i.model,
      max_tokens: 16000,
      system: i.system,
      tools,
      messages,
      // Business questions: thorough enough for multi-step answers without long waits.
      output_config: { effort: 'medium' },
      ...(FALLBACK_MODELS.has(i.model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    });
    inputTokens += res.usage.input_tokens;
    outputTokens += res.usage.output_tokens;
    served = res.model;
    if (res.stop_reason === 'refusal') return { answer: 'I cannot help with that question.', tools: used, inputTokens, outputTokens, model: served };
    // Keep the whole assistant turn (thinking and tool calls) so the next round continues it.
    messages.push({ role: 'assistant', content: res.content });
    const calls = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    if (res.stop_reason === 'tool_use' && calls.length) {
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const c of calls) {
        const r = await i.call(c.name, c.input);
        used.push({ name: c.name, ok: r.ok, ...(r.error ? { error: r.error } : {}) });
        results.push({ type: 'tool_result', tool_use_id: c.id, content: stringify(r), ...(r.ok ? {} : { is_error: true }) });
      }
      messages.push({ role: 'user', content: results });
      continue;
    }
    const text = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
    const cut = res.stop_reason === 'max_tokens' ? '\n\n(The answer was cut short; ask a narrower question.)' : '';
    return { answer: (text || 'I could not find an answer in your data.') + cut, tools: used, inputTokens, outputTokens, model: served };
  }
  return { answer: 'That question needed too many steps. Try asking about one thing at a time.', tools: used, inputTokens, outputTokens, model: served };
}

async function askOpenAI(i: AskInput): Promise<AskOutput> {
  const messages: any[] = [{ role: 'system', content: i.system }, ...i.history.map((h) => ({ role: h.role, content: h.text })), { role: 'user', content: i.question }];
  const tools = i.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: toolSchema(t) } }));
  const used: AskOutput['tools'] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${i.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: i.model, messages, tools }), signal: AbortSignal.timeout(90_000) });
    const data: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data?.error?.message ?? `OpenAI returned ${r.status}`);
    inputTokens += data.usage?.prompt_tokens ?? 0;
    outputTokens += data.usage?.completion_tokens ?? 0;
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error('OpenAI sent no answer');
    messages.push(msg);
    if (msg.tool_calls?.length) {
      for (const c of msg.tool_calls) {
        let args: unknown = {};
        try { args = JSON.parse(c.function?.arguments || '{}'); } catch { args = null; }
        const res = args === null ? { ok: false, error: 'Arguments were not valid JSON' } : await i.call(c.function?.name, args);
        used.push({ name: c.function?.name, ok: res.ok, ...(res.error ? { error: res.error } : {}) });
        messages.push({ role: 'tool', tool_call_id: c.id, content: stringify(res) });
      }
      continue;
    }
    return { answer: String(msg.content ?? '').trim() || 'I could not find an answer in your data.', tools: used, inputTokens, outputTokens, model: i.model };
  }
  return { answer: 'That question needed too many steps. Try asking about one thing at a time.', tools: used, inputTokens, outputTokens, model: i.model };
}

/** Gemini's function schemas are an OpenAPI subset: no additionalProperties, no $schema. */
function geminiSchema(s: any): any {
  if (Array.isArray(s)) return s.map(geminiSchema);
  if (!s || typeof s !== 'object') return s;
  const out: any = {};
  for (const [k, v] of Object.entries(s)) if (!['additionalProperties', '$schema', 'default'].includes(k)) out[k] = geminiSchema(v);
  return out;
}

async function askGemini(i: AskInput): Promise<AskOutput> {
  const contents: any[] = [...i.history.map((h) => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.text }] })), { role: 'user', parts: [{ text: i.question }] }];
  const tools = [{ functionDeclarations: i.tools.map((t) => ({ name: t.name, description: t.description, parameters: geminiSchema(toolSchema(t)) })) }];
  const used: AskOutput['tools'] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(i.model)}:generateContent`, { method: 'POST', headers: { 'x-goog-api-key': i.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ systemInstruction: { parts: [{ text: i.system }] }, contents, tools }), signal: AbortSignal.timeout(90_000) });
    const data: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data?.error?.message ?? `Gemini returned ${r.status}`);
    inputTokens += data.usageMetadata?.promptTokenCount ?? 0;
    outputTokens += data.usageMetadata?.candidatesTokenCount ?? 0;
    const content = data.candidates?.[0]?.content;
    if (!content) throw new Error('Gemini sent no answer');
    contents.push(content);
    const calls = (content.parts ?? []).filter((p: any) => p.functionCall);
    if (calls.length) {
      const parts = [];
      for (const p of calls) {
        const res = await i.call(p.functionCall.name, p.functionCall.args ?? {});
        used.push({ name: p.functionCall.name, ok: res.ok, ...(res.error ? { error: res.error } : {}) });
        parts.push({ functionResponse: { name: p.functionCall.name, response: res.ok ? { result: res.result } : { error: res.error } } });
      }
      contents.push({ role: 'user', parts });
      continue;
    }
    const text = (content.parts ?? []).map((p: any) => p.text ?? '').join('').trim();
    return { answer: text || 'I could not find an answer in your data.', tools: used, inputTokens, outputTokens, model: i.model };
  }
  return { answer: 'That question needed too many steps. Try asking about one thing at a time.', tools: used, inputTokens, outputTokens, model: i.model };
}

export function askProvider(provider: ProviderKey, input: AskInput) {
  return provider === 'anthropic' ? askAnthropic(input) : provider === 'openai' ? askOpenAI(input) : askGemini(input);
}
