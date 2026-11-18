/**
 * Read-only business tools for the AI assistant. Each tool has a fixed query the server wrote (the model never
 * writes queries), validates its input, checks the user's permission and only sees the user's branches. Results
 * are small summaries: no passwords, keys, payment credentials or personal phone numbers.
 */
import { z } from 'zod/v4';
import { Types } from 'mongoose';
import type { Permission } from '@afeypos/shared';
import { AuditLog, Category, Product, Sale, SaleReturn, StockLevel, StockMovement, User, Warehouse, Branch } from '../../models/index.js';
import { localDateString, localMidnightUtc } from '../reports/routes.js';
import { suggestOrders } from '../purchasing/intelligence.js';

export interface ToolContext {
  tz: string;
  /** Branches the user may see (null = all). */
  branchIds: Types.ObjectId[] | null;
  permissions: ReadonlySet<string>;
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const range = z.object({ from: day.describe('First day, YYYY-MM-DD (local business time)'), to: day.describe('Last day, YYYY-MM-DD, inclusive') });

function window(ctx: ToolContext, from: string, to: string) {
  if (from > to) throw new Error('"from" is after "to"');
  const endDay = new Date(Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10) + 1)).toISOString().slice(0, 10);
  return { start: localMidnightUtc(from, ctx.tz), end: localMidnightUtc(endDay, ctx.tz) };
}
const salesMatch = (ctx: ToolContext, start: Date, end: Date, extra: Record<string, unknown> = {}) => ({
  completedAt: { $gte: start, $lt: end }, status: { $ne: 'voided' }, ...(ctx.branchIds ? { branchId: { $in: ctx.branchIds } } : {}), ...extra,
});
const ksh = (cents: number) => Math.round(cents) / 100;
async function warehousesOf(ctx: ToolContext) {
  if (!ctx.branchIds) return null;
  return (await Warehouse.find({ branchId: { $in: ctx.branchIds } }, { _id: 1 }).lean()).map((w) => w._id);
}

export interface AssistantTool<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  input: S;
  /** All must be held. */
  permissions: Permission[];
  run: (input: z.infer<S>, ctx: ToolContext) => Promise<unknown>;
}

const tool = <S extends z.ZodTypeAny>(t: AssistantTool<S>) => t;

