/**
 * Three read-only ledgers for the Finance menu:
 *  - M-Pesa logs: every message to and from Safaricom (C2B confirmations, STK results, status checks, payouts...).
 *  - M-Pesa payments: every successful M-Pesa payment, used on a sale or not.
 *  - Cash: every cash payment on a sale, and every cash refund.
 * Phone numbers are shown partly hidden.
 */
import { Router } from 'express';
import { z } from 'zod';
import { MpesaEvent, PaymentIntent, Sale, SaleReturn, Shift, User } from '../../models/index.js';
import { escapeRegex, objectId, parse } from '../../http/validate.js';
import { requireAnyPermission } from '../../http/auth.js';

export const ledgerRoutes = Router();
const READ = requireAnyPermission('payments.reconcile', 'reports.financial');

/** 254712345678 -> 0712***678 */
export const maskPhone = (p?: unknown) => {
  const s = String(p ?? '').replace(/\D/g, '');
  if (s.length < 9) return s ? `${s.slice(0, 2)}***` : '';
  const local = s.startsWith('254') ? `0${s.slice(3)}` : s;
  return `${local.slice(0, 4)}***${local.slice(-3)}`;
};

const range = (from?: Date, to?: Date) => (from || to ? { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } : undefined);
const dates = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() });
/** "to" as a date means the whole day. */
const endOfDay = (d?: Date) => (d && d.getUTCHours() === 0 && d.getUTCMinutes() === 0 ? new Date(d.getTime() + 86_399_999) : d);

/** What a Safaricom message says, in a few fields, whatever its kind. */
function summarise(e: any) {
  const p = e.payload ?? {};
  const out: Record<string, unknown> = {};
  if (e.kind === 'c2b_confirmation' || e.kind === 'c2b_validation') {
    Object.assign(out, { receipt: p.TransID, amountCents: p.TransAmount !== undefined ? Math.round(Number(p.TransAmount) * 100) : undefined, phone: maskPhone(p.MSISDN), shortCode: p.BusinessShortCode, account: p.BillRefNumber || undefined, payer: [p.FirstName, p.MiddleName, p.LastName].filter(Boolean).join(' ') || undefined, type: p.TransactionType });
  } else if (e.kind === 'stk_callback') {
    const cb = p.Body?.stkCallback ?? {};
    const item = (n: string) => (cb.CallbackMetadata?.Item ?? []).find((i: any) => i.Name === n)?.Value;
    Object.assign(out, { resultCode: cb.ResultCode, resultDesc: cb.ResultDesc, receipt: item('MpesaReceiptNumber'), amountCents: item('Amount') !== undefined ? Math.round(Number(item('Amount')) * 100) : undefined, phone: maskPhone(item('PhoneNumber')) });
  } else if (e.kind === 'txn_status' || e.kind === 'b2c_result' || e.kind === 'async_timeout') {
    const r = p.Result ?? p;
    Object.assign(out, { resultCode: r.ResultCode, resultDesc: r.ResultDesc ?? r.errorMessage, receipt: r.TransactionID });
  } else if (e.kind === 'stk_request' || e.kind === 'stk_query') {
    Object.assign(out, { resultCode: p.body?.errorCode ?? p.ResultCode ?? p.status, resultDesc: p.body?.errorMessage ?? p.ResultDesc ?? p.message });
  } else {
    Object.assign(out, { resultDesc: p.status ?? p.message });
  }
  return out;
}

