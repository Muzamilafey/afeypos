import { Schema, model } from 'mongoose';
import { ObjectId, tenantModel } from './common.js';

const counterSchema = new Schema({ key: { type: String, required: true }, seq: { type: Number, default: 0 } });
counterSchema.index({ tenantId: 1, key: 1 }, { unique: true });
export const Counter = tenantModel('Counter', counterSchema);

const auditSchema = new Schema(
  {
    action: { type: String, required: true },
    entity: String,
    entityId: String,
    actor: { kind: { type: String, enum: ['user', 'system', 'device', 'sync'] }, id: ObjectId, name: String },
    supervisorId: ObjectId,
    ip: String,
    details: Schema.Types.Mixed,
    at: { type: Date, default: () => new Date() },
  },
  { timestamps: false },
);
auditSchema.index({ tenantId: 1, at: -1 });
auditSchema.index({ tenantId: 1, entity: 1, entityId: 1 });
export const AuditLog = tenantModel('AuditLog', auditSchema);

const idempotencySchema = new Schema(
  {
    key: { type: String, required: true },
    scope: { type: String, required: true },
    requestHash: String,
    status: { type: String, enum: ['in_progress', 'completed'], default: 'in_progress' },
    responseStatus: Number,
    responseBody: Schema.Types.Mixed,
    createdAt: { type: Date, default: () => new Date() },
  },
  { timestamps: false },
);
idempotencySchema.index({ tenantId: 1, scope: 1, key: 1 }, { unique: true });
idempotencySchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });
export const IdempotencyRecord = tenantModel('IdempotencyRecord', idempotencySchema);

/** Durable background job queue (MongoDB-backed). tenantId is optional (platform jobs). */
const jobSchema = new Schema(
  {
    tenantId: { type: ObjectId, index: true },
    type: { type: String, required: true },
    payload: Schema.Types.Mixed,
    status: { type: String, enum: ['queued', 'running', 'completed', 'failed', 'dead'], default: 'queued' },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    runAt: { type: Date, default: () => new Date() },
    lockedUntil: Date,
    lastError: String,
    dedupeKey: String,
    completedAt: Date,
  },
  { timestamps: true },
);
jobSchema.index({ status: 1, runAt: 1 });
jobSchema.index({ dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } });
jobSchema.index({ completedAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600, partialFilterExpression: { status: 'completed' } });
export const Job = model('Job', jobSchema);

const notificationTemplateSchema = new Schema(
  { key: { type: String, required: true }, channel: { type: String, enum: ['sms', 'email'], required: true }, subject: String, body: { type: String, required: true } },
  { timestamps: true },
);
notificationTemplateSchema.index({ tenantId: 1, key: 1, channel: 1 }, { unique: true });
export const NotificationTemplate = tenantModel('NotificationTemplate', notificationTemplateSchema);

/** tenantId optional: platform notifications (e.g. owner password reset before tenant context) also log here. */
const notificationLogSchema = new Schema(
  {
    tenantId: { type: ObjectId, index: true },
    channel: { type: String, enum: ['sms', 'email'], required: true },
    to: { type: String, required: true },
    templateKey: String,
    subject: String,
    body: String,
    status: { type: String, enum: ['queued', 'sent', 'failed', 'skipped'], default: 'queued' },
    provider: String,
    providerMessageId: String,
    error: String,
    attempts: { type: Number, default: 0 },
    dedupeKey: String,
    ref: { type: { type: String }, id: ObjectId },
    cc: { type: [String], default: undefined },
    /** Business document attached as PDF (rebuilt when sending). */
    attachment: { kind: String, id: ObjectId },
    sentAt: Date,
  },
  { timestamps: true },
);
notificationLogSchema.index({ dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } });
notificationLogSchema.index({ tenantId: 1, createdAt: -1 });
export const NotificationLog = model('NotificationLog', notificationLogSchema);

