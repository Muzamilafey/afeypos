import { Schema } from 'mongoose';
import { ObjectId, tenantModel } from './common.js';

const branchSchema = new Schema(
  {
    name: { type: String, required: true },
    code: { type: String, required: true, uppercase: true },
    address: String,
    phone: String,
    active: { type: Boolean, default: true },
    mpesaConfigId: { type: ObjectId, ref: 'IntegrationConfig' },
    /**
     * Set at head office when the branch runs its own server (own database, syncs with HQ). Stock in its
     * warehouses can then only change on that server.
     */
    hasServer: { type: Boolean, default: false },
    syncTokenHash: { type: String, select: false },
    sync: {
      lastSeenAt: Date,
      lastPushAt: Date,
      lastPullAt: Date,
      pendingUp: Number,
      lastError: String,
      serverVersion: String,
    },
  },
  { timestamps: true },
);
branchSchema.index({ tenantId: 1, code: 1 }, { unique: true });
export const Branch = tenantModel('Branch', branchSchema);

const warehouseSchema = new Schema(
  {
    branchId: { type: ObjectId, ref: 'Branch', required: true },
    name: { type: String, required: true },
    code: { type: String, required: true, uppercase: true },
    isDefault: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
warehouseSchema.index({ tenantId: 1, code: 1 }, { unique: true });
export const Warehouse = tenantModel('Warehouse', warehouseSchema);

const tillSchema = new Schema(
  {
    branchId: { type: ObjectId, ref: 'Branch', required: true },
    warehouseId: { type: ObjectId, ref: 'Warehouse', required: true },
    name: { type: String, required: true },
    code: { type: String, required: true, uppercase: true },
    active: { type: Boolean, default: true },
    receiptPrinterId: { type: ObjectId, ref: 'HardwareDevice' },
    lastSeenAt: Date,
  },
  { timestamps: true },
);
tillSchema.index({ tenantId: 1, code: 1 }, { unique: true });
export const Till = tenantModel('Till', tillSchema);
