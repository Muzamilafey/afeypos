import { Schema } from 'mongoose';
import { ObjectId, refSchema, tenantModel } from './common.js';

/**
 * Stock on hand per product per warehouse, in base units.
 * Costing: weighted average cost per warehouse (avgCostCents per base unit), updated on every inbound movement.
 */
const stockLevelSchema = new Schema(
  {
    productId: { type: ObjectId, ref: 'Product', required: true },
    warehouseId: { type: ObjectId, ref: 'Warehouse', required: true },
    qty: { type: Number, default: 0 },
    reserved: { type: Number, default: 0 },
    inTransit: { type: Number, default: 0 },
    avgCostCents: { type: Number, default: 0 },
    lastMovementAt: Date,
  },
  { timestamps: true },
);
stockLevelSchema.index({ tenantId: 1, productId: 1, warehouseId: 1 }, { unique: true });
stockLevelSchema.index({ tenantId: 1, warehouseId: 1 });
export const StockLevel = tenantModel('StockLevel', stockLevelSchema);

export const MOVEMENT_TYPES = [
  'opening', 'purchase_receipt', 'sale', 'sale_return', 'supplier_return', 'adjustment', 'damage', 'wastage', 'expiry',
  'transfer_out', 'transfer_in', 'stocktake', 'sync',
] as const;

const stockMovementSchema = new Schema(
  {
    productId: { type: ObjectId, ref: 'Product', required: true },
    warehouseId: { type: ObjectId, ref: 'Warehouse', required: true },
    type: { type: String, enum: MOVEMENT_TYPES, required: true },
    /** Signed quantity in base units. */
    qty: { type: Number, required: true },
    unitCostCents: { type: Number, default: 0 },
    balanceAfter: { type: Number, required: true },
    reason: String,
    userId: { type: ObjectId, ref: 'User' },
    ref: { type: refSchema },
    batches: { type: [{ batchNo: String, expiryDate: Date, qty: Number, _id: false }], default: undefined },
    serials: { type: [String], default: undefined },
    at: { type: Date, default: () => new Date() },
  },
  { timestamps: false },
);
stockMovementSchema.index({ tenantId: 1, productId: 1, at: -1 });
stockMovementSchema.index({ tenantId: 1, warehouseId: 1, at: -1 });
stockMovementSchema.index({ tenantId: 1, 'ref.type': 1, 'ref.id': 1 });
export const StockMovement = tenantModel('StockMovement', stockMovementSchema);

const stockBatchSchema = new Schema(
  {
    productId: { type: ObjectId, required: true },
    warehouseId: { type: ObjectId, required: true },
    batchNo: { type: String, required: true },
    expiryDate: Date,
    qty: { type: Number, default: 0 },
    receivedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);
stockBatchSchema.index({ tenantId: 1, productId: 1, warehouseId: 1, batchNo: 1 }, { unique: true });
stockBatchSchema.index({ tenantId: 1, expiryDate: 1 });
export const StockBatch = tenantModel('StockBatch', stockBatchSchema);

const serialItemSchema = new Schema(
  {
    productId: { type: ObjectId, required: true },
    serial: { type: String, required: true, trim: true },
    warehouseId: ObjectId,
    status: { type: String, enum: ['in_stock', 'sold', 'returned_to_supplier', 'in_transit', 'defective'], default: 'in_stock' },
    saleId: ObjectId,
    customerId: ObjectId,
    soldAt: Date,
    warrantyEndsAt: Date,
    receivedRef: { type: refSchema },
  },
  { timestamps: true },
);
serialItemSchema.index({ tenantId: 1, productId: 1, serial: 1 }, { unique: true });
serialItemSchema.index({ tenantId: 1, serial: 1 });
export const SerialItem = tenantModel('SerialItem', serialItemSchema);

const adjustmentSchema = new Schema(
  {
    number: { type: String, required: true },
    warehouseId: { type: ObjectId, required: true },
    reason: { type: String, enum: ['correction', 'damage', 'wastage', 'expiry', 'theft', 'opening', 'other'], required: true },
    notes: String,
    lines: [{ productId: { type: ObjectId, required: true }, qty: Number, batchNo: String, expiryDate: Date, serials: [String], unitCostCents: Number, _id: false }],
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    requestedBy: ObjectId,
    approvedBy: ObjectId,
    approvedAt: Date,
  },
  { timestamps: true },
);
adjustmentSchema.index({ tenantId: 1, number: 1 }, { unique: true });
export const StockAdjustment = tenantModel('StockAdjustment', adjustmentSchema);

const transferSchema = new Schema(
  {
    number: { type: String, required: true },
    fromWarehouseId: { type: ObjectId, required: true },
    toWarehouseId: { type: ObjectId, required: true },
    lines: [{ productId: { type: ObjectId, required: true }, qty: Number, receivedQty: { type: Number, default: 0 }, unitCostCents: Number, _id: false }],
    status: { type: String, enum: ['draft', 'in_transit', 'received', 'cancelled'], default: 'draft' },
    notes: String,
    createdBy: ObjectId,
    dispatchedBy: ObjectId,
    dispatchedAt: Date,
    receivedBy: ObjectId,
    receivedAt: Date,
  },
  { timestamps: true },
);
transferSchema.index({ tenantId: 1, number: 1 }, { unique: true });
export const StockTransfer = tenantModel('StockTransfer', transferSchema);

const stocktakeSchema = new Schema(
  {
    number: { type: String, required: true },
    warehouseId: { type: ObjectId, required: true },
    status: { type: String, enum: ['counting', 'posted', 'cancelled'], default: 'counting' },
    categoryId: ObjectId,
    lines: [{ productId: { type: ObjectId, required: true }, expectedQty: Number, countedQty: Number, unitCostCents: Number, countedBy: ObjectId, _id: false }],
    startedBy: ObjectId,
    postedBy: ObjectId,
    postedAt: Date,
    notes: String,
  },
  { timestamps: true },
);
stocktakeSchema.index({ tenantId: 1, number: 1 }, { unique: true });
export const Stocktake = tenantModel('Stocktake', stocktakeSchema);
