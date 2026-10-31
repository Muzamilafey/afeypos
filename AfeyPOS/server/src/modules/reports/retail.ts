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

/**
 * Stock analysis: what sells together, what the stock will do next, and what is tying money up.
 *   pairs        products bought together in the same receipt (how often, and how much of one is with the other)
 *   forecastDays stock, sales per day, days of cover and the day it runs out, with how much to order
 *   forecastMonths what each month used the last 6 months, and what the next 3 are expected to need
 *   overstock    stock worth more than months of sales (money standing still)
 *   seasonality  sales per weekday and month, so buying follows the busy days
 * Predictions are an average of the last weeks: they follow what the shop actually sold, nothing more.
 */
router.get('/reports/stock-analysis', requirePermission('inventory.read'), async (req, res) => {
  const p = period(req);
  const q = parse(z.object({
    tab: z.enum(['pairs', 'forecastDays', 'forecastMonths', 'overstock', 'seasonality']).default('forecastDays'),
    days: z.coerce.number().int().min(7).max(365).default(28),
    leadDays: z.coerce.number().int().min(0).max(120).default(7),
    coverDays: z.coerce.number().int().min(1).max(180).default(14),
    warehouseId: objectId.optional(),
  }), p.query);
  const warehouses = await scopedWarehouses(p, q.warehouseId);
  const whMatch = warehouses ? { warehouseId: { $in: warehouses } } : {};
  const dayMs = 86400_000;

  if (q.tab === 'pairs') {
    // Receipts with at least two different products in the chosen period.
    const sales = await Sale.find({ ...saleMatch(p), 'lines.1': { $exists: true } }, { lines: { productId: 1, name: 1, baseQty: 1, totalCents: 1 } }).limit(20_000).lean();
    const pairs = new Map<string, { a: string; b: string; count: number; cents: number }>();
    const alone = new Map<string, number>();
    const names = new Map<string, string>();
    for (const sale of sales) {
      const items = new Map<string, number>();
      for (const l of sale.lines ?? []) {
        const id = String((l as any).productId ?? '');
        if (!id) continue;
        names.set(id, (l as any).name ?? '');
        items.set(id, (items.get(id) ?? 0) + ((l as any).totalCents ?? 0));
      }
      const ids = [...items.keys()].sort();
      for (const id of ids) alone.set(id, (alone.get(id) ?? 0) + 1);
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const key = `${ids[i]}|${ids[j]}`;
          const e = pairs.get(key) ?? { a: ids[i]!, b: ids[j]!, count: 0, cents: 0 };
          e.count += 1;
          e.cents += (items.get(ids[i]!) ?? 0) + (items.get(ids[j]!) ?? 0);
          pairs.set(key, e);
        }
      }
    }
    const rows = [...pairs.values()]
      .filter((x) => x.count >= 2)
      .map((x) => ({
        a: names.get(x.a) ?? '', b: names.get(x.b) ?? '', count: x.count, salesCents: x.cents,
        // Of the receipts with A, how many also had B (and the other way round).
        withABp: Math.round((x.count / Math.max(1, alone.get(x.a) ?? 1)) * 10_000),
        withBBp: Math.round((x.count / Math.max(1, alone.get(x.b) ?? 1)) * 10_000),
      }))
      .sort((m, n) => n.count - m.count || n.salesCents - m.salesCents)
      .slice(0, 200);
    send(res, p.format, 'bought-together', rows, { receipts: sales.length });
    return;
  }

  if (q.tab === 'seasonality') {
    const [weekdays, months] = await Promise.all([
      Sale.aggregate([{ $match: saleMatch(p) }, { $group: { _id: { $dayOfWeek: { date: '$completedAt', timezone: p.tz } }, count: { $sum: 1 }, grossCents: { $sum: '$totalCents' }, units: { $sum: { $sum: '$lines.baseQty' } } } }, { $sort: { _id: 1 } }]),
      Sale.aggregate([
        { $match: { ...saleMatch(p), completedAt: { $gte: new Date(Date.now() - 365 * dayMs) } } },
        { $group: { _id: { $dateToString: { date: '$completedAt', format: '%Y-%m', timezone: p.tz } }, count: { $sum: 1 }, grossCents: { $sum: '$totalCents' }, units: { $sum: { $sum: '$lines.baseQty' } } } },
        { $sort: { _id: 1 } },
      ]),
    ]);
    const names = ['', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const avg = weekdays.reduce((a, r) => a + r.grossCents, 0) / Math.max(1, weekdays.length);
    res.json({
      data: {
        weekdays: weekdays.map((r) => ({ name: names[r._id], count: r.count, grossCents: r.grossCents, units: Math.round((r.units ?? 0) * 100) / 100, vsAverageBp: avg ? Math.round(((r.grossCents - avg) / avg) * 10_000) : 0 })),
        months: months.map((r) => ({ month: r._id, count: r.count, grossCents: r.grossCents, units: Math.round((r.units ?? 0) * 100) / 100 })),
      },
    });
    return;
  }

  // The three stock tabs share the sales rate of the last `days` days.
  const since = new Date(Date.now() - q.days * dayMs);
  const [products, rate, onOrder] = await Promise.all([
    Product.find({ trackStock: true, type: 'stock', active: { $ne: false } }, { name: 1, sku: 1, baseUnit: 1, reorderLevel: 1, reorderQty: 1, costCents: 1, prices: 1 }).lean(),
    StockMovement.aggregate([{ $match: { type: { $in: ['sale', 'sale_return'] }, at: { $gte: since }, ...whMatch } }, { $group: { _id: '$productId', qty: { $sum: '$qty' } } }]),
    PurchaseOrder.aggregate([
      { $match: { status: { $in: ['sent', 'partially_received'] }, ...whMatch } }, { $unwind: '$lines' },
      { $group: { _id: '$lines.productId', qty: { $sum: { $multiply: [{ $subtract: ['$lines.qty', { $ifNull: ['$lines.receivedQty', 0] }] }, { $ifNull: ['$lines.factor', 1] }] } } } },
    ]),
  ]);
  const stock = await onHandByProduct(warehouses);
  const sold = new Map(rate.map((r) => [String(r._id), Math.max(0, -(r.qty as number))]));
  const ordered = new Map(onOrder.map((r) => [String(r._id), r.qty as number]));

  if (q.tab === 'forecastDays') {
    const rows = products.map((prod) => {
      const id = String(prod._id);
      const perDay = (sold.get(id) ?? 0) / q.days;
      const onHand = stock.get(id)?.qty ?? 0;
      const incoming = ordered.get(id) ?? 0;
      const daysLeft = perDay > 0 ? Math.floor((onHand + incoming) / perDay) : null;
      const needByCover = Math.ceil(perDay * (q.leadDays + q.coverDays) - onHand - incoming);
      return {
        productId: prod._id, name: prod.name, sku: prod.sku, unit: prod.baseUnit, onHand, onOrder: incoming,
        perDay: Math.round(perDay * 100) / 100, perWeek: Math.round(perDay * 7 * 10) / 10,
        daysLeft, outOn: daysLeft === null ? null : new Date(Date.now() + daysLeft * dayMs),
        expected7: Math.round(perDay * 7 * 10) / 10, expected30: Math.round(perDay * 30 * 10) / 10,
        orderQty: Math.max(0, needByCover), orderCostCents: Math.max(0, needByCover) * (prod.costCents ?? 0),
        status: perDay <= 0 ? (onHand > 0 ? 'not selling' : 'no sales') : daysLeft! <= q.leadDays ? 'order now' : daysLeft! <= q.leadDays + q.coverDays ? 'order soon' : 'enough',
      };
    }).filter((r) => r.onHand > 0 || r.perDay > 0);
    rows.sort((a, b) => (a.daysLeft ?? 99_999) - (b.daysLeft ?? 99_999));
    send(res, p.format, 'stock-forecast-days', rows, {
      params: { days: q.days, leadDays: q.leadDays, coverDays: q.coverDays },
      summary: {
        orderNow: rows.filter((r) => r.status === 'order now').length, orderSoon: rows.filter((r) => r.status === 'order soon').length,
        notSelling: rows.filter((r) => r.status === 'not selling').length, orderCostCents: rows.reduce((a, r) => a + r.orderCostCents, 0),
      },
    });
    return;
  }

  if (q.tab === 'forecastMonths') {
    // What each of the last 6 months used, then the next 3 months from the recent daily rate.
    const start = new Date(Date.now() - 183 * dayMs);
    const history = await StockMovement.aggregate([
      { $match: { type: { $in: ['sale', 'sale_return'] }, at: { $gte: start }, ...whMatch } },
      { $group: { _id: { p: '$productId', m: { $dateToString: { date: '$at', format: '%Y-%m', timezone: p.tz } } }, qty: { $sum: '$qty' } } },
    ]);
    const byProduct = new Map<string, Map<string, number>>();
    for (const h of history) {
      const id = String(h._id.p);
      const m = byProduct.get(id) ?? new Map<string, number>();
      m.set(h._id.m, Math.max(0, -(h.qty as number)));
      byProduct.set(id, m);
    }
    const monthKeys: string[] = [];
    const now = new Date();
    for (let i = 5; i >= 0; i--) monthKeys.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
    const nextKeys: string[] = [];
    for (let i = 1; i <= 3; i++) nextKeys.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1)).toISOString().slice(0, 7));
    const rows = products.map((prod) => {
      const id = String(prod._id);
      const hist = byProduct.get(id) ?? new Map<string, number>();
      const perDay = (sold.get(id) ?? 0) / q.days;
      const past = monthKeys.map((m) => Math.round((hist.get(m) ?? 0) * 100) / 100);
      // A month is about 30.4 days of the recent rate.
      const expected = Math.round(perDay * 30.4 * 10) / 10;
      const onHand = stock.get(id)?.qty ?? 0;
      const need3 = Math.max(0, Math.ceil(expected * 3 - onHand - (ordered.get(id) ?? 0)));
      return {
        productId: prod._id, name: prod.name, sku: prod.sku, unit: prod.baseUnit, onHand,
        months: Object.fromEntries(monthKeys.map((m, i) => [m, past[i]])), lastMonth: past.at(-1) ?? 0, average: Math.round((past.reduce((a, b) => a + b, 0) / Math.max(1, past.filter((x) => x > 0).length || 1)) * 10) / 10,
        expectedPerMonth: expected, next3: Object.fromEntries(nextKeys.map((m) => [m, expected])), orderForNext3: need3, orderCostCents: need3 * (prod.costCents ?? 0),
      };
    }).filter((r) => r.expectedPerMonth > 0 || r.lastMonth > 0);
    rows.sort((a, b) => b.expectedPerMonth - a.expectedPerMonth);
    send(res, p.format, 'stock-forecast-months', rows, { months: monthKeys, nextMonths: nextKeys, totalOrderCostCents: rows.reduce((a, r) => a + r.orderCostCents, 0) });
    return;
  }

  // overstock: stock that will last far longer than it should, with the money standing in it.
  const rows = products.map((prod) => {
    const id = String(prod._id);
    const perDay = (sold.get(id) ?? 0) / q.days;
    const onHand = stock.get(id)?.qty ?? 0;
    const valueCents = stock.get(id)?.valueCents ?? 0;
    const monthsOfCover = perDay > 0 ? Math.round((onHand / (perDay * 30.4)) * 10) / 10 : null;
    const target = Math.ceil(perDay * (q.leadDays + q.coverDays));
    return {
      productId: prod._id, name: prod.name, sku: prod.sku, unit: prod.baseUnit, onHand, valueCents,
      perDay: Math.round(perDay * 100) / 100, monthsOfCover, target, excess: Math.max(0, onHand - target),
      excessValueCents: Math.round(Math.max(0, onHand - target) * (valueCents / Math.max(1, onHand))),
    };
  }).filter((r) => r.onHand > 0 && (r.monthsOfCover === null || r.monthsOfCover >= 2) && r.excess > 0);
  rows.sort((a, b) => b.excessValueCents - a.excessValueCents);
  send(res, p.format, 'overstock', rows, { totalExcessValueCents: rows.reduce((a, r) => a + r.excessValueCents, 0), params: { days: q.days, leadDays: q.leadDays, coverDays: q.coverDays } });
});

export const retailReports = router;