export const ASSISTANT_TOOLS: AssistantTool[] = [
  tool({
    name: 'sales_summary',
    description: 'Sales totals for a period: revenue before tax, tax, gross sales, number of receipts, average basket, discounts, returns, and how customers paid. Amounts in KES.',
    input: range,
    permissions: ['reports.read'],
    run: async ({ from, to }, ctx) => {
      const { start, end } = window(ctx, from, to);
      const [t] = await Sale.aggregate([{ $match: salesMatch(ctx, start, end) }, { $group: { _id: null, gross: { $sum: '$totalCents' }, net: { $sum: '$netCents' }, tax: { $sum: '$taxCents' }, discount: { $sum: '$discountCents' }, n: { $sum: 1 } } }]);
      const pay = await Sale.aggregate([{ $match: salesMatch(ctx, start, end) }, { $unwind: '$payments' }, { $group: { _id: '$payments.method', cents: { $sum: '$payments.amountCents' } } }, { $sort: { cents: -1 } }]);
      const [r] = await SaleReturn.aggregate([{ $match: { createdAt: { $gte: start, $lt: end }, isVoid: { $ne: true }, ...(ctx.branchIds ? { branchId: { $in: ctx.branchIds } } : {}) } }, { $unwind: '$lines' }, { $group: { _id: null, refund: { $sum: '$lines.refundCents' } } }]);
      const n = t?.n ?? 0;
      return { period: { from, to }, receipts: n, grossSalesKes: ksh(t?.gross ?? 0), revenueBeforeTaxKes: ksh(t?.net ?? 0), taxKes: ksh(t?.tax ?? 0), discountsKes: ksh(t?.discount ?? 0), returnsRefundedKes: ksh(r?.refund ?? 0), averageBasketKes: n ? ksh((t?.gross ?? 0) / n) : 0, byPaymentMethod: pay.map((p) => ({ method: p._id, kes: ksh(p.cents) })) };
    },
  }),
  tool({
    name: 'top_products',
    description: 'Best products in a period ranked by revenue, quantity sold or gross profit (profit = revenue before tax minus the recorded cost of what was sold).',
    input: range.extend({ by: z.enum(['revenue', 'quantity', 'profit']), limit: z.number().int().min(1).max(25).default(10) }),
    permissions: ['reports.read'],
    run: async ({ from, to, by, limit }, ctx) => {
      if (by === 'profit' && !ctx.permissions.has('reports.financial')) throw new Error('Profit figures need the financial reports permission');
      const { start, end } = window(ctx, from, to);
      const sort = by === 'revenue' ? 'net' : by === 'quantity' ? 'qty' : 'profit';
      const rows = await Sale.aggregate([
        { $match: salesMatch(ctx, start, end) }, { $unwind: '$lines' },
        { $group: { _id: '$lines.productId', name: { $first: '$lines.name' }, qty: { $sum: { $ifNull: ['$lines.baseQty', '$lines.qty'] } }, net: { $sum: '$lines.netCents' }, cost: { $sum: '$lines.costCents' } } },
        { $addFields: { profit: { $subtract: ['$net', '$cost'] } } }, { $sort: { [sort]: -1 } }, { $limit: limit },
      ]);
      return { period: { from, to }, rankedBy: by, products: rows.map((r) => ({ name: r.name, quantity: Math.round(r.qty * 100) / 100, revenueKes: ksh(r.net), ...(ctx.permissions.has('reports.financial') ? { grossProfitKes: ksh(r.profit), marginPct: r.net ? Math.round((r.profit / r.net) * 1000) / 10 : null } : {}) })) };
    },
  }),
  tool({
    name: 'category_revenue',
    description: 'Revenue (before tax) per product category for a period.',
    input: range,
    permissions: ['reports.read'],
    run: async ({ from, to }, ctx) => {
      const { start, end } = window(ctx, from, to);
      const rows = await Sale.aggregate([{ $match: salesMatch(ctx, start, end) }, { $unwind: '$lines' }, { $group: { _id: '$lines.productId', net: { $sum: '$lines.netCents' } } }]);
      const prods = new Map((await Product.find({ _id: { $in: rows.map((r) => r._id) } }, { categoryId: 1 }).lean()).map((p) => [String(p._id), p.categoryId ? String(p.categoryId) : '']));
      const cats = new Map((await Category.find({}, { name: 1 }).lean()).map((c) => [String(c._id), c.name]));
      const by = new Map<string, number>();
      for (const r of rows) { const c = prods.get(String(r._id)) ?? ''; by.set(c, (by.get(c) ?? 0) + r.net); }
      return { period: { from, to }, categories: [...by.entries()].map(([c, net]) => ({ category: c ? cats.get(c) ?? 'Unknown' : 'No category', revenueKes: ksh(net) })).sort((a, b) => b.revenueKes - a.revenueKes) };
    },
  }),
  tool({
    name: 'branch_performance',
    description: 'Per-branch revenue, receipts and (with financial permission) gross profit for a period, to compare branches.',
    input: range,
    permissions: ['reports.read'],
    run: async ({ from, to }, ctx) => {
      const { start, end } = window(ctx, from, to);
      const rows = await Sale.aggregate([{ $match: salesMatch(ctx, start, end) }, { $group: { _id: '$branchId', net: { $sum: '$netCents' }, gross: { $sum: '$totalCents' }, cost: { $sum: '$costCents' }, n: { $sum: 1 } } }, { $sort: { net: -1 } }]);
      const names = new Map((await Branch.find({ _id: { $in: rows.map((r) => r._id) } }, { name: 1 }).lean()).map((b) => [String(b._id), b.name]));
      const fin = ctx.permissions.has('reports.financial');
      return { period: { from, to }, branches: rows.map((r) => ({ branch: names.get(String(r._id)) ?? 'Unknown', receipts: r.n, grossSalesKes: ksh(r.gross), revenueBeforeTaxKes: ksh(r.net), ...(fin ? { grossProfitKes: ksh(r.net - r.cost) } : {}) })) };
    },
  }),
  tool({
    name: 'cashier_performance',
    description: 'Per-cashier receipts, sales value and voids for a period.',
    input: range,
    permissions: ['reports.read', 'sales.read.all'],
    run: async ({ from, to }, ctx) => {
      const { start, end } = window(ctx, from, to);
      const rows = await Sale.aggregate([{ $match: { completedAt: { $gte: start, $lt: end }, ...(ctx.branchIds ? { branchId: { $in: ctx.branchIds } } : {}) } }, { $group: { _id: '$cashierId', n: { $sum: { $cond: [{ $ne: ['$status', 'voided'] }, 1, 0] } }, gross: { $sum: { $cond: [{ $ne: ['$status', 'voided'] }, '$totalCents', 0] } }, voids: { $sum: { $cond: [{ $eq: ['$status', 'voided'] }, 1, 0] } } } }, { $sort: { gross: -1 } }]);
      const users = new Map((await User.find({ _id: { $in: rows.map((r) => r._id) } }, { name: 1 }).lean()).map((u) => [String(u._id), u.name]));
      return { period: { from, to }, cashiers: rows.map((r) => ({ cashier: users.get(String(r._id)) ?? 'Unknown', receipts: r.n, salesKes: ksh(r.gross), voidedReceipts: r.voids })) };
    },
  }),
  tool({
    name: 'low_stock',
    description: 'Products at or below their reorder level, or out of stock, with quantity on hand.',
    input: z.object({ limit: z.number().int().min(1).max(50).default(20) }),
    permissions: ['inventory.read'],
    run: async ({ limit }, ctx) => {
      const wh = await warehousesOf(ctx);
      const rows = await Product.aggregate([
        { $match: { active: true, trackStock: true, type: 'stock' } },
        { $lookup: { from: StockLevel.collection.collectionName, let: { p: '$_id' }, pipeline: [{ $match: { $expr: { $eq: ['$productId', '$$p'] }, ...(wh ? { warehouseId: { $in: wh } } : {}) } }], as: 'levels' } },
        { $addFields: { onHand: { $sum: '$levels.qty' } } }, { $match: { $expr: { $lte: ['$onHand', '$reorderLevel'] } } }, { $sort: { onHand: 1 } }, { $limit: limit },
      ]);
      return { products: rows.map((p) => ({ name: p.name, onHand: p.onHand, unit: p.baseUnit, reorderLevel: p.reorderLevel, outOfStock: p.onHand <= 0 })) };
    },
  }),
  tool({
    name: 'dead_stock',
    description: 'Products in stock that have not sold for a number of days, with the money tied up at cost.',
    input: z.object({ days: z.number().int().min(7).max(730).default(60), limit: z.number().int().min(1).max(50).default(20) }),
    permissions: ['inventory.read'],
    run: async ({ days, limit }, ctx) => {
      const wh = await warehousesOf(ctx);
      const since = new Date(Date.now() - days * 86400_000);
      const stock = await StockLevel.aggregate([{ $match: { qty: { $gt: 0 }, ...(wh ? { warehouseId: { $in: wh } } : {}) } }, { $group: { _id: '$productId', qty: { $sum: '$qty' }, value: { $sum: { $multiply: ['$qty', '$avgCostCents'] } } } }]);
      const sold = new Set((await StockMovement.distinct('productId', { type: 'sale', at: { $gte: since }, productId: { $in: stock.map((s) => s._id) } })).map(String));
      const idle = stock.filter((s) => !sold.has(String(s._id))).sort((a, b) => b.value - a.value);
      const names = new Map((await Product.find({ _id: { $in: idle.slice(0, limit).map((s) => s._id) } }, { name: 1, baseUnit: 1 }).lean()).map((p) => [String(p._id), p]));
      const fin = ctx.permissions.has('products.cost');
      return { noSaleForDays: days, products: idle.slice(0, limit).map((s) => ({ name: names.get(String(s._id))?.name ?? '?', onHand: s.qty, unit: names.get(String(s._id))?.baseUnit, ...(fin ? { valueAtCostKes: ksh(s.value) } : {}) })), ...(fin ? { totalTiedUpKes: ksh(idle.reduce((a, s) => a + s.value, 0)) } : {}), productCount: idle.length };
    },
  }),
  tool({
    name: 'inventory_value',
    description: 'Current stock value at cost (moving average) and at retail price, per branch store.',
    input: z.object({}),
    permissions: ['reports.financial'],
    run: async (_i, ctx) => {
      const wh = await warehousesOf(ctx);
      const rows = await StockLevel.aggregate([{ $match: { qty: { $gt: 0 }, ...(wh ? { warehouseId: { $in: wh } } : {}) } }, { $lookup: { from: Product.collection.collectionName, localField: 'productId', foreignField: '_id', as: 'p' } }, { $unwind: '$p' }, { $group: { _id: '$warehouseId', cost: { $sum: { $multiply: ['$qty', '$avgCostCents'] } }, retail: { $sum: { $multiply: ['$qty', { $ifNull: ['$p.prices.retail', 0] }] } }, items: { $sum: 1 } } }]);
      const names = new Map((await Warehouse.find({ _id: { $in: rows.map((r) => r._id) } }, { name: 1 }).lean()).map((w) => [String(w._id), w.name]));
      return { stores: rows.map((r) => ({ store: names.get(String(r._id)) ?? '?', productsInStock: r.items, valueAtCostKes: ksh(r.cost), valueAtRetailKes: ksh(r.retail) })), totalAtCostKes: ksh(rows.reduce((a, r) => a + r.cost, 0)), totalAtRetailKes: ksh(rows.reduce((a, r) => a + r.retail, 0)) };
    },
  }),
  tool({
    name: 'reorder_suggestions',
    description: 'What to order now per supplier, from recent sales, supplier lead time, stock on hand and on order. Suggestions only.',
    input: z.object({ days: z.number().int().min(7).max(365).default(28), coverDays: z.number().int().min(1).max(180).default(14) }),
    permissions: ['purchasing.read'],
    run: async ({ days, coverDays }, ctx) => {
      const whs = (await warehousesOf(ctx)) ?? (await Warehouse.find({}, { _id: 1 }).lean()).map((w) => w._id);
      const out = [];
      for (const w of whs.slice(0, 10)) {
        const groups = await suggestOrders({ warehouseId: new Types.ObjectId(String(w)), days, coverDays, safety: 1.5 });
        const name = (await Warehouse.findById(w, { name: 1 }).lean())?.name;
        for (const g of groups) out.push({ store: name, supplier: g.supplier, estimatedCostKes: ksh(g.totalCents), lines: g.lines.slice(0, 15).map((l) => ({ product: l.name, order: l.suggestQty, unit: l.unit, daysLeft: l.daysLeft })) });
      }
      return { basis: `Average sales of the last ${days} days × (supplier lead time + ${coverDays} days), minus stock on hand and on order`, orders: out };
    },
  }),
  tool({
    name: 'sales_trend',
    description: 'Products whose sales fell (or rose) most: compares the last N weeks with the N weeks before.',
    input: z.object({ weeks: z.number().int().min(1).max(26).default(4), direction: z.enum(['declining', 'growing']).default('declining'), limit: z.number().int().min(1).max(25).default(10) }),
    permissions: ['reports.read'],
    run: async ({ weeks, direction, limit }, ctx) => {
      const now = Date.now();
      const mid = new Date(now - weeks * 7 * 86400_000);
      const start = new Date(now - 2 * weeks * 7 * 86400_000);
      const rows = await Sale.aggregate([
        { $match: { completedAt: { $gte: start }, status: { $ne: 'voided' }, ...(ctx.branchIds ? { branchId: { $in: ctx.branchIds } } : {}) } }, { $unwind: '$lines' },
        { $group: { _id: '$lines.productId', name: { $first: '$lines.name' }, recent: { $sum: { $cond: [{ $gte: ['$completedAt', mid] }, '$lines.netCents', 0] } }, before: { $sum: { $cond: [{ $lt: ['$completedAt', mid] }, '$lines.netCents', 0] } } } },
        { $match: { before: { $gt: 0 } } }, { $addFields: { change: { $divide: [{ $subtract: ['$recent', '$before'] }, '$before'] } } },
        { $sort: { change: direction === 'declining' ? 1 : -1 } }, { $limit: limit },
      ]);
      return { compares: `last ${weeks} weeks vs the ${weeks} weeks before`, products: rows.map((r) => ({ name: r.name, beforeKes: ksh(r.before), recentKes: ksh(r.recent), changePct: Math.round(r.change * 1000) / 10 })) };
    },
  }),
  tool({
    name: 'unusual_activity',
    description: 'Things worth checking in recent days: voided receipts, cash drawer opened without a sale, supervisor approvals (price changes, discounts, removals), failed sign-ins and till unlocks.',
    input: z.object({ days: z.number().int().min(1).max(60).default(7) }),
    permissions: ['audit.read'],
    run: async ({ days }) => {
      const since = new Date(Date.now() - days * 86400_000);
      const watch = ['sale.voided', 'till.drawer_opened', 'auth.override_granted', 'auth.till_unlock_failed', 'pos.item_removed', 'pos.sale_cleared', 'inventory.adjustment_approved', 'audit.verified'];
      const rows = await AuditLog.aggregate([{ $match: { at: { $gte: since }, action: { $in: watch } } }, { $group: { _id: { a: '$action', who: '$actor.name' }, n: { $sum: 1 }, last: { $max: '$at' } } }, { $sort: { n: -1 } }, { $limit: 40 }]);
      return { lastDays: days, events: rows.map((r) => ({ what: r._id.a, by: r._id.who, times: r.n, lastAt: r.last })) };
    },
  }),
];

