import { Schema } from 'mongoose';
import { ObjectId, tenantModel } from './common.js';

const categorySchema = new Schema(
  { name: { type: String, required: true }, parentId: { type: ObjectId, ref: 'Category' }, color: String, sortOrder: { type: Number, default: 0 }, active: { type: Boolean, default: true } },
  { timestamps: true },
);
categorySchema.index({ tenantId: 1, name: 1 }, { unique: true });
export const Category = tenantModel('Category', categorySchema);

const brandSchema = new Schema({ name: { type: String, required: true } }, { timestamps: true });
brandSchema.index({ tenantId: 1, name: 1 }, { unique: true });
export const Brand = tenantModel('Brand', brandSchema);

const priceMapSchema = new Schema(
  { retail: Number, wholesale: Number, contractor: Number },
  { _id: false },
);

const productUnitSchema = new Schema(
  {
    code: { type: String, required: true },
    name: { type: String, required: true },
    /** Number of base units in this unit (carton of 24 => 24, foot when base is metre => 0.3048). */
    factor: { type: Number, required: true, min: 0.000001 },
    prices: { type: priceMapSchema, default: () => ({}) },
    isDefaultSale: { type: Boolean, default: false },
    isDefaultPurchase: { type: Boolean, default: false },
  },
  { _id: false },
);

const productSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    sku: { type: String, required: true, trim: true },
    type: { type: String, enum: ['stock', 'service', 'non_stock'], default: 'stock' },
    categoryId: { type: ObjectId, ref: 'Category' },
    brandId: { type: ObjectId, ref: 'Brand' },
    description: String,
    images: { type: [String], default: [] },
    baseUnit: { type: String, required: true, default: 'pc' },
    units: { type: [productUnitSchema], default: [] },
    barcodes: { type: [{ code: { type: String, required: true }, unitCode: { type: String, required: true }, _id: false }], default: [] },
    costCents: { type: Number, default: 0 },
    prices: { type: priceMapSchema, default: () => ({}) },
    priceTiers: { type: [{ priceList: String, minQty: Number, priceCents: Number, _id: false }], default: [] },
    minOrderQty: { type: Number, default: 0 },
    taxRateBp: { type: Number, default: null },
    trackStock: { type: Boolean, default: true },
    trackBatches: { type: Boolean, default: false },
    trackSerials: { type: Boolean, default: false },
    allowFractional: { type: Boolean, default: false },
    reorderLevel: { type: Number, default: 0 },
    reorderQty: { type: Number, default: 0 },
    attributes: { type: Schema.Types.Mixed, default: {} },
    warrantyMonths: { type: Number, default: 0 },
    requiresPrescription: { type: Boolean, default: false },
    ageRestricted: { type: Boolean, default: false },
    minAge: { type: Number, default: 18 },
    soldByWeight: { type: Boolean, default: false },
    plu: String,
    parentId: { type: ObjectId, ref: 'Product' },
    variantAttributes: { type: Schema.Types.Mixed },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
productSchema.index({ tenantId: 1, sku: 1 }, { unique: true });
productSchema.index(
  { tenantId: 1, 'barcodes.code': 1 },
  { unique: true, partialFilterExpression: { 'barcodes.code': { $exists: true } } },
);
productSchema.index({ tenantId: 1, plu: 1 }, { unique: true, partialFilterExpression: { plu: { $type: 'string' } } });
productSchema.index({ tenantId: 1, name: 'text', sku: 'text' });
productSchema.index({ tenantId: 1, categoryId: 1, active: 1 });
export const Product = tenantModel('Product', productSchema);
export type ProductDoc = InstanceType<typeof Product>;

const customerPriceSchema = new Schema(
  { customerId: { type: ObjectId, required: true }, productId: { type: ObjectId, required: true }, unitCode: { type: String, required: true }, priceCents: { type: Number, required: true } },
  { timestamps: true },
);
customerPriceSchema.index({ tenantId: 1, customerId: 1, productId: 1, unitCode: 1 }, { unique: true });
export const CustomerPrice = tenantModel('CustomerPrice', customerPriceSchema);

const promotionSchema = new Schema(
  {
    name: { type: String, required: true },
    kind: { type: String, enum: ['percent', 'fixed_price'], required: true },
    /** percent: basis points off; fixed_price: promotional unit price (base unit) in cents */
    value: { type: Number, required: true },
    productIds: { type: [ObjectId], default: [] },
    categoryIds: { type: [ObjectId], default: [] },
    branchIds: { type: [ObjectId], default: [] },
    couponCode: { type: String, uppercase: true, trim: true },
    minQty: { type: Number, default: 0 },
    startsAt: Date,
    endsAt: Date,
    active: { type: Boolean, default: true },
    maxUses: Number,
    uses: { type: Number, default: 0 },
  },
  { timestamps: true },
);
promotionSchema.index({ tenantId: 1, couponCode: 1 }, { unique: true, partialFilterExpression: { couponCode: { $type: 'string' } } });
export const Promotion = tenantModel('Promotion', promotionSchema);
