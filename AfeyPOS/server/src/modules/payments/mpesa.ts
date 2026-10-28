/**
 * M-Pesa payment intents.
 *
 * A payment is only "succeeded" after Safaricom confirms it: via the STK callback (validated against a
 * known CheckoutRequestID, the per-tenant callback secret, amount check and receipt de-duplication)
 * or via an STK status query / C2B confirmation. Initiating an STK push only creates a *pending* intent.
 * Sales and account payments can only consume succeeded, unallocated intents (atomic claim in checkout).
 */
import type { Request } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { IntegrationConfig, MpesaEvent, PaymentIntent, Tenant, Till, type PaymentIntentDoc } from '../../models/index.js';
import { idParam, objectId, pagination, parse, positiveCents } from '../../http/validate.js';
import { requirePermission } from '../../http/auth.js';
import { AppError, badRequest, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { safeEqual } from '../../lib/crypto.js';
import { normalizePhone, isKenyanMobile } from '../../lib/phone.js';
import { runInTenant } from '../../lib/context.js';
import { logger } from '../../lib/logger.js';
import { emitToTenant } from '../../realtime/socket.js';
import { enqueue, registerJob } from '../../jobs/queue.js';
import { DarajaClient, MockMpesaGateway, parseAsyncResult, parseDarajaDate, parseStkCallback, splitParty, stkResultToStatus, type MpesaGateway } from '../../integrations/mpesa/daraja.js';
import { findActiveConfig, openSecrets } from '../integrations/configs.js';
import { handleB2CResult } from './payouts.js';
import { finalizeIntent, presentIntent } from './intents.js';
import { verifyGatewayIntent } from './gateways.js';

export function gatewayFor(cfg: InstanceType<typeof IntegrationConfig>): MpesaGateway {
  if (cfg.provider === 'mock') {
    if (env().NODE_ENV === 'production' && cfg.environment === 'production') throw badRequest('The M-Pesa simulator cannot be used in production');
    return new MockMpesaGateway();
  }
  const s = cfg.settings ?? {};
  const secrets = openSecrets(cfg);
  return new DarajaClient({
    environment: cfg.environment as 'sandbox' | 'production', consumerKey: secrets.consumerKey, consumerSecret: secrets.consumerSecret, passkey: secrets.passkey,
    shortCode: s.shortCode, type: s.type === 'till' ? 'till' : 'paybill', tillNumber: s.tillNumber,
    initiatorName: s.initiatorName, securityCredential: secrets.securityCredential, b2cShortCode: s.b2cShortCode,
  });
}

/**
 * Public addresses Safaricom calls back. Branch servers are not reachable from the internet, so their
 * callbacks go to head office, which relays them during sync.
 */
export function callbackUrls(tenantId: Types.ObjectId, token: string) {
  const e = env();
  const base = (e.DEPLOYMENT_MODE === 'branch' ? e.SYNC_HQ_URL || e.SYNC_CLOUD_URL || e.API_PUBLIC_URL : e.API_PUBLIC_URL).replace(/\/$/, '');
  const root = `${base}/api/v1/hooks/pay/${tenantId}/${urlToken(token)}`;
  return {
    stk: `${root}/stk`,
    c2bConfirmation: `${root}/c2b/confirmation`,
    c2bValidation: `${root}/c2b/validation`,
    statusResult: `${root}/status/result`,
    b2cResult: `${root}/b2c/result`,
    timeout: `${root}/timeout`,
  };
}

/** Words Safaricom refuses in callback URLs (any case), e.g. "mpesa", "safaricom", "exe", "cmd", "sql", "query". */
export const DARAJA_BLOCKED_URL_WORDS = /m-?pesa|safaricom|exe|cmd|sql|query/i;

/**
 * The callback secret as it appears in URLs. Random base64url tokens can contain a blocked word by chance
 * ("...SqL..."), so those are sent hex-encoded instead (hex letters a-f can never spell one). Both forms are accepted.
 */
export function urlToken(token: string) {
  return DARAJA_BLOCKED_URL_WORDS.test(token) ? `h${Buffer.from(token).toString('hex')}` : token;
}

/** Reasons Safaricom would refuse (or never reach) these callback URLs; empty when they look fine. */
export function callbackUrlProblems(url: string, environment: 'sandbox' | 'production'): string[] {
  const problems: string[] = [];
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return [`"${url}" is not a valid address. Set API_PUBLIC_URL in server/.env to this server's public address.`];
  }
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.lan') || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.)/.test(host) || host === '::1' || !host.includes('.')) {
    problems.push(`${u.origin} is a private address that Safaricom cannot reach. Set API_PUBLIC_URL in server/.env to a public HTTPS address of this server (or of head office for branch servers), then restart.`);
  }
  if (u.protocol !== 'https:') problems.push(environment === 'production' ? 'Live M-Pesa only calls HTTPS addresses. Put the server behind HTTPS (e.g. the installer\'s --domain option) and use an https:// API_PUBLIC_URL.' : 'Use an HTTPS address: Safaricom may refuse plain http:// callback URLs.');
  const word = url.match(DARAJA_BLOCKED_URL_WORDS)?.[0];
  if (word) problems.push(`The address contains "${word}", which Safaricom refuses in callback URLs. Use a domain name without it.`);
  return problems;
}

const router = Router();

const stkSchema = z.object({
  clientRequestId: z.string().min(8).max(100),
  amountCents: positiveCents.refine((v) => v >= 100 && v % 100 === 0, 'M-Pesa amounts must be whole shillings'),
  phone: z.string().min(9).max(20),
  tillId: objectId.optional(),
  accountReference: z.string().trim().max(12).optional(),
});

