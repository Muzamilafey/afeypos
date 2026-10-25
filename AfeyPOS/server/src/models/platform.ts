import { Schema, model } from 'mongoose';
import { MODULES } from '@afeypos/shared';

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
    /** Uploaded file id (see modules/files) shown on the sign-in page and documents. */
    logoFileId: { type: String },
    tagline: { type: String },
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
    /** minimart | supermarket (older installs may hold a retired type; see effectiveBusinessType). */
    businessType: { type: String, required: true },
    enabledModules: { type: [String], enum: MODULES, default: [] },
    disabledModules: { type: [String], enum: MODULES, default: [] },
    status: { type: String, enum: ['active', 'suspended'], default: 'active' },
    contact: { email: String, phone: String, address: String },
    settings: { type: tenantSettingsSchema, default: () => ({}) },
    sync: { tokenHash: String, enabled: { type: Boolean, default: false } },
    callbackToken: { type: String, required: true },
  },
  { timestamps: true },
);

export const Tenant = model('Tenant', tenantSchema);
export type TenantDoc = InstanceType<typeof Tenant>;
