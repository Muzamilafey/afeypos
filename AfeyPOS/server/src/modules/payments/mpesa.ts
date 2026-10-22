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
import { requireModule, requirePermission } from '../../http/auth.js';
import { AppError, badRequest, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { safeEqual } from '../../lib/crypto.js';
import { normalizePhone, isKenyanMobile } from '../../lib/phone.js';
import { runInTenant } from '../../lib/context.js';
import { logger } from '../../lib/logger.js';
import { emitToTenant } from '../../realtime/socket.js';
import { enqueue, registerJob } from '../../jobs/queue.js';
import { DarajaClient, MockMpesaGateway, parseDarajaDate, parseStkCallback, stkResultToStatus, type MpesaGateway } from '../../integrations/mpesa/daraja.js';
import { findActiveConfig, openSecrets } from '../integrations/configs.js';

export function gatewayFor(cfg: InstanceType<typeof IntegrationConfig>): MpesaGateway {
  if (cfg.provider === 'mock') {
    if (env().NODE_ENV === 'production' && cfg.environment === 'production') throw badRequest('The M-Pesa simulator cannot be used in production');
    return new MockMpesaGateway();
  }
  const s = cfg.settings ?? {};
  const secrets = openSecrets(cfg);
  return new DarajaClient({ environment: cfg.environment as 'sandbox' | 'production', consumerKey: secrets.consumerKey, consumerSecret: secrets.consumerSecret, passkey: secrets.passkey, shortCode: s.shortCode, type: s.type ?? 'paybill', tillNumber: s.tillNumber });
}

export function callbackUrls(tenantId: Types.ObjectId, token: string) {
  const base = env().API_PUBLIC_URL.replace(/\/$/, '');
  return {
    stk: `${base}/api/v1/integrations/mpesa/${tenantId}/${token}/stk`,
    c2bConfirmation: `${base}/api/v1/integrations/mpesa/${tenantId}/${token}/c2b/confirmation`,
    c2bValidation: `${base}/api/v1/integrations/mpesa/${tenantId}/${token}/c2b/validation`,
  };
}

function presentIntent(i: PaymentIntentDoc | Record<string, any>) {
  return {
    id: i._id, status: i.status, source: i.source, amountCents: i.amountCents, paidAmountCents: i.paidAmountCents, phone: i.phone, payerName: i.payerName,
    receiptNumber: i.receiptNumber, resultCode: i.resultCode, resultDesc: i.resultDesc, accountReference: i.accountReference, allocatedTo: i.allocatedTo,
    allocatedCents: i.allocatedCents, createdAt: i.createdAt, completedAt: i.completedAt, checkoutRequestId: i.checkoutRequestId,
  };
}

/** Applies a final result to a pending intent exactly once. */
async function finalizeIntent(intent: PaymentIntentDoc, update: { status: 'succeeded' | 'failed' | 'cancelled' | 'expired'; resultCode?: number; resultDesc?: string; receiptNumber?: string; paidAmountCents?: number; phone?: string; transactionDate?: Date }) {
  const set: Record<string, unknown> = { status: update.status, resultCode: update.resultCode, resultDesc: update.resultDesc, completedAt: new Date() };
  if (update.status === 'succeeded') {
    set.receiptNumber = update.receiptNumber;
    set.paidAmountCents = update.paidAmountCents ?? intent.amountCents;
    set.transactionDate = update.transactionDate;
  }
  try {
    const r = await PaymentIntent.findOneAndUpdate({ _id: intent._id, status: 'pending' }, { $set: set }, { new: true });
    if (r) emitToTenant(r.tenantId, 'payment.updated', presentIntent(r));
    return r;
  } catch (err: any) {
    if (err?.code === 11000) {
      // Same M-Pesa receipt already recorded on another intent: never double count.
      await PaymentIntent.updateOne({ _id: intent._id, status: 'pending' }, { $set: { status: 'failed', resultDesc: `Duplicate receipt ${update.receiptNumber}` } });
      return null;
    }
    throw err;
  }
}

const router = Router();

const stkSchema = z.object({
  clientRequestId: z.string().min(8).max(100),
  amountCents: positiveCents.refine((v) => v >= 100 && v % 100 === 0, 'M-Pesa amounts must be whole shillings'),
  phone: z.string().min(9).max(20),
  tillId: objectId.optional(),
  accountReference: z.string().trim().max(12).optional(),
});

router.post('/payments/mpesa/stk', requirePermission('sales.create'), async (req, res) => {
  const body = parse(stkSchema, req.body);
  const existing = await PaymentIntent.findOne({ clientRequestId: body.clientRequestId }).lean();
  if (existing) {
    res.json({ data: presentIntent(existing), replay: true });
    return;
  }
  const phone = normalizePhone(body.phone);
  if (!phone || !isKenyanMobile(phone)) throw badRequest('Enter a valid Safaricom number, e.g. 0712345678');
  const till = body.tillId ? await Till.findById(body.tillId).lean() : null;
  const cfg = await findActiveConfig('mpesa', till?.branchId);
  if (!cfg) throw new AppError(409, 'MPESA_NOT_CONFIGURED', 'M-Pesa is not configured for this branch');
  const tenant = req.tenant!;
  const accountReference = (body.accountReference || tenant.slug).replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'AFEYPOS';
  const [intent] = await PaymentIntent.create([{ source: 'stk', status: 'pending', clientRequestId: body.clientRequestId, amountCents: body.amountCents, phone, accountReference, shortCode: cfg.settings?.shortCode, branchId: till?.branchId, tillId: till?._id, configId: cfg._id, initiatedBy: req.auth!.userId }]);
  try {
    const resp = await gatewayFor(cfg).stkPush({ amount: body.amountCents / 100, phone, accountReference, description: 'Payment', callbackUrl: callbackUrls(tenant._id, tenant.callbackToken).stk });
    if (resp.ResponseCode !== '0') {
      await PaymentIntent.updateOne({ _id: intent._id }, { $set: { status: 'failed', resultDesc: resp.ResponseDescription, completedAt: new Date() } });
      throw unprocessable(`M-Pesa rejected the request: ${resp.ResponseDescription}`, 'MPESA_REJECTED');
    }
    intent.checkoutRequestId = resp.CheckoutRequestID;
    intent.merchantRequestId = resp.MerchantRequestID;
    await intent.save();
  } catch (err: any) {
    if (err instanceof AppError) throw err;
    await PaymentIntent.updateOne({ _id: intent._id, status: 'pending' }, { $set: { status: 'failed', resultDesc: `Could not reach M-Pesa: ${err?.message}`, completedAt: new Date() } });
    logger.warn({ err: err?.message }, 'stk push failed');
    throw new AppError(502, 'MPESA_UNAVAILABLE', 'Could not reach M-Pesa. Try again or use another payment method.');
  }
  // Safety net: if no callback arrives, query the status and expire.
  const timeout = tenant.settings?.stkPendingTimeoutSeconds ?? 180;
  await enqueue('mpesa.checkIntent', { intentId: String(intent._id) }, { runAt: new Date(Date.now() + 45_000), dedupeKey: `mpesa-check:${intent._id}:1` });
  await enqueue('mpesa.checkIntent', { intentId: String(intent._id), final: true }, { runAt: new Date(Date.now() + timeout * 1000), dedupeKey: `mpesa-check:${intent._id}:final` });
  await audit(req, { action: 'mpesa.stk_initiated', entity: 'PaymentIntent', entityId: intent._id, details: { amountCents: body.amountCents, phone: phone.replace(/\d(?=\d{3})/g, '*') } });
  res.status(201).json({ data: presentIntent(intent) });
});

router.get('/payments/intents', requirePermission('sales.create'), async (req, res) => {
  const q = parse(pagination.extend({ status: z.string().optional(), unallocated: z.enum(['true']).optional(), source: z.enum(['stk', 'c2b']).optional() }), req.query);
  const filter: Record<string, unknown> = {};
  if (q.status) filter.status = q.status;
  if (q.source) filter.source = q.source;
  if (q.unallocated) filter.$expr = { $lt: ['$allocatedCents', '$paidAmountCents'] };
  if (q.q) filter.$or = [{ receiptNumber: q.q.toUpperCase() }, { phone: { $regex: q.q.replace(/\D/g, '') } }, { accountReference: q.q }];
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
  if (i.status === 'pending') await queryAndApply(i, false);
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
  const range = q.from || q.to ? { createdAt: { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) } } : {};
  const [summary, unallocated, late] = await Promise.all([
    PaymentIntent.aggregate([{ $match: range }, { $group: { _id: '$status', count: { $sum: 1 }, amountCents: { $sum: { $ifNull: ['$paidAmountCents', '$amountCents'] } }, allocatedCents: { $sum: '$allocatedCents' } } }]),
    PaymentIntent.find({ ...range, status: 'succeeded', $expr: { $lt: ['$allocatedCents', '$paidAmountCents'] } }).sort({ createdAt: -1 }).limit(200).lean(),
    PaymentIntent.find({ ...range, status: { $in: ['cancelled', 'expired'] }, receiptNumber: { $exists: true } }).limit(200).lean(),
  ]);
  res.json({ data: { summary, unallocated: unallocated.map(presentIntent), lateConfirmations: late.map(presentIntent) } });
});

