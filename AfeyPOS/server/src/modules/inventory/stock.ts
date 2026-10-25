/**
 * The only code path allowed to change stock. Every change creates an auditable StockMovement
 * linked to the user, time, reason and originating document.
 *
 * Invariants:
 *  - Outbound movements use a conditional atomic update (qty >= requested) unless negative stock is allowed,
 *    so concurrent sales can never oversell.
 *  - Costing is weighted average per warehouse, recalculated atomically on inbound movements.
 *  - Callers run inside withTransaction() so the movement, stock level, batch and serial changes and the
 *    originating document commit together.
 */
import { Types } from 'mongoose';
import { roundQty } from '@afeypos/shared';
import { Product, SerialItem, StockBatch, StockLevel, StockMovement, type ProductDoc } from '../../models/index.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { enqueue } from '../../jobs/queue.js';
import { assertWarehouseOwned } from '../sync/ownership.js';

export type MovementType = 'opening' | 'purchase_receipt' | 'sale' | 'sale_return' | 'supplier_return' | 'adjustment' | 'damage' | 'wastage' | 'expiry' | 'transfer_out' | 'transfer_in' | 'stocktake' | 'sync';

export interface BatchAllocation {
  batchNo: string;
  expiryDate?: Date | null;
  qty: number;
}

export interface MovementInput {
  productId: Types.ObjectId;
  warehouseId: Types.ObjectId;
  /** Signed quantity in base units. */
  qty: number;
  type: MovementType;
  /** Unit cost (per base unit) for inbound movements. Defaults to the current average cost. */
  unitCostCents?: number;
  reason?: string;
  ref?: { type: string; id: Types.ObjectId; number?: string };
  userId?: Types.ObjectId;
  batchNo?: string;
  expiryDate?: Date | null;
  /** Explicit batch allocations (inbound returns / transfers). */
  batches?: BatchAllocation[];
  serials?: string[];
  allowNegative?: boolean;
  product?: ProductDoc | null;
}

export interface MovementResult {
  movementId: Types.ObjectId;
  unitCostCents: number;
  balanceAfter: number;
  batches?: BatchAllocation[];
}

export class InsufficientStockError extends AppError {
  constructor(name: string, available: number, requested: number) {
    super(422, 'INSUFFICIENT_STOCK', `Insufficient stock for ${name}: ${available} available, ${requested} requested`, { product: name, available, requested });
  }
}

const SERIAL_OUT_STATUS: Partial<Record<MovementType, string>> = {
  sale: 'sold', transfer_out: 'in_transit', supplier_return: 'returned_to_supplier',
  damage: 'defective', wastage: 'defective', expiry: 'defective', adjustment: 'defective', stocktake: 'defective', sync: 'sold',
};

