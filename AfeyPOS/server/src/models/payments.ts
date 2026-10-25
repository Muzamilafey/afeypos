import { Schema } from 'mongoose';
import { PAYMENT_PROVIDERS } from '@afeypos/shared';
import { ObjectId, tenantModel } from './common.js';

export const INTENT_STATUSES = ['pending', 'succeeded', 'failed', 'cancelled', 'expired'] as const;

const paymentIntentSchema = new Schema(
  {
    provider: { type: String, enum: ['mpesa', ...PAYMENT_PROVIDERS], default: 'mpesa' },
    /** stk / c2b: Safaricom Daraja. push / link: payment gateways (prompt on phone / hosted checkout). */
    source: { type: String, enum: ['stk', 'c2b', 'push', 'link'], required: true },
    status: { type: String, enum: INTENT_STATUSES, default: 'pending' },
    clientRequestId: String,
    amountCents: { type: Number, required: true },
    paidAmountCents: Number,
    phone: String,
    payerName: String,
    accountReference: String,
    shortCode: String,
    branchId: ObjectId,
    tillId: ObjectId,
    configId: ObjectId,
    checkoutRequestId: String,
    /**
     * M-Pesa payments made to the Paybill/Till rather than by prompt:
     *  expected = the till is waiting for a payment with this account number (Paybill) or amount (Buy Goods);
     *  verify   = the cashier entered a receipt code and we asked Safaricom (Transaction Status API).
     */
    awaiting: { type: String, enum: ['expected', 'verify'] },
    originatorConversationId: String,
    conversationId: String,
    /** Gateway intents: our reference sent to the provider, the provider's own id, and the hosted checkout URL. */
    reference: String,
    providerRef: String,
    checkoutUrl: String,
    currency: String,
    channel: String,
    merchantRequestId: String,
    receiptNumber: String,
    resultCode: Number,
    resultDesc: String,
    transactionDate: Date,
    initiatedBy: ObjectId,
    allocatedTo: { kind: { type: String, enum: ['sale', 'customer_payment'] }, id: ObjectId, number: String },
    allocatedCents: { type: Number, default: 0 },
    allocatedAt: Date,
    lastQueriedAt: Date,
    completedAt: Date,
  },
  { timestamps: true },
);
paymentIntentSchema.index({ tenantId: 1, checkoutRequestId: 1 }, { unique: true, partialFilterExpression: { checkoutRequestId: { $type: 'string' } } });
paymentIntentSchema.index({ tenantId: 1, receiptNumber: 1 }, { unique: true, partialFilterExpression: { receiptNumber: { $type: 'string' } } });
paymentIntentSchema.index({ tenantId: 1, clientRequestId: 1 }, { unique: true, partialFilterExpression: { clientRequestId: { $type: 'string' } } });
paymentIntentSchema.index({ tenantId: 1, reference: 1 }, { unique: true, partialFilterExpression: { reference: { $type: 'string' } } });
paymentIntentSchema.index({ tenantId: 1, configId: 1, providerRef: 1 }, { partialFilterExpression: { providerRef: { $type: 'string' } } });
paymentIntentSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
paymentIntentSchema.index({ tenantId: 1, awaiting: 1, status: 1, accountReference: 1 }, { partialFilterExpression: { awaiting: { $type: 'string' } } });
paymentIntentSchema.index({ tenantId: 1, originatorConversationId: 1 }, { partialFilterExpression: { originatorConversationId: { $type: 'string' } } });
export const PaymentIntent = tenantModel('PaymentIntent', paymentIntentSchema);
export type PaymentIntentDoc = InstanceType<typeof PaymentIntent>;

const mpesaEventSchema = new Schema(
  {
    kind: { type: String, enum: ['stk_callback', 'c2b_validation', 'c2b_confirmation', 'stk_query', 'gateway_webhook', 'gateway_verify', 'txn_status', 'b2c_result', 'async_timeout'], required: true },
    provider: String,
    configId: ObjectId,
    payload: Schema.Types.Mixed,
    ip: String,
    outcome: String,
    error: String,
    paymentIntentId: ObjectId,
    at: { type: Date, default: () => new Date() },
  },
  { timestamps: false },
);
mpesaEventSchema.index({ tenantId: 1, at: -1 });
export const MpesaEvent = tenantModel('MpesaEvent', mpesaEventSchema);

/**
 * Money sent out by M-Pesa B2C (salaries, refunds). Created as a draft, approved by a second person,
 * then sent; it is "paid" only when Safaricom's result callback confirms it.
 */
const payoutSchema = new Schema(
  {
    purpose: { type: String, enum: ['salary', 'refund', 'other'], required: true },
    status: { type: String, enum: ['draft', 'approved', 'sent', 'succeeded', 'failed', 'cancelled'], default: 'draft' },
    amountCents: { type: Number, required: true },
    phone: { type: String, required: true },
    payeeName: String,
    /** e.g. { type: 'PayrollRun', id, number } or the sale return. */
    ref: { type: { type: String }, id: ObjectId, number: String },
    employeeId: ObjectId,
    configId: ObjectId,
    batchId: String,
    originatorConversationId: String,
    conversationId: String,
    receiptNumber: String,
    receiverName: String,
    resultCode: Number,
    resultDesc: String,
    requestedBy: ObjectId,
    approvedBy: ObjectId,
    approvedAt: Date,
    sentAt: Date,
    completedAt: Date,
  },
  { timestamps: true },
);
payoutSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
payoutSchema.index({ tenantId: 1, originatorConversationId: 1 }, { unique: true, partialFilterExpression: { originatorConversationId: { $type: 'string' } } });
export const Payout = tenantModel('Payout', payoutSchema);

const integrationConfigSchema = new Schema(
  {
    kind: { type: String, enum: ['mpesa', 'payment', 'sms', 'email'], required: true },
    provider: { type: String, required: true },
    name: { type: String, required: true },
    enabled: { type: Boolean, default: true },
    isDefault: { type: Boolean, default: false },
    environment: { type: String, enum: ['sandbox', 'production'], default: 'sandbox' },
    branchIds: { type: [ObjectId], default: [] },
    /** Non-secret settings (shortcode, sender id, smtp host...). */
    settings: { type: Schema.Types.Mixed, default: {} },
    /** AES-256-GCM encrypted JSON of secrets. Never returned by the API. */
    secretsEnc: String,
    lastTest: { at: Date, ok: Boolean, message: String },
  },
  { timestamps: true },
);
integrationConfigSchema.index({ tenantId: 1, kind: 1 });
export const IntegrationConfig = tenantModel('IntegrationConfig', integrationConfigSchema);
export type IntegrationConfigDoc = InstanceType<typeof IntegrationConfig>;
