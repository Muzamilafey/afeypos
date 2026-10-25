/**
 * Minimart and supermarket reports (definitions in docs/REPORTS.md):
 *  - Returns analysis, daily Z summary, basket analysis, discounts.
 *  - Product performance (ABC by net revenue, margin, days of cover), dead stock and reorder suggestions.
 * Periods and branch scoping follow the other reports (see period() in routes.ts).
 */
import { Router } from 'express';
import { z } from 'zod';
import type { Types } from 'mongoose';
import { GoodsReceipt, Product, Promotion, PurchaseOrder, Sale, SaleReturn, StockLevel, StockMovement, Supplier, User, Warehouse } from '../../models/index.js';
import { objectId, parse } from '../../http/validate.js';
import { requirePermission } from '../../http/auth.js';
import { period, saleMatch, send } from './routes.js';

const router = Router();

type Period = ReturnType<typeof period>;

/** Warehouses the period's branch filter covers (null = all). */
async function scopedWarehouses(p: Period, warehouseId?: Types.ObjectId) {
  if (warehouseId) return [warehouseId];
  if (!p.branchIds) return null;
  return (await Warehouse.find({ branchId: { $in: p.branchIds } }, { _id: 1 }).lean()).map((w) => w._id);
}

async function userNames(ids: unknown[]) {
  return new Map((await User.find({ _id: { $in: ids.filter(Boolean) } }, { name: 1 }).lean()).map((u) => [String(u._id), u.name]));
}

function returnMatch(p: Period) {
  const m: Record<string, unknown> = { createdAt: { $gte: p.start, $lt: p.end }, isVoid: { $ne: true } };
  if (p.branchIds) m.branchId = { $in: p.branchIds };
  return m;
}

const REASON_LABELS: Record<string, string> = { damaged: 'Damaged', expired: 'Expired', wrong_item: 'Wrong item', not_wanted: 'Changed mind', quality: 'Quality problem', overcharged: 'Overcharged', other: 'Other', unspecified: 'Not given' };

router.get('/reports/returns', requirePermission('reports.read'), async (req, res) => {
  const p = period(req);
  const match = returnMatch(p);
  const [byReason, byMethod, byCashier, byProduct, [sales], list] = await Promise.all([
    SaleReturn.aggregate([{ $match: match }, { $group: { _id: { $ifNull: ['$reasonCode', 'unspecified'] }, count: { $sum: 1 }, refundCents: { $sum: '$refundCents' } } }, { $sort: { refundCents: -1 } }]),
    SaleReturn.aggregate([{ $match: match }, { $group: { _id: '$refundMethod', count: { $sum: 1 }, refundCents: { $sum: '$refundCents' } } }, { $sort: { refundCents: -1 } }]),
    SaleReturn.aggregate([{ $match: match }, { $group: { _id: '$processedBy', count: { $sum: 1 }, refundCents: { $sum: '$refundCents' }, approved: { $sum: { $cond: [{ $ifNull: ['$approvedBy', false] }, 1, 0] } } } }, { $sort: { refundCents: -1 } }]),
    SaleReturn.aggregate([
      { $match: match }, { $unwind: '$lines' },
      { $group: { _id: '$lines.productId', name: { $first: '$lines.name' }, qty: { $sum: '$lines.qty' }, refundCents: { $sum: '$lines.refundCents' }, restockedQty: { $sum: { $cond: ['$lines.restocked', '$lines.qty', 0] } } } },
      { $sort: { refundCents: -1 } }, { $limit: 100 },
    ]),
    Sale.aggregate([{ $match: saleMatch(p) }, { $group: { _id: null, gross: { $sum: '$totalCents' }, count: { $sum: 1 } } }]),
    SaleReturn.find(match).sort({ createdAt: -1 }).limit(p.format === 'csv' ? 10_000 : 200).lean(),
  ]);
  const names = await userNames([...byCashier.map((r) => r._id), ...list.flatMap((r) => [r.processedBy, r.approvedBy])]);
  const saleNumbers = new Map((await Sale.find({ _id: { $in: list.map((r) => r.saleId) } }, { number: 1 }).lean()).map((s) => [String(s._id), s.number]));
  const rows = list.map((r) => ({
    number: r.number, saleNumber: saleNumbers.get(String(r.saleId)), createdAt: r.createdAt, refundCents: r.refundCents, refundMethod: r.refundMethod,
    reason: REASON_LABELS[r.reasonCode ?? 'unspecified'], notes: r.reason, processedBy: names.get(String(r.processedBy)), approvedBy: r.approvedBy ? names.get(String(r.approvedBy)) : '',
  }));
  if (p.format === 'csv') return send(res, 'csv', 'returns', rows);
  const refundCents = byMethod.reduce((a, r) => a + r.refundCents, 0);
  res.json({
    data: {
      summary: { count: rows.length, refundCents, salesCents: sales?.gross ?? 0, returnRateBp: sales?.gross ? Math.round((refundCents / sales.gross) * 10_000) : 0 },
      byReason: byReason.map((r) => ({ ...r, name: REASON_LABELS[r._id] ?? r._id })),
      byMethod,
      byCashier: byCashier.map((r) => ({ ...r, name: names.get(String(r._id)) ?? 'Unknown' })),
      byProduct,
      returns: rows,
    },
  });
});