export async function applyMovement(input: MovementInput): Promise<MovementResult | null> {
  await assertWarehouseOwned(input.warehouseId);
  const product = input.product ?? (await Product.findById(input.productId));
  if (!product) throw notFound('Product');
  if (product.type !== 'stock' || !product.trackStock) return null;
  const qty = roundQty(input.qty);
  if (qty === 0) throw badRequest('Movement quantity cannot be zero');
  const outbound = qty < 0;
  const absQty = Math.abs(qty);
  if (!product.allowFractional && !Number.isInteger(absQty)) {
    throw badRequest(`${product.name} cannot be sold in fractional quantities`);
  }

  // ---- serial numbers ----
  let serials: string[] | undefined;
  if (product.trackSerials) {
    serials = [...new Set((input.serials ?? []).map((s) => s.trim()).filter(Boolean))];
    if (!Number.isInteger(absQty) || serials.length !== absQty) throw badRequest(`${product.name} requires exactly ${absQty} serial number(s)`);
    for (const serial of serials) {
      if (outbound) {
        const target = SERIAL_OUT_STATUS[input.type] ?? 'sold';
        const r = await SerialItem.updateOne({ productId: product._id, serial, status: 'in_stock', warehouseId: input.warehouseId }, { $set: { status: target } });
        if (r.modifiedCount !== 1) throw new AppError(422, 'SERIAL_UNAVAILABLE', `Serial ${serial} is not in stock at this location`);
      } else {
        const r = await SerialItem.updateOne({ productId: product._id, serial, status: { $ne: 'in_stock' } }, { $set: { status: 'in_stock', warehouseId: input.warehouseId }, $unset: { saleId: 1, soldAt: 1 } });
        if (r.matchedCount === 0) {
          try {
            await SerialItem.create({ productId: product._id, serial, warehouseId: input.warehouseId, status: 'in_stock', receivedRef: input.ref });
          } catch (err: any) {
            if (err?.code === 11000) throw new AppError(409, 'SERIAL_DUPLICATE', `Serial ${serial} is already in stock`);
            throw err;
          }
        }
      }
    }
  }

  const allowNegative = Boolean(input.allowNegative) && !product.trackSerials;

  // ---- batches / expiry ----
  let batches: BatchAllocation[] | undefined;
  if (product.trackBatches) {
    if (outbound) batches = await allocateBatchesOut(product, input, absQty, allowNegative);
    else {
      batches = input.batches?.length ? input.batches : [{ batchNo: input.batchNo || 'UNBATCHED', expiryDate: input.expiryDate ?? null, qty: absQty }];
      const sum = roundQty(batches.reduce((a, b) => a + b.qty, 0));
      if (sum !== absQty) throw badRequest('Batch quantities must add up to the movement quantity');
      for (const b of batches) {
        await StockBatch.findOneAndUpdate(
          { productId: product._id, warehouseId: input.warehouseId, batchNo: b.batchNo },
          { $inc: { qty: b.qty }, $setOnInsert: { expiryDate: b.expiryDate ?? undefined, receivedAt: new Date() } },
          { upsert: true },
        );
      }
    }
  }

  // ---- stock level (atomic) ----
  const now = new Date();
  const filter: Record<string, unknown> = { productId: product._id, warehouseId: input.warehouseId };
  let level;
  if (outbound) {
    if (!allowNegative) filter.qty = { $gte: absQty };
    level = await StockLevel.findOneAndUpdate(
      filter,
      [{ $set: { qty: { $round: [{ $subtract: [{ $ifNull: ['$qty', 0] }, absQty] }, 3] }, reserved: { $ifNull: ['$reserved', 0] }, inTransit: { $ifNull: ['$inTransit', 0] }, avgCostCents: { $ifNull: ['$avgCostCents', product.costCents ?? 0] }, lastMovementAt: now, ...stamp(now) } }],
      { new: true, upsert: allowNegative },
    );
    if (!level) {
      const current = await StockLevel.findOne({ productId: product._id, warehouseId: input.warehouseId }).lean();
      throw new InsufficientStockError(product.name, current?.qty ?? 0, absQty);
    }
  } else {
    const cost = input.unitCostCents;
    const set: Record<string, unknown> = {
      qty: { $round: [{ $add: [{ $ifNull: ['$qty', 0] }, absQty] }, 3] },
      reserved: { $ifNull: ['$reserved', 0] },
      inTransit: { $ifNull: ['$inTransit', 0] },
      lastMovementAt: now,
      ...stamp(now),
    };
    if (cost !== undefined && cost !== null) {
      set.avgCostCents = {
        $cond: [
          { $gt: [{ $ifNull: ['$qty', 0] }, 0] },
          { $round: [{ $divide: [{ $add: [{ $multiply: ['$qty', { $ifNull: ['$avgCostCents', 0] }] }, absQty * cost] }, { $add: ['$qty', absQty] }] }, 0] },
          cost,
        ],
      };
    } else {
      set.avgCostCents = { $ifNull: ['$avgCostCents', product.costCents ?? 0] };
    }
    level = await StockLevel.findOneAndUpdate(filter, [{ $set: set }], { new: true, upsert: true });
  }

  const unitCostCents = outbound ? (level!.avgCostCents ?? 0) : (input.unitCostCents ?? level!.avgCostCents ?? 0);
  const [movement] = await StockMovement.create([
    {
      productId: product._id,
      warehouseId: input.warehouseId,
      type: input.type,
      qty,
      unitCostCents,
      balanceAfter: level!.qty,
      reason: input.reason,
      userId: input.userId,
      ref: input.ref,
      batches,
      serials,
      at: now,
    },
  ]);

  if (outbound && product.reorderLevel > 0 && level!.qty <= product.reorderLevel && level!.qty + absQty > product.reorderLevel) {
    await enqueue('inventory.lowStock', { productId: String(product._id), warehouseId: String(input.warehouseId) }, { dedupeKey: `lowstock:${product._id}:${input.warehouseId}:${now.toISOString().slice(0, 10)}` });
  }

  return { movementId: movement._id, unitCostCents, balanceAfter: level!.qty, batches };
}

