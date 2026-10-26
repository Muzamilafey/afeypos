import { Schema } from 'mongoose';
import { ObjectId, tenantModel } from './common.js';

/** KRA eTIMS submission of a sale or credit note (see modules/etims). */
const etimsSubmissionSchema = new Schema(
  {
    status: { type: String, enum: ['pending', 'signed', 'failed'], default: 'pending' },
    configId: ObjectId,
    invcNo: Number,
    orgInvcNo: Number,
    rcptNo: Number,
    totRcptNo: Number,
    intrlData: String,
    rcptSign: String,
    sdcId: String,
    mrcNo: String,
    sdcDateTime: String,
    qrUrl: String,
    attempts: { type: Number, default: 0 },
    error: String,
    signedAt: Date,
  },
  { _id: false },
);

const saleLineSchema = new Schema({
  productId: { type: ObjectId, required: true },
  sku: String,
  name: String,
  unitCode: String,
  unitFactor: Number,
  qty: Number,
  baseQty: Number,
  listPriceCents: Number,
  unitPriceCents: Number,
  discountCents: { type: Number, default: 0 },
  cartDiscountCents: { type: Number, default: 0 },
  taxRateBp: Number,
  taxCents: Number,
  /** Amount charged for the line after all discounts, including tax. */
  totalCents: Number,
  /** totalCents excluding tax = revenue. */
  netCents: Number,
  /** Cost of goods sold for this line (weighted average cost at sale time). */
  costCents: { type: Number, default: 0 },
  serials: { type: [String], default: undefined },
  batches: { type: [{ batchNo: String, expiryDate: Date, qty: Number, _id: false }], default: undefined },
  promotionId: ObjectId,
  prescriptionRef: String,
  returnedQty: { type: Number, default: 0 },
  warrantyEndsAt: Date,
});

const salePaymentSchema = new Schema(
  {
    method: { type: String, enum: ['cash', 'mpesa', 'card', 'bank', 'credit', 'loyalty', 'voucher', 'gateway', 'other'], required: true },
    amountCents: { type: Number, required: true },
    tenderedCents: Number,
    changeCents: Number,
    reference: String,
    paymentIntentId: ObjectId,
    /** Gateway that collected a 'gateway' payment (paystack, pawapay...). */
    provider: String,
  },
  { _id: false },
);

const saleSchema = new Schema(
  {
    number: { type: String, required: true },
    clientRequestId: { type: String, required: true },
    source: { type: String, enum: ['pos', 'invoice', 'sync'], default: 'pos' },
    sourceRef: String,
    branchId: { type: ObjectId, required: true },
    warehouseId: { type: ObjectId, required: true },
    tillId: ObjectId,
    shiftId: ObjectId,
    cashierId: { type: ObjectId, required: true },
    customerId: ObjectId,
    salesRepId: ObjectId,
    priceList: { type: String, default: 'retail' },
    lines: [saleLineSchema],
    grossCents: Number,
    discountCents: { type: Number, default: 0 },
    taxCents: { type: Number, default: 0 },
    totalCents: { type: Number, required: true },
    netCents: Number,
    costCents: { type: Number, default: 0 },
    payments: [salePaymentSchema],
    paidCents: { type: Number, default: 0 },
    creditCents: { type: Number, default: 0 },
    changeCents: { type: Number, default: 0 },
    refundedCents: { type: Number, default: 0 },
    status: { type: String, enum: ['completed', 'partially_returned', 'returned', 'voided'], default: 'completed' },
    loyalty: { earned: { type: Number, default: 0 }, redeemed: { type: Number, default: 0 } },
    couponCode: String,
    ageVerifiedBy: ObjectId,
    overrides: { type: [{ action: String, supervisorId: ObjectId, at: Date, _id: false }], default: [] },
    salesDocumentId: ObjectId,
    dueDate: Date,
    notes: String,
    commissionCents: { type: Number, default: 0 },
    etims: { type: etimsSubmissionSchema, default: undefined },
    completedAt: { type: Date, default: () => new Date() },
    voidedAt: Date,
    voidedBy: ObjectId,
    voidReason: String,
  },
  { timestamps: true },
);
saleSchema.index({ tenantId: 1, number: 1 }, { unique: true });
saleSchema.index({ tenantId: 1, clientRequestId: 1 }, { unique: true });
saleSchema.index({ tenantId: 1, completedAt: -1 });
saleSchema.index({ tenantId: 1, customerId: 1, completedAt: -1 });
saleSchema.index({ tenantId: 1, shiftId: 1 });
saleSchema.index({ tenantId: 1, 'lines.serials': 1 });
export const Sale = tenantModel('Sale', saleSchema, { branchScope: [{ path: 'branchId', kind: 'branch' }] });
export type SaleDoc = InstanceType<typeof Sale>;

