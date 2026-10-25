/**
 * M-Pesa B2C payouts (salaries, refunds). Optional: needs a B2C short code and an initiator.
 *
 * Controls: a payout is requested by one person and approved by a different person with payouts.approve;
 * only approved payouts are sent; a payout is "succeeded" only when Safaricom's result callback says so.
 */
import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { IntegrationConfig, MpesaEvent, Payout } from '../../models/index.js';
import { idParam, objectId, pagination, parse, positiveCents } from '../../http/validate.js';
import { requirePermission } from '../../http/auth.js';
import { AppError, badRequest, forbidden, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { runInTenant } from '../../lib/context.js';
import { normalizePhone } from '../../lib/phone.js';
import { emitToTenant } from '../../realtime/socket.js';
import { parseAsyncResult, splitParty } from '../../integrations/mpesa/daraja.js';
import { findActiveConfig } from '../integrations/configs.js';
import { callbackUrls, gatewayFor } from './mpesa.js';
import { onPayoutSucceeded } from '../hr/events.js';

const router = Router();

const payoutInput = z.object({
  purpose: z.enum(['salary', 'refund', 'other']),
  amountCents: positiveCents.refine((v) => v >= 1000 && v % 100 === 0, 'Payouts are whole shillings of at least 10'),
  phone: z.string().min(9).max(20),
  payeeName: z.string().trim().max(120).optional(),
  employeeId: objectId.optional(),
  ref: z.object({ type: z.string().max(40), id: objectId.optional(), number: z.string().max(40).optional() }).optional(),
  batchId: z.string().max(60).optional(),
});

/** Creates draft payouts (also used by payroll). */
export async function createPayouts(rows: z.infer<typeof payoutInput>[], requestedBy: Types.ObjectId) {
  const docs = rows.map((r) => {
    const phone = normalizePhone(r.phone);
    if (!phone) throw badRequest(`Invalid phone number ${r.phone}`);
    return { ...r, phone, status: 'draft', requestedBy };
  });
  return Payout.create(docs);
}

router.get('/payments/payouts', requirePermission('payouts.request'), async (req, res) => {
  const q = parse(pagination.extend({ status: z.string().optional(), batchId: z.string().optional() }), req.query);
  const filter: Record<string, unknown> = {};
  if (q.status) filter.status = q.status;
  if (q.batchId) filter.batchId = q.batchId;
  const [data, total] = await Promise.all([Payout.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), Payout.countDocuments(filter)]);
  res.json({ data, total, page: q.page, limit: q.limit });
});

router.post('/payments/payouts', requirePermission('payouts.request'), async (req, res) => {
  const body = parse(z.object({ payouts: z.array(payoutInput).min(1).max(500) }), req.body);
  const created = await createPayouts(body.payouts, req.auth!.userId);
  await audit(req, { action: 'payout.requested', details: { count: created.length, totalCents: created.reduce((a, p) => a + p.amountCents, 0) } });
  res.status(201).json({ data: created });
});

/** A second person approves; the requester cannot approve their own payouts. */
router.post('/payments/payouts/approve', requirePermission('payouts.approve'), async (req, res) => {
  const body = parse(z.object({ ids: z.array(objectId).min(1).max(500) }), req.body);
  const rows = await Payout.find({ _id: { $in: body.ids }, status: 'draft' });
  if (rows.some((p) => String(p.requestedBy) === String(req.auth!.userId))) throw forbidden('Payouts must be approved by someone other than the person who requested them');
  const r = await Payout.updateMany({ _id: { $in: rows.map((p) => p._id) }, status: 'draft' }, { $set: { status: 'approved', approvedBy: req.auth!.userId, approvedAt: new Date() } });
  await audit(req, { action: 'payout.approved', details: { count: r.modifiedCount, totalCents: rows.reduce((a, p) => a + p.amountCents, 0) } });
  res.json({ data: { approved: r.modifiedCount } });
});

router.post('/payments/payouts/cancel', requirePermission('payouts.request'), async (req, res) => {
  const body = parse(z.object({ ids: z.array(objectId).min(1).max(500) }), req.body);
  const r = await Payout.updateMany({ _id: { $in: body.ids }, status: { $in: ['draft', 'approved'] } }, { $set: { status: 'cancelled' } });
  await audit(req, { action: 'payout.cancelled', details: { count: r.modifiedCount } });
  res.json({ data: { cancelled: r.modifiedCount } });
});

