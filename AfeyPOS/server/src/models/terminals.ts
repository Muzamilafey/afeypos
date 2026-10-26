import { Schema } from 'mongoose';
import { TERMINAL_CONNECTIONS, TERMINAL_PROVIDERS, TERMINAL_TXN_STATUSES } from '@afeypos/shared';
import { ObjectId, tenantModel } from './common.js';

const checkSchema = new Schema({ at: Date, ok: Boolean, message: String }, { _id: false });

/**
 * A bank card terminal registered by the business. Credentials and pairing keys are kept encrypted in
 * `secretsEnc` (bound to this record) and are never returned by the API.
 */
const paymentTerminalSchema = new Schema(
  {
    name: { type: String, required: true },
    provider: { type: String, enum: TERMINAL_PROVIDERS, required: true },
    /** sandbox = test payments only (simulator or the provider's sandbox); live = real card payments. */
    mode: { type: String, enum: ['sandbox', 'live'], default: 'sandbox' },
    branchId: { type: ObjectId, required: true },
    tillIds: { type: [ObjectId], default: [] },
    connection: { type: String, enum: TERMINAL_CONNECTIONS, required: true },
    /** Non-secret connection details (host and port for LAN, COM port for serial...). */
    connectionSettings: { type: Schema.Types.Mixed, default: {} },
    /** What the device says it is, recorded when it is registered and checked again on every connection. */
    device: { model: String, serialNumber: String, providerTerminalId: String, firmware: String, os: String },
    integrationVersion: String,
    status: { type: String, enum: ['draft', 'registered', 'paired', 'ready', 'enabled', 'disabled'], default: 'draft' },
    checks: { installed: checkSchema, registered: checkSchema, paired: checkSchema, connectivity: checkSchema, tills: checkSchema, test: checkSchema },
    health: {
      online: Boolean,
      ready: Boolean,
      lastCheckAt: Date,
      lastSuccessAt: Date,
      lastError: { code: String, message: String, at: Date },
    },
    secretsEnc: { type: String, select: false },
    enabledAt: Date,
    enabledBy: ObjectId,
    removedAt: Date,
    createdBy: ObjectId,
  },
  { timestamps: true },
);
paymentTerminalSchema.index({ tenantId: 1, branchId: 1, status: 1 });
paymentTerminalSchema.index({ tenantId: 1, tillIds: 1 });
export const PaymentTerminal = tenantModel('PaymentTerminal', paymentTerminalSchema, { branchScope: [{ path: 'branchId', kind: 'branch' }] });
export type PaymentTerminalDoc = InstanceType<typeof PaymentTerminal>;

/**
 * One request sent to a terminal (a sale payment, a refund, or a setup test). Only what the terminal reports
 * for receipts and reconciliation is stored: scheme, last four digits, approval code. Never card numbers,
 * CVV, PIN or track data.
 */
const terminalTransactionSchema = new Schema(
  {
    terminalId: { type: ObjectId, required: true },
    provider: { type: String, required: true },
    branchId: { type: ObjectId, required: true },
    tillId: ObjectId,
    kind: { type: String, enum: ['sale', 'refund', 'test'], required: true },
    /** Our unique reference, sent to the terminal. */
    reference: { type: String, required: true },
    clientRequestId: { type: String, required: true },
    amountCents: { type: Number, required: true },
    currency: { type: String, required: true },
    status: { type: String, enum: TERMINAL_TXN_STATUSES, default: 'created' },
    /** Test payment (simulator or provider sandbox): never real money and never shown as such. */
    sandbox: { type: Boolean, default: false },
    /** True only after the provider's authenticated status check confirmed the approval, amount and currency. */
    verified: { type: Boolean, default: false },
    verifiedAt: Date,
    providerRef: String,
    authCode: String,
    cardScheme: String,
    last4: { type: String, match: /^\d{4}$/ },
    entryMode: String,
    message: String,
    removeCard: Boolean,
    connectionLost: Boolean,
    /** Set to the terminal while the transaction is open: one open transaction per terminal (unique index). */
    lockKey: ObjectId,
    events: [{ _id: false, status: String, at: Date, source: { type: String, enum: ['start', 'query', 'notification', 'cashier', 'manager', 'system'] }, message: String }],
    /** The one sale this approved payment paid for (claimed atomically at checkout). */
    saleId: ObjectId,
    saleNumber: String,
    linkedAt: Date,
    /** Refunds: the payment being refunded. Payments: how much has been refunded. */
    originalTxnId: ObjectId,
    refundedCents: { type: Number, default: 0 },
    initiatedBy: ObjectId,
    cancelRequestedAt: Date,
    cancelRequestedBy: ObjectId,
    resolvedBy: ObjectId,
    resolution: String,
    queryAttempts: { type: Number, default: 0 },
    lastQueriedAt: Date,
    completedAt: Date,
  },
  { timestamps: true },
);
terminalTransactionSchema.index({ tenantId: 1, reference: 1 }, { unique: true });
terminalTransactionSchema.index({ tenantId: 1, clientRequestId: 1 }, { unique: true });
terminalTransactionSchema.index({ tenantId: 1, lockKey: 1 }, { unique: true, partialFilterExpression: { lockKey: { $type: 'objectId' } } });
terminalTransactionSchema.index({ tenantId: 1, saleId: 1 }, { partialFilterExpression: { saleId: { $type: 'objectId' } } });
terminalTransactionSchema.index({ tenantId: 1, terminalId: 1, createdAt: -1 });
terminalTransactionSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
terminalTransactionSchema.index({ tenantId: 1, tillId: 1, status: 1 });
export const TerminalTransaction = tenantModel('TerminalTransaction', terminalTransactionSchema, { branchScope: [{ path: 'branchId', kind: 'branch' }] });
export type TerminalTransactionDoc = InstanceType<typeof TerminalTransaction>;

/**
 * The simulated terminal's own memory (what a real terminal would hold). Used only by the simulator adapter,
 * kept apart from production payment records.
 */
const simulatedTerminalSchema = new Schema(
  {
    deviceId: { type: String, required: true },
    pairingCode: String,
    pairedKeyHash: String,
    poweredOff: { type: Boolean, default: false },
    disconnected: { type: Boolean, default: false },
    credentialsExpired: { type: Boolean, default: false },
    busy: { type: Boolean, default: false },
    payments: [{
      _id: false,
      reference: String,
      kind: String,
      amountCents: Number,
      currency: String,
      providerRef: String,
      scenario: String,
      startedAt: Date,
      queries: { type: Number, default: 0 },
      forced: String,
      cancelRequested: Boolean,
    }],
  },
  { timestamps: true },
);
simulatedTerminalSchema.index({ tenantId: 1, deviceId: 1 }, { unique: true });
export const SimulatedTerminal = tenantModel('SimulatedTerminal', simulatedTerminalSchema);