const saleReturnSchema = new Schema(
  {
    number: { type: String, required: true },
    clientRequestId: { type: String, required: true },
    saleId: { type: ObjectId, required: true },
    branchId: ObjectId,
    shiftId: ObjectId,
    customerId: ObjectId,
    lines: [{ lineId: ObjectId, productId: ObjectId, name: String, qty: Number, baseQty: Number, refundCents: Number, netCents: Number, taxCents: Number, costCents: Number, restocked: Boolean, serials: [String], _id: false }],
    refundCents: Number,
    refundMethod: { type: String, enum: ['cash', 'mpesa', 'card', 'account', 'credit_note'] },
    reason: String,
    /** Why it came back (damaged, expired, wrong item...), for the returns report. */
    reasonCode: String,
    reference: String,
    isVoid: { type: Boolean, default: false },
    processedBy: ObjectId,
    approvedBy: ObjectId,
    /** Why a supervisor had to approve (outside the return window, above the approval amount). */
    approvalReasons: { type: [String], default: undefined },
    /** M-Pesa refund sent back to the customer's phone with B2C (draft until approved). */
    payoutId: ObjectId,
    etims: { type: etimsSubmissionSchema, default: undefined },
  },
  { timestamps: true },
);
saleReturnSchema.index({ tenantId: 1, number: 1 }, { unique: true });
saleReturnSchema.index({ tenantId: 1, clientRequestId: 1 }, { unique: true });
saleReturnSchema.index({ tenantId: 1, createdAt: -1 });
saleReturnSchema.index({ tenantId: 1, saleId: 1 });
export const SaleReturn = tenantModel('SaleReturn', saleReturnSchema, { branchScope: [{ path: 'branchId', kind: 'branch' }] });

const salesDocumentSchema = new Schema(
  {
    type: { type: String, enum: ['quotation', 'sales_order', 'delivery_note'], required: true },
    number: { type: String, required: true },
    customerId: ObjectId,
    customerName: String,
    branchId: { type: ObjectId, required: true },
    warehouseId: ObjectId,
    priceList: { type: String, default: 'retail' },
    lines: [{ productId: ObjectId, sku: String, name: String, unitCode: String, unitFactor: Number, qty: Number, unitPriceCents: Number, discountCents: Number, taxRateBp: Number, taxCents: Number, totalCents: Number, deliveredQty: { type: Number, default: 0 } }],
    totalCents: Number,
    taxCents: Number,
    status: { type: String, enum: ['draft', 'sent', 'accepted', 'converted', 'cancelled', 'expired', 'delivered'], default: 'draft' },
    validUntil: Date,
    convertedSaleId: ObjectId,
    saleId: ObjectId,
    sourceDocumentId: ObjectId,
    deliveryAddress: String,
    driver: String,
    vehicle: String,
    notes: String,
    salesRepId: ObjectId,
    createdBy: ObjectId,
    stockReserved: { type: Boolean, default: false },
  },
  { timestamps: true },
);
salesDocumentSchema.index({ tenantId: 1, number: 1 }, { unique: true });
salesDocumentSchema.index({ tenantId: 1, type: 1, status: 1, createdAt: -1 });
export const SalesDocument = tenantModel('SalesDocument', salesDocumentSchema, { branchScope: [{ path: 'branchId', kind: 'branch' }] });