/** Sends an STK Push and creates the pending intent (till checkout, account payments and online orders). */
/** What to do about the usual Daraja refusals of an STK push. */
function stkHint(said: string, status?: number): string {
  const m = said.toLowerCase();
  if (/access token|invalid credentials|401/.test(m) || status === 401) return ' Check the consumer key and secret (and that sandbox/production matches the Daraja app).';
  if (/businessshortcode|merchant does not exist|shortcode/.test(m)) return ' Check the shortcode: for a Buy Goods till, the "shortcode" is the store (head office) number and the till number goes in "Till number".';
  if (/password|passkey/.test(m)) return ' Check the Lipa Na M-Pesa Online passkey: it belongs to the shortcode and comes from Safaricom when STK is approved.';
  if (/callback/.test(m)) return ' The callback address must be the public https:// address of the online server.';
  if (/phone|partya/.test(m)) return ' Check the customer number (Safaricom line, e.g. 0712345678).';
  if (/not.*(enabled|allowed|permitted)|product/.test(m)) return ' Ask Safaricom to enable Lipa Na M-Pesa Online (STK push) for this shortcode on the Daraja app.';
  return '';
}

export async function startStk(opts: { tenant: any; clientRequestId: string; amountCents: number; phone: string; accountReference?: string; tillId?: unknown; branchId?: unknown; initiatedBy?: unknown; description?: string; configId?: unknown }) {
  const existing = await PaymentIntent.findOne({ clientRequestId: opts.clientRequestId });
  if (existing) return { intent: existing, replay: true };
  const phone = normalizePhone(opts.phone);
  if (!phone || !isKenyanMobile(phone)) throw badRequest('Enter a valid Safaricom number, e.g. 0712345678');
  const till = opts.tillId ? await Till.findById(opts.tillId).lean() : null;
  const branchId = till?.branchId ?? (opts.branchId as any);
  // The online shop may use its own Paybill / Till instead of the branch's.
  const cfg = opts.configId ? await IntegrationConfig.findOne({ _id: opts.configId, kind: 'mpesa', enabled: true }) : await findActiveConfig('mpesa', branchId, till?._id);
  if (!cfg) throw new AppError(409, 'MPESA_NOT_CONFIGURED', 'M-Pesa is not configured for this branch');
  const tenant = opts.tenant;
  const callbackUrl = callbackUrls(tenant._id, tenant.callbackToken).stk;
  // Safaricom only calls public HTTPS addresses: a prompt with any other callback is always refused.
  if (cfg.provider !== 'mock' && !/^https:\/\/(?!localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)[^/]+/i.test(callbackUrl)) {
    throw new AppError(409, 'MPESA_CALLBACK_NOT_PUBLIC', `M-Pesa prompts need this system's public HTTPS address (now ${new URL(callbackUrl).origin}). Set API_PUBLIC_URL${env().DEPLOYMENT_MODE === 'branch' ? ' / SYNC_HQ_URL' : ''} in server/.env to the https:// address of the online server, then restart.`);
  }
  const accountReference = (opts.accountReference || tenant.slug).replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'AFEYPOS';
  const [intent] = await PaymentIntent.create([{ source: 'stk', status: 'pending', clientRequestId: opts.clientRequestId, amountCents: opts.amountCents, phone, accountReference, shortCode: cfg.settings?.shortCode, branchId, tillId: till?._id, configId: cfg._id, initiatedBy: opts.initiatedBy }]);
  try {
    const resp = await gatewayFor(cfg).stkPush({ amount: opts.amountCents / 100, phone, accountReference, description: opts.description ?? 'Payment', callbackUrl });
    if (resp.ResponseCode !== '0') {
      await PaymentIntent.updateOne({ _id: intent._id }, { $set: { status: 'failed', resultDesc: resp.ResponseDescription, completedAt: new Date() } });
      throw unprocessable(`M-Pesa rejected the request: ${resp.ResponseDescription}`, 'MPESA_REJECTED');
    }
    intent.checkoutRequestId = resp.CheckoutRequestID;
    intent.merchantRequestId = resp.MerchantRequestID;
    await intent.save();
  } catch (err: any) {
    if (err instanceof AppError) throw err;
    // Safaricom answered with an error (HTTP 4xx/5xx): show its reason instead of "could not reach".
    const said = err?.body && typeof err.body === 'object' ? String((err.body as any).errorMessage ?? (err.body as any).ResponseDescription ?? (err.body as any).error_description ?? '') : '';
    await PaymentIntent.updateOne({ _id: intent._id, status: 'pending' }, { $set: { status: 'failed', resultDesc: said || `Could not reach M-Pesa: ${err?.message}`, completedAt: new Date() } });
    await MpesaEvent.create({ kind: 'stk_request', payload: { status: err?.status, body: err?.body, message: err?.message }, ip: 'outgoing', outcome: 'rejected', paymentIntentId: intent._id }).catch(() => undefined);
    logger.warn({ err: err?.message, body: err?.body }, 'stk push failed');
    if (said || (err?.status && err.status < 500)) throw unprocessable(`M-Pesa refused the prompt: ${said || err.message}.${stkHint(said, err?.status)}`, 'MPESA_REJECTED');
    throw new AppError(502, 'MPESA_UNAVAILABLE', 'Could not reach M-Pesa. Check the internet connection and try again, or use another payment method.');
  }
  // Safety net: if no callback arrives, query the status and expire.
  const timeout = tenant.settings?.stkPendingTimeoutSeconds ?? 180;
  await enqueue('mpesa.checkIntent', { intentId: String(intent._id) }, { runAt: new Date(Date.now() + 45_000), dedupeKey: `mpesa-check:${intent._id}:1` });
  await enqueue('mpesa.checkIntent', { intentId: String(intent._id), final: true }, { runAt: new Date(Date.now() + timeout * 1000), dedupeKey: `mpesa-check:${intent._id}:final` });
  return { intent, replay: false };
}