/** Sends approved payouts through M-Pesa B2C. Each is claimed atomically so it is never sent twice. */
router.post('/payments/payouts/send', requirePermission('payouts.approve'), async (req, res) => {
  const body = parse(z.object({ ids: z.array(objectId).min(1).max(500) }), req.body);
  const cfg = await findActiveConfig('mpesa');
  if (!cfg) throw new AppError(409, 'MPESA_NOT_CONFIGURED', 'M-Pesa is not configured');
  if (env().NODE_ENV === 'production' && cfg.provider === 'mock') throw forbidden('The simulator cannot send money');
  const gw = gatewayFor(cfg);
  const urls = callbackUrls(req.tenant!._id, req.tenant!.callbackToken);
  const results: { id: string; status: string; message?: string }[] = [];
  for (const id of body.ids) {
    const originatorConversationId = `AFYB2C-${new Types.ObjectId().toHexString()}`;
    const p = await Payout.findOneAndUpdate({ _id: id, status: 'approved' }, { $set: { status: 'sent', sentAt: new Date(), originatorConversationId, configId: cfg._id } }, { new: true });
    if (!p) {
      results.push({ id: String(id), status: 'skipped', message: 'Not approved or already sent' });
      continue;
    }
    try {
      const r = await gw.b2c({
        originatorConversationId, amount: p.amountCents / 100, phone: p.phone, commandId: p.purpose === 'salary' ? 'SalaryPayment' : 'BusinessPayment',
        remarks: p.purpose === 'salary' ? `Salary ${p.ref?.number ?? ''}`.trim() : `Payment ${p.ref?.number ?? ''}`.trim(), occasion: p.ref?.number ?? undefined, resultUrl: urls.b2cResult, timeoutUrl: urls.timeout,
      });
      if (r.ResponseCode !== '0') throw new Error(r.ResponseDescription ?? r.errorMessage ?? 'rejected');
      await Payout.updateOne({ _id: p._id }, { $set: { conversationId: r.ConversationID } });
      results.push({ id: String(id), status: 'sent' });
    } catch (err: any) {
      await Payout.updateOne({ _id: p._id, status: 'sent' }, { $set: { status: 'failed', resultDesc: `Not sent: ${err?.message}`, completedAt: new Date() } });
      results.push({ id: String(id), status: 'failed', message: err?.message });
    }
  }
  await audit(req, { action: 'payout.sent', details: { results } });
  res.json({ data: results });
});

/** Development only: Safaricom's B2C result for a simulator payout. */
router.post('/payments/payouts/:id/simulate', requirePermission('payouts.approve'), async (req, res) => {
  if (env().NODE_ENV === 'production') throw forbidden('Simulation is disabled in production');
  const body = parse(z.object({ success: z.boolean().default(true) }), req.body ?? {});
  const p = await Payout.findById(idParam(req.params.id));
  if (!p?.originatorConversationId) throw notFound('Sent payout');
  const cfg = await IntegrationConfig.findById(p.configId).lean();
  if (cfg?.provider !== 'mock') throw forbidden('Only simulator payouts can be simulated');
  await handleB2CResult(req.tenant!._id, {
    Result: {
      ResultType: 0, ResultCode: body.success ? 0 : 2001, ResultDesc: body.success ? 'The service request is processed successfully.' : 'The initiator information is invalid.',
      OriginatorConversationID: p.originatorConversationId, ConversationID: p.conversationId, TransactionID: `SIMB2C${Date.now().toString(36).toUpperCase()}`.slice(0, 10),
      ResultParameters: { ResultParameter: [{ Key: 'TransactionAmount', Value: p.amountCents / 100 }, { Key: 'TransactionReceipt', Value: `SIMB2C${Date.now().toString(36).toUpperCase()}`.slice(0, 10) }, { Key: 'ReceiverPartyPublicName', Value: `${p.phone} - ${p.payeeName ?? 'EMPLOYEE'}` }] },
    },
  }, 'simulator');
  res.json({ data: await Payout.findById(p._id).lean() });
});

export async function handleB2CResult(tenantId: Types.ObjectId, payload: any, ip: string) {
  return runInTenant(tenantId, async () => {
    const parsed = parseAsyncResult(payload);
    const event = await MpesaEvent.create({ kind: 'b2c_result', payload, ip });
    const p = parsed?.originatorConversationId ? await Payout.findOne({ originatorConversationId: parsed.originatorConversationId }) : null;
    if (!parsed || !p) {
      event.outcome = parsed ? 'unknown_payout' : 'malformed';
      await event.save();
      return;
    }
    if (p.status !== 'sent') {
      event.outcome = 'duplicate';
      await event.save();
      return;
    }
    const ok = parsed.resultCode === 0;
    const receiver = splitParty(parsed.params.get('ReceiverPartyPublicName'));
    const amount = Math.round(Number(parsed.params.get('TransactionAmount') ?? 0) * 100);
    const mismatch = ok && amount && amount !== p.amountCents;
    p.status = ok ? 'succeeded' : 'failed';
    p.resultCode = parsed.resultCode;
    p.resultDesc = mismatch ? `Paid ${amount / 100} instead of ${p.amountCents / 100}: check with Safaricom` : parsed.resultDesc;
    p.receiptNumber = ok ? String(parsed.params.get('TransactionReceipt') ?? parsed.transactionId ?? '') : undefined;
    p.receiverName = receiver.name;
    p.completedAt = new Date();
    await p.save();
    event.outcome = p.status;
    await event.save();
    if (ok) await onPayoutSucceeded(p);
    emitToTenant(tenantId, 'payout.updated', { id: p._id, status: p.status });
  });
}

export const payoutRoutes = router;
