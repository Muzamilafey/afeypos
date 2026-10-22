import { Schema } from 'mongoose';
import { ObjectId, tenantModel } from './common.js';

export const INTENT_STATUSES = ['pending', 'succeeded', 'failed', 'cancelled', 'expired'] as const;

const paymentIntentSchema = new Schema(
  {
    provider: { type: String, enum: ['mpesa'], default: 'mpesa' },
    source: { type: String, enum: ['stk', 'c2b'], required: true },
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
paymentIntentSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
export const PaymentIntent = tenantModel('PaymentIntent', paymentIntentSchema);
export type PaymentIntentDoc = InstanceType<typeof PaymentIntent>;

const mpesaEventSchema = new Schema(
  {
    kind: { type: String, enum: ['stk_callback', 'c2b_validation', 'c2b_confirmation', 'stk_query'], required: true },
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

const integrationConfigSchema = new Schema(
  {
    kind: { type: String, enum: ['mpesa', 'sms', 'email'], required: true },
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