router.post('/payments/mpesa/stk', requirePermission('sales.create'), async (req, res) => {
  const body = parse(stkSchema, req.body);
  const { intent, replay } = await startStk({ tenant: req.tenant!, clientRequestId: body.clientRequestId, amountCents: body.amountCents, phone: body.phone, accountReference: body.accountReference, tillId: body.tillId, initiatedBy: req.auth!.userId });
  if (replay) {
    res.json({ data: presentIntent(intent), replay: true });
    return;
  }
  await audit(req, { action: 'mpesa.stk_initiated', entity: 'PaymentIntent', entityId: intent._id, details: { amountCents: body.amountCents, phone: String(intent.phone).replace(/\d(?=\d{3})/g, '*') } });
  res.status(201).json({ data: presentIntent(intent) });
});

router.get('/payments/intents', requirePermission('sales.create'), async (req, res) => {
  const q = parse(pagination.extend({ status: z.string().optional(), unallocated: z.enum(['true']).optional(), source: z.enum(['stk', 'c2b', 'push', 'link']).optional(), provider: z.string().max(40).optional() }), req.query);
  const filter: Record<string, unknown> = {};
  // provider=gateway selects every non-Daraja gateway.
  if (q.provider) filter.provider = q.provider === 'gateway' ? { $ne: 'mpesa' } : q.provider;
  if (q.status) filter.status = q.status;
  if (q.source) filter.source = q.source;
  if (q.unallocated) {
    filter.$expr = { $lt: ['$allocatedCents', '$paidAmountCents'] };
    filter.onlineOrderId = null;
  }
  if (q.q) {
    const digits = q.q.replace(/\D/g, '');
    filter.$or = [{ receiptNumber: q.q.toUpperCase() }, { receiptNumber: q.q }, { reference: q.q }, ...(digits ? [{ phone: { $regex: digits } }] : []), { accountReference: q.q }];
  }
  const [data, total] = await Promise.all([PaymentIntent.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), PaymentIntent.countDocuments(filter)]);
  res.json({ data: data.map(presentIntent), total, page: q.page, limit: q.limit });
});

router.get('/payments/intents/:id', requirePermission('sales.create'), async (req, res) => {
  const i = await PaymentIntent.findById(idParam(req.params.id)).lean();
  if (!i) throw notFound('Payment');
  res.json({ data: presentIntent(i) });
});

/** Cashier-triggered status check (STK query) for a pending intent. */
router.post('/payments/intents/:id/query', requirePermission('sales.create'), async (req, res) => {
  const i = await PaymentIntent.findById(idParam(req.params.id));
  if (!i) throw notFound('Payment');
  if (i.status === 'pending') {
    if ((i.provider ?? 'mpesa') === 'mpesa') await queryAndApply(i, false);
    else await verifyGatewayIntent(i, false);
  }
  res.json({ data: presentIntent((await PaymentIntent.findById(i._id).lean())!) });
});

router.post('/payments/intents/:id/cancel', requirePermission('sales.create'), async (req, res) => {
  // Marks the local intent abandoned; if Safaricom later confirms it, the callback is still recorded and flagged for reconciliation.
  const i = await PaymentIntent.findOneAndUpdate({ _id: idParam(req.params.id), status: 'pending' }, { $set: { status: 'cancelled', resultDesc: 'Cancelled by cashier', completedAt: new Date() } }, { new: true });
  if (!i) throw unprocessable('Only pending payments can be cancelled');
  await audit(req, { action: 'mpesa.intent_cancelled', entity: 'PaymentIntent', entityId: i._id });
  res.json({ data: presentIntent(i) });
});

/** Reconciliation view: succeeded-but-unallocated and late confirmations need attention. */
router.get('/payments/mpesa/reconciliation', requirePermission('payments.reconcile'), async (req, res) => {
  const q = parse(z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }), req.query);
  const range = { provider: 'mpesa', ...(q.from || q.to ? { createdAt: { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) } } : {}) };
  const [summary, unallocated, late] = await Promise.all([
    PaymentIntent.aggregate([{ $match: range }, { $group: { _id: '$status', count: { $sum: 1 }, amountCents: { $sum: { $ifNull: ['$paidAmountCents', '$amountCents'] } }, allocatedCents: { $sum: '$allocatedCents' } } }]),
    PaymentIntent.find({ ...range, status: 'succeeded', $expr: { $lt: ['$allocatedCents', '$paidAmountCents'] } }).sort({ createdAt: -1 }).limit(200).lean(),
    PaymentIntent.find({ ...range, status: { $in: ['cancelled', 'expired'] }, receiptNumber: { $exists: true } }).limit(200).lean(),
  ]);
  res.json({ data: { summary, unallocated: unallocated.map(presentIntent), lateConfirmations: late.map(presentIntent) } });
});

router.get('/payments/mpesa/events', requirePermission('payments.reconcile'), async (req, res) => {
  const q = parse(pagination, req.query);
  const data = await MpesaEvent.find({ kind: { $in: ['stk_callback', 'c2b_validation', 'c2b_confirmation', 'stk_query'] } }).sort({ at: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean();
  res.json({ data });
});

/** Development only: simulate Safaricom's STK callback for a mock intent. */
router.post('/payments/mpesa/simulate/:id', requirePermission('sales.create'), async (req, res) => {
  if (env().NODE_ENV === 'production') throw forbidden('Simulation is disabled in production');
  const body = parse(z.object({ resultCode: z.number().int().default(0), amount: z.number().optional() }), req.body ?? {});
  const i = await PaymentIntent.findById(idParam(req.params.id));
  if (!i?.checkoutRequestId) throw notFound('Payment');
  const cfg = await IntegrationConfig.findById(i.configId).lean();
  if (cfg?.provider !== 'mock') throw forbidden('Only simulator payments can be simulated');
  const payload = buildStkCallback(i.checkoutRequestId, i.merchantRequestId ?? 'mock', body.resultCode, body.amount ?? i.amountCents / 100, i.phone ?? '254700000000');
  await handleStkCallback(req.tenant!._id, payload, req.ip ?? 'simulator');
  res.json({ data: presentIntent((await PaymentIntent.findById(i._id).lean())!) });
});

export function buildStkCallback(checkoutRequestId: string, merchantRequestId: string, resultCode: number, amount: number, phone: string, receipt = `SIM${Date.now().toString(36).toUpperCase()}`) {
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: merchantRequestId,
        CheckoutRequestID: checkoutRequestId,
        ResultCode: resultCode,
        ResultDesc: resultCode === 0 ? 'The service request is processed successfully.' : resultCode === 1032 ? 'Request cancelled by user' : 'Failed',
        ...(resultCode === 0
          ? { CallbackMetadata: { Item: [{ Name: 'Amount', Value: amount }, { Name: 'MpesaReceiptNumber', Value: receipt }, { Name: 'TransactionDate', Value: 20261022143000 }, { Name: 'PhoneNumber', Value: Number(phone) }] } }
          : {}),
      },
    },
  };
}