/** End-of-day (Z) summary per local day: sales, returns, voids and money taken by method. */
router.get('/reports/daily-summary', requirePermission('reports.read'), async (req, res) => {
  const p = period(req);
  const day = (field: string) => ({ $dateToString: { date: field, format: '%Y-%m-%d', timezone: p.tz } });
  const voidMatch: Record<string, unknown> = { status: 'voided', voidedAt: { $gte: p.start, $lt: p.end } };
  if (p.branchIds) voidMatch.branchId = { $in: p.branchIds };
  const [sales, payments, returns, voids] = await Promise.all([
    Sale.aggregate([
      { $match: saleMatch(p) },
      { $group: { _id: day('$completedAt'), count: { $sum: 1 }, grossCents: { $sum: '$totalCents' }, netCents: { $sum: '$netCents' }, taxCents: { $sum: '$taxCents' }, discountCents: { $sum: '$discountCents' }, costCents: { $sum: '$costCents' }, items: { $sum: { $size: '$lines' } }, customers: { $addToSet: '$customerId' } } },
    ]),
    Sale.aggregate([{ $match: saleMatch(p) }, { $unwind: '$payments' }, { $group: { _id: { d: day('$completedAt'), m: '$payments.method' }, amountCents: { $sum: '$payments.amountCents' } } }]),
    SaleReturn.aggregate([{ $match: returnMatch(p) }, { $group: { _id: { d: day('$createdAt'), m: '$refundMethod' }, count: { $sum: 1 }, refundCents: { $sum: '$refundCents' } } }]),
    Sale.aggregate([{ $match: voidMatch }, { $group: { _id: day('$voidedAt'), count: { $sum: 1 }, totalCents: { $sum: '$totalCents' } } }]),
  ]);
  const days = [...new Set([...sales.map((s) => s._id), ...returns.map((r) => r._id.d), ...voids.map((v) => v._id)])].sort();
  const rows = days.map((d) => {
    const s = sales.find((x) => x._id === d);
    const pay = (m: string[]) => payments.filter((x) => x._id.d === d && m.includes(x._id.m)).reduce((a, x) => a + x.amountCents, 0);
    const refunds = returns.filter((x) => x._id.d === d);
    const refund = (m: string[]) => refunds.filter((x) => m.includes(x._id.m)).reduce((a, x) => a + x.refundCents, 0);
    const v = voids.find((x) => x._id === d);
    const cashCents = pay(['cash']);
    const mpesaCents = pay(['mpesa', 'gateway']);
    const cardCents = pay(['card']);
    const bankCents = pay(['bank']);
    const creditCents = pay(['credit']);
    const otherCents = pay(['loyalty', 'other']);
    const refundsPaidCents = refund(['cash', 'mpesa', 'card']);
    return {
      date: d, salesCount: s?.count ?? 0, grossCents: s?.grossCents ?? 0, discountCents: s?.discountCents ?? 0, taxCents: s?.taxCents ?? 0, netCents: s?.netCents ?? 0,
      grossProfitCents: (s?.netCents ?? 0) - (s?.costCents ?? 0), avgBasketCents: s?.count ? Math.round(s.grossCents / s.count) : 0, linesPerBasket: s?.count ? Math.round((s.items / s.count) * 10) / 10 : 0,
      cashCents, mpesaCents, cardCents, bankCents, creditCents, otherCents,
      returnsCount: refunds.reduce((a, x) => a + x.count, 0), returnsCents: refund(['cash', 'mpesa', 'card', 'account', 'credit_note']), cashRefundsCents: refund(['cash']),
      voidsCount: v?.count ?? 0, voidsCents: v?.totalCents ?? 0,
      netCollectedCents: cashCents + mpesaCents + cardCents + bankCents - refundsPaidCents,
    };
  });
  const totals = rows.reduce<Record<string, number>>((a, r) => {
    for (const [k, v] of Object.entries(r)) if (typeof v === 'number' && k !== 'avgBasketCents' && k !== 'linesPerBasket') a[k] = (a[k] ?? 0) + v;
    return a;
  }, {});
  totals.avgBasketCents = totals.salesCount ? Math.round(totals.grossCents / totals.salesCount) : 0;
  send(res, p.format, 'daily-summary', rows, { totals });
});

