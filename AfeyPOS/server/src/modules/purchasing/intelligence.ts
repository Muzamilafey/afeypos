/**
 * Purchasing intelligence: suggested purchase orders, supplier prices per product, and supplier performance.
 * Suggestions are only suggestions: drafts are created on request and still need someone to send them.
 */
import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { lineAmount, roundQty } from '@afeypos/shared';
import { GoodsReceipt, Product, PurchaseOrder, StockLevel, StockMovement, Supplier, SupplierQuotation, Warehouse } from '../../models/index.js';
import { idParam, objectId, parse } from '../../http/validate.js';
import { requirePermission } from '../../http/auth.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { nextNumber } from '../../lib/numbering.js';

const router = Router();
const DAY = 86400_000;

interface Suggestion {
  productId: Types.ObjectId; name: string; sku: string; unit: string; onHand: number; onOrder: number; avgDailySales: number;
  daysLeft: number | null; leadDays: number; reorderPoint: number; suggestQty: number; unitCostCents: number; estCostCents: number; reason: string;
}

/**
 * What to order now, per supplier. Uses the sales rate of the last `days` days, the supplier's lead time, the days
 * of cover wanted, stock on hand and stock already on order. A product's main supplier comes first, then the
 * supplier it was last received from.
 */
export async function suggestOrders(opts: { warehouseId: Types.ObjectId; days: number; coverDays: number; safety: number }) {
  const since = new Date(Date.now() - opts.days * DAY);
  const [products, sales, levels, open] = await Promise.all([
    Product.find({ type: 'stock', trackStock: true, active: { $ne: false } }, { name: 1, sku: 1, baseUnit: 1, reorderLevel: 1, reorderQty: 1, maxStock: 1, costCents: 1, supplierId: 1 }).lean(),
    StockMovement.aggregate([{ $match: { warehouseId: opts.warehouseId, type: { $in: ['sale', 'sale_return'] }, at: { $gte: since } } }, { $group: { _id: '$productId', qty: { $sum: '$qty' } } }]),
    StockLevel.find({ warehouseId: opts.warehouseId }, { productId: 1, qty: 1 }).lean(),
    PurchaseOrder.aggregate([
      { $match: { warehouseId: opts.warehouseId, status: { $in: ['draft', 'sent', 'partially_received'] } } }, { $unwind: '$lines' },
      { $group: { _id: '$lines.productId', qty: { $sum: { $multiply: [{ $max: [0, { $subtract: ['$lines.qty', { $ifNull: ['$lines.receivedQty', 0] }] }] }, { $ifNull: ['$lines.factor', 1] }] } } } },
    ]),
  ]);
  const sold = new Map(sales.map((r) => [String(r._id), Math.max(0, -r.qty)]));
  const onHand = new Map(levels.map((l) => [String(l.productId), l.qty ?? 0]));
  const onOrder = new Map(open.map((r) => [String(r._id), r.qty as number]));
  // Last supplier and base-unit cost each product was received at.
  const lastRx = await GoodsReceipt.aggregate([
    { $match: { supplierId: { $ne: null } } }, { $sort: { createdAt: -1 } }, { $unwind: '$lines' },
    { $group: { _id: '$lines.productId', supplierId: { $first: '$supplierId' }, cost: { $first: { $divide: ['$lines.unitCostCents', { $ifNull: ['$lines.factor', 1] }] } } } },
  ]);
  const last = new Map(lastRx.map((r) => [String(r._id), r]));
  const suppliers = new Map((await Supplier.find({ active: { $ne: false } }, { name: 1, leadTimeDays: 1 }).lean()).map((s) => [String(s._id), s]));

  const groups = new Map<string, { supplierId: Types.ObjectId | null; supplier: string; leadTimeDays: number; lines: Suggestion[] }>();
  for (const p of products) {
    const id = String(p._id);
    const supplierId = (p.supplierId && suppliers.has(String(p.supplierId)) ? p.supplierId : last.get(id)?.supplierId) as Types.ObjectId | undefined;
    const s = supplierId ? suppliers.get(String(supplierId)) : undefined;
    const leadDays = s?.leadTimeDays ?? 7;
    const perDay = (sold.get(id) ?? 0) / opts.days;
    const have = onHand.get(id) ?? 0;
    const coming = onOrder.get(id) ?? 0;
    const reorderPoint = Math.max(p.reorderLevel ?? 0, Math.ceil(perDay * leadDays * opts.safety));
    if (reorderPoint <= 0 || have + coming > reorderPoint) continue;
    let qty = Math.max(p.reorderQty ?? 0, Math.ceil(perDay * (leadDays + opts.coverDays) - have - coming), 1);
    if (p.maxStock && p.maxStock > 0) qty = Math.max(0, Math.min(qty, Math.floor(p.maxStock - have - coming)));
    if (qty <= 0) continue;
    const unitCost = Math.round(last.get(id)?.cost ?? p.costCents ?? 0);
    const line: Suggestion = {
      productId: p._id, name: p.name, sku: p.sku, unit: p.baseUnit, onHand: have, onOrder: coming, avgDailySales: Math.round(perDay * 100) / 100,
      daysLeft: perDay > 0 ? Math.floor(have / perDay) : null, leadDays, reorderPoint, suggestQty: qty, unitCostCents: unitCost, estCostCents: lineAmount(qty, unitCost),
      reason: perDay > 0 ? `Sells ${Math.round(perDay * 10) / 10}/day; ${have} on hand${coming ? ` + ${coming} on order` : ''} covers ${Math.floor((have + coming) / perDay)} days, delivery takes ${leadDays}` : `At or below the reorder level (${p.reorderLevel})`,
    };
    const key = supplierId ? String(supplierId) : 'none';
    if (!groups.has(key)) groups.set(key, { supplierId: supplierId ?? null, supplier: s?.name ?? 'No supplier yet', leadTimeDays: leadDays, lines: [] });
    groups.get(key)!.lines.push(line);
  }
  return [...groups.values()].map((g) => ({ ...g, lines: g.lines.sort((a, b) => (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999)), totalCents: g.lines.reduce((a, l) => a + l.estCostCents, 0) }))
    .sort((a, b) => (a.supplierId ? 0 : 1) - (b.supplierId ? 0 : 1) || b.totalCents - a.totalCents);
}

