import { Schema } from 'mongoose';
import { SCALE_ADAPTER_KEYS } from '@afeypos/shared';
import { ObjectId, tenantModel } from './common.js';

/**
 * A weighing scale. `status` only becomes "verified" after a real check: a stable reading received from the
 * scale (counter scales) or a confirmed PLU import (label scales). Simulator scales are flagged and can never
 * be used for live sales.
 */
const weighingScaleSchema = new Schema(
  {
    name: { type: String, required: true },
    brand: { type: String, required: true },
    model: String,
    adapter: { type: String, enum: SCALE_ADAPTER_KEYS, required: true },
    /** counter = weighs at the till; label = prints price labels from its PLU list; both = does both. */
    role: { type: String, enum: ['counter', 'label', 'both'], default: 'counter' },
    branchId: { type: ObjectId, required: true },
    tillIds: { type: [ObjectId], default: [] },
    /** Non-secret connection details: serial port and baud (bridge), barcode prefix for label scales. */
    settings: {
      port: String,
      baud: Number,
      tareCommand: String,
      maxKg: Number,
      minKg: Number,
      /** Label scales: send every weighed product with a PLU, or only products assigned to this scale. */
      syncAll: { type: Boolean, default: true },
      /** Simulator only: fail this many sends before succeeding (to rehearse retries). */
      simulateFailures: Number,
    },
    status: { type: String, enum: ['unverified', 'verified', 'failed', 'disabled'], default: 'unverified' },
    lastCheck: { at: Date, ok: Boolean, message: String, reading: Schema.Types.Mixed, by: ObjectId },
    /** PLU list last confirmed on the scale (hash + version). */
    plu: { version: { type: Number, default: 0 }, hash: String, count: Number, confirmedAt: Date },
    simulated: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
    createdBy: ObjectId,
  },
  { timestamps: true },
);
weighingScaleSchema.index({ tenantId: 1, branchId: 1, active: 1 });
export const WeighingScale = tenantModel('WeighingScale', weighingScaleSchema, { branchScope: [{ path: 'branchId', kind: 'branch' }] });

/**
 * One PLU/price send to a scale. Never "succeeded" without confirmation: the adapter's acknowledgement
 * (direct) or a person confirming the import (file). Retries with backoff for direct sends.
 */
const scaleSyncJobSchema = new Schema(
  {
    scaleId: { type: ObjectId, required: true, index: true },
    branchId: { type: ObjectId, required: true },
    version: { type: Number, required: true },
    hash: { type: String, required: true },
    items: { type: [{ plu: String, name: String, priceCents: Number, unit: String, productId: ObjectId, _id: false }], default: [] },
    status: { type: String, enum: ['queued', 'sending', 'awaiting_import', 'succeeded', 'failed', 'superseded'], default: 'queued' },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    nextAttemptAt: Date,
    log: { type: [{ at: Date, message: String, _id: false }], default: [] },
    error: String,
    confirmation: { type: String, enum: ['device', 'manual'] },
    confirmedAt: Date,
    confirmedBy: ObjectId,
    createdBy: ObjectId,
  },
  { timestamps: true },
);
export const ScaleSyncJob = tenantModel('ScaleSyncJob', scaleSyncJobSchema, { branchScope: [{ path: 'branchId', kind: 'branch' }] });
