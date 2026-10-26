import { Schema } from 'mongoose';
import { ObjectId, tenantModel } from './common.js';

const poLineSchema = new Schema(
  {
    productId: { type: ObjectId, required: true },
    name: String,
    unitCode: { type: String, required: true },
    factor: { type: Number, required: true },
    qty: { type: Number, required: true },
    unitCostCents: { type: Number, required: true },
    receivedQty: { type: Number, default: 0 },
  },
  { _id: true },
);

const purchaseOrderSchema = new Schema(
  {
    number: { type: String, required: true },
    supplierId: { type: ObjectId, ref: 'Supplier', required: true },
    warehouseId: { type: ObjectId, required: true },
    status: { type: String, enum: ['draft', 'sent', 'partially_received', 'received', 'cancelled'], default: 'draft' },
    lines: [poLineSchema],
    totalCents: { type: Number, default: 0 },
    expectedAt: Date,
    notes: String,
    createdBy: ObjectId,
    sentAt: Date,
    /** Created from this supplier quotation. */
    supplierQuotationId: ObjectId,
  },
  { timestamps: true },
);
purchaseOrderSchema.index({ tenantId: 1, number: 1 }, { unique: true });
export const PurchaseOrder = tenantModel('PurchaseOrder', purchaseOrderSchema, { branchScope: [{ path: 'warehouseId', kind: 'warehouse' }] });

const grnSchema = new Schema(
  {
    number: { type: String, required: true },
    clientRequestId: String,
    supplierId: { type: ObjectId, ref: 'Supplier', required: true },
    purchaseOrderId: ObjectId,
    warehouseId: { type: ObjectId, required: true },
    supplierInvoiceNo: String,
    invoiceDate: Date,
    dueDate: Date,
    lines: [
      {
        productId: { type: ObjectId, required: true },
        poLineId: ObjectId,
        name: String,
        unitCode: String,
        factor: Number,
        qty: Number,
        unitCostCents: Number,
        batchNo: String,
        expiryDate: Date,
        serials: [String],
        _id: false,
      },
    ],
    subtotalCents: Number,
    taxCents: { type: Number, default: 0 },
    totalCents: Number,
    paidCents: { type: Number, default: 0 },
    receivedBy: ObjectId,
    notes: String,
  },
  { timestamps: true },
);
grnSchema.index({ tenantId: 1, number: 1 }, { unique: true });
grnSchema.index({ tenantId: 1, clientRequestId: 1 }, { unique: true, partialFilterExpression: { clientRequestId: { $type: 'string' } } });
export const GoodsReceipt = tenantModel('GoodsReceipt', grnSchema, { branchScope: [{ path: 'warehouseId', kind: 'warehouse' }] });

const supplierReturnSchema = new Schema(
  {
    number: { type: String, required: true },
    supplierId: { type: ObjectId, ref: 'Supplier', required: true },
    warehouseId: { type: ObjectId, required: true },
    goodsReceiptId: ObjectId,
    lines: [{ productId: ObjectId, name: String, qty: Number, unitCostCents: Number, batchNo: String, serials: [String], _id: false }],
    totalCents: Number,
    reason: String,
    createdBy: ObjectId,
  },
  { timestamps: true },
);
supplierReturnSchema.index({ tenantId: 1, number: 1 }, { unique: true });
export const SupplierReturn = tenantModel('SupplierReturn', supplierReturnSchema, { branchScope: [{ path: 'warehouseId', kind: 'warehouse' }] });

/**
 * Request for quotation sent to one supplier, and the supplier's answer (prices per line). A request to several
 * suppliers creates one per supplier sharing a groupId, so their quotes can be compared; the accepted one becomes
 * a purchase order.
 */
const supplierQuotationSchema = new Schema(
  {
    number: { type: String, required: true },
    groupId: { type: ObjectId, required: true },
    supplierId: { type: ObjectId, ref: 'Supplier', required: true },
    warehouseId: { type: ObjectId, required: true },
    status: { type: String, enum: ['draft', 'sent', 'quoted', 'accepted', 'rejected', 'cancelled'], default: 'draft' },
    lines: [
      {
        productId: { type: ObjectId, required: true },
        name: String,
        unitCode: { type: String, required: true },
        factor: { type: Number, required: true },
        qty: { type: Number, required: true },
        /** Quoted price per unit (null until the supplier answers). */
        unitCostCents: { type: Number, default: null },
        available: { type: Boolean, default: true },
        notes: String,
      },
    ],
    /** Total of the quoted, available lines. */
    totalCents: { type: Number, default: 0 },
    respondBy: Date,
    validUntil: Date,
    supplierRef: String,
    deliveryDays: Number,
    notes: String,
    supplierNotes: String,
    sentAt: Date,
    quotedAt: Date,
    decidedAt: Date,
    decisionNote: String,
    purchaseOrderId: ObjectId,
    createdBy: ObjectId,
  },
  { timestamps: true },
);
supplierQuotationSchema.index({ tenantId: 1, number: 1 }, { unique: true });
supplierQuotationSchema.index({ tenantId: 1, groupId: 1 });
supplierQuotationSchema.index({ tenantId: 1, supplierId: 1, createdAt: -1 });
export const SupplierQuotation = tenantModel('SupplierQuotation', supplierQuotationSchema, { branchScope: [{ path: 'warehouseId', kind: 'warehouse' }] });