/** How customers pay this till without a prompt: Paybill number + account, or Buy Goods till number. */
function payTo(cfg: InstanceType<typeof IntegrationConfig>) {
  const till = cfg.settings?.type === 'till';
  return { type: till ? 'till' : 'paybill', number: String(till ? (cfg.settings?.tillNumber ?? cfg.settings?.shortCode) : cfg.settings?.shortCode) };
}

/**
 * The till waits for the customer to pay the Paybill/Till themselves. Paybill: we give an account number
 * to type, so the payment matches this sale exactly. Buy Goods: matched by amount (see handleC2B).
 */
router.post('/payments/mpesa/expect', requirePermission('sales.create'), async (req, res) => {
  const body = parse(z.object({ clientRequestId: z.string().min(8).max(100), amountCents: positiveCents.refine((v) => v >= 100 && v % 100 === 0, 'M-Pesa amounts must be whole shillings'), tillId: objectId }), req.body);
  const existing = await PaymentIntent.findOne({ clientRequestId: body.clientRequestId }).lean();
  if (existing) {
    res.json({ data: presentIntent(existing), replay: true });
    return;
  }
  const till = await Till.findById(body.tillId).lean();
  if (!till) throw notFound('Till');
  const cfg = await findActiveConfig('mpesa', till.branchId, till._id);
  if (!cfg) throw new AppError(409, 'MPESA_NOT_CONFIGURED', 'M-Pesa is not configured for this branch');
  const to = payTo(cfg);
  // Short and easy to type on a phone: till code + 4 digits, unique among waiting payments.
  let account = '';
  for (let n = 0; n < 20 && !account; n++) {
    const candidate = `${till.code}${Math.floor(1000 + Math.random() * 9000)}`.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    if (!(await PaymentIntent.exists({ awaiting: 'expected', status: 'pending', accountReference: candidate }))) account = candidate;
  }
  const [intent] = await PaymentIntent.create([{
    source: 'c2b', awaiting: 'expected', status: 'pending', clientRequestId: body.clientRequestId, amountCents: body.amountCents,
    accountReference: to.type === 'paybill' ? account : undefined, shortCode: to.number, branchId: till.branchId, tillId: till._id, configId: cfg._id, initiatedBy: req.auth!.userId,
  }]);
  // Waiting payments that never arrive expire like prompts do.
  const timeout = Math.max(600, req.tenant!.settings?.stkPendingTimeoutSeconds ?? 0);
  await enqueue('mpesa.expireExpected', { intentId: String(intent._id) }, { runAt: new Date(Date.now() + timeout * 1000), dedupeKey: `mpesa-expect:${intent._id}` });
  res.status(201).json({ data: { ...presentIntent(intent), payTo: to } });
});

registerJob('mpesa.expireExpected', async ({ intentId }: { intentId: string }) => {
  const i = await PaymentIntent.findById(intentId);
  if (i?.status === 'pending' && i.awaiting === 'expected') await finalizeIntent(i, { status: 'expired', resultDesc: 'No payment received to the Paybill/Till in time' });
});

/**
 * Cashier enters the M-Pesa code from the customer's SMS. Found and unused: ready to apply. Not found yet:
 * if the business set up an initiator, Safaricom's Transaction Status API is asked (answer arrives by callback).
 */
