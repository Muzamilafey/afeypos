/**
 * "My dashboard" for staff who are not owners or administrators: what matters for their role, read with their own
 * permissions and branches (the branch scope applies to every query here).
 *  - selling roles: their own sales today and this week, their open shift, what they sold;
 *  - stock roles: low and out of stock, transfers on the way, adjustments to approve, stock movement;
 *  - buying roles: purchase orders by status and awaiting delivery, what is owed to suppliers.
 */
import { Router } from 'express';
import { Types } from 'mongoose';
import { PurchaseOrder, Sale, Shift, StockAdjustment, StockBatch, StockLevel, StockMovement, StockTransfer, Stocktake, Supplier } from '../../models/index.js';
import { signedIn } from '../../http/auth.js';
import { localDateString, localMidnightUtc } from '../reports/routes.js';

const router = Router();

// Every signed-in user: each section below is shown only with the permission it needs.
router.get('/dashboard/me', signedIn('each section checks its own permission'), async (req, res) => {
  const perms = new Set(req.auth!.permissions);
  const has = (p: string) => perms.has(p as never);
  const tz = req.tenant!.settings?.timezone ?? 'Africa/Nairobi';
  const today = localDateString(new Date(), tz);
  const start = localMidnightUtc(today, tz);
  const weekStart = new Date(start.getTime() - 6 * 86400_000);
  const me = new Types.ObjectId(String(req.auth!.userId));
  const out: Record<string, unknown> = { today };

  if (has('sales.create')) {
    const mine = { cashierId: me, status: { $ne: 'voided' } };
    const [todayTot, week, pay, items, recent, shift] = await Promise.all([
      Sale.aggregate([{ $match: { ...mine, completedAt: { $gte: start } } }, { $group: { _id: null, n: { $sum: 1 }, total: { $sum: '$totalCents' } } }]),
      Sale.aggregate([{ $match: { ...mine, completedAt: { $gte: weekStart } } }, { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$completedAt', timezone: tz } }, n: { $sum: 1 }, total: { $sum: '$totalCents' } } }]),
      Sale.aggregate([{ $match: { ...mine, completedAt: { $gte: start } } }, { $unwind: '$payments' }, { $group: { _id: '$payments.method', total: { $sum: '$payments.amountCents' } } }, { $sort: { total: -1 } }]),
      Sale.aggregate([{ $match: { ...mine, completedAt: { $gte: start } } }, { $unwind: '$lines' }, { $group: { _id: '$lines.productId', name: { $first: '$lines.name' }, qty: { $sum: '$lines.qty' }, total: { $sum: '$lines.totalCents' } } }, { $sort: { total: -1 } }, { $limit: 6 }]),
      Sale.find(mine, { number: 1, totalCents: 1, completedAt: 1 }).sort({ completedAt: -1 }).limit(8).lean(),
      Shift.findOne({ userId: me, status: 'open' }).lean(),
    ]);
    const t = todayTot[0];
    const days = Array.from({ length: 7 }, (_, i) => localDateString(new Date(weekStart.getTime() + i * 86400_000 + 12 * 3600_000), tz));
    out.mySales = {
      today: { count: t?.n ?? 0, totalCents: t?.total ?? 0, averageCents: t?.n ? Math.round(t.total / t.n) : 0 },
      week: days.map((d) => { const w = week.find((x) => x._id === d); return { day: d, count: w?.n ?? 0, totalCents: w?.total ?? 0 }; }),
      payments: pay.map((p) => ({ method: p._id, totalCents: p.total })),
      topItems: items.map((x) => ({ name: x.name, qty: x.qty, totalCents: x.total })),
      recent: recent.map((r) => ({ id: r._id, number: r.number, totalCents: r.totalCents, at: r.completedAt })),
      shift: shift ? { id: shift._id, number: (shift as any).number, openedAt: (shift as any).openedAt ?? (shift as any).createdAt, openingFloatCents: shift.openingFloatCents } : null,
    };
  }

  if (has('inventory.read')) {
    const [low, outCount, transfers, adjustments, stocktakes, moves, value, expiring] = await Promise.all([
      StockLevel.aggregate([
        { $lookup: { from: 'products', localField: 'productId', foreignField: '_id', as: 'p', pipeline: [{ $match: { tenantId: req.tenant!._id, active: true } }, { $project: { name: 1, sku: 1, reorderLevel: 1 } }] } },
        { $unwind: '$p' },
        { $match: { 'p.reorderLevel': { $gt: 0 }, $expr: { $lte: ['$qty', '$p.reorderLevel'] } } },
        { $sort: { qty: 1 } },
        { $limit: 10 },
        { $project: { name: '$p.name', sku: '$p.sku', qty: 1, reorderLevel: '$p.reorderLevel' } },
      ]),
      StockLevel.countDocuments({ qty: { $lte: 0 } }),
      StockTransfer.find({ status: { $in: ['draft', 'in_transit'] } }, { number: 1, status: 1, createdAt: 1, lines: 1 }).sort({ createdAt: -1 }).limit(8).lean(),
      StockAdjustment.countDocuments({ status: 'pending' }),
      Stocktake.countDocuments({ status: 'counting' }),
      StockMovement.aggregate([{ $match: { at: { $gte: weekStart } } }, { $group: { _id: '$type', n: { $sum: 1 }, qty: { $sum: { $abs: '$qty' } } } }, { $sort: { n: -1 } }]),
      has('products.cost') ? StockLevel.aggregate([{ $match: { qty: { $gt: 0 } } }, { $group: { _id: null, v: { $sum: { $multiply: ['$qty', '$avgCostCents'] } }, units: { $sum: '$qty' } } }]) : Promise.resolve([]),
      req.capabilities!.modules.includes('batchExpiry') ? StockBatch.countDocuments({ qty: { $gt: 0 }, expiryDate: { $lte: new Date(Date.now() + 30 * 86400_000) } }) : Promise.resolve(0),
    ]);
    out.stock = {
      low: low.map((l) => ({ name: l.name, sku: l.sku, qty: l.qty, reorderLevel: l.reorderLevel })),
      outOfStock: outCount, adjustmentsToApprove: adjustments, stocktakesOpen: stocktakes, expiringSoon: expiring,
      transfers: transfers.map((x) => ({ id: x._id, number: x.number, status: x.status, at: x.createdAt, lines: x.lines?.length ?? 0 })),
      movements7: moves.map((m) => ({ type: m._id, count: m.n, qty: m.qty })),
      valueCents: has('products.cost') ? Math.round((value as any[])[0]?.v ?? 0) : null,
      units: (value as any[])[0]?.units ?? null,
    };
  }

  if (has('purchasing.read')) {
    const [byStatus, awaiting, owed, topOwed] = await Promise.all([
      PurchaseOrder.aggregate([{ $group: { _id: '$status', n: { $sum: 1 }, total: { $sum: '$totalCents' } } }]),
      PurchaseOrder.find({ status: { $in: ['sent', 'partially_received'] } }, { number: 1, status: 1, totalCents: 1, expectedAt: 1, supplierId: 1 }).sort({ expectedAt: 1 }).limit(8).populate('supplierId', 'name').lean(),
      Supplier.aggregate([{ $match: { balanceCents: { $gt: 0 } } }, { $group: { _id: null, total: { $sum: '$balanceCents' }, n: { $sum: 1 } } }]),
      Supplier.find({ balanceCents: { $gt: 0 } }, { name: 1, balanceCents: 1 }).sort({ balanceCents: -1 }).limit(6).lean(),
    ]);
    out.purchasing = {
      byStatus: byStatus.map((b) => ({ status: b._id, count: b.n, totalCents: b.total })),
      awaiting: awaiting.map((p: any) => ({ id: p._id, number: p.number, status: p.status, totalCents: p.totalCents, expectedAt: p.expectedAt, supplier: p.supplierId?.name ?? '' })),
      owedCents: owed[0]?.total ?? 0, suppliersOwed: owed[0]?.n ?? 0,
      topOwed: topOwed.map((s) => ({ name: s.name, balanceCents: s.balanceCents })),
    };
  }
  res.json({ data: out });
});

export const dashboardRoutes = router;
