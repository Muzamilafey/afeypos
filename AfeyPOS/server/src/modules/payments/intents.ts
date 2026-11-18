/** Helpers shared by M-Pesa (Daraja) and payment-gateway intents. */
import { PaymentIntent, type PaymentIntentDoc } from '../../models/index.js';
import { emitToTenant } from '../../realtime/socket.js';

export function presentIntent(i: PaymentIntentDoc | Record<string, any>) {
  return {
    id: i._id, provider: i.provider ?? 'mpesa', status: i.status, source: i.source, amountCents: i.amountCents, paidAmountCents: i.paidAmountCents, currency: i.currency,
    phone: i.phone, payerName: i.payerName, receiptNumber: i.receiptNumber, resultCode: i.resultCode, resultDesc: i.resultDesc, accountReference: i.accountReference,
    allocatedTo: i.allocatedTo, allocatedCents: i.allocatedCents, createdAt: i.createdAt, completedAt: i.completedAt, checkoutRequestId: i.checkoutRequestId,
    reference: i.reference, checkoutUrl: i.status === 'pending' ? i.checkoutUrl : undefined, channel: i.channel, configId: i.configId,
    awaiting: i.awaiting, shortCode: i.shortCode,
  };
}

export type FinalUpdate = {
  status: 'succeeded' | 'failed' | 'cancelled' | 'expired';
  resultCode?: number;
  resultDesc?: string;
  receiptNumber?: string;
  paidAmountCents?: number;
  phone?: string;
  payerName?: string;
  transactionDate?: Date;
};

/** Applies a final result to a pending intent exactly once. */
export async function finalizeIntent(intent: PaymentIntentDoc, update: FinalUpdate) {
  const set: Record<string, unknown> = { status: update.status, resultCode: update.resultCode, resultDesc: update.resultDesc, completedAt: new Date() };
  if (update.status === 'succeeded') {
    set.receiptNumber = update.receiptNumber;
    set.paidAmountCents = update.paidAmountCents ?? intent.amountCents;
    set.transactionDate = update.transactionDate;
    if (update.payerName) set.payerName = update.payerName;
    if (update.phone && !intent.phone) set.phone = update.phone;
  }
  try {
    const r = await PaymentIntent.findOneAndUpdate({ _id: intent._id, status: 'pending' }, { $set: set }, { new: true });
    if (r) emitToTenant(r.tenantId, 'payment.updated', presentIntent(r));
    return r;
  } catch (err: any) {
    if (err?.code === 11000) {
      // A prompt (STK) to a Till with C2B URLs is reported twice by Safaricom: the prompt's callback and a C2B
      // confirmation. When the confirmation came first it was recorded on its own; that record hands its receipt
      // to this payment, so the money counts once and the sale that sent the prompt completes.
      const taken = update.status === 'succeeded' && update.receiptNumber ? await takeOverReceipt(intent, update) : null;
      if (taken) return taken;
      // Same receipt already recorded on another intent: never double count.
      await PaymentIntent.updateOne({ _id: intent._id, status: 'pending' }, { $set: { status: 'failed', resultDesc: `Duplicate receipt ${update.receiptNumber}` } });
      return null;
    }
    throw err;
  }
}

/**
 * The customer's money reached the business after the prompt had been marked failed, expired or cancelled
 * (PIN entered late, Safaricom slow, cashier gave up). The record becomes a received, unused M-Pesa payment that
 * any sale can take (by its code, or from the received list). Never one already used, never counted twice.
 */
export async function reviveConfirmedPayment(intentId: unknown, opts: { receiptNumber?: string | null; paidAmountCents: number; how: string }) {
  const before = await PaymentIntent.findById(intentId);
  if (!before || !['failed', 'expired', 'cancelled'].includes(before.status) || (before.allocatedCents ?? 0) > 0 || !before.checkoutRequestId) return null;
  if (!(opts.paidAmountCents > 0)) return null;
  const set: Record<string, unknown> = {
    status: 'succeeded', paidAmountCents: opts.paidAmountCents, lateConfirmedAt: new Date(), completedAt: new Date(),
    resultDesc: `Money received after this payment was marked ${before.status} (${opts.how}): free to use on a sale`,
  };
  if (opts.receiptNumber) set.receiptNumber = opts.receiptNumber;
  let r;
  try {
    r = await PaymentIntent.findOneAndUpdate({ _id: before._id, status: before.status, allocatedCents: { $in: [0, null] } }, { $set: set }, { new: true });
  } catch (err: any) {
    // The receipt is already on another record (e.g. a Till confirmation): that one is the usable payment.
    if (err?.code === 11000) return null;
    throw err;
  }
  if (r) emitToTenant(r.tenantId, 'payment.updated', presentIntent(r));
  return r;
}

/** Moves a receipt from an unused, stand-alone C2B record of the same amount to this pending payment. */
async function takeOverReceipt(intent: PaymentIntentDoc, update: FinalUpdate) {
  if ((intent.provider ?? 'mpesa') !== 'mpesa') return null;
  const receipt = update.receiptNumber!;
  const paid = update.paidAmountCents ?? intent.amountCents;
  const other = await PaymentIntent.findOneAndUpdate(
    {
      receiptNumber: receipt, _id: { $ne: intent._id }, provider: 'mpesa', source: 'c2b', awaiting: { $exists: false }, status: 'succeeded',
      allocatedCents: 0, allocatedTo: { $exists: false }, onlineOrderId: { $exists: false }, paidAmountCents: paid,
    },
    { $set: { status: 'cancelled', resultDesc: `Receipt ${receipt} belongs to the prompt payment ${intent._id}` }, $unset: { receiptNumber: 1 } },
    { new: false },
  );
  if (!other) return null;
  const r = await PaymentIntent.findOneAndUpdate(
    { _id: intent._id, status: 'pending' },
    { $set: {
      status: 'succeeded', resultCode: update.resultCode, resultDesc: update.resultDesc, completedAt: new Date(), receiptNumber: receipt, paidAmountCents: paid,
      transactionDate: update.transactionDate ?? other.transactionDate, payerName: update.payerName || other.payerName || undefined, ...(!intent.phone && other.phone ? { phone: other.phone } : {}),
    } },
    { new: true },
  ).catch(() => null);
  if (!r) {
    // This payment was no longer pending: give the receipt back so the money is still there to use.
    await PaymentIntent.updateOne({ _id: other._id }, { $set: { status: 'succeeded', receiptNumber: receipt, resultDesc: other.resultDesc } });
    return null;
  }
  emitToTenant(r.tenantId, 'payment.updated', presentIntent(r));
  const cancelled = await PaymentIntent.findById(other._id).lean();
  if (cancelled) emitToTenant(cancelled.tenantId, 'payment.updated', presentIntent(cancelled));
  return r;
}
