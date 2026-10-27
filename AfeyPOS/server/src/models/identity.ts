import { Schema, model } from 'mongoose';
import { CUSTOM_ROLE_PREFIX, PERMISSIONS, ROLES } from '@afeypos/shared';
import { ObjectId, tenantModel } from './common.js';

const userSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    /** Optional short sign-in name (e.g. "amina"), usable instead of the email to sign in and to approve. */
    username: { type: String, lowercase: true, trim: true },
    name: { type: String, required: true },
    phone: String,
    passwordHash: { type: String, required: true },
    pinHash: String,
    /** Built-in roles and custom roles ("custom:<slug>", see CustomRole). */
    roles: {
      type: [String], required: true,
      validate: { validator: (rs: string[]) => rs.every((r) => (ROLES as readonly string[]).includes(r) || /^custom:[a-z0-9-]{2,40}$/.test(r)), message: 'Unknown role' },
    },
    /** Granted on top of the roles, or taken away from them, for this user only. */
    extraPermissions: { type: [String], enum: PERMISSIONS, default: [] },
    deniedPermissions: { type: [String], enum: PERMISSIONS, default: [] },
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
    /** Staff ID card: the barcode code is kept hashed (for sign-in lookup) and encrypted (for reprints). */
    card: {
      codeHash: String,
      codeEnc: String,
      last4: String,
      issuedAt: Date,
      issuedBy: ObjectId,
      revokedAt: Date,
    },
    /** Uploaded photo (modules/files) printed on the card. */
    photoFileId: String,
    jobTitle: String,
  },
  { timestamps: true },
);
userSchema.index({ tenantId: 1, email: 1 }, { unique: true });
userSchema.index({ tenantId: 1, username: 1 }, { unique: true, partialFilterExpression: { username: { $type: 'string' } } });
userSchema.index({ tenantId: 1, 'card.codeHash': 1 }, { unique: true, partialFilterExpression: { 'card.codeHash': { $type: 'string' } } });
userSchema.index({ tenantId: 1, employeeNo: 1 }, { unique: true, partialFilterExpression: { employeeNo: { $type: 'string' } } });
export const User = tenantModel('User', userSchema);

/** A role the business defines itself: a name and a set of permissions. Users get it by key in their roles. */
const customRoleSchema = new Schema(
  {
    key: { type: String, required: true, match: new RegExp(`^${CUSTOM_ROLE_PREFIX}[a-z0-9-]{2,40}$`) },
    name: { type: String, required: true, trim: true },
    description: String,
    permissions: { type: [String], enum: PERMISSIONS, default: [] },
    createdBy: ObjectId,
    updatedBy: ObjectId,
  },
  { timestamps: true },
);
customRoleSchema.index({ tenantId: 1, key: 1 }, { unique: true });
export const CustomRole = tenantModel('CustomRole', customRoleSchema);

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