router.post('/payments/mpesa/lookup', requirePermission('sales.create'), async (req, res) => {
  const body = parse(z.object({ receipt: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{8,12}$/, 'M-Pesa codes are 8-12 letters and digits, e.g. SJK3AB12CD'), tillId: objectId.optional(), clientRequestId: z.string().min(8).max(100) }), req.body);
  let found = await PaymentIntent.findOne({ provider: 'mpesa', receiptNumber: body.receipt }).lean();
  // At a branch server, a payment head office received without a branch (or one not downloaded yet) is claimed from HQ first.
  if (env().DEPLOYMENT_MODE === 'branch' && !found?.branchId) {
    const { claimMpesaFromHq } = await import('../sync/branch.js');
    let r: { claimed: boolean; reason?: string } | null = null;
    try {
      r = await claimMpesaFromHq(body.receipt);
    } catch {
      // Payments reach head office (Safaricom calls the live server), so without it this server cannot know.
      throw new AppError(503, 'HQ_UNREACHABLE', found
        ? `M-Pesa ${body.receipt} was received at head office, which cannot be reached right now. Try again when the internet is back, or take another payment.`
        : `M-Pesa ${body.receipt} is not on this server yet, and head office (where M-Pesa payments arrive) cannot be reached to check it. Try again when the internet is back.`);
    }
    if (r?.claimed) found = await PaymentIntent.findOne({ provider: 'mpesa', receiptNumber: body.receipt }).lean();
    else if (r?.reason && r.reason !== 'not_found') throw unprocessable(r.reason, 'MPESA_NOT_AVAILABLE');
  }
  if (found) {
    const free = (found.paidAmountCents ?? 0) - (found.allocatedCents ?? 0);
    if (found.status !== 'succeeded') throw unprocessable(`M-Pesa ${body.receipt} is ${found.status}`, 'MPESA_NOT_AVAILABLE');
    if (free <= 0) throw unprocessable(`M-Pesa ${body.receipt} was already used${found.allocatedTo?.number ? ` for ${found.allocatedTo.number}` : ''}`, 'MPESA_ALREADY_USED');
    res.json({ data: presentIntent(found), found: true });
    return;
  }
  const pendingCheck = await PaymentIntent.findOne({ awaiting: 'verify', accountReference: body.receipt, status: 'pending' }).lean();
  if (pendingCheck) {
    res.json({ data: presentIntent(pendingCheck), found: false, verifying: true });
    return;
  }
  const till = body.tillId ? await Till.findById(body.tillId).lean() : null;
  const cfg = await findActiveConfig('mpesa', till?.branchId, till?._id);
  if (!cfg) throw new AppError(409, 'MPESA_NOT_CONFIGURED', 'M-Pesa is not configured for this branch');
  if (cfg.provider !== 'mock' && (!cfg.settings?.initiatorName || !openSecrets(cfg).securityCredential)) {
    throw new AppError(404, 'MPESA_RECEIPT_NOT_FOUND', `${body.receipt} has not reached the system yet. Check the code, wait a minute, or set up the M-Pesa initiator to verify codes with Safaricom.`);
  }
  const tenant = req.tenant!;
  const urls = callbackUrls(tenant._id, tenant.callbackToken);
  const originatorConversationId = `AFY-${new Types.ObjectId().toHexString()}`;
  const [intent] = await PaymentIntent.create([{
    source: 'c2b', awaiting: 'verify', status: 'pending', clientRequestId: body.clientRequestId, amountCents: 0, accountReference: body.receipt,
    originatorConversationId, branchId: till?.branchId, tillId: till?._id, configId: cfg._id, initiatedBy: req.auth!.userId,
  }]);
  try {
    const r = await gatewayFor(cfg).transactionStatus({ transactionId: body.receipt, originatorConversationId, resultUrl: urls.statusResult, timeoutUrl: urls.timeout });
    if (r.ResponseCode !== '0') throw new Error(r.ResponseDescription ?? r.errorMessage ?? 'rejected');
    await PaymentIntent.updateOne({ _id: intent._id }, { $set: { conversationId: r.ConversationID } });
  } catch (err: any) {
    await finalizeIntent(intent, { status: 'failed', resultDesc: `Could not ask M-Pesa: ${err?.message}` });
    throw new AppError(502, 'MPESA_UNAVAILABLE', `Could not ask M-Pesa about ${body.receipt}: ${err?.message}`);
  }
  await enqueue('mpesa.expireExpected', { intentId: String(intent._id) }, { runAt: new Date(Date.now() + 5 * 60_000), dedupeKey: `mpesa-verify:${intent._id}` });
  await audit(req, { action: 'mpesa.receipt_verification', entity: 'PaymentIntent', entityId: intent._id, details: { receipt: body.receipt } });
  res.status(202).json({ data: presentIntent(intent), found: false, verifying: true });
});

/** Development only: simulate a customer paying the Paybill/Till (C2B confirmation) on a simulator config. */
router.post('/payments/mpesa/simulate-c2b', requirePermission('sales.create'), async (req, res) => {
  if (env().NODE_ENV === 'production') throw forbidden('Simulation is disabled in production');
  const body = parse(z.object({ amountCents: positiveCents, account: z.string().max(20).optional(), phone: z.string().default('254712345678'), receipt: z.string().optional(), tillId: objectId.optional() }), req.body);
  const till = body.tillId ? await Till.findById(body.tillId).lean() : null;
  const cfg = await findActiveConfig('mpesa', till?.branchId, till?._id);
  if (cfg?.provider !== 'mock') throw forbidden('Only the M-Pesa simulator can simulate payments');
  const to = payTo(cfg);
  const receipt = body.receipt ?? `SIM${Date.now().toString(36).toUpperCase()}`.slice(0, 10);
  await handleC2B(req.tenant!._id, { TransactionType: to.type === 'till' ? 'Buy Goods' : 'Pay Bill', TransID: receipt, TransTime: '20261025120000', TransAmount: String(body.amountCents / 100), BusinessShortCode: to.number, BillRefNumber: body.account ?? '', MSISDN: body.phone, FirstName: 'SIMULATED', LastName: 'CUSTOMER' }, 'simulator');
  res.json({ data: presentIntent((await PaymentIntent.findOne({ receiptNumber: receipt.toUpperCase() }).lean())!) });
});

/** Development only: simulate Safaricom's Transaction Status answer for a pending receipt check. */
router.post('/payments/mpesa/simulate-status/:id', requirePermission('sales.create'), async (req, res) => {
  if (env().NODE_ENV === 'production') throw forbidden('Simulation is disabled in production');
  const body = parse(z.object({ amountCents: positiveCents, completed: z.boolean().default(true) }), req.body);
  const i = await PaymentIntent.findById(idParam(req.params.id));
  if (!i?.originatorConversationId) throw notFound('Receipt check');
  await handleStatusResult(req.tenant!._id, {
    Result: {
      ResultType: 0, ResultCode: body.completed ? 0 : 2001, ResultDesc: body.completed ? 'The service request is processed successfully.' : 'The initiator information is invalid.',
      OriginatorConversationID: i.originatorConversationId, ConversationID: i.conversationId, TransactionID: 'SIMSTATUS',
      ResultParameters: { ResultParameter: [{ Key: 'ReceiptNo', Value: i.accountReference }, { Key: 'Amount', Value: body.amountCents / 100 }, { Key: 'TransactionStatus', Value: 'Completed' }, { Key: 'DebitPartyName', Value: '254712345678 - SIMULATED CUSTOMER' }] },
    },
  }, 'simulator');
  res.json({ data: presentIntent((await PaymentIntent.findById(i._id).lean())!) });
});