/**
 * Suggested purchase orders for a store. With `create`, makes DRAFT orders for the chosen suppliers (and only the
 * lines given, with the quantities given): nothing is sent to a supplier until someone sends the order.
 */
router.post('/purchase-orders/suggest', requirePermission('purchasing.manage'), async (req, res) => {
  const body = parse(z.object({
    warehouseId: objectId,
    days: z.number().int().min(7).max(365).default(28),
    coverDays: z.number().int().min(1).max(180).default(14),
    safety: z.number().min(1).max(3).default(1.5),
    create: z.array(z.object({ supplierId: objectId, lines: z.array(z.object({ productId: objectId, qty: z.number().positive(), unitCostCents: z.number().int().min(0) })).min(1).max(500) })).max(50).optional(),
  }), req.body);
  if (!(await Warehouse.exists({ _id: body.warehouseId }))) throw notFound('Warehouse');
  if (!body.create) {
    const groups = await suggestOrders({ warehouseId: new Types.ObjectId(String(body.warehouseId)), days: body.days, coverDays: body.coverDays, safety: body.safety });
    return void res.json({ data: { groups, basis: { salesDays: body.days, coverDays: body.coverDays, safetyFactor: body.safety, note: 'Average daily sales of the period × (supplier lead time + days of cover), less stock on hand and on order. An estimate from past sales, not a promise of future demand.' } } });
  }
  const made = [];
  for (const g of body.create) {
    const supplier = await Supplier.findById(g.supplierId, { name: 1, leadTimeDays: 1 }).lean();
    if (!supplier) throw notFound('Supplier');
    const lines = [];
    for (const l of g.lines) {
      const p = await Product.findById(l.productId, { name: 1, baseUnit: 1 }).lean();
      if (!p) throw notFound('Product');
      lines.push({ productId: p._id, name: p.name, unitCode: p.baseUnit, factor: 1, qty: roundQty(l.qty), unitCostCents: l.unitCostCents });
    }
    const number = await nextNumber('po', 'PO');
    const po = await PurchaseOrder.create({
      number, supplierId: supplier._id, warehouseId: body.warehouseId, status: 'draft', lines, totalCents: lines.reduce((a, l) => a + lineAmount(l.qty, l.unitCostCents), 0),
      expectedAt: new Date(Date.now() + (supplier.leadTimeDays ?? 7) * DAY), notes: 'Suggested order (review before sending)', createdBy: req.auth!.userId,
    });
    await audit(req, { action: 'purchase_order.created', entity: 'PurchaseOrder', entityId: po._id, details: { number, suggested: true, lines: lines.length } });
    made.push(po);
  }
  res.status(201).json({ data: made });
});

