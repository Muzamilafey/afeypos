import { Schema } from 'mongoose';
import { ObjectId, tenantModel } from './common.js';

/** Notes, calls, visits, complaints and follow-up tasks against a customer. */
const activitySchema = new Schema(
  {
    customerId: { type: ObjectId, required: true },
    type: { type: String, enum: ['note', 'call', 'visit', 'sms', 'email', 'whatsapp', 'complaint', 'task'], required: true },
    subject: { type: String, required: true },
    body: String,
    /** Follow-up date; open until done. */
    dueAt: Date,
    done: { type: Boolean, default: false },
    doneAt: Date,
    assignedTo: ObjectId,
    createdBy: ObjectId,
  },
  { timestamps: true },
);
activitySchema.index({ tenantId: 1, customerId: 1, createdAt: -1 });
activitySchema.index({ tenantId: 1, done: 1, dueAt: 1 });
export const CustomerActivity = tenantModel('CustomerActivity', activitySchema);

/** SMS or email sent to a segment of customers who agreed to marketing messages. */
const campaignSchema = new Schema(
  {
    number: { type: String, required: true },
    name: { type: String, required: true },
    channel: { type: String, enum: ['sms', 'email'], required: true },
    subject: String,
    message: { type: String, required: true },
    segment: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ['draft', 'sent', 'cancelled'], default: 'draft' },
    recipients: { type: Number, default: 0 },
    queued: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 },
    createdBy: ObjectId,
    sentBy: ObjectId,
    sentAt: Date,
  },
  { timestamps: true },
);
campaignSchema.index({ tenantId: 1, number: 1 }, { unique: true });
export const Campaign = tenantModel('Campaign', campaignSchema);

/**
 * Gift / store voucher with a value. Sold to customers, given as a promotion or as compensation; spent
 * at checkout (payment method "voucher") until its balance runs out. The balance only changes atomically.
 */
const voucherSchema = new Schema(
  {
    code: { type: String, required: true, uppercase: true, trim: true },
    initialCents: { type: Number, required: true },
    balanceCents: { type: Number, required: true },
    status: { type: String, enum: ['active', 'used', 'cancelled'], default: 'active' },
    expiresAt: Date,
    /** sold: paid for by the customer. promo: given away. compensation: goodwill for a complaint. */
    source: { type: String, enum: ['sold', 'promo', 'compensation'], default: 'sold' },
    customerId: ObjectId,
    /** For sold vouchers: how the customer paid for it. */
    payment: { method: String, reference: String, tillId: ObjectId, shiftId: ObjectId },
    batch: String,
    note: String,
    issuedBy: ObjectId,
    redemptions: { type: [{ saleId: ObjectId, saleNumber: String, amountCents: Number, at: Date, _id: false }], default: [] },
    cancelledAt: Date,
    cancelledBy: ObjectId,
    cancelReason: String,
  },
  { timestamps: true },
);
voucherSchema.index({ tenantId: 1, code: 1 }, { unique: true });
voucherSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
export const Voucher = tenantModel('Voucher', voucherSchema);

/** Every change to a customer's loyalty points: earned, spent, bonuses, manual adjustments and reversals. */
const loyaltyTxSchema = new Schema(
  {
    customerId: { type: ObjectId, required: true },
    points: { type: Number, required: true },
    kind: { type: String, enum: ['earn', 'redeem', 'bonus', 'adjust', 'reverse'], required: true },
    saleId: ObjectId,
    saleNumber: String,
    branchId: ObjectId,
    note: String,
    userId: ObjectId,
    at: { type: Date, default: () => new Date() },
  },
  { timestamps: false },
);
loyaltyTxSchema.index({ tenantId: 1, customerId: 1, at: -1 });
export const LoyaltyTransaction = tenantModel('LoyaltyTransaction', loyaltyTxSchema);
