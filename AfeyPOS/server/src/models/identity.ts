import { Schema, model } from 'mongoose';
import { ROLES } from '@afeypos/shared';
import { ObjectId, tenantModel } from './common.js';

const userSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    name: { type: String, required: true },
    phone: String,
    passwordHash: { type: String, required: true },
    pinHash: String,
    roles: { type: [String], enum: ROLES, required: true },
    /** Branches this user may operate in. Empty = all branches. */
    branchIds: { type: [ObjectId], ref: 'Branch', default: [] },
    status: { type: String, enum: ['active', 'disabled'], default: 'active' },
    emailVerifiedAt: Date,
    twoFactor: { enabled: { type: Boolean, default: false }, secretEnc: String, pendingSecretEnc: String },
    failedLogins: { type: Number, default: 0 },
    lockedUntil: Date,
    lastLoginAt: Date,
    commissionRateBp: { type: Number, default: 0 },
    employeeNo: String,
  },
  { timestamps: true },
);
userSchema.index({ tenantId: 1, email: 1 }, { unique: true });
export const User = tenantModel('User', userSchema);

/** Refresh sessions are looked up by id before tenant context exists, so they are not plugin-scoped; every query filters tenantId explicitly. */
const sessionSchema = new Schema(
  {
    userId: { type: ObjectId, required: true, index: true },
    userType: { type: String, enum: ['tenant'], required: true },
    tenantId: { type: ObjectId, index: true },
    refreshHash: { type: String, required: true },
    previousHash: String,
    expiresAt: { type: Date, required: true },
    revokedAt: Date,
    revokedReason: String,
    ip: String,
    userAgent: String,
    lastUsedAt: Date,
  },
  { timestamps: true },
);
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });
export const Session = model('Session', sessionSchema);

const authTokenSchema = new Schema(
  {
    purpose: { type: String, enum: ['password_reset', 'email_verify'], required: true },
    userId: { type: ObjectId, required: true },
    userType: { type: String, enum: ['tenant'], required: true },
    tenantId: ObjectId,
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    usedAt: Date,
  },
  { timestamps: true },
);
authTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 3600 });
export const AuthToken = model('AuthToken', authTokenSchema);
