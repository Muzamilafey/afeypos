/**
 * Reporting. Definitions (documented in docs/REPORTS.md):
 *  - Gross sales: amount charged on completed (non-voided) sales, incl. tax, after discounts.
 *  - Net revenue: gross sales excluding tax, minus returns (excluding tax).
 *  - COGS: weighted-average cost of goods sold, minus cost of restocked returns.
 *  - Gross profit: net revenue - COGS.  Expenses are reported separately; operating profit = gross profit - expenses.
 *  - Cash received: money actually collected (sale payments except credit/loyalty, plus account payments), minus refunds paid.
 *  - Receivables / payables: current customer / supplier balances (not revenue / expenses).
 * Periods are interpreted in the tenant's timezone.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import {
  AuditLog, Branch, CashMovement, Category, Customer, Expense, GoodsReceipt, LedgerEntry, PaymentIntent, Product, Sale, SaleReturn,
  Shift, StockBatch, StockLevel, StockMovement, Supplier, User, Warehouse, Till,
} from '../../models/index.js';
import { objectId, parse } from '../../http/validate.js';
import { requirePermission, requireModule } from '../../http/auth.js';
import { toCsv } from '../../lib/csv.js';
import { ageing } from '../parties/routes.js';

const router = Router();

/** Offset (ms) of a timezone at a given instant. */
function tzOffsetMs(at: Date, tz: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return asUtc - at.getTime();
}

/** Converts a local calendar date (YYYY-MM-DD) at 00:00 in tz to a UTC instant. */
export function localMidnightUtc(date: string, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d));
  const off = tzOffsetMs(guess, tz);
  const result = new Date(guess.getTime() - off);
  const off2 = tzOffsetMs(result, tz);
  return off2 === off ? result : new Date(guess.getTime() - off2);
}

export function localDateString(at: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

const periodSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  branchId: objectId.optional(),
  format: z.enum(['json', 'csv']).default('json'),
});

function period(req: Request) {
  const q = parse(periodSchema.passthrough(), req.query);
  const tz = req.tenant!.settings?.timezone ?? 'Africa/Nairobi';
  const today = localDateString(new Date(), tz);
  const from = q.from ?? today;
  const to = q.to ?? from;
  const start = localMidnightUtc(from, tz);
  const endDay = new Date(Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10) + 1)).toISOString().slice(0, 10);
  const end = localMidnightUtc(endDay, tz);
  const branchIds = q.branchId ? [q.branchId] : req.auth!.branchIds.length ? req.auth!.branchIds : null;
  return { from, to, start, end, tz, branchIds, format: q.format, query: q as Record<string, any> };
}

function send(res: Response, format: string, name: string, rows: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
    res.send(toCsv(rows));
    return;
  }
  res.json({ data: rows, ...extra });
}

function saleMatch(p: ReturnType<typeof period>) {
  const m: Record<string, unknown> = { completedAt: { $gte: p.start, $lt: p.end }, status: { $ne: 'voided' } };
  if (p.branchIds) m.branchId = { $in: p.branchIds };
  return m;
}

async function returnsTotals(p: ReturnType<typeof period>) {
  const m: Record<string, unknown> = { createdAt: { $gte: p.start, $lt: p.end }, isVoid: { $ne: true } };
  if (p.branchIds) m.branchId = { $in: p.branchIds };
  const [r] = await SaleReturn.aggregate([
    { $match: m },
    { $unwind: '$lines' },
    { $group: { _id: null, refund: { $sum: '$lines.refundCents' }, net: { $sum: '$lines.netCents' }, tax: { $sum: '$lines.taxCents' }, cost: { $sum: '$lines.costCents' }, count: { $addToSet: '$_id' } } },
  ]);
  return { refundCents: r?.refund ?? 0, netCents: r?.net ?? 0, taxCents: r?.tax ?? 0, costCents: r?.cost ?? 0, count: r?.count?.length ?? 0 };
}

