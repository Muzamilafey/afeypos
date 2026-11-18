import type { Types } from 'mongoose';
import { Product, RemoteStockRequest, Warehouse } from '../../models/index.js';
import { withTransaction } from '../../db/connection.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { applyMovement } from './stock.js';
import { ownsWarehouse } from '../sync/ownership.js';

export interface RemoteStockInput {
  type?: 'opening' | 'purchase_receipt';
  ref?: { type: string; id: Types.ObjectId; number?: string };
  productId: Types.ObjectId;
  warehouseId: Types.ObjectId;
  qty: number;
  unitCostCents?: number;
  batchNo?: string;
  expiryDate?: Date | string;
  serials?: string[];
  reason?: string;
  userId?: Types.ObjectId;
}

/** Head office: records stock (opening stock, goods received) for a warehouse owned by a branch server; the branch applies it on its next sync. */
export async function requestRemoteStock(input: RemoteStockInput) {
  const w = await Warehouse.findById(input.warehouseId, { branchId: 1 }).lean();
  if (!w) throw new Error('Warehouse not found');
  const [doc] = await RemoteStockRequest.create([{
    type: input.type ?? 'opening', ref: input.ref, productId: input.productId, warehouseId: input.warehouseId, branchId: w.branchId, qty: input.qty, unitCostCents: input.unitCostCents,
    batchNo: input.batchNo, expiryDate: input.expiryDate, serials: input.serials, reason: input.reason ?? (input.type === 'purchase_receipt' ? 'Goods received at head office' : 'Opening stock'),
    requestedBy: input.userId, requestedOn: env().DEPLOYMENT_MODE,
  }]);
  return doc;
}

/**
 * Owning server: applies pending requests for its own warehouses, once each. A request whose product has not
 * arrived yet waits for a later sync; one that cannot be applied (e.g. serial numbers already in stock) is marked
 * failed with the reason, which syncs back so head office can see it.
 */
export async function processRemoteStockRequests() {
  const pending = await RemoteStockRequest.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(500);
  let applied = 0;
  for (const r of pending) {
    if (!(await ownsWarehouse(r.warehouseId))) continue;
    const product = await Product.findById(r.productId);
    if (!product) continue;
    try {
      await withTransaction(async () => {
        await applyMovement({
          product, productId: product._id, warehouseId: r.warehouseId, qty: r.qty, type: (r.type ?? 'opening') as 'opening' | 'purchase_receipt', unitCostCents: r.unitCostCents ?? product.costCents,
          reason: r.reason ?? 'Opening stock', ref: r.ref?.id ? { type: r.ref.type!, id: r.ref.id, number: r.ref.number ?? undefined } : { type: 'Product', id: product._id, number: product.sku }, userId: r.requestedBy ?? undefined,
          batchNo: r.batchNo ?? undefined, expiryDate: r.expiryDate ?? undefined, serials: r.serials ?? undefined,
        });
        await RemoteStockRequest.updateOne({ _id: r._id, status: 'pending' }, { $set: { status: 'applied', appliedAt: new Date() } });
      });
      applied++;
    } catch (err) {
      logger.warn({ id: String(r._id), err: (err as Error).message }, 'remote stock request failed');
      await RemoteStockRequest.updateOne({ _id: r._id, status: 'pending' }, { $set: { status: 'failed', error: (err as Error).message.slice(0, 300) } });
    }
  }
  return applied;
}