const BASKET_BUCKETS = [0, 10_000, 50_000, 100_000, 250_000, 500_000, 1_000_000];

router.get('/reports/basket', requirePermission('reports.read'), async (req, res) => {
  const p = period(req);
  const [summary, buckets, heat] = await Promise.all([
    Sale.aggregate([
      { $match: saleMatch(p) },
      { $project: { totalCents: 1, lines: { $size: '$lines' }, units: { $sum: '$lines.qty' }, customerId: 1 } },
      { $group: { _id: null, count: { $sum: 1 }, grossCents: { $sum: '$totalCents' }, lines: { $sum: '$lines' }, units: { $sum: '$units' }, maxCents: { $max: '$totalCents' }, withCustomer: { $sum: { $cond: [{ $ifNull: ['$customerId', false] }, 1, 0] } } } },
    ]),
    Sale.aggregate([{ $match: saleMatch(p) }, { $bucket: { groupBy: '$totalCents', boundaries: BASKET_BUCKETS, default: 'more', output: { count: { $sum: 1 }, grossCents: { $sum: '$totalCents' } } } }]),
    Sale.aggregate([
      { $match: saleMatch(p) },
      { $group: { _id: { d: { $dayOfWeek: { date: '$completedAt', timezone: p.tz } }, h: { $hour: { date: '$completedAt', timezone: p.tz } } }, count: { $sum: 1 }, grossCents: { $sum: '$totalCents' } } },
    ]),
  ]);
  const s = summary[0];
  const label = (lo: number, hi?: number) => (hi === undefined ? `${lo / 100}+` : `${lo / 100}–${hi / 100}`);
  res.json({
    data: {
      summary: {
        transactions: s?.count ?? 0, grossCents: s?.grossCents ?? 0, avgBasketCents: s?.count ? Math.round(s.grossCents / s.count) : 0,
        avgLines: s?.count ? Math.round((s.lines / s.count) * 10) / 10 : 0, avgUnits: s?.count ? Math.round((s.units / s.count) * 10) / 10 : 0,
        largestCents: s?.maxCents ?? 0, identifiedCustomersBp: s?.count ? Math.round((s.withCustomer / s.count) * 10_000) : 0,
      },
      buckets: buckets.map((b) => {
        const i = BASKET_BUCKETS.indexOf(b._id as number);
        return { label: b._id === 'more' ? label(BASKET_BUCKETS.at(-1)!) : label(BASKET_BUCKETS[i], BASKET_BUCKETS[i + 1]), count: b.count, grossCents: b.grossCents };
      }),
      // weekday 1 = Sunday ... 7 = Saturday; hour 0-23 in the business timezone.
      heatmap: heat.map((h) => ({ weekday: h._id.d, hour: h._id.h, count: h.count, grossCents: h.grossCents })),
    },
  });
});