/** Who sells this product and at what: received prices, latest quotes, lead time and delivery record per supplier. */
router.get('/products/:id/supplier-prices', requirePermission('purchasing.read'), async (req, res) => {
  const productId = idParam(req.params.id);
  const product = await Product.findById(productId, { name: 1, baseUnit: 1, supplierId: 1 }).lean();
  if (!product) throw notFound('Product');
  const rx = await GoodsReceipt.aggregate([
    { $match: { supplierId: { $ne: null }, 'lines.productId': productId } }, { $unwind: '$lines' }, { $match: { 'lines.productId': productId } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: '$supplierId', last: { $first: { $divide: ['$lines.unitCostCents', { $ifNull: ['$lines.factor', 1] }] } }, lastAt: { $first: '$createdAt' }, min: { $min: { $divide: ['$lines.unitCostCents', { $ifNull: ['$lines.factor', 1] }] } }, max: { $max: { $divide: ['$lines.unitCostCents', { $ifNull: ['$lines.factor', 1] }] } }, avg: { $avg: { $divide: ['$lines.unitCostCents', { $ifNull: ['$lines.factor', 1] }] } }, deliveries: { $sum: 1 }, damaged: { $sum: { $ifNull: ['$lines.damagedQty', 0] } }, qty: { $sum: '$lines.qty' } } },
  ]);
  const quotes = await SupplierQuotation.aggregate([
    { $match: { status: { $in: ['quoted', 'accepted'] }, 'lines.productId': productId } }, { $unwind: '$lines' }, { $match: { 'lines.productId': productId, 'lines.unitCostCents': { $gt: 0 }, 'lines.available': { $ne: false } } },
    { $sort: { updatedAt: -1 } }, { $group: { _id: '$supplierId', quoteCents: { $first: { $round: [{ $divide: ['$lines.unitCostCents', { $ifNull: ['$lines.factor', 1] }] }, 0] } }, quotedAt: { $first: '$updatedAt' } } },
  ]).catch(() => []);
  const ids = [...new Set([...rx.map((r) => String(r._id)), ...quotes.map((q) => String(q._id))])];
  const perf = await supplierPerformance(ids.map((i) => new Types.ObjectId(i)));
  const suppliers = new Map((await Supplier.find({ _id: { $in: ids } }, { name: 1, leadTimeDays: 1 }).lean()).map((s) => [String(s._id), s]));
  const rows = ids.map((id) => {
    const r = rx.find((x) => String(x._id) === id);
    const q = quotes.find((x) => String(x._id) === id);
    const p = perf.get(id);
    return {
      supplierId: id, supplier: suppliers.get(id)?.name ?? '?', main: String(product.supplierId ?? '') === id,
      lastCostCents: r ? Math.round(r.last) : null, lastReceivedAt: r?.lastAt ?? null, avgCostCents: r ? Math.round(r.avg) : null, minCostCents: r ? Math.round(r.min) : null, maxCostCents: r ? Math.round(r.max) : null,
      deliveries: r?.deliveries ?? 0, damagedPct: r && r.qty ? Math.round((r.damaged / (r.qty + r.damaged)) * 1000) / 10 : 0,
      quoteCents: q?.quoteCents ?? null, quotedAt: q?.quotedAt ?? null, leadTimeDays: suppliers.get(id)?.leadTimeDays ?? 7,
      onTimePct: p?.onTimePct ?? null, fillRatePct: p?.fillRatePct ?? null,
    };
  });
  // Best overall, not just cheapest: price (latest quote or last cost) weighted with reliability and lead time.
  const price = (r: (typeof rows)[number]) => r.quoteCents ?? r.lastCostCents;
  const priced = rows.filter((r) => price(r) !== null);
  const cheapest = priced.length ? Math.min(...priced.map((r) => price(r)!)) : 0;
  const scored = rows.map((r) => {
    const p = price(r);
    if (p === null) return { ...r, score: null as number | null };
    const priceScore = cheapest ? cheapest / p : 1;
    const reliability = ((r.onTimePct ?? 80) / 100) * 0.6 + ((r.fillRatePct ?? 90) / 100) * 0.4;
    const lead = 1 / (1 + (r.leadTimeDays ?? 7) / 14);
    return { ...r, score: Math.round((priceScore * 0.55 + reliability * 0.3 + lead * 0.1 + (1 - Math.min(1, r.damagedPct / 20)) * 0.05) * 100) };
  }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  res.json({ data: { product: { _id: product._id, name: product.name, unit: product.baseUnit }, suppliers: scored, best: scored.find((s) => s.score !== null)?.supplierId ?? null, basis: 'Score: price 55%, delivery reliability 30% (on time and complete), lead time 10%, damaged goods 5%. Missing history counts as average.' } });
});