const hardwareDeviceSchema = new Schema(
  {
    kind: { type: String, enum: ['receipt_printer', 'label_printer', 'a4_printer', 'cash_drawer', 'customer_display', 'scale', 'barcode_scanner', 'rfid_reader', 'fingerprint_reader'], required: true },
    name: { type: String, required: true },
    branchId: ObjectId,
    tillId: ObjectId,
    connection: { type: String, enum: ['network', 'usb', 'serial', 'bluetooth', 'bridge', 'browser', 'keyboard_wedge'], required: true },
    settings: { type: Schema.Types.Mixed, default: {} },
    status: { lastCheckAt: Date, ok: Boolean, message: String },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
export const HardwareDevice = tenantModel('HardwareDevice', hardwareDeviceSchema);

const biometricDeviceSchema = new Schema(
  {
    name: { type: String, required: true },
    vendor: { type: String, enum: ['zkteco', 'secugen', 'simulator'], required: true },
    model: String,
    branchId: ObjectId,
    tillId: ObjectId,
    /** HMAC key shared with the local device bridge (encrypted at rest). */
    keyEnc: { type: String, required: true },
    lastSeenAt: Date,
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
export const BiometricDevice = tenantModel('BiometricDevice', biometricDeviceSchema);

const biometricTemplateSchema = new Schema(
  {
    userId: { type: ObjectId, required: true },
    finger: { type: String, default: 'right_index' },
    vendor: String,
    format: String,
    /** Vendor template (not an image), AES-256-GCM encrypted with the user id as AAD. */
    templateEnc: { type: String, required: true },
    enrolledBy: ObjectId,
    deviceId: ObjectId,
    retainUntil: Date,
  },
  { timestamps: true },
);
biometricTemplateSchema.index({ tenantId: 1, userId: 1, finger: 1 }, { unique: true });
export const BiometricTemplate = tenantModel('BiometricTemplate', biometricTemplateSchema);

const biometricChallengeSchema = new Schema(
  {
    nonce: { type: String, required: true },
    /** 1:1 verification: the user who claims to be at the reader. Empty for 1:N identification. */
    userId: ObjectId,
    /** 1:N identification: the users whose templates were handed to the reader. */
    candidates: { type: [ObjectId], default: undefined },
    purpose: { type: String, enum: ['login', 'override', 'attendance'], required: true },
    deviceId: { type: ObjectId, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: Date,
    result: String,
  },
  { timestamps: true },
);
biometricChallengeSchema.index({ tenantId: 1, nonce: 1 }, { unique: true });
export const BiometricChallenge = tenantModel('BiometricChallenge', biometricChallengeSchema);

const attendanceSchema = new Schema(
  { userId: { type: ObjectId, required: true }, kind: { type: String, enum: ['clock_in', 'clock_out'], required: true }, method: { type: String, enum: ['fingerprint', 'card', 'pin', 'password'] }, deviceId: ObjectId, branchId: ObjectId, at: { type: Date, default: () => new Date() } },
  { timestamps: false },
);
attendanceSchema.index({ tenantId: 1, userId: 1, at: -1 });
export const AttendanceRecord = tenantModel('AttendanceRecord', attendanceSchema);

// ---------------- branch <-> head office sync bookkeeping (not business data, not synced) ----------------

/** Branch server: replication cursor per direction and collection ("up:sales", "down:products"). */
const syncCursorSchema = new Schema(
  { key: { type: String, required: true, unique: true }, t: { type: Date, default: () => new Date(0) }, id: { type: ObjectId, default: null }, updatedAt: Date },
  { timestamps: false },
);
export const SyncCursor = model('SyncCursor', syncCursorSchema);

/** Records that could not be applied (ownership, unique-index clashes...) for an administrator to review. */
const syncConflictSchema = new Schema(
  {
    side: { type: String, enum: ['hq', 'branch'], required: true },
    branchCode: String,
    collectionName: { type: String, required: true },
    docId: ObjectId,
    reason: { type: String, required: true },
    resolved: { type: Boolean, default: false },
    at: { type: Date, default: () => new Date() },
  },
  { timestamps: false },
);
syncConflictSchema.index({ resolved: 1, at: -1 });
export const SyncConflict = model('SyncConflict', syncConflictSchema);

/** Head office: deletions of replicated records, so branches delete them too. */
const syncTombstoneSchema = new Schema(
  { collectionName: { type: String, required: true }, docId: { type: ObjectId, required: true }, at: { type: Date, default: () => new Date() } },
  { timestamps: false },
);
syncTombstoneSchema.index({ at: 1, _id: 1 });
export const SyncTombstone = model('SyncTombstone', syncTombstoneSchema);

const backupRecordSchema = new Schema(
  {
    tenantId: ObjectId,
    scope: { type: String, enum: ['full', 'tenant'], required: true },
    file: String,
    sizeBytes: Number,
    documents: Number,
    sha256: String,
    status: { type: String, enum: ['running', 'completed', 'failed'], default: 'running' },
    error: String,
    trigger: { type: String, enum: ['manual', 'scheduled'], default: 'manual' },
    startedAt: { type: Date, default: () => new Date() },
    completedAt: Date,
  },
  { timestamps: false },
);
export const BackupRecord = model('BackupRecord', backupRecordSchema);