export const mpesaRoutes = router;

// ---------------- callbacks (public, tenant resolved from path + secret) ----------------

export async function handleStkCallback(tenantId: Types.ObjectId, payload: any, ip: string) {
  return runInTenant(tenantId, async () => {
    const parsed = parseStkCallback(payload);
    const event = await MpesaEvent.create({ kind: 'stk_callback', payload, ip });
    if (!parsed) {
      event.outcome = 'malformed';
      await event.save();
      return 'malformed';
    }
    const intent = await PaymentIntent.findOne({ checkoutRequestId: parsed.checkoutRequestId });
    event.paymentIntentId = intent?._id;
    if (!intent) {
      event.outcome = 'unknown_checkout_request';
      await event.save();
      return event.outcome;
    }
    if (intent.status !== 'pending') {
      // Duplicate or late callback: never double-apply. Fill in a missing receipt (status-query confirmations)
      // and flag confirmations that arrive after the intent was abandoned, for reconciliation.
      if (parsed.resultCode === 0 && parsed.receiptNumber && !intent.receiptNumber) {
        const late = intent.status !== 'succeeded';
        await PaymentIntent.updateOne(
          { _id: intent._id },
          { $set: { receiptNumber: parsed.receiptNumber, ...(late ? { resultDesc: `Late confirmation after ${intent.status}`, paidAmountCents: Math.round((parsed.amount ?? 0) * 100) } : {}) } },
        ).catch(() => undefined);
        event.outcome = late ? 'late_confirmation' : 'receipt_added';
      } else event.outcome = 'duplicate';
      await event.save();
      return event.outcome;
    }
    const status = stkResultToStatus(parsed.resultCode);
    if (status === 'succeeded') {
      const paid = Math.round((parsed.amount ?? 0) * 100);
      if (!parsed.receiptNumber || paid !== intent.amountCents) {
        await finalizeIntent(intent, { status: 'failed', resultCode: parsed.resultCode, resultDesc: `Amount/receipt mismatch: expected ${intent.amountCents / 100}, got ${parsed.amount}` });
        event.outcome = 'amount_mismatch';
        await event.save();
        return event.outcome;
      }
      const cfg = await IntegrationConfig.findById(intent.configId);
      if (cfg?.settings?.verifyCallbacksWithQuery && cfg.provider !== 'mock') {
        // Optional defence in depth: confirm with Daraja before trusting the callback body.
        const q = await gatewayFor(cfg).stkQuery(intent.checkoutRequestId!);
        if (String(q.ResultCode) !== '0') {
          event.outcome = 'query_did_not_confirm';
          await event.save();
          return event.outcome;
        }
      }
      await finalizeIntent(intent, { status, resultCode: parsed.resultCode, resultDesc: parsed.resultDesc, receiptNumber: parsed.receiptNumber, paidAmountCents: paid, transactionDate: parsed.transactionDate });
    } else {
      await finalizeIntent(intent, { status, resultCode: parsed.resultCode, resultDesc: parsed.resultDesc });
    }
    event.outcome = status;
    await event.save();
    return status;
  });
}

async function queryAndApply(intent: PaymentIntentDoc, final: boolean) {
  const cfg = await IntegrationConfig.findById(intent.configId);
  if (!cfg || !intent.checkoutRequestId) {
    if (final) await finalizeIntent(intent, { status: 'expired', resultDesc: 'No confirmation received' });
    return;
  }
  const q = await gatewayFor(cfg).stkQuery(intent.checkoutRequestId);
  await MpesaEvent.create({ kind: 'stk_query', payload: q, paymentIntentId: intent._id });
  await PaymentIntent.updateOne({ _id: intent._id }, { $set: { lastQueriedAt: new Date() } });
  if (q.ResultCode !== undefined && q.ResultCode !== null && q.ResultCode !== '') {
    const code = Number(q.ResultCode);
    if (code === 0) {
      // Confirmed by an authenticated server-to-Safaricom status query. The query does not return the
      // M-Pesa receipt number; a later callback fills it in.
      await finalizeIntent(intent, { status: 'succeeded', resultCode: 0, resultDesc: 'Confirmed by M-Pesa status query', paidAmountCents: intent.amountCents });
      return;
    }
    await finalizeIntent(intent, { status: stkResultToStatus(code), resultCode: code, resultDesc: q.ResultDesc });
    return;
  }
  if (final) await finalizeIntent(intent, { status: 'expired', resultDesc: q.errorMessage ?? 'No confirmation received in time' });
}

registerJob('mpesa.checkIntent', async ({ intentId, final }: { intentId: string; final?: boolean }) => {
  const i = await PaymentIntent.findById(intentId);
  if (!i || i.status !== 'pending') return;
  await queryAndApply(i, Boolean(final));
});

/**
 * A customer paid the Paybill/Till directly. If a till is waiting for it (Paybill: same account number;
 * Buy Goods: exactly one waiting sale with the same amount in the last 30 minutes) that sale's intent is
 * completed; otherwise the payment is recorded as unallocated for the cashier to pick.
 */