router.get('/reports/discounts', requirePermission('reports.read'), async (req, res) => {
  const p = period(req);
  const [byCashier, byProduct, byPromotion] = await Promise.all([
    Sale.aggregate([{ $match: { ...saleMatch(p), discountCents: { $gt: 0 } } }, { $group: { _id: '$cashierId', count: { $sum: 1 }, discountCents: { $sum: '$discountCents' }, grossCents: { $sum: '$grossCents' } } }, { $sort: { discountCents: -1 } }]),
    Sale.aggregate([
      { $match: saleMatch(p) }, { $unwind: '$lines' },
      { $project: { productId: '$lines.productId', name: '$lines.name', d: { $add: [{ $ifNull: ['$lines.discountCents', 0] }, { $ifNull: ['$lines.cartDiscountCents', 0] }] } } },
      { $match: { d: { $gt: 0 } } },
      { $group: { _id: '$productId', name: { $first: '$name' }, count: { $sum: 1 }, discountCents: { $sum: '$d' } } }, { $sort: { discountCents: -1 } }, { $limit: 100 },
    ]),
    Sale.aggregate([
      { $match: saleMatch(p) }, { $unwind: '$lines' }, { $match: { 'lines.promotionId': { $ne: null } } },
      { $group: { _id: '$lines.promotionId', count: { $sum: 1 }, discountCents: { $sum: { $ifNull: ['$lines.discountCents', 0] } }, salesCents: { $sum: '$lines.totalCents' } } }, { $sort: { discountCents: -1 } },
    ]),
  ]);
  const names = await userNames(byCashier.map((r) => r._id));
  const promos = new Map((await Promotion.find({ _id: { $in: byPromotion.map((r) => r._id) } }, { name: 1 }).lean()).map((x: any) => [String(x._id), x.name]));
  res.json({
    data: {
      totalCents: byCashier.reduce((a, r) => a + r.discountCents, 0),
      byCashier: byCashier.map((r) => ({ ...r, name: names.get(String(r._id)) ?? 'Unknown', rateBp: r.grossCents ? Math.round((r.discountCents / r.grossCents) * 10_000) : 0 })),
      byProduct,
      byPromotion: byPromotion.map((r) => ({ ...r, name: promos.get(String(r._id)) ?? 'Removed promotion' })),
    },
  });
});

async function onHandByProduct(warehouses: Types.ObjectId[] | null) {
  const rows = await StockLevel.aggregate([{ $match: warehouses ? { warehouseId: { $in: warehouses } } : {} }, { $group: { _id: '$productId', qty: { $sum: '$qty' }, valueCents: { $sum: { $multiply: ['$qty', '$avgCostCents'] } } } }]);
  return new Map(rows.map((r) => [String(r._id), { qty: r.qty as number, valueCents: Math.round(r.valueCents) }]));
}

/** ABC classes by cumulative share of net revenue: A = first 80 %, B = next 15 %, C = the rest. */
export function abcClass(cumulativeShare: number) {
  return cumulativeShare <= 0.8 ? 'A' : cumulativeShare <= 0.95 ? 'B' : 'C';
}

router.get('/reports/product-performance', requirePermission('reports.financial'), async (req, res) => {
  const p = period(req);
  const days = Math.max(1, Math.round((p.end.getTime() - p.start.getTime()) / 86400_000));
  const sold = await Sale.aggregate([
    { $match: saleMatch(p) }, { $unwind: '$lines' },
    { $group: { _id: '$lines.productId', name: { $first: '$lines.name' }, sku: { $first: '$lines.sku' }, qty: { $sum: { $subtract: ['$lines.baseQty', { $multiply: [{ $ifNull: ['$lines.returnedQty', 0] }, { $ifNull: ['$lines.unitFactor', 1] }] }] } }, grossCents: { $sum: '$lines.totalCents' }, netCents: { $sum: '$lines.netCents' }, costCents: { $sum: '$lines.costCents' }, baskets: { $sum: 1 } } },
    { $sort: { netCents: -1 } },
  ]);
  const stock = await onHandByProduct(await scopedWarehouses(p));
  const totalNet = sold.reduce((a, r) => a + Math.max(0, r.netCents), 0);
  let cumulative = 0;
  const rows = sold.map((r, i) => {
    cumulative += Math.max(0, r.netCents);
    const onHand = stock.get(String(r._id))?.qty ?? 0;
    const perDay = r.qty / days;
    const profit = r.netCents - r.costCents;
    return {
      rank: i + 1, productId: r._id, name: r.name, sku: r.sku, abc: abcClass(totalNet ? cumulative / totalNet : 1), qtySold: Math.round(r.qty * 1000) / 1000, baskets: r.baskets,
      grossCents: r.grossCents, netCents: r.netCents, costCents: r.costCents, grossProfitCents: profit, marginBp: r.netCents ? Math.round((profit / r.netCents) * 10_000) : 0,
      shareBp: totalNet ? Math.round((Math.max(0, r.netCents) / totalNet) * 10_000) : 0, onHand, daysOfCover: perDay > 0 ? Math.round(onHand / perDay) : null,
    };
  });
  const classes = ['A', 'B', 'C'].map((c) => ({ class: c, products: rows.filter((r) => r.abc === c).length, netCents: rows.filter((r) => r.abc === c).reduce((a, r) => a + r.netCents, 0) }));
  send(res, p.format, 'product-performance', rows, { classes, days });
});