/** Tools this user may use (others are not even offered to the model). */
export const toolsFor = (perms: ReadonlySet<string>) => ASSISTANT_TOOLS.filter((t) => t.permissions.every((p) => perms.has(p)));

/** Runs a tool call from the model: unknown tools, missing permission and invalid input come back as errors. */
export async function runTool(name: string, rawInput: unknown, ctx: ToolContext) {
  const t = ASSISTANT_TOOLS.find((x) => x.name === name);
  if (!t) return { ok: false as const, error: `Unknown tool ${name}` };
  if (!t.permissions.every((p) => ctx.permissions.has(p))) return { ok: false as const, error: 'You do not have permission for this information' };
  const parsed = t.input.safeParse(rawInput ?? {});
  if (!parsed.success) return { ok: false as const, error: `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` };
  try {
    return { ok: true as const, result: await t.run(parsed.data, ctx) };
  } catch (err) {
    return { ok: false as const, error: (err as Error).message };
  }
}

export const today = (tz: string) => localDateString(new Date(), tz);

/** JSON Schema of a tool's input, for the AI provider (closed objects, every field listed). */
export function toolSchema(t: AssistantTool): Record<string, unknown> {
  const js = z.toJSONSchema(t.input, { io: 'input', target: 'draft-2020-12' }) as Record<string, unknown>;
  delete js.$schema;
  return { ...js, additionalProperties: false };
}