router.get('/payments/mpesa/events', requirePermission('payments.reconcile'), async (req, res) => {
  const q = parse(pagination, req.query);
  const data = await MpesaEvent.find({}).sort({ at: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean();
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

async function handleC2B(tenantId: Types.ObjectId, payload: any, ip: string) {
  return runInTenant(tenantId, async () => {
    const event = await MpesaEvent.create({ kind: 'c2b_confirmation', payload, ip });
    const transId = String(payload?.TransID ?? '').trim();
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
    try {
      const [intent] = await PaymentIntent.create([{
        source: 'c2b', status: 'succeeded', amountCents: Math.round(amount * 100), paidAmountCents: Math.round(amount * 100), receiptNumber: transId,
        phone: String(payload.MSISDN ?? ''), payerName: [payload.FirstName, payload.MiddleName, payload.LastName].filter(Boolean).join(' '),
        accountReference: payload.BillRefNumber, shortCode: String(payload.BusinessShortCode), configId: cfg._id, branchId: cfg.branchIds?.[0],
        transactionDate: parseDarajaDate(String(payload.TransTime ?? '')), completedAt: new Date(),
      }]);
      event.paymentIntentId = intent._id;
      event.outcome = 'recorded';
      emitToTenant(tenantId, 'payment.updated', presentIntent(intent));
    } catch (err: any) {
      if (err?.code !== 11000) throw err;
      event.outcome = 'duplicate';
    }
    await event.save();
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
  if (!tenant || !safeEqual(tenant.callbackToken, token)) return null;
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

mpesaCallbackRoutes.post('/:tenantId/:token/c2b/confirmation', async (req, res) => {
  const tenant = await callbackTenant(req);
  if (tenant) await handleC2B(tenant._id, req.body, req.ip ?? '');
  res.json({ ResultCode: 0, ResultDesc: 'Success' });
});