router.get('/reports/dashboard', requirePermission('reports.read'), async (req, res) => {
  const p = period(req);
  const [sales] = await Sale.aggregate([{ $match: saleMatch(p) }, { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$totalCents' }, net: { $sum: '$netCents' }, cost: { $sum: '$costCents' }, credit: { $sum: '$creditCents' } } }]);
  const payments = await Sale.aggregate([{ $match: saleMatch(p) }, { $unwind: '$payments' }, { $group: { _id: '$payments.method', total: { $sum: '$payments.amountCents' } } }]);
  const top = await Sale.aggregate([{ $match: saleMatch(p) }, { $unwind: '$lines' }, { $group: { _id: '$lines.productId', name: { $first: '$lines.name' }, qty: { $sum: '$lines.qty' }, total: { $sum: '$lines.totalCents' } } }, { $sort: { total: -1 } }, { $limit: 5 }]);
  const hourly = await Sale.aggregate([{ $match: saleMatch(p) }, { $group: { _id: { $hour: { date: '$completedAt', timezone: p.tz } }, total: { $sum: '$totalCents' }, count: { $sum: 1 } } }, { $sort: { _id: 1 } }]);
  const lowStock = await StockLevel.aggregate([
    { $lookup: { from: 'products', localField: 'productId', foreignField: '_id', as: 'p', pipeline: [{ $match: { tenantId: req.tenant!._id, active: true } }] } },
    { $unwind: '$p' },
    { $match: { 'p.reorderLevel': { $gt: 0 }, $expr: { $lte: ['$qty', '$p.reorderLevel'] } } },
    { $count: 'n' },
  ]);
  const expiring = req.capabilities!.modules.includes('batchExpiry') ? await StockBatch.countDocuments({ qty: { $gt: 0 }, expiryDate: { $lte: new Date(Date.now() + 30 * 86400_000) } }) : 0;
  const openShifts = await Shift.countDocuments({ status: 'open' });
  const [recv] = await Customer.aggregate([{ $match: { balanceCents: { $gt: 0 } } }, { $group: { _id: null, total: { $sum: '$balanceCents' }, count: { $sum: 1 } } }]);
  const ret = await returnsTotals(p);
  res.json({
    data: {
      period: { from: p.from, to: p.to, timezone: p.tz },
      sales: { count: sales?.count ?? 0, grossCents: sales?.total ?? 0, averageCents: sales?.count ? Math.round(sales.total / sales.count) : 0, creditCents: sales?.credit ?? 0 },
      grossProfitCents: (sales?.net ?? 0) - ret.netCents - ((sales?.cost ?? 0) - ret.costCents),
      returnsCents: ret.refundCents,
      paymentMix: payments.map((x) => ({ method: x._id, totalCents: x.total })),
      topProducts: top,
      hourly: hourly.map((h) => ({ hour: h._id, totalCents: h.total, count: h.count })),
      lowStockCount: lowStock[0]?.n ?? 0,
      expiringSoonCount: expiring,
      openShifts,
      receivablesCents: recv?.total ?? 0,
      debtorCount: recv?.count ?? 0,
    },
  });
});

const GROUPS = ['day', 'week', 'month', 'hour', 'product', 'category', 'cashier', 'branch', 'till', 'paymentMethod', 'customer', 'salesRep'] as const;

router.get('/reports/sales', requirePermission('reports.read'), async (req, res) => {
  const p = period(req);
  const groupBy = parse(z.enum(GROUPS).default('day'), p.query.groupBy);
  const match = saleMatch(p);
  let rows: any[];
  if (['day', 'week', 'month', 'hour'].includes(groupBy)) {
    const fmt = { day: '%Y-%m-%d', week: '%G-W%V', month: '%Y-%m', hour: '%H:00' }[groupBy as 'day'];
    rows = await Sale.aggregate([
      { $match: match },
      { $group: { _id: { $dateToString: { date: '$completedAt', format: fmt, timezone: p.tz } }, count: { $sum: 1 }, grossCents: { $sum: '$totalCents' }, netCents: { $sum: '$netCents' }, taxCents: { $sum: '$taxCents' }, discountCents: { $sum: '$discountCents' }, costCents: { $sum: '$costCents' } } },
      { $sort: { _id: 1 } },
    ]);
  } else if (groupBy === 'paymentMethod') {
    rows = await Sale.aggregate([{ $match: match }, { $unwind: '$payments' }, { $group: { _id: '$payments.method', count: { $sum: 1 }, grossCents: { $sum: '$payments.amountCents' } } }, { $sort: { grossCents: -1 } }]);
  } else if (groupBy === 'product' || groupBy === 'category') {
    rows = await Sale.aggregate([
      { $match: match },
      { $unwind: '$lines' },
      { $group: { _id: '$lines.productId', name: { $first: '$lines.name' }, sku: { $first: '$lines.sku' }, qty: { $sum: '$lines.baseQty' }, returnedQty: { $sum: { $multiply: ['$lines.returnedQty', { $ifNull: ['$lines.unitFactor', 1] }] } }, grossCents: { $sum: '$lines.totalCents' }, netCents: { $sum: '$lines.netCents' }, costCents: { $sum: '$lines.costCents' }, discountCents: { $sum: { $add: ['$lines.discountCents', { $ifNull: ['$lines.cartDiscountCents', 0] }] } } } },
      { $sort: { grossCents: -1 } },
      { $limit: 5000 },
    ]);
    if (groupBy === 'category') {
      const prods = new Map((await Product.find({ _id: { $in: rows.map((r) => r._id) } }, { categoryId: 1 }).lean()).map((x) => [String(x._id), x.categoryId ? String(x.categoryId) : 'none']));
      const cats = new Map((await Category.find({}).lean()).map((c) => [String(c._id), c.name]));
      const agg = new Map<string, any>();
      for (const r of rows) {
        const key = prods.get(String(r._id)) ?? 'none';
        const a = agg.get(key) ?? { _id: key, name: cats.get(key) ?? 'Uncategorised', grossCents: 0, netCents: 0, costCents: 0, discountCents: 0 };
        for (const k of ['grossCents', 'netCents', 'costCents', 'discountCents']) a[k] += r[k];
        agg.set(key, a);
      }
      rows = [...agg.values()].sort((a, b) => b.grossCents - a.grossCents);
    }
  } else {
    const field = ({ cashier: '$cashierId', branch: '$branchId', till: '$tillId', customer: '$customerId', salesRep: '$salesRepId' } as Record<string, string>)[groupBy];
    rows = await Sale.aggregate([{ $match: match }, { $group: { _id: field, count: { $sum: 1 }, grossCents: { $sum: '$totalCents' }, netCents: { $sum: '$netCents' }, costCents: { $sum: '$costCents' }, discountCents: { $sum: '$discountCents' }, commissionCents: { $sum: '$commissionCents' } } }, { $sort: { grossCents: -1 } }]);
    const ids = rows.map((r) => r._id).filter(Boolean);
    const model: any = ({ cashier: User, salesRep: User, branch: Branch, till: Till, customer: Customer } as Record<string, unknown>)[groupBy];
    const names = new Map((await model.find({ _id: { $in: ids } }, { name: 1 }).lean()).map((x: any) => [String(x._id), x.name]));
    rows = rows.map((r) => ({ ...r, name: r._id ? names.get(String(r._id)) ?? 'Unknown' : groupBy === 'customer' ? 'Walk-in' : 'Unassigned' }));
  }
  rows = rows.map((r) => ('netCents' in r && 'costCents' in r ? { ...r, grossProfitCents: r.netCents - r.costCents } : r));
  send(res, p.format, `sales-by-${groupBy}`, rows, { period: { from: p.from, to: p.to, timezone: p.tz }, groupBy });
});

router.get('/reports/profit', requirePermission('reports.financial'), async (req, res) => {
  const p = period(req);
  const [s] = await Sale.aggregate([{ $match: saleMatch(p) }, { $group: { _id: null, gross: { $sum: '$totalCents' }, net: { $sum: '$netCents' }, tax: { $sum: '$taxCents' }, cost: { $sum: '$costCents' }, discount: { $sum: '$discountCents' }, credit: { $sum: '$creditCents' }, count: { $sum: 1 } } }]);
  const ret = await returnsTotals(p);
  const expMatch: Record<string, unknown> = { date: { $gte: p.start, $lt: p.end } };
  if (p.branchIds) expMatch.branchId = { $in: p.branchIds };
  const [exp] = await Expense.aggregate([{ $match: expMatch }, { $group: { _id: null, total: { $sum: '$amountCents' } } }]);
  const netRevenue = (s?.net ?? 0) - ret.netCents;
  const cogs = (s?.cost ?? 0) - ret.costCents;
  const gp = netRevenue - cogs;
  const pay = await Sale.aggregate([{ $match: saleMatch(p) }, { $unwind: '$payments' }, { $match: { 'payments.method': { $nin: ['credit', 'loyalty'] } } }, { $group: { _id: null, total: { $sum: '$payments.amountCents' } } }]);
  const [acct] = await LedgerEntry.aggregate([{ $match: { partyType: 'customer', kind: 'payment', at: { $gte: p.start, $lt: p.end } } }, { $group: { _id: null, total: { $sum: '$amountCents' } } }]);
  const refundsPaid = await SaleReturn.aggregate([{ $match: { createdAt: { $gte: p.start, $lt: p.end }, refundMethod: { $in: ['cash', 'mpesa', 'card'] } } }, { $group: { _id: null, total: { $sum: '$refundCents' } } }]);
  const data = {
    period: { from: p.from, to: p.to, timezone: p.tz },
    salesCount: s?.count ?? 0,
    grossSalesCents: s?.gross ?? 0,
    discountsCents: s?.discount ?? 0,
    returnsCents: ret.refundCents,
    outputTaxCents: (s?.tax ?? 0) - ret.taxCents,
    netRevenueCents: netRevenue,
    cogsCents: cogs,
    grossProfitCents: gp,
    grossMarginBp: netRevenue ? Math.round((gp * 10000) / netRevenue) : 0,
    expensesCents: exp?.total ?? 0,
    operatingProfitCents: gp - (exp?.total ?? 0),
    cashReceivedCents: (pay[0]?.total ?? 0) + -(acct?.total ?? 0) - (refundsPaid[0]?.total ?? 0),
    creditSalesCents: s?.credit ?? 0,
  };
  send(res, p.format, 'profit', [data], {});
});

router.get('/reports/inventory-valuation', requirePermission('reports.financial'), async (req, res) => {
  const p = period(req);
  const warehouseId = p.query.warehouseId ? parse(objectId, p.query.warehouseId) : undefined;
  const rows = await StockLevel.aggregate([
    { $match: { qty: { $ne: 0 }, ...(warehouseId ? { warehouseId } : {}) } },
    { $lookup: { from: 'products', localField: 'productId', foreignField: '_id', as: 'p', pipeline: [{ $match: { tenantId: req.tenant!._id } }, { $project: { name: 1, sku: 1, baseUnit: 1, prices: 1 } }] } },
    { $unwind: '$p' },
    { $project: { productId: 1, warehouseId: 1, name: '$p.name', sku: '$p.sku', unit: '$p.baseUnit', qty: 1, avgCostCents: 1, valueCents: { $round: [{ $multiply: ['$qty', '$avgCostCents'] }, 0] }, retailValueCents: { $round: [{ $multiply: ['$qty', { $ifNull: ['$p.prices.retail', 0] }] }, 0] } } },
    { $sort: { valueCents: -1 } },
  ]);
  const total = rows.reduce((a, r) => a + r.valueCents, 0);
  send(res, p.format, 'inventory-valuation', rows, { totalValueCents: total, retailValueCents: rows.reduce((a, r) => a + r.retailValueCents, 0), costingMethod: 'weighted_average' });
});

router.get('/reports/stock-movements', requirePermission('reports.read'), async (req, res) => {
  const p = period(req);
  const rows = await StockMovement.aggregate([
    { $match: { at: { $gte: p.start, $lt: p.end } } },
    { $group: { _id: '$type', count: { $sum: 1 }, qty: { $sum: '$qty' }, valueCents: { $sum: { $round: [{ $multiply: ['$qty', '$unitCostCents'] }, 0] } } } },
    { $sort: { _id: 1 } },
  ]);
  send(res, p.format, 'stock-movements', rows, { period: { from: p.from, to: p.to } });
});

router.get('/reports/losses', requirePermission('reports.read'), async (req, res) => {
  const p = period(req);
  const rows = await StockMovement.aggregate([
    { $match: { at: { $gte: p.start, $lt: p.end }, type: { $in: ['damage', 'wastage', 'expiry', 'stocktake', 'adjustment'] }, qty: { $lt: 0 } } },
    { $group: { _id: { type: '$type', productId: '$productId' }, qty: { $sum: '$qty' }, valueCents: { $sum: { $round: [{ $multiply: ['$qty', '$unitCostCents'] }, 0] } } } },
    { $lookup: { from: 'products', localField: '_id.productId', foreignField: '_id', as: 'p', pipeline: [{ $match: { tenantId: req.tenant!._id } }, { $project: { name: 1, sku: 1 } }] } },
    { $project: { type: '$_id.type', name: { $first: '$p.name' }, sku: { $first: '$p.sku' }, qty: 1, valueCents: 1 } },
    { $sort: { valueCents: 1 } },
  ]);
  send(res, p.format, 'losses', rows);
});

router.get('/reports/low-stock', requirePermission('inventory.read'), async (req, res) => {
  const p = period(req);
  const rows = await StockLevel.aggregate([
    { $lookup: { from: 'products', localField: 'productId', foreignField: '_id', as: 'p', pipeline: [{ $match: { tenantId: req.tenant!._id, active: true } }] } },
    { $unwind: '$p' },
    { $match: { 'p.reorderLevel': { $gt: 0 }, $expr: { $lte: ['$qty', '$p.reorderLevel'] } } },
    { $project: { productId: 1, warehouseId: 1, name: '$p.name', sku: '$p.sku', qty: 1, reorderLevel: '$p.reorderLevel', reorderQty: '$p.reorderQty' } },
    { $sort: { qty: 1 } },
  ]);
  send(res, p.format, 'low-stock', rows);
});

router.get('/reports/expiry', requirePermission('inventory.read'), requireModule('batchExpiry'), async (req, res) => {
  const p = period(req);
  const days = Number(p.query.days ?? 60);
  const rows = await StockBatch.aggregate([
    { $match: { qty: { $gt: 0 }, expiryDate: { $lte: new Date(Date.now() + days * 86400_000) } } },
    { $lookup: { from: 'products', localField: 'productId', foreignField: '_id', as: 'p', pipeline: [{ $match: { tenantId: req.tenant!._id } }, { $project: { name: 1, sku: 1 } }] } },
    { $project: { batchNo: 1, expiryDate: 1, qty: 1, warehouseId: 1, name: { $first: '$p.name' }, sku: { $first: '$p.sku' }, expired: { $lt: ['$expiryDate', new Date()] } } },
    { $sort: { expiryDate: 1 } },
  ]);
  send(res, p.format, 'expiry', rows);
});

router.get('/reports/exceptions', requirePermission('reports.read'), async (req, res) => {
  const p = period(req);
  const range = { $gte: p.start, $lt: p.end };
  const [voids, returns, discounts, overrides] = await Promise.all([
    Sale.find({ status: 'voided', voidedAt: range }, { number: 1, totalCents: 1, voidReason: 1, voidedBy: 1, voidedAt: 1 }).lean(),
    SaleReturn.find({ createdAt: range }, { number: 1, refundCents: 1, refundMethod: 1, reason: 1, processedBy: 1, createdAt: 1, isVoid: 1 }).lean(),
    Sale.find({ completedAt: range, discountCents: { $gt: 0 }, status: { $ne: 'voided' } }, { number: 1, discountCents: 1, grossCents: 1, cashierId: 1, overrides: 1, completedAt: 1 }).lean(),
    Sale.find({ completedAt: range, 'overrides.0': { $exists: true } }, { number: 1, overrides: 1, cashierId: 1 }).lean(),
  ]);
  res.json({ data: { voids, returns, discounts, overrides, totals: { voidsCents: voids.reduce((a, v) => a + v.totalCents, 0), returnsCents: returns.reduce((a, r) => a + (r.refundCents ?? 0), 0), discountsCents: discounts.reduce((a, d) => a + d.discountCents, 0) } } });
});

router.get('/reports/shifts', requirePermission('reports.read'), async (req, res) => {
  const p = period(req);
  const rows = await Shift.find({ openedAt: { $gte: p.start, $lt: p.end } }).sort({ openedAt: -1 }).populate('userId', 'name').populate('tillId', 'name code').lean();
  send(res, p.format, 'shifts', rows.map((s: any) => ({ number: s.number, till: s.tillId?.name, cashier: s.userId?.name, status: s.status, openedAt: s.openedAt, closedAt: s.closedAt, openingFloatCents: s.openingFloatCents, expectedCashCents: s.expectedCashCents, countedCashCents: s.countedCashCents, varianceCents: s.varianceCents, salesCount: s.salesCount, salesTotalCents: s.salesTotalCents })));
});

router.get('/reports/mpesa', requirePermission('payments.reconcile'), async (req, res) => {
  const p = period(req);
  const rows = await PaymentIntent.aggregate([
    { $match: { provider: 'mpesa', createdAt: { $gte: p.start, $lt: p.end } } },
    { $group: { _id: { status: '$status', source: '$source' }, count: { $sum: 1 }, amountCents: { $sum: { $ifNull: ['$paidAmountCents', '$amountCents'] } }, allocatedCents: { $sum: '$allocatedCents' } } },
  ]);
  const unallocated = await PaymentIntent.find({ provider: 'mpesa', createdAt: { $gte: p.start, $lt: p.end }, status: 'succeeded', $expr: { $lt: ['$allocatedCents', '$paidAmountCents'] } }).lean();
  res.json({ data: { summary: rows, unallocated } });
});

router.get('/reports/receivables', requirePermission('reports.financial'), async (_req, res) => {
  const rows = await ageing('customer');
  const names = new Map((await Customer.find({ _id: { $in: rows.map((r) => r._id) } }, { name: 1, creditLimitCents: 1, balanceCents: 1 }).lean()).map((c) => [String(c._id), c]));
  res.json({ data: rows.map((r) => ({ ...r, customer: names.get(String(r._id)) })), totalCents: rows.reduce((a, r) => a + r.total, 0) });
});

router.get('/reports/payables', requirePermission('reports.financial'), async (_req, res) => {
  const rows = await ageing('supplier');
  const names = new Map((await Supplier.find({ _id: { $in: rows.map((r) => r._id) } }, { name: 1 }).lean()).map((c) => [String(c._id), c]));
  res.json({ data: rows.map((r) => ({ ...r, supplier: names.get(String(r._id)) })), totalCents: rows.reduce((a, r) => a + r.total, 0) });
});

router.get('/reports/purchases', requirePermission('reports.financial'), async (req, res) => {
  const p = period(req);
  const rows = await GoodsReceipt.aggregate([{ $match: { createdAt: { $gte: p.start, $lt: p.end } } }, { $group: { _id: '$supplierId', count: { $sum: 1 }, totalCents: { $sum: '$totalCents' }, taxCents: { $sum: '$taxCents' }, paidCents: { $sum: '$paidCents' } } }, { $sort: { totalCents: -1 } }]);
  const names = new Map((await Supplier.find({ _id: { $in: rows.map((r) => r._id) } }, { name: 1 }).lean()).map((c) => [String(c._id), c.name]));
  send(res, p.format, 'purchases', rows.map((r) => ({ ...r, supplier: names.get(String(r._id)) })));
});

router.get('/reports/expenses', requirePermission('reports.financial'), async (req, res) => {
  const p = period(req);
  const rows = await Expense.aggregate([{ $match: { date: { $gte: p.start, $lt: p.end } } }, { $group: { _id: '$category', count: { $sum: 1 }, totalCents: { $sum: '$amountCents' } } }, { $sort: { totalCents: -1 } }]);
  const cash = await CashMovement.aggregate([{ $match: { at: { $gte: p.start, $lt: p.end } } }, { $group: { _id: '$type', count: { $sum: 1 }, totalCents: { $sum: '$amountCents' } } }]);
  res.json({ data: rows, cashMovements: cash });
});

router.get('/reports/tax', requirePermission('reports.financial'), async (req, res) => {
  const p = period(req);
  const byRate = await Sale.aggregate([{ $match: saleMatch(p) }, { $unwind: '$lines' }, { $group: { _id: '$lines.taxRateBp', netCents: { $sum: '$lines.netCents' }, taxCents: { $sum: '$lines.taxCents' } } }, { $sort: { _id: 1 } }]);
  const ret = await returnsTotals(p);
  const [inputGrn] = await GoodsReceipt.aggregate([{ $match: { createdAt: { $gte: p.start, $lt: p.end } } }, { $group: { _id: null, tax: { $sum: '$taxCents' } } }]);
  const [inputExp] = await Expense.aggregate([{ $match: { date: { $gte: p.start, $lt: p.end } } }, { $group: { _id: null, tax: { $sum: '$taxCents' } } }]);
  const output = byRate.reduce((a, r) => a + r.taxCents, 0) - ret.taxCents;
  const input = (inputGrn?.tax ?? 0) + (inputExp?.tax ?? 0);
  res.json({ data: { period: { from: p.from, to: p.to }, outputByRate: byRate.map((r) => ({ rateBp: r._id, netCents: r.netCents, taxCents: r.taxCents })), returnsTaxCents: ret.taxCents, outputTaxCents: output, inputTaxCents: input, netTaxPayableCents: output - input, note: 'Indicative only. Confirm with your tax adviser and KRA eTIMS requirements.' } });
});

router.get('/reports/branches', requirePermission('reports.read'), async (req, res) => {
  const p = period(req);
  const rows = await Sale.aggregate([{ $match: saleMatch(p) }, { $group: { _id: '$branchId', count: { $sum: 1 }, grossCents: { $sum: '$totalCents' }, netCents: { $sum: '$netCents' }, costCents: { $sum: '$costCents' } } }]);
  const branches = await Branch.find({}).lean();
  const warehouses = await Warehouse.find({}).lean();
  const stock = await StockLevel.aggregate([{ $group: { _id: '$warehouseId', valueCents: { $sum: { $multiply: ['$qty', '$avgCostCents'] } } } }]);
  const stockByBranch = new Map<string, number>();
  for (const s of stock) {
    const w = warehouses.find((x) => String(x._id) === String(s._id));
    if (w) stockByBranch.set(String(w.branchId), (stockByBranch.get(String(w.branchId)) ?? 0) + Math.round(s.valueCents));
  }
  send(res, p.format, 'branches', branches.map((b) => {
    const r = rows.find((x) => String(x._id) === String(b._id));
    return { branch: b.name, code: b.code, salesCount: r?.count ?? 0, grossCents: r?.grossCents ?? 0, grossProfitCents: (r?.netCents ?? 0) - (r?.costCents ?? 0), stockValueCents: stockByBranch.get(String(b._id)) ?? 0 };
  }));
});

router.get('/reports/activity', requirePermission('audit.read'), async (req, res) => {
  const p = period(req);
  const rows = await AuditLog.aggregate([{ $match: { at: { $gte: p.start, $lt: p.end } } }, { $group: { _id: { user: '$actor.name', action: '$action' }, count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 500 }]);
  send(res, p.format, 'activity', rows.map((r) => ({ user: r._id.user, action: r._id.action, count: r.count })));
});

export const reportRoutes = router;
export { Types };