async function allocateBatchesOut(product: ProductDoc, input: MovementInput, absQty: number, allowNegative: boolean): Promise<BatchAllocation[]> {
  const allocations: BatchAllocation[] = [];
  if (input.batchNo) {
    const b = await StockBatch.findOneAndUpdate(
      { productId: product._id, warehouseId: input.warehouseId, batchNo: input.batchNo, qty: { $gte: absQty } },
      [{ $set: { qty: { $round: [{ $subtract: ['$qty', absQty] }, 3] }, updatedAt: new Date() } }],
      { new: true },
    );
    if (!b) throw new AppError(422, 'INSUFFICIENT_BATCH', `Batch ${input.batchNo} of ${product.name} does not have ${absQty} available`);
    return [{ batchNo: b.batchNo, expiryDate: b.expiryDate, qty: absQty }];
  }
  const filter: Record<string, unknown> = { productId: product._id, warehouseId: input.warehouseId, qty: { $gt: 0 } };
  // Expired batches are never sold automatically.
  if (input.type === 'sale') filter.$or = [{ expiryDate: null }, { expiryDate: { $exists: false } }, { expiryDate: { $gt: new Date() } }];
  const candidates = await StockBatch.find(filter).sort({ expiryDate: 1, receivedAt: 1 });
  // FEFO: first expiring, first out. Batches without expiry go last.
  candidates.sort((a, b) => (a.expiryDate?.getTime() ?? Infinity) - (b.expiryDate?.getTime() ?? Infinity));
  let remaining = absQty;
  for (const b of candidates) {
    if (remaining <= 0) break;
    const take = roundQty(Math.min(b.qty, remaining));
    const r = await StockBatch.updateOne({ _id: b._id, qty: { $gte: take } }, [{ $set: { qty: { $round: [{ $subtract: ['$qty', take] }, 3] }, updatedAt: new Date() } }]);
    if (r.modifiedCount !== 1) continue;
    allocations.push({ batchNo: b.batchNo, expiryDate: b.expiryDate, qty: take });
    remaining = roundQty(remaining - take);
  }
  if (remaining > 0) {
    if (!allowNegative) throw new InsufficientStockError(`${product.name} (unexpired batches)`, roundQty(absQty - remaining), absQty);
    allocations.push({ batchNo: 'UNBATCHED', qty: remaining });
  }
  return allocations;
}

export async function adjustInTransit(productId: Types.ObjectId, warehouseId: Types.ObjectId, delta: number) {
  await assertWarehouseOwned(warehouseId);
  await StockLevel.findOneAndUpdate(
    { productId, warehouseId },
    [{ $set: { inTransit: { $round: [{ $add: [{ $ifNull: ['$inTransit', 0] }, delta] }, 3] }, qty: { $ifNull: ['$qty', 0] }, reserved: { $ifNull: ['$reserved', 0] }, avgCostCents: { $ifNull: ['$avgCostCents', 0] }, ...stamp(new Date()) } }],
    { upsert: true },
  );
}

export async function adjustReserved(productId: Types.ObjectId, warehouseId: Types.ObjectId, delta: number) {
  await assertWarehouseOwned(warehouseId);
  await StockLevel.findOneAndUpdate(
    { productId, warehouseId },
    [{ $set: { reserved: { $max: [0, { $round: [{ $add: [{ $ifNull: ['$reserved', 0] }, delta] }, 3] }] }, qty: { $ifNull: ['$qty', 0] }, inTransit: { $ifNull: ['$inTransit', 0] }, avgCostCents: { $ifNull: ['$avgCostCents', 0] }, ...stamp(new Date()) } }],
    { upsert: true },
  );
}

/** Pipeline updates bypass Mongoose timestamps; branch sync tracks changes by updatedAt, so set them here. */
function stamp(now: Date) {
  return { updatedAt: now, createdAt: { $ifNull: ['$createdAt', now] } };
}
