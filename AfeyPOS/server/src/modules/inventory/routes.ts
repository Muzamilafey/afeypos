import { Router } from 'express';
import { z } from 'zod';
import { roundQty } from '@afeypos/shared';
import { Product, SerialItem, StockAdjustment, StockBatch, StockLevel, StockMovement, StockTransfer, Stocktake, Warehouse, Sale } from '../../models/index.js';
import { idParam, objectId, pagination, parse } from '../../http/validate.js';
import { can, requireModule, requirePermission } from '../../http/auth.js';
import { idempotent } from '../../http/idempotency.js';
import { withTransaction } from '../../db/connection.js';
import { AppError, badRequest, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { nextNumber } from '../../lib/numbering.js';
import { audit } from '../../lib/audit.js';
import { adjustInTransit, applyMovement } from './stock.js';
import { registerJob } from '../../jobs/queue.js';
import { emitToTenant } from '../../realtime/socket.js';
import { notify } from '../notifications/service.js';
import { Tenant, User } from '../../models/index.js';
import { runAsPlatform } from '../../lib/context.js';
import { ownsWarehouse } from '../sync/ownership.js';

const router = Router();

router.get('/inventory/levels', requirePermission('inventory.read'), async (req, res) => {
  const q = parse(pagination.extend({ warehouseId: objectId.optional(), productId: objectId.optional(), belowReorder: z.enum(['true']).optional() }), req.query);
  const match: Record<string, unknown> = {};
  if (q.warehouseId) match.warehouseId = q.warehouseId;
  if (q.productId) match.productId = q.productId;
  const pipeline: any[] = [
    { $match: match },
    { $lookup: { from: 'products', localField: 'productId', foreignField: '_id', as: 'product', pipeline: [{ $match: { tenantId: req.tenant!._id } }, { $project: { name: 1, sku: 1, baseUnit: 1, reorderLevel: 1, reorderQty: 1, categoryId: 1, active: 1 } }] } },
    { $unwind: '$product' },
  ];
  if (q.q) pipeline.push({ $match: { $or: [{ 'product.name': { $regex: q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }, { 'product.sku': q.q }] } });
  if (q.belowReorder) pipeline.push({ $match: { $expr: { $lte: ['$qty', '$product.reorderLevel'] }, 'product.reorderLevel': { $gt: 0 } } });
  pipeline.push({ $addFields: { available: { $subtract: ['$qty', { $ifNull: ['$reserved', 0] }] }, valueCents: { $round: [{ $multiply: ['$qty', '$avgCostCents'] }, 0] } } });
  pipeline.push({ $sort: { 'product.name': 1 } }, { $facet: { data: [{ $skip: (q.page - 1) * q.limit }, { $limit: q.limit }], total: [{ $count: 'n' }] } });
  const [r] = await StockLevel.aggregate(pipeline);
  res.json({ data: r.data, total: r.total[0]?.n ?? 0, page: q.page, limit: q.limit });
});

router.get('/inventory/movements', requirePermission('inventory.read'), async (req, res) => {
  const q = parse(pagination.extend({ productId: objectId.optional(), warehouseId: objectId.optional(), type: z.string().optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional() }), req.query);
  const filter: Record<string, unknown> = {};
  if (q.productId) filter.productId = q.productId;
  if (q.warehouseId) filter.warehouseId = q.warehouseId;
  if (q.type) filter.type = q.type;
  if (q.from || q.to) filter.at = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  const [data, total] = await Promise.all([
    StockMovement.find(filter).sort({ at: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).populate('productId', 'name sku baseUnit').populate('userId', 'name').lean(),
    StockMovement.countDocuments(filter),
  ]);
  res.json({ data, total, page: q.page, limit: q.limit });
});

router.get('/inventory/batches', requirePermission('inventory.read'), requireModule('batchExpiry'), async (req, res) => {
  const q = parse(z.object({ productId: objectId.optional(), warehouseId: objectId.optional(), expiringWithinDays: z.coerce.number().int().positive().optional() }), req.query);
  const filter: Record<string, unknown> = { qty: { $gt: 0 } };
  if (q.productId) filter.productId = q.productId;
  if (q.warehouseId) filter.warehouseId = q.warehouseId;
  if (q.expiringWithinDays) filter.expiryDate = { $lte: new Date(Date.now() + q.expiringWithinDays * 86400_000) };
  res.json({ data: await StockBatch.find(filter).sort({ expiryDate: 1 }).populate('productId', 'name sku').limit(1000).lean() });
});

router.get('/inventory/serials/:serial', requirePermission('inventory.read'), requireModule('serialNumbers'), async (req, res) => {
  const items = await SerialItem.find({ serial: String(req.params.serial).trim() }).populate('productId', 'name sku warrantyMonths').lean();
  if (!items.length) throw notFound('Serial number');
  const now = new Date();
  res.json({
    data: await Promise.all(
      items.map(async (i) => ({
        ...i,
        warranty: i.warrantyEndsAt ? { endsAt: i.warrantyEndsAt, active: i.warrantyEndsAt > now } : null,
        sale: i.saleId ? await Sale.findById(i.saleId, { number: 1, completedAt: 1, customerId: 1 }).lean() : null,
      })),
    ),
  });
});

// ---- adjustments (with authorisation) ----
const adjustmentSchema = z.object({
  warehouseId: objectId,
  reason: z.enum(['correction', 'damage', 'wastage', 'expiry', 'theft', 'opening', 'other']),
  notes: z.string().max(500).optional(),
  lines: z.array(z.object({ productId: objectId, qty: z.number().refine((v) => v !== 0, 'qty cannot be zero'), batchNo: z.string().optional(), expiryDate: z.coerce.date().optional(), serials: z.array(z.string()).optional(), unitCostCents: z.number().int().nonnegative().optional() })).min(1).max(500),
  approveNow: z.boolean().default(false),
});

const REASON_TYPE = { correction: 'adjustment', damage: 'damage', wastage: 'wastage', expiry: 'expiry', theft: 'adjustment', opening: 'opening', other: 'adjustment' } as const;

async function postAdjustment(req: any, adj: InstanceType<typeof StockAdjustment>) {
  for (const l of adj.lines) {
    await applyMovement({
      productId: l.productId, warehouseId: adj.warehouseId, qty: l.qty!, type: REASON_TYPE[adj.reason as keyof typeof REASON_TYPE] as any,
      unitCostCents: l.qty! > 0 ? l.unitCostCents ?? undefined : undefined, reason: adj.notes ?? adj.reason,
      ref: { type: 'StockAdjustment', id: adj._id, number: adj.number }, userId: req.auth.userId, batchNo: l.batchNo ?? undefined, expiryDate: l.expiryDate, serials: l.serials ?? undefined,
      allowNegative: false,
    });
  }
  adj.status = 'approved';
  adj.approvedBy = req.auth.userId;
  adj.approvedAt = new Date();
  await adj.save();
}

router.get('/inventory/adjustments', requirePermission('inventory.read'), async (req, res) => {
  const q = parse(pagination.extend({ status: z.string().optional() }), req.query);
  const filter = q.status ? { status: q.status } : {};
  const [data, total] = await Promise.all([StockAdjustment.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), StockAdjustment.countDocuments(filter)]);
  res.json({ data, total, page: q.page, limit: q.limit });
});

router.post('/inventory/adjustments', requirePermission('inventory.adjust'), idempotent('adjustment'), async (req, res) => {
  const input = parse(adjustmentSchema, req.body);
  if (!(await Warehouse.exists({ _id: input.warehouseId }))) throw notFound('Warehouse');
  if (input.approveNow && !can(req, 'inventory.adjust.approve')) throw forbidden('You cannot approve adjustments');
  const adj = await withTransaction(async () => {
    const number = await nextNumber('adjustment', 'ADJ');
    const [a] = await StockAdjustment.create([{ number, warehouseId: input.warehouseId, reason: input.reason, notes: input.notes, lines: input.lines, requestedBy: req.auth!.userId }]);
    if (input.approveNow) await postAdjustment(req, a);
    await audit(req, { action: input.approveNow ? 'inventory.adjustment_posted' : 'inventory.adjustment_requested', entity: 'StockAdjustment', entityId: a._id, details: { number, reason: input.reason, lines: input.lines.length } });
    return a;
  });
  res.status(201).json({ data: adj });
});

router.post('/inventory/adjustments/:id/approve', requirePermission('inventory.adjust.approve'), async (req, res) => {
  const adj = await withTransaction(async () => {
    const a = await StockAdjustment.findOne({ _id: idParam(req.params.id), status: 'pending' });
    if (!a) throw notFound('Pending adjustment');
    if (String(a.requestedBy) === String(req.auth!.userId) && !req.auth!.roles.includes('tenant_owner')) throw forbidden('Adjustments must be approved by someone other than the requester');
    await postAdjustment(req, a);
    await audit(req, { action: 'inventory.adjustment_approved', entity: 'StockAdjustment', entityId: a._id });
    return a;
  });
  res.json({ data: adj });
});

router.post('/inventory/adjustments/:id/reject', requirePermission('inventory.adjust.approve'), async (req, res) => {
  const a = await StockAdjustment.findOneAndUpdate({ _id: idParam(req.params.id), status: 'pending' }, { $set: { status: 'rejected', approvedBy: req.auth!.userId, approvedAt: new Date() } }, { new: true });
  if (!a) throw notFound('Pending adjustment');
  await audit(req, { action: 'inventory.adjustment_rejected', entity: 'StockAdjustment', entityId: a._id });
  res.json({ data: a });
});

// ---- transfers ----
router.get('/inventory/transfers', requirePermission('inventory.read'), requireModule('stockTransfers'), async (req, res) => {
  const q = parse(pagination.extend({ status: z.string().optional() }), req.query);
  const filter = q.status ? { status: q.status } : {};
  const [data, total] = await Promise.all([StockTransfer.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), StockTransfer.countDocuments(filter)]);
  res.json({ data, total, page: q.page, limit: q.limit });
});

router.post('/inventory/transfers', requirePermission('inventory.transfer'), requireModule('stockTransfers'), async (req, res) => {
  const body = parse(z.object({ fromWarehouseId: objectId, toWarehouseId: objectId, notes: z.string().max(500).optional(), lines: z.array(z.object({ productId: objectId, qty: z.number().positive() })).min(1).max(500), dispatchNow: z.boolean().default(false) }), req.body);
  if (String(body.fromWarehouseId) === String(body.toWarehouseId)) throw badRequest('Source and destination must differ');
  const count = await Warehouse.countDocuments({ _id: { $in: [body.fromWarehouseId, body.toWarehouseId] } });
  if (count !== 2) throw notFound('Warehouse');
  const t = await withTransaction(async () => {
    const number = await nextNumber('transfer', 'TRF');
    const [tr] = await StockTransfer.create([{ number, fromWarehouseId: body.fromWarehouseId, toWarehouseId: body.toWarehouseId, notes: body.notes, lines: body.lines, createdBy: req.auth!.userId }]);
    if (body.dispatchNow) await dispatchTransfer(req, tr);
    return tr;
  });
  res.status(201).json({ data: t });
});

async function dispatchTransfer(req: any, tr: InstanceType<typeof StockTransfer>) {
  for (const l of tr.lines) {
    const mv = await applyMovement({ productId: l.productId, warehouseId: tr.fromWarehouseId, qty: -l.qty!, type: 'transfer_out', ref: { type: 'StockTransfer', id: tr._id, number: tr.number }, userId: req.auth.userId });
    l.unitCostCents = mv?.unitCostCents ?? 0;
    // A destination on another server counts the goods as in transit when the transfer reaches it by sync.
    if (await ownsWarehouse(tr.toWarehouseId)) await adjustInTransit(l.productId, tr.toWarehouseId, l.qty!);
  }
  tr.status = 'in_transit';
  tr.dispatchedBy = req.auth.userId;
  tr.dispatchedAt = new Date();
  await tr.save();
  await audit(req, { action: 'inventory.transfer_dispatched', entity: 'StockTransfer', entityId: tr._id, details: { number: tr.number } });
}

router.post('/inventory/transfers/:id/dispatch', requirePermission('inventory.transfer'), requireModule('stockTransfers'), async (req, res) => {
  const tr = await withTransaction(async () => {
    const t = await StockTransfer.findOne({ _id: idParam(req.params.id), status: 'draft' });
    if (!t) throw notFound('Draft transfer');
    await dispatchTransfer(req, t);
    return t;
  });
  res.json({ data: tr });
});

router.post('/inventory/transfers/:id/receive', requirePermission('inventory.transfer'), requireModule('stockTransfers'), async (req, res) => {
  const body = parse(z.object({ lines: z.array(z.object({ productId: objectId, receivedQty: z.number().nonnegative() })).optional() }), req.body ?? {});
  const tr = await withTransaction(async () => {
    const t = await StockTransfer.findOne({ _id: idParam(req.params.id), status: 'in_transit' });
    if (!t) throw notFound('In-transit transfer');
    for (const l of t.lines) {
      const received = body.lines?.find((x) => String(x.productId) === String(l.productId))?.receivedQty ?? l.qty!;
      if (received > l.qty!) throw unprocessable('Received quantity cannot exceed dispatched quantity');
      await adjustInTransit(l.productId, t.toWarehouseId, -l.qty!);
      if (received > 0) await applyMovement({ productId: l.productId, warehouseId: t.toWarehouseId, qty: received, type: 'transfer_in', unitCostCents: l.unitCostCents ?? 0, ref: { type: 'StockTransfer', id: t._id, number: t.number }, userId: req.auth!.userId });
      l.receivedQty = received;
    }
    t.status = 'received';
    t.receivedBy = req.auth!.userId;
    t.receivedAt = new Date();
    await t.save();
    const shortages = t.lines.filter((l) => (l.receivedQty ?? 0) < (l.qty ?? 0)).map((l) => ({ productId: l.productId, short: roundQty((l.qty ?? 0) - (l.receivedQty ?? 0)) }));
    await audit(req, { action: 'inventory.transfer_received', entity: 'StockTransfer', entityId: t._id, details: { number: t.number, shortages } });
    return t;
  });
  res.json({ data: tr });
});

// ---- stocktake ----
router.get('/inventory/stocktakes', requirePermission('inventory.read'), requireModule('stocktake'), async (_req, res) => {
  res.json({ data: await Stocktake.find({}, { lines: 0 }).sort({ createdAt: -1 }).limit(100).lean() });
});

router.get('/inventory/stocktakes/:id', requirePermission('inventory.read'), requireModule('stocktake'), async (req, res) => {
  const st = await Stocktake.findById(idParam(req.params.id)).populate('lines.productId', 'name sku baseUnit').lean();
  if (!st) throw notFound('Stocktake');
  res.json({ data: st });
});

/** Starts a count: snapshots expected quantities so sales during counting are not lost. */
router.post('/inventory/stocktakes', requirePermission('inventory.stocktake'), requireModule('stocktake'), async (req, res) => {
  const body = parse(z.object({ warehouseId: objectId, categoryId: objectId.optional(), notes: z.string().max(500).optional() }), req.body);
  if (!(await Warehouse.exists({ _id: body.warehouseId }))) throw notFound('Warehouse');
  if (await Stocktake.exists({ warehouseId: body.warehouseId, status: 'counting' })) throw new AppError(409, 'STOCKTAKE_OPEN', 'A stocktake is already in progress for this warehouse');
  const products = await Product.find({ type: 'stock', trackStock: true, active: true, ...(body.categoryId ? { categoryId: body.categoryId } : {}) }, { _id: 1, costCents: 1 }).lean();
  const levels = new Map((await StockLevel.find({ warehouseId: body.warehouseId, productId: { $in: products.map((p) => p._id) } }).lean()).map((l) => [String(l.productId), l]));
  const number = await nextNumber('stocktake', 'STK');
  const st = await Stocktake.create({
    number, warehouseId: body.warehouseId, categoryId: body.categoryId, notes: body.notes, startedBy: req.auth!.userId,
    lines: products.map((p) => ({ productId: p._id, expectedQty: levels.get(String(p._id))?.qty ?? 0, unitCostCents: levels.get(String(p._id))?.avgCostCents ?? p.costCents ?? 0 })),
  });
  res.status(201).json({ data: st });
});

router.patch('/inventory/stocktakes/:id/counts', requirePermission('inventory.stocktake'), requireModule('stocktake'), async (req, res) => {
  const body = parse(z.object({ counts: z.array(z.object({ productId: objectId, countedQty: z.number().nonnegative() })).min(1).max(5000) }), req.body);
  const st = await Stocktake.findOne({ _id: idParam(req.params.id), status: 'counting' });
  if (!st) throw notFound('Open stocktake');
  for (const c of body.counts) {
    const line = st.lines.find((l) => String(l.productId) === String(c.productId));
    if (!line) throw badRequest('Product is not part of this stocktake');
    line.countedQty = roundQty(c.countedQty);
    line.countedBy = req.auth!.userId;
  }
  await st.save();
  res.json({ data: { counted: st.lines.filter((l) => l.countedQty !== undefined && l.countedQty !== null).length, total: st.lines.length } });
});

router.post('/inventory/stocktakes/:id/post', requirePermission('inventory.adjust.approve'), requireModule('stocktake'), async (req, res) => {
  const result = await withTransaction(async () => {
    const st = await Stocktake.findOne({ _id: idParam(req.params.id), status: 'counting' });
    if (!st) throw notFound('Open stocktake');
    const variances = [];
    for (const l of st.lines) {
      if (l.countedQty === undefined || l.countedQty === null) continue;
      const diff = roundQty(l.countedQty - (l.expectedQty ?? 0));
      if (diff === 0) continue;
      const product = await Product.findById(l.productId);
      if (product?.trackSerials) throw unprocessable(`${product.name} is serialised: adjust serial numbers individually`);
      await applyMovement({ product, productId: l.productId, warehouseId: st.warehouseId, qty: diff, type: 'stocktake', unitCostCents: diff > 0 ? l.unitCostCents ?? undefined : undefined, reason: `Stocktake ${st.number}`, ref: { type: 'Stocktake', id: st._id, number: st.number }, userId: req.auth!.userId, allowNegative: true });
      variances.push({ productId: l.productId, diff, valueCents: Math.round(diff * (l.unitCostCents ?? 0)) });
    }
    st.status = 'posted';
    st.postedBy = req.auth!.userId;
    st.postedAt = new Date();
    await st.save();
    await audit(req, { action: 'inventory.stocktake_posted', entity: 'Stocktake', entityId: st._id, details: { number: st.number, variances: variances.length, valueCents: variances.reduce((a, v) => a + v.valueCents, 0) } });
    return { stocktake: st, variances };
  });
  res.json({ data: result });
});

// ---- low stock alert job ----
registerJob('inventory.lowStock', async ({ productId, warehouseId }: { productId: string; warehouseId: string }, job) => {
  const product = await Product.findById(productId).lean();
  const level = await StockLevel.findOne({ productId, warehouseId }).lean();
  if (!product || !level || level.qty > product.reorderLevel) return;
  emitToTenant(job.tenantId!, 'inventory.low_stock', { productId, warehouseId, name: product.name, qty: level.qty, reorderLevel: product.reorderLevel });
  const tenant = await runAsPlatform(() => Tenant.findById(job.tenantId).lean());
  const managers = await User.find({ status: 'active', roles: { $in: ['tenant_owner', 'inventory_manager'] } }, { email: 1 }).lean();
  for (const m of managers) {
    await notify({ channel: 'email', to: m.email, templateKey: 'low_stock', data: { business: tenant?.name, items: `${product.name} (${product.sku}): ${level.qty} ${product.baseUnit} left`, count: 1 }, dedupeKey: `lowstock:${productId}:${warehouseId}:${new Date().toISOString().slice(0, 10)}:${m.email}` });
  }
});

export const inventoryRoutes = router;
