import { Schema, model } from 'mongoose';
import { BUSINESS_TYPES, MODULES } from '@afeypos/shared';
import { ObjectId } from './common.js';

const tenantSettingsSchema = new Schema(
  {
    currency: { type: String, default: 'KES' },
    country: { type: String, default: 'KE' },
    timezone: { type: String, default: 'Africa/Nairobi' },
    locale: { type: String, default: 'en-KE' },
    taxPin: String,
    defaultTaxRateBp: { type: Number, default: 1600 },
    pricesIncludeTax: { type: Boolean, default: true },
    allowNegativeStock: { type: Boolean, default: false },
    requireOpenShift: { type: Boolean, default: true },
    cashierDiscountLimitBp: { type: Number, default: 1000 },
    receiptHeader: String,
    receiptFooter: { type: String, default: 'Thank you for shopping with us!' },
    variableWeight: {
      enabled: { type: Boolean, default: false },
      prefixes: { type: [String], default: ['20', '21', '22', '23', '24', '25', '26', '27', '28', '29'] },
      itemCodeLength: { type: Number, default: 5 },
      valueLength: { type: Number, default: 5 },
      valueType: { type: String, enum: ['weight', 'price'], default: 'weight' },
      valueDecimals: { type: Number, default: 3 },
    },
    loyalty: {
      pointsPerUnitCents: { type: Number, default: 10000 },
      pointValueCents: { type: Number, default: 100 },
    },
    stkPendingTimeoutSeconds: { type: Number, default: 180 },
    /** Liquor licensing: age-restricted products can only be sold inside these local hours (HH:mm). */
    restrictedSaleHours: { start: { type: String }, end: { type: String } },
    dailyReportEmails: { type: [String], default: [] },
    creditReminders: { enabled: { type: Boolean, default: false }, overdueDays: { type: Number, default: 7 } },
  },
  { _id: false },
);

const tenantSchema = new Schema(
  {
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    customDomains: { type: [String], default: [] },
    businessType: { type: String, enum: BUSINESS_TYPES, required: true },
    enabledModules: { type: [String], enum: MODULES, default: [] },
    disabledModules: { type: [String], enum: MODULES, default: [] },
    status: { type: String, enum: ['trial', 'active', 'past_due', 'suspended', 'cancelled'], default: 'trial' },
    planCode: { type: String, default: 'starter' },
    trialEndsAt: Date,
    currentPeriodEnd: Date,
    suspendedReason: String,
    contact: { email: String, phone: String, address: String },
    settings: { type: tenantSettingsSchema, default: () => ({}) },
    sync: { tokenHash: String, enabled: { type: Boolean, default: false } },
    callbackToken: { type: String, required: true },
    usage: {
      smsMonth: { type: String },
      smsCount: { type: Number, default: 0 },
      lastActivityAt: Date,
    },
  },
  { timestamps: true },
);
tenantSchema.index({ customDomains: 1 }, { unique: true, partialFilterExpression: { 'customDomains.0': { $exists: true } } });

export const Tenant = model('Tenant', tenantSchema);
export type TenantDoc = InstanceType<typeof Tenant>;

const planSchema = new Schema(
  {
    code: { type: String, unique: true, required: true },
    name: String,
    priceMonthlyCents: Number,
    currency: { type: String, default: 'KES' },
    trialDays: { type: Number, default: 14 },
    limits: { branches: Number, users: Number, tills: Number, products: Number, smsPerMonth: Number },
    modules: { type: [String], default: undefined },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
export const Plan = model('Plan', planSchema);

const platformUserSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true },
    passwordHash: { type: String, required: true },
    roles: { type: [String], enum: ['platform_owner', 'platform_support'], required: true },
    status: { type: String, enum: ['active', 'disabled'], default: 'active' },
    twoFactor: { enabled: { type: Boolean, default: false }, secretEnc: String },
    failedLogins: { type: Number, default: 0 },
    lockedUntil: Date,
    lastLoginAt: Date,
  },
  { timestamps: true },
);
export const PlatformUser = model('PlatformUser', platformUserSchema);

const supportGrantSchema = new Schema(
  {
    tenantId: { type: ObjectId, ref: 'Tenant', required: true, index: true },
    requestedBy: { type: ObjectId, ref: 'PlatformUser', required: true },
    reason: { type: String, required: true },
    scope: { type: String, enum: ['read'], default: 'read' },
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'revoked', 'expired'], default: 'pending' },
    durationMinutes: { type: Number, required: true },
    approvedBy: { kind: String, id: ObjectId },
    approvedAt: Date,
    expiresAt: Date,
  },
  { timestamps: true },
);
export const SupportGrant = model('SupportGrant', supportGrantSchema);