const shiftSchema = new Schema(
  {
    number: { type: String, required: true },
    tillId: { type: ObjectId, required: true },
    branchId: { type: ObjectId, required: true },
    userId: { type: ObjectId, required: true },
    status: { type: String, enum: ['open', 'closed'], default: 'open' },
    openedAt: { type: Date, default: () => new Date() },
    closedAt: Date,
    openingFloatCents: { type: Number, default: 0 },
    /** Notes and coins counted into the drawer at the start ("note-1000": 2, ...). */
    openingDenominations: { type: Schema.Types.Mixed },
    expectedCashCents: Number,
    countedCashCents: Number,
    varianceCents: Number,
    totalsByMethod: { type: Schema.Types.Mixed },
    salesCount: Number,
    salesTotalCents: Number,
    denominations: { type: Schema.Types.Mixed },
    notes: String,
    closedBy: ObjectId,
  },
  { timestamps: true },
);
shiftSchema.index({ tenantId: 1, number: 1 }, { unique: true });
shiftSchema.index({ tenantId: 1, tillId: 1 }, { unique: true, partialFilterExpression: { status: 'open' } });
export const Shift = tenantModel('Shift', shiftSchema, { branchScope: [{ path: 'branchId', kind: 'branch' }] });

const cashMovementSchema = new Schema(
  {
    shiftId: { type: ObjectId, required: true },
    tillId: ObjectId,
    type: { type: String, enum: ['float', 'sale', 'refund', 'cash_in', 'cash_out', 'customer_payment', 'expense'], required: true },
    amountCents: { type: Number, required: true },
    reason: String,
    userId: ObjectId,
    ref: { type: { type: String }, id: ObjectId, number: String },
    at: { type: Date, default: () => new Date() },
  },
  { timestamps: false },
);
cashMovementSchema.index({ tenantId: 1, shiftId: 1 });
export const CashMovement = tenantModel('CashMovement', cashMovementSchema);

const expenseSchema = new Schema(
  {
    number: { type: String, required: true },
    branchId: ObjectId,
    category: { type: String, required: true },
    amountCents: { type: Number, required: true },
    taxCents: { type: Number, default: 0 },
    method: { type: String, enum: ['cash', 'mpesa', 'bank', 'card', 'other'], default: 'cash' },
    shiftId: ObjectId,
    payee: String,
    reference: String,
    notes: String,
    date: { type: Date, default: () => new Date() },
    userId: ObjectId,
  },
  { timestamps: true },
);
expenseSchema.index({ tenantId: 1, number: 1 }, { unique: true });
expenseSchema.index({ tenantId: 1, date: -1 });
export const Expense = tenantModel('Expense', expenseSchema, { branchScope: [{ path: 'branchId', kind: 'branch' }] });

const repairSchema = new Schema(
  {
    number: { type: String, required: true },
    customerId: ObjectId,
    customerName: String,
    customerPhone: String,
    productId: ObjectId,
    itemDescription: { type: String, required: true },
    serial: String,
    fault: String,
    underWarranty: { type: Boolean, default: false },
    status: { type: String, enum: ['received', 'diagnosing', 'awaiting_parts', 'repairing', 'ready', 'collected', 'cancelled'], default: 'received' },
    estimateCents: Number,
    chargeCents: Number,
    technician: String,
    notes: [{ at: Date, by: ObjectId, text: String, _id: false }],
    createdBy: ObjectId,
  },
  { timestamps: true },
);
repairSchema.index({ tenantId: 1, number: 1 }, { unique: true });
export const RepairTicket = tenantModel('RepairTicket', repairSchema);