export async function handleC2B(tenantId: Types.ObjectId, payload: any, ip: string) {
  return runInTenant(tenantId, async () => {
    const event = await MpesaEvent.create({ kind: 'c2b_confirmation', payload, ip });
    const transId = String(payload?.TransID ?? '').trim().toUpperCase();
    const amount = Number(payload?.TransAmount);
    if (!transId || !Number.isFinite(amount) || amount <= 0) {
      event.outcome = 'malformed';
      await event.save();
      return;
    }
    const cfgs = await IntegrationConfig.find({ kind: 'mpesa', enabled: true }).lean();
    const cfg = cfgs.find((c) => String(c.settings?.shortCode) === String(payload.BusinessShortCode) || String(c.settings?.tillNumber) === String(payload.BusinessShortCode));
    if (!cfg) {
      event.outcome = 'unknown_shortcode';
      await event.save();
      return;
    }
    // Proof that the registered URLs work: shown next to the registration in Settings > Integrations.
    await IntegrationConfig.updateOne({ _id: cfg._id }, { $set: { 'c2bRegistration.lastConfirmationAt': new Date() } });
    if (await PaymentIntent.exists({ receiptNumber: transId })) {
      event.outcome = 'duplicate';
      await event.save();
      return;
    }
    const cents = Math.round(amount * 100);
    const billRef = String(payload.BillRefNumber ?? '').trim().toUpperCase();
    const paid = {
      receiptNumber: transId, paidAmountCents: cents, phone: String(payload.MSISDN ?? ''),
      payerName: [payload.FirstName, payload.MiddleName, payload.LastName].filter(Boolean).join(' '),
      transactionDate: parseDarajaDate(String(payload.TransTime ?? '')),
    };
    const waiting = { configId: cfg._id, source: 'c2b', awaiting: 'expected', status: 'pending' };
    let expected = billRef ? await PaymentIntent.findOne({ ...waiting, accountReference: billRef }) : null;
    if (!expected && cfg.settings?.type === 'till') {
      const candidates = await PaymentIntent.find({ ...waiting, amountCents: cents, createdAt: { $gt: new Date(Date.now() - 30 * 60_000) } }).limit(2);
      if (candidates.length === 1) expected = candidates[0];
    }
    try {
      if (expected) {
        const done = await finalizeIntent(expected, { status: 'succeeded', resultCode: 0, resultDesc: 'Paid to M-Pesa Paybill/Till', ...paid });
        event.paymentIntentId = expected._id;
        event.outcome = done ? 'matched_expected' : 'duplicate';
      } else {
        const [intent] = await PaymentIntent.create([{
          source: 'c2b', status: 'succeeded', amountCents: cents, ...paid, accountReference: billRef || undefined,
          shortCode: String(payload.BusinessShortCode), configId: cfg._id, branchId: cfg.branchIds?.[0], completedAt: new Date(),
        }]);
        event.paymentIntentId = intent._id;
        event.outcome = 'recorded';
        emitToTenant(tenantId, 'payment.updated', presentIntent(intent));
      }
    } catch (err: any) {
      if (err?.code !== 11000) throw err;
      event.outcome = 'duplicate';
    }
    await event.save();
  });
}

/**
 * Result of a Transaction Status query (a receipt code a cashier entered): becomes a confirmed payment
 * when Safaricom says the transaction completed and credited this business.
 */
export async function handleStatusResult(tenantId: Types.ObjectId, payload: any, ip: string) {
  return runInTenant(tenantId, async () => {
    const parsed = parseAsyncResult(payload);
    const event = await MpesaEvent.create({ kind: 'txn_status', payload, ip });
    const intent = parsed?.originatorConversationId ? await PaymentIntent.findOne({ originatorConversationId: parsed.originatorConversationId, awaiting: 'verify' }) : null;
    event.paymentIntentId = intent?._id;
    if (!parsed || !intent) {
      event.outcome = parsed ? 'unknown_request' : 'malformed';
      await event.save();
      return event.outcome;
    }
    if (intent.status !== 'pending') {
      event.outcome = 'duplicate';
      await event.save();
      return event.outcome;
    }
    const status = String(parsed.params.get('TransactionStatus') ?? '');
    const cents = Math.round(Number(parsed.params.get('Amount') ?? 0) * 100);
    const receipt = String(parsed.params.get('ReceiptNo') ?? intent.accountReference ?? '').toUpperCase();
    if (parsed.resultCode !== 0 || !/completed/i.test(status) || cents <= 0) {
      await finalizeIntent(intent, { status: 'failed', resultCode: parsed.resultCode, resultDesc: parsed.resultDesc || `Transaction ${status || 'not found'}` });
      event.outcome = 'not_confirmed';
    } else if (await PaymentIntent.exists({ receiptNumber: receipt, _id: { $ne: intent._id } })) {
      // Already recorded (e.g. its C2B confirmation arrived meanwhile): point the cashier at that one.
      await finalizeIntent(intent, { status: 'failed', resultDesc: `Receipt ${receipt} is already recorded` });
      event.outcome = 'duplicate_receipt';
    } else {
      const payer = splitParty(parsed.params.get('DebitPartyName'));
      await PaymentIntent.updateOne({ _id: intent._id }, { $set: { amountCents: cents } });
      intent.amountCents = cents;
      await finalizeIntent(intent, { status: 'succeeded', resultCode: 0, resultDesc: 'Confirmed by M-Pesa transaction status', receiptNumber: receipt, paidAmountCents: cents, phone: payer.phone, payerName: payer.name });
      event.outcome = 'confirmed';
    }
    await event.save();
    return event.outcome;
  });
}

/** Resolves the tenant from the callback path and verifies the per-tenant secret token. */
async function callbackTenant(req: Request) {
  const { tenantId, token } = req.params as { tenantId: string; token: string };
  if (!/^[a-f0-9]{24}$/.test(tenantId)) return null;
  const allowed = env().MPESA_ALLOWED_IPS.split(',').map((s) => s.trim()).filter(Boolean);
  if (allowed.length && !allowed.includes(req.ip ?? '')) {
    logger.warn({ ip: req.ip }, 'mpesa callback from non-allowlisted IP');
    return null;
  }
  const tenant = await Tenant.findById(tenantId).lean();
  if (!tenant || !(safeEqual(tenant.callbackToken, token) || safeEqual(urlToken(tenant.callbackToken), token))) return null;
  return tenant;
}

