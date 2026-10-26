import { Schema, model } from 'mongoose';

const ObjectId = Schema.Types.ObjectId;
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
    /** Receipt template, paper and fields (Settings > Receipts; see RECEIPT_DEFAULTS in shared). */
    receipt: Schema.Types.Mixed,
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
    /** Staff sign-in with an employee card: require the PIN as well (recommended; a barcode can be copied). */
    /** Online shop (separate website): where orders are fulfilled and how customers receive and pay for them. */
    store: {
      enabled: { type: Boolean, default: false },
      branchId: ObjectId,
      warehouseId: ObjectId,
      pickup: { type: Boolean, default: true },
      delivery: { type: Boolean, default: true },
      deliveryAreas: { type: [{ name: String, feeCents: Number, _id: false }], default: [] },
      deliveryFeeCents: { type: Number, default: 0 },
      freeDeliveryAboveCents: { type: Number, default: 0 },
      minOrderCents: { type: Number, default: 0 },
      payOnDelivery: { type: Boolean, default: true },
      mpesa: { type: Boolean, default: true },
      notifyPhone: String,
      contactPhone: String,
      announcement: String,
      hours: String,
      /** Look and content of the shop website, edited in Store studio (see STUDIO_DEFAULTS in shared). */
      studio: Schema.Types.Mixed,
      /** The shop may take payments on its own M-Pesa Paybill / Till or card gateway instead of the POS defaults. */
      mpesaConfigId: ObjectId,
      gatewayConfigId: ObjectId,
      /** Web address of the shop website (Studio preview and links back from card payments). */
      publicUrl: String,
    },
    /** CRM: spend tiers over the last 12 months and the birthday greeting. */
    crm: {
      tiers: { type: [{ name: String, minSpendCents: Number, _id: false }], default: () => [{ name: 'Bronze', minSpendCents: 0 }, { name: 'Silver', minSpendCents: 2_000_000 }, { name: 'Gold', minSpendCents: 10_000_000 }, { name: 'Platinum', minSpendCents: 30_000_000 }] },
      birthdayGreeting: { enabled: { type: Boolean, default: false }, channel: { type: String, enum: ['sms', 'email'], default: 'sms' }, offer: String },
    },
    /** Books closed up to this local date (YYYY-MM-DD): manual journals before it are refused. */
    accounting: { lockDate: String },
    staffLogin: { cardRequiresPin: { type: Boolean, default: true } },
    /** Returns policy: older sales or bigger refunds need someone with returns.approve. */
    returns: {
      windowDays: { type: Number, default: 14 },
      approvalAboveCents: { type: Number, default: 0 },
      restockByDefault: { type: Boolean, default: true },
    },
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
