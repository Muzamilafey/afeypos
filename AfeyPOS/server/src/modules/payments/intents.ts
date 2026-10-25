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
      // Same receipt already recorded on another intent: never double count.
      await PaymentIntent.updateOne({ _id: intent._id, status: 'pending' }, { $set: { status: 'failed', resultDesc: `Duplicate receipt ${update.receiptNumber}` } });
      return null;
    }
    throw err;
  }
}