/** Products holding stock that have not sold for `days` days. */
router.get('/reports/dead-stock', requirePermission('reports.read'), async (req, res) => {
  const p = period(req);
  const days = parse(z.coerce.number().int().min(1).max(730).default(30), p.query.days);
  const warehouses = await scopedWarehouses(p);
  const since = new Date(Date.now() - days * 86400_000);
  const stock = await StockLevel.aggregate([
    { $match: { qty: { $gt: 0 }, ...(warehouses ? { warehouseId: { $in: warehouses } } : {}) } },
    { $group: { _id: '$productId', qty: { $sum: '$qty' }, valueCents: { $sum: { $multiply: ['$qty', '$avgCostCents'] } } } },
  ]);
  // Last sale, and last time stock arrived (a product never sold counts from its latest delivery).
  const moves = await StockMovement.aggregate([
    { $match: { type: { $in: ['sale', 'opening', 'purchase_receipt', 'transfer_in'] }, productId: { $in: stock.map((s) => s._id) }, ...(warehouses ? { warehouseId: { $in: warehouses } } : {}) } },
    { $group: { _id: { p: '$productId', sale: { $eq: ['$type', 'sale'] } }, at: { $max: '$at' } } },
  ]);
  const lastSold = new Map(moves.filter((m) => m._id.sale).map((r) => [String(r._id.p), r.at as Date]));
  const lastIn = new Map(moves.filter((m) => !m._id.sale).map((r) => [String(r._id.p), r.at as Date]));
  const products = new Map((await Product.find({ _id: { $in: stock.map((s) => s._id) }, active: { $ne: false } }, { name: 1, sku: 1, baseUnit: 1, createdAt: 1, prices: 1 }).lean()).map((x: any) => [String(x._id), x]));
  const rows = stock
    .filter((s) => products.has(String(s._id)))
    .map((s) => {
      const prod = products.get(String(s._id));
      const last = lastSold.get(String(s._id));
      return { productId: s._id, name: prod.name, sku: prod.sku, qty: s.qty, unit: prod.baseUnit, valueCents: Math.round(s.valueCents), retailValueCents: Math.round(s.qty * (prod.prices?.retail ?? 0)), lastSoldAt: last ?? null, daysSinceSale: last ? Math.floor((Date.now() - last.getTime()) / 86400_000) : null, inStockSince: lastIn.get(String(s._id)) ?? prod.createdAt };
    })
    .filter((r) => (r.lastSoldAt ? r.lastSoldAt < since : new Date(r.inStockSince) < since))
    .sort((a, b) => b.valueCents - a.valueCents);
  send(res, p.format, 'dead-stock', rows, { days, totalValueCents: rows.reduce((a, r) => a + r.valueCents, 0) });
});

/**
 * Reorder suggestions from the sales rate of the last `days` days:
 *   reorder point = max(reorder level, average daily sales × lead time × 1.5)
 *   when on hand + on order ≤ reorder point, order enough to cover lead time + `coverDays`
 *   (at least the product's reorder quantity).
 */
