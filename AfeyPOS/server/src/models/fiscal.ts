import { Schema } from 'mongoose';
import { ObjectId, tenantModel } from './common.js';

/**
 * One fiscal operation with a device or KRA: an invoice or credit note sent, a status query, a manual
 * reconciliation, a connection test. Request and response are stored without keys (see sanitizeForLog).
 */
const fiscalTransactionSchema = new Schema(
  {
    configId: { type: ObjectId, required: true },
    deviceName: String,
    /** oscu, vscu, etr_http, etr_folder, etr_simulator, mock */
    deviceKind: String,
    branchId: ObjectId,
    /** Which server did it: "main" or the branch server's code. */
    origin: String,
    operation: { type: String, enum: ['invoice', 'credit_note', 'status_query', 'reconcile', 'test', 'health'], required: true },
    docKind: { type: String, enum: ['sale', 'return'] },
    docId: ObjectId,
    docNumber: String,
    invcNo: Number,
    attempt: Number,
    /** The document's fiscal status after this operation. */
    outcome: String,
    ok: { type: Boolean, default: false },
    error: String,
    request: Schema.Types.Mixed,
    response: Schema.Types.Mixed,
    durationMs: Number,
    userId: ObjectId,
    note: String,
    at: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);
fiscalTransactionSchema.index({ tenantId: 1, at: -1 });
fiscalTransactionSchema.index({ tenantId: 1, configId: 1, at: -1 });
fiscalTransactionSchema.index({ tenantId: 1, docId: 1, at: -1 });
fiscalTransactionSchema.index({ tenantId: 1, updatedAt: 1 });
export const FiscalTransaction = tenantModel('FiscalTransaction', fiscalTransactionSchema);

/**
 * The live state of a fiscal device as one server sees it: health, and the lease that lets only one worker talk
 * to the device at a time (one central device shared by many tills).
 */
const fiscalDeviceStateSchema = new Schema(
  {
    configId: { type: ObjectId, required: true },
    origin: { type: String, required: true },
    branchId: ObjectId,
    state: { type: String, enum: ['online', 'offline', 'unknown'], default: 'unknown' },
    message: String,
    lastCheckAt: Date,
    lastSuccessAt: Date,
    lastFailureAt: Date,
    lastError: String,
    consecutiveFailures: { type: Number, default: 0 },
    /** When it last went offline (cleared when it is back); downtime periods are kept below. */
    downSince: Date,
    outages: { type: [{ from: Date, to: Date, _id: false }], default: [] },
    lockUntil: Date,
    lockHolder: String,
  },
  { timestamps: true },
);
fiscalDeviceStateSchema.index({ tenantId: 1, configId: 1, origin: 1 }, { unique: true });
export const FiscalDeviceState = tenantModel('FiscalDeviceState', fiscalDeviceStateSchema);