/** Hides phone numbers inside the raw message as well. */
function maskDeep(v: any, depth = 0): any {
  if (depth > 6) return v;
  if (Array.isArray(v)) return v.map((x) => maskDeep(x, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = /msisdn|phone|partya|debitparty/i.test(k) && (typeof x === 'string' || typeof x === 'number') ? maskPhone(x) : maskDeep(x, depth + 1);
    // STK metadata items: { Name: 'PhoneNumber', Value: 2547... }
    if (out.Name === 'PhoneNumber' && out.Value !== undefined) out.Value = maskPhone(out.Value);
    return out;
  }
  return v;
}

ledgerRoutes.get('/payments/mpesa/logs', READ, async (req, res) => {
  const q = parse(dates.extend({
    kind: z.string().max(40).optional(), outcome: z.string().max(40).optional(), q: z.string().trim().max(60).optional(),
    page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(200).default(50),
  }), req.query);
  const filter: Record<string, unknown> = {};
  if (q.kind) filter.kind = q.kind;
  if (q.outcome) filter.outcome = q.outcome;
  const at = range(q.from, endOfDay(q.to));
  if (at) filter.at = at;
  if (q.q) {
    const rx = new RegExp(escapeRegex(q.q), 'i');
    filter.$or = [{ 'payload.TransID': rx }, { 'payload.BillRefNumber': rx }, { 'payload.Body.stkCallback.CheckoutRequestID': rx }, { 'payload.Result.TransactionID': rx }];
  }
  const [rows, total, kinds] = await Promise.all([
    MpesaEvent.find(filter).sort({ at: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    MpesaEvent.countDocuments(filter),
    MpesaEvent.aggregate([{ $group: { _id: '$kind', n: { $sum: 1 } } }]),
  ]);
  res.json({
    data: rows.map((e: any) => ({ id: e._id, at: e.at, kind: e.kind, provider: e.provider, outcome: e.outcome, error: e.error, ip: e.ip, paymentIntentId: e.paymentIntentId, ...summarise(e), payload: maskDeep(e.payload) })),
    total, page: q.page, limit: q.limit, kinds: Object.fromEntries(kinds.map((k) => [k._id, k.n])),
  });
});

ledgerRoutes.get('/payments/mpesa/received', READ, async (req, res) => {
  const q = parse(dates.extend({
    q: z.string().trim().max(60).optional(), used: z.enum(['used', 'unused']).optional(), source: z.enum(['stk', 'c2b']).optional(), branchId: objectId.optional(),
    page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(200).default(50),
  }), req.query);
  const filter: Record<string, unknown> = { provider: 'mpesa', status: 'succeeded', receiptNumber: { $type: 'string' } };
  const when = range(q.from, endOfDay(q.to));
  if (when) filter.completedAt = when;
  if (q.source) filter.source = q.source;
  if (q.branchId) filter.branchId = q.branchId;
  if (q.used === 'used') filter.allocatedCents = { $gt: 0 };
  if (q.used === 'unused') filter.$expr = { $lt: ['$allocatedCents', '$paidAmountCents'] };
  if (q.q) {
    const rx = new RegExp(escapeRegex(q.q), 'i');
    const digits = q.q.replace(/\D/g, '');
    filter.$or = [{ receiptNumber: rx }, { payerName: rx }, { accountReference: rx }, { 'allocatedTo.number': rx }, ...(digits.length >= 3 ? [{ phone: { $regex: digits } }] : [])];
  }
  const [rows, total, sums] = await Promise.all([
    PaymentIntent.find(filter).sort({ completedAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    PaymentIntent.countDocuments(filter),
    PaymentIntent.aggregate([{ $match: filter }, { $group: { _id: null, n: { $sum: 1 }, paid: { $sum: '$paidAmountCents' }, used: { $sum: '$allocatedCents' } } }]),
  ]);
  const s = sums[0] ?? { n: 0, paid: 0, used: 0 };
  res.json({
    data: rows.map((i: any) => ({
      id: i._id, completedAt: i.completedAt ?? i.updatedAt, source: i.source, receiptNumber: i.receiptNumber, payerName: i.payerName, phone: maskPhone(i.phone),
      amountCents: i.paidAmountCents ?? i.amountCents, usedCents: i.allocatedCents ?? 0, usedFor: i.allocatedTo?.number, account: i.accountReference, shortCode: i.shortCode, branchId: i.branchId, tillId: i.tillId,
    })),
    total, page: q.page, limit: q.limit, summary: { count: s.n, totalCents: s.paid, usedCents: s.used, unusedCents: s.paid - s.used },
  });
});

ledgerRoutes.get('/payments/cash', READ, async (req, res) => {
  const q = parse(dates.extend({ tillId: objectId.optional(), branchId: objectId.optional(), q: z.string().trim().max(60).optional(), limit: z.coerce.number().int().min(1).max(1000).default(300) }), req.query);
  const when = range(q.from, endOfDay(q.to));
  const saleMatch: Record<string, unknown> = { 'payments.method': 'cash', status: { $ne: 'voided' }, ...(when ? { completedAt: when } : {}), ...(q.tillId ? { tillId: q.tillId } : {}), ...(q.branchId ? { branchId: q.branchId } : {}) };
  // Returns record their shift, not the till: the till is found through the shift.
  const tillShifts = q.tillId ? (await Shift.find({ tillId: q.tillId }, { _id: 1 }).lean()).map((x) => x._id) : null;
  const retMatch: Record<string, unknown> = { refundMethod: 'cash', ...(when ? { createdAt: when } : {}), ...(tillShifts ? { shiftId: { $in: tillShifts } } : {}), ...(q.branchId ? { branchId: q.branchId } : {}) };
  if (q.q) {
    const rx = new RegExp(escapeRegex(q.q), 'i');
    saleMatch.number = rx;
    retMatch.number = rx;
  }
  const [sales, refunds, saleSum, refundSum] = await Promise.all([
    Sale.find(saleMatch, { number: 1, completedAt: 1, tillId: 1, branchId: 1, cashierId: 1, payments: 1, changeCents: 1, totalCents: 1 }).sort({ completedAt: -1 }).limit(q.limit).lean(),
    SaleReturn.find(retMatch, { number: 1, createdAt: 1, shiftId: 1, branchId: 1, processedBy: 1, refundCents: 1, saleId: 1 }).sort({ createdAt: -1 }).limit(q.limit).lean(),
    Sale.aggregate([{ $match: saleMatch }, { $unwind: '$payments' }, { $match: { 'payments.method': 'cash' } }, { $group: { _id: null, n: { $addToSet: '$_id' }, cash: { $sum: '$payments.amountCents' } } }, { $project: { n: { $size: '$n' }, cash: 1 } }]),
    SaleReturn.aggregate([{ $match: retMatch }, { $group: { _id: null, n: { $sum: 1 }, cash: { $sum: '$refundCents' } } }]),
  ]);
  const shiftTill = new Map((await Shift.find({ _id: { $in: refunds.map((r: any) => r.shiftId).filter(Boolean) } }, { tillId: 1 }).lean()).map((x) => [String(x._id), x.tillId]));
  const people = new Map((await User.find({ _id: { $in: [...sales.map((s: any) => s.cashierId), ...refunds.map((r: any) => r.processedBy)].filter(Boolean) } }, { name: 1 }).lean()).map((u) => [String(u._id), u.name]));
  const rows = [
    ...sales.map((s: any) => {
      const cash = s.payments.filter((p: any) => p.method === 'cash');
      return {
        id: s._id, kind: 'sale' as const, at: s.completedAt, number: s.number, tillId: s.tillId, branchId: s.branchId, by: people.get(String(s.cashierId)) ?? '',
        amountCents: cash.reduce((a: number, p: any) => a + p.amountCents, 0), tenderedCents: cash.reduce((a: number, p: any) => a + (p.tenderedCents ?? p.amountCents), 0), changeCents: s.changeCents ?? 0,
        otherCents: s.payments.filter((p: any) => p.method !== 'cash').reduce((a: number, p: any) => a + p.amountCents, 0),
      };
    }),
    ...refunds.map((r: any) => ({ id: r._id, kind: 'refund' as const, at: r.createdAt, number: r.number, tillId: shiftTill.get(String(r.shiftId)), branchId: r.branchId, by: people.get(String(r.processedBy)) ?? '', amountCents: -(r.refundCents ?? 0), tenderedCents: 0, changeCents: 0, otherCents: 0 })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, q.limit);
  const inCents = saleSum[0]?.cash ?? 0;
  const outCents = refundSum[0]?.cash ?? 0;
  res.json({ data: rows, summary: { sales: saleSum[0]?.n ?? 0, refunds: refundSum[0]?.n ?? 0, cashInCents: inCents, refundsCents: outCents, netCents: inCents - outCents } });
});
