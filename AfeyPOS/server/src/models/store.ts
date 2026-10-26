import { Schema } from 'mongoose';
import { ObjectId, tenantModel } from './common.js';

export const ORDER_STATUSES = ['pending_payment', 'placed', 'accepted', 'picking', 'ready', 'out_for_delivery', 'completed', 'cancelled'] as const;

/** An order placed on the online shop, fulfilled from a branch and completed as a normal sale. */
const onlineOrderSchema = new Schema(
  {
    number: { type: String, required: true },
    clientRequestId: { type: String, required: true },
    trackingToken: { type: String, required: true },
    status: { type: String, enum: ORDER_STATUSES, default: 'placed' },
    customer: { name: String, phone: String, email: String },
    customerId: ObjectId,
    fulfilment: { type: String, enum: ['delivery', 'pickup'], required: true },
    address: String,
    area: String,
    notes: String,
    branchId: ObjectId,
    warehouseId: ObjectId,
    /** Stock was reserved on this server (false when the warehouse belongs to a branch server). */
    reserved: { type: Boolean, default: false },
    lines: [{ productId: ObjectId, name: String, sku: String, unitCode: String, qty: Number, unitPriceCents: Number, totalCents: Number, _id: false }],
    subtotalCents: Number,
    deliveryFeeCents: { type: Number, default: 0 },
    totalCents: Number,
    payment: {
      method: { type: String, enum: ['mpesa', 'card', 'on_delivery'] },
      /** Card payments: the gateway's hosted checkout page. */
      checkoutUrl: String,
      status: { type: String, enum: ['unpaid', 'pending', 'paid', 'failed', 'refund_due', 'refunded'], default: 'unpaid' },
      paymentIntentId: ObjectId,
      phone: String,
      receiptNumber: String,
      paidCents: { type: Number, default: 0 },
    },
    saleId: ObjectId,
    saleNumber: String,
    history: [{ status: String, at: Date, by: ObjectId, note: String, _id: false }],
    cancelReason: String,
  },
  { timestamps: true },
);
onlineOrderSchema.index({ tenantId: 1, number: 1 }, { unique: true });
onlineOrderSchema.index({ tenantId: 1, clientRequestId: 1 }, { unique: true });
onlineOrderSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
export const OnlineOrder = tenantModel('OnlineOrder', onlineOrderSchema, { branchScope: [{ path: 'branchId', kind: 'branch' }] });