/** On-time rate, average lead time, fill rate, damaged share and price changes, per supplier. */
async function supplierPerformance(ids?: Types.ObjectId[]) {
  const pos = await PurchaseOrder.find({ ...(ids ? { supplierId: { $in: ids } } : {}), status: { $in: ['sent', 'partially_received', 'received'] } }, { supplierId: 1, sentAt: 1, createdAt: 1, expectedAt: 1, lines: 1, status: 1 }).lean();
  const grns = await GoodsReceipt.find({ ...(ids ? { supplierId: { $in: ids } } : { supplierId: { $ne: null } }) }, { supplierId: 1, purchaseOrderId: 1, createdAt: 1, lines: 1 }).sort({ createdAt: 1 }).lean();
  const suppliers = new Map((await Supplier.find(ids ? { _id: { $in: ids } } : {}, { name: 1, leadTimeDays: 1, balanceCents: 1 }).lean()).map((s) => [String(s._id), s]));
  const firstRx = new Map<string, Date>();
  for (const g of grns) if (g.purchaseOrderId && !firstRx.has(String(g.purchaseOrderId))) firstRx.set(String(g.purchaseOrderId), g.createdAt as Date);
  const out = new Map<string, { supplierId: string; supplier: string; orders: number; delivered: number; onTimePct: number | null; avgLeadDays: number | null; fillRatePct: number | null; damagedPct: number; priceChanges: number; avgPriceChangePct: number | null; balanceCents: number; leadTimeDays: number }>();
  for (const [id, s] of suppliers) {
    const mine = pos.filter((p) => String(p.supplierId) === id);
    const delivered = mine.filter((p) => firstRx.has(String(p._id)));
    const leads = delivered.map((p) => (firstRx.get(String(p._id))!.getTime() - new Date(p.sentAt ?? p.createdAt!).getTime()) / DAY);
    const onTime = delivered.filter((p) => {
      const due = p.expectedAt ? new Date(p.expectedAt).getTime() : new Date(p.sentAt ?? p.createdAt!).getTime() + (s.leadTimeDays ?? 7) * DAY;
      return firstRx.get(String(p._id))!.getTime() <= due + DAY / 2;
    });
    const ordered = mine.reduce((a, p) => a + p.lines.reduce((b, l) => b + (l.qty ?? 0), 0), 0);
    const received = mine.reduce((a, p) => a + p.lines.reduce((b, l) => b + Math.min(l.qty ?? 0, l.receivedQty ?? 0), 0), 0);
    const myGrns = grns.filter((g) => String(g.supplierId) === id);
    const good = myGrns.reduce((a, g) => a + g.lines.reduce((b, l) => b + (l.qty ?? 0), 0), 0);
    const damaged = myGrns.reduce((a, g) => a + g.lines.reduce((b, l) => b + (l.damagedQty ?? 0), 0), 0);
    // Price consistency: change of the base-unit cost between consecutive deliveries of the same product.
    const lastCost = new Map<string, number>();
    const changes: number[] = [];
    for (const g of myGrns) for (const l of g.lines) {
      const c = (l.unitCostCents ?? 0) / (l.factor || 1);
      const k = String(l.productId);
      const prev = lastCost.get(k);
      if (prev && c && Math.abs(c - prev) > 0.5) changes.push(((c - prev) / prev) * 100);
      if (c) lastCost.set(k, c);
    }
    out.set(id, {
      supplierId: id, supplier: s.name, orders: mine.length, delivered: delivered.length,
      onTimePct: delivered.length ? Math.round((onTime.length / delivered.length) * 100) : null,
      avgLeadDays: leads.length ? Math.round((leads.reduce((a, b) => a + b, 0) / leads.length) * 10) / 10 : null,
      fillRatePct: ordered ? Math.round((received / ordered) * 100) : null,
      damagedPct: good + damaged ? Math.round((damaged / (good + damaged)) * 1000) / 10 : 0,
      priceChanges: changes.length, avgPriceChangePct: changes.length ? Math.round((changes.reduce((a, b) => a + b, 0) / changes.length) * 10) / 10 : null,
      balanceCents: s.balanceCents ?? 0, leadTimeDays: s.leadTimeDays ?? 7,
    });
  }
  return out;
}

router.get('/reports/supplier-performance', requirePermission('purchasing.read'), async (req, res) => {
  const q = parse(z.object({ supplierId: objectId.optional() }), req.query);
  if (q.supplierId && !(await Supplier.exists({ _id: q.supplierId }))) throw badRequest('Unknown supplier');
  const perf = await supplierPerformance(q.supplierId ? [new Types.ObjectId(String(q.supplierId))] : undefined);
  res.json({ data: [...perf.values()].sort((a, b) => b.orders - a.orders), notes: 'On time: first delivery by the expected date (or order date + lead time). Fill rate: received ÷ ordered on sent orders. Damaged: share of delivered units recorded as damaged.' });
});

export const purchasingIntelligenceRoutes = router;