router.get('/reports/reorder', requirePermission('inventory.read'), async (req, res) => {
  const p = period(req);
  const q = parse(z.object({ days: z.coerce.number().int().min(7).max(365).default(28), leadDays: z.coerce.number().int().min(0).max(120).default(7), coverDays: z.coerce.number().int().min(1).max(180).default(14), warehouseId: objectId.optional() }), p.query);
  const warehouses = await scopedWarehouses(p, q.warehouseId);
  const whMatch = warehouses ? { warehouseId: { $in: warehouses } } : {};
  const since = new Date(Date.now() - q.days * 86400_000);
  const [products, rate, onOrder] = await Promise.all([
    Product.find({ trackStock: true, type: 'stock', active: { $ne: false } }, { name: 1, sku: 1, baseUnit: 1, reorderLevel: 1, reorderQty: 1, costCents: 1 }).lean(),
    StockMovement.aggregate([{ $match: { type: { $in: ['sale', 'sale_return'] }, at: { $gte: since }, ...whMatch } }, { $group: { _id: '$productId', qty: { $sum: '$qty' } } }]),
    PurchaseOrder.aggregate([
      { $match: { status: { $in: ['sent', 'partially_received'] }, ...whMatch } }, { $unwind: '$lines' },
      { $group: { _id: '$lines.productId', qty: { $sum: { $multiply: [{ $subtract: ['$lines.qty', { $ifNull: ['$lines.receivedQty', 0] }] }, { $ifNull: ['$lines.factor', 1] }] } } } },
    ]),
  ]);
  const stock = await onHandByProduct(warehouses);
  const sold = new Map(rate.map((r) => [String(r._id), -r.qty as number]));
  const ordered = new Map(onOrder.map((r) => [String(r._id), r.qty as number]));
  const rows: Record<string, any>[] = [];
  for (const prod of products) {
    const id = String(prod._id);
    const perDay = Math.max(0, sold.get(id) ?? 0) / q.days;
    const onHand = stock.get(id)?.qty ?? 0;
    const incoming = ordered.get(id) ?? 0;
    const reorderPoint = Math.max(prod.reorderLevel ?? 0, Math.ceil(perDay * q.leadDays * 1.5));
    if (reorderPoint <= 0 || onHand + incoming > reorderPoint) continue;
    const suggestQty = Math.max(prod.reorderQty ?? 0, Math.ceil(perDay * (q.leadDays + q.coverDays) - onHand - incoming), 1);
    rows.push({ productId: prod._id, name: prod.name, sku: prod.sku, unit: prod.baseUnit, onHand, onOrder: incoming, avgDailySales: Math.round(perDay * 100) / 100, reorderPoint, suggestQty, estCostCents: Math.round(suggestQty * (prod.costCents ?? 0)), daysLeft: perDay > 0 ? Math.floor(onHand / perDay) : null });
  }
  // Last supplier each product was received from, to group the order.
  const last = await GoodsReceipt.aggregate([
    { $match: { 'lines.productId': { $in: rows.map((r) => r.productId) } } }, { $sort: { createdAt: -1 } }, { $unwind: '$lines' },
    { $match: { 'lines.productId': { $in: rows.map((r) => r.productId) } } }, { $group: { _id: '$lines.productId', supplierId: { $first: '$supplierId' } } },
  ]);
  const supplierOf = new Map(last.map((r) => [String(r._id), r.supplierId]));
  const suppliers = new Map((await Supplier.find({ _id: { $in: last.map((r) => r.supplierId) } }, { name: 1 }).lean()).map((x: any) => [String(x._id), x.name]));
  for (const r of rows) {
    const sid = supplierOf.get(String(r.productId));
    r.supplierId = sid ?? null;
    r.supplier = sid ? suppliers.get(String(sid)) ?? '' : '';
  }
  rows.sort((a, b) => (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999) || String(a.supplier).localeCompare(String(b.supplier)));
  send(res, p.format, 'reorder', rows, { params: { days: q.days, leadDays: q.leadDays, coverDays: q.coverDays }, totalCostCents: rows.reduce((a, r) => a + r.estCostCents, 0) });
});

export const retailReports = router;