export const mpesaCallbackRoutes = Router();

mpesaCallbackRoutes.post('/:tenantId/:token/stk', async (req, res) => {
  const tenant = await callbackTenant(req);
  // Always acknowledge so Safaricom does not retry forever; unknown senders are ignored and logged.
  if (tenant) {
    try {
      await handleStkCallback(tenant._id, req.body, req.ip ?? '');
    } catch (err) {
      logger.error({ err }, 'stk callback processing failed');
      res.status(500).json({ ResultCode: 1, ResultDesc: 'Temporary error' });
      return;
    }
  }
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

mpesaCallbackRoutes.post('/:tenantId/:token/c2b/validation', async (req, res) => {
  const tenant = await callbackTenant(req);
  if (!tenant) {
    res.json({ ResultCode: 'C2B00016', ResultDesc: 'Rejected' });
    return;
  }
  await runInTenant(tenant._id, () => MpesaEvent.create({ kind: 'c2b_validation', payload: req.body, ip: req.ip }));
  res.json({ ResultCode: '0', ResultDesc: 'Accepted' });
});

mpesaCallbackRoutes.post('/:tenantId/:token/status/result', async (req, res) => {
  const tenant = await callbackTenant(req);
  if (tenant) await handleStatusResult(tenant._id, req.body, req.ip ?? '');
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

mpesaCallbackRoutes.post('/:tenantId/:token/b2c/result', async (req, res) => {
  const tenant = await callbackTenant(req);
  if (tenant) await handleB2CResult(tenant._id, req.body, req.ip ?? '');
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

/** Safaricom gave up queueing an async request (Transaction Status or B2C); recorded for reconciliation. */
mpesaCallbackRoutes.post('/:tenantId/:token/timeout', async (req, res) => {
  const tenant = await callbackTenant(req);
  if (tenant) await runInTenant(tenant._id, () => MpesaEvent.create({ kind: 'async_timeout', payload: req.body, ip: req.ip, outcome: 'timeout' }));
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

mpesaCallbackRoutes.post('/:tenantId/:token/c2b/confirmation', async (req, res) => {
  const tenant = await callbackTenant(req);
  if (tenant) await handleC2B(tenant._id, req.body, req.ip ?? '');
  res.json({ ResultCode: 0, ResultDesc: 'Success' });
});

/**
 * Head office with branch servers: a till's "waiting for a payment to the Paybill/Till" record reaches head
 * office at the next sync, but Safaricom's confirmation often arrives first and is recorded as unmatched.
 * When the waiting record arrives (or on the periodic check), this pairs them: same M-Pesa configuration,
 * same account number (Paybill) or the same amount (Buy Goods, one candidate only), paid after the till
 * started waiting. The unmatched record gives its receipt to the waiting one, so the payment counts once.
 */
export async function matchExpectedToReceived(expected: PaymentIntentDoc): Promise<boolean> {
  if (expected.status !== 'pending' || expected.awaiting !== 'expected' || expected.source !== 'c2b') return false;
  const cfg = expected.configId ? await IntegrationConfig.findById(expected.configId).lean() : null;
  if (!cfg) return false;
  const since = new Date(new Date(expected.createdAt as unknown as Date).getTime() - 2 * 60_000);
  const filter: Record<string, unknown> = {
    configId: cfg._id, source: 'c2b', awaiting: { $exists: false }, status: 'succeeded', allocatedCents: 0,
    allocatedTo: { $exists: false }, onlineOrderId: { $exists: false }, receiptNumber: { $type: 'string' }, completedAt: { $gte: since },
  };
  if (cfg.settings?.type === 'till') filter.paidAmountCents = expected.amountCents;
  else if (expected.accountReference) filter.accountReference = expected.accountReference;
  else return false;
  const candidates = await PaymentIntent.find(filter).sort({ completedAt: 1 }).limit(2);
  if (candidates.length !== 1) return false;
  const received = candidates[0]!;
  const receipt = received.receiptNumber!;
  // Hand the receipt over first (receipts are unique), then confirm the till's waiting payment with it.
  const freed = await PaymentIntent.updateOne(
    { _id: received._id, status: 'succeeded', allocatedCents: 0 },
    { $set: { status: 'cancelled', resultDesc: `Receipt ${receipt} matched to the till's waiting payment ${expected._id}` }, $unset: { receiptNumber: 1 } },
  );
  if (!freed.modifiedCount) return false;
  const done = await finalizeIntent(expected, {
    status: 'succeeded', resultCode: 0, resultDesc: 'Paid to M-Pesa Paybill/Till', receiptNumber: receipt, paidAmountCents: received.paidAmountCents ?? expected.amountCents,
    phone: received.phone ?? undefined, payerName: received.payerName ?? undefined, transactionDate: received.transactionDate ?? undefined,
  });
  if (!done) {
    await PaymentIntent.updateOne({ _id: received._id }, { $set: { status: 'succeeded', receiptNumber: receipt, resultDesc: received.resultDesc } });
    return false;
  }
  await MpesaEvent.updateMany({ paymentIntentId: received._id }, { $set: { paymentIntentId: expected._id, outcome: 'matched_expected_later' } });
  return true;
}

/** Periodic safety net at head office: waiting till payments that a confirmation already paid. */
registerJob('mpesa.matchExpected', async () => {
  const waiting = await PaymentIntent.find({ source: 'c2b', awaiting: 'expected', status: 'pending', createdAt: { $gt: new Date(Date.now() - 2 * 3600_000) } }).limit(200);
  for (const w of waiting) await matchExpectedToReceived(w).catch((err) => logger.warn({ err }, 'matching a waiting M-Pesa payment failed'));
});
