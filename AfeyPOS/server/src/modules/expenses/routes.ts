/**
 * Expenses: what the shop spends outside buying stock. Each one can carry a photo of the bill, say which
 * account the money left, wait for a manager's approval above a limit, and count against a monthly budget.
 * Bills that come every month (rent, electricity) are recorded by the server on the day they are due.
 */
import { Router } from 'express';
import { z } from 'zod';
import { BankAccount, Budget, CashMovement, Expense, RecurringExpense, Shift, Supplier, Tenant } from '../../models/index.js';
import { idParam, objectId, pagination, parse, positiveCents } from '../../http/validate.js';
import { requirePermission, requireModule, can } from '../../http/auth.js';
import { badRequest, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { nextNumber } from '../../lib/numbering.js';
import { runAsPlatform } from '../../lib/context.js';
import { registerJob } from '../../jobs/queue.js';
import { toCsv } from '../../lib/csv.js';

const router = Router();
const METHODS = ['cash', 'mpesa', 'bank', 'card', 'other'] as const;
const period = z.string().regex(/^\d{4}-\d{2}$/, 'Use a month like 2026-10');

router.use(['/expenses', '/recurring-expenses', '/budgets'], requirePermission('expenses.manage'), requireModule('expenses'));

/** The amount above which an expense waits for someone with expenses.approve (0 = never). */
async function approvalAbove(tenantId: unknown): Promise<number> {
  const t = await runAsPlatform(() => Tenant.findById(tenantId, { settings: 1 }).lean());
  return Number((t?.settings as any)?.expenses?.approvalAboveCents ?? 0);
}

const expenseBody = z.object({
  category: z.string().trim().min(2).max(60),
  amountCents: positiveCents.refine((v) => v > 0, 'Enter an amount'),
  taxCents: positiveCents.default(0),
  method: z.enum(METHODS).default('cash'),
  bankAccountId: objectId.optional(),
  supplierId: objectId.optional(),
  branchId: objectId.optional(),
  shiftId: objectId.optional(),
  payee: z.string().max(120).optional(),
  reference: z.string().max(80).optional(),
  notes: z.string().max(500).optional(),
  attachmentFileId: z.string().regex(/^[a-f0-9]{32}\.(png|jpg|webp|pdf)$/).optional(),
  date: z.coerce.date().optional(),
});

router.get('/expenses', async (req, res) => {
  const q = parse(pagination.extend({
    from: z.coerce.date().optional(), to: z.coerce.date().optional(), category: z.string().optional(),
    status: z.enum(['approved', 'pending', 'rejected']).optional(), bankAccountId: objectId.optional(), format: z.enum(['json', 'csv']).optional(),
  }), req.query);
  const filter: Record<string, unknown> = {};
  if (q.category) filter.category = q.category;
  if (q.status) filter.status = q.status;
  if (q.bankAccountId) filter.bankAccountId = q.bankAccountId;
  if (q.from || q.to) filter.date = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  const [data, total, pending] = await Promise.all([
    Expense.find(filter).sort({ date: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    Expense.countDocuments(filter),
    Expense.countDocuments({ status: 'pending' }),
  ]);
  if (q.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="expenses.csv"');
    res.send(toCsv(data.map((e) => ({ number: e.number, date: e.date, category: e.category, payee: e.payee ?? '', method: e.method, amount: (e.amountCents ?? 0) / 100, tax: (e.taxCents ?? 0) / 100, status: e.status, reference: e.reference ?? '' }))));
    return;
  }
  res.json({ data, total, page: q.page, limit: q.limit, pendingApproval: pending });
});

router.post('/expenses', async (req, res) => {
  const body = parse(expenseBody, req.body);
  if (body.bankAccountId && !(await BankAccount.exists({ _id: body.bankAccountId, active: { $ne: false } }))) throw badRequest('Choose an account the money came from');
  if (body.supplierId && !(await Supplier.exists({ _id: body.supplierId }))) throw notFound('Supplier');
  const limit = await approvalAbove(req.tenant!._id);
  // Over the limit it waits for a manager, unless the person recording it may approve expenses themselves.
  const needsApproval = limit > 0 && body.amountCents > limit && !can(req, 'expenses.approve');
  const number = await nextNumber('expense', 'EXP');
  const e = await Expense.create({
    ...body, number, userId: req.auth!.userId, status: needsApproval ? 'pending' : 'approved',
    ...(needsApproval ? {} : { approvedBy: req.auth!.userId, approvedAt: new Date() }),
  });
  // Cash out of a till drawer only moves once the expense is real.
  if (!needsApproval && body.method === 'cash' && body.shiftId) await takeFromDrawer(e, body.shiftId, req.auth!.userId);
  await audit(req, { action: needsApproval ? 'expense.submitted' : 'expense.recorded', entity: 'Expense', entityId: e._id, details: { amountCents: body.amountCents, category: body.category } });
  res.status(201).json({ data: e, needsApproval });
});

async function takeFromDrawer(e: { _id: unknown; number: string; amountCents: number; category: string }, shiftId: unknown, userId: unknown) {
  const shift = await Shift.findOne({ _id: shiftId, status: 'open' });
  if (!shift) throw badRequest('Shift is not open');
  await CashMovement.create({ shiftId: shift._id, tillId: shift.tillId, type: 'expense', amountCents: -e.amountCents, reason: e.category, userId, ref: { type: 'Expense', id: e._id, number: e.number } });
}

router.patch('/expenses/:id', async (req, res) => {
  const body = parse(expenseBody.partial(), req.body);
  const e = await Expense.findById(idParam(req.params.id));
  if (!e) throw notFound('Expense');
  if (e.status === 'approved' && !can(req, 'expenses.approve')) throw forbidden('An approved expense can only be changed by someone who may approve expenses');
  Object.assign(e, body);
  await e.save();
  await audit(req, { action: 'expense.updated', entity: 'Expense', entityId: e._id, details: { fields: Object.keys(body) } });
  res.json({ data: e });
});

/** Approving or turning down an expense that is waiting. */
router.post('/expenses/:id/decide', requirePermission('expenses.approve'), async (req, res) => {
  const body = parse(z.object({ approve: z.boolean(), reason: z.string().trim().max(300).optional() }), req.body);
  const e = await Expense.findById(idParam(req.params.id));
  if (!e) throw notFound('Expense');
  if (e.status !== 'pending') throw unprocessable(`This expense is already ${e.status}`, 'NOT_PENDING');
  e.status = body.approve ? 'approved' : 'rejected';
  e.approvedBy = req.auth!.userId as any;
  e.approvedAt = new Date();
  if (!body.approve) e.rejectedReason = body.reason;
  await e.save();
  if (body.approve && e.method === 'cash' && e.shiftId) await takeFromDrawer(e as any, e.shiftId, req.auth!.userId).catch(() => undefined);
  await audit(req, { action: body.approve ? 'expense.approved' : 'expense.rejected', entity: 'Expense', entityId: e._id, details: { amountCents: e.amountCents, reason: body.reason } });
  res.json({ data: e });
});

router.delete('/expenses/:id', requirePermission('expenses.approve'), async (req, res) => {
  const e = await Expense.findOneAndDelete({ _id: idParam(req.params.id), status: { $ne: 'approved' } });
  if (!e) throw unprocessable('Only an expense that is waiting or turned down can be deleted; approved ones stay in the books', 'EXPENSE_APPROVED');
  await audit(req, { action: 'expense.removed', entity: 'Expense', entityId: e._id, details: { number: e.number } });
  res.json({ ok: true });
});

// ---------- bills that come every month ----------
const recurringBody = z.object({
  category: z.string().trim().min(2).max(60),
  amountCents: positiveCents.refine((v) => v > 0, 'Enter an amount'),
  method: z.enum(METHODS).default('bank'),
  bankAccountId: objectId.optional(),
  branchId: objectId.optional(),
  payee: z.string().max(120).optional(),
  notes: z.string().max(500).optional(),
  dayOfMonth: z.number().int().min(1).max(28),
  active: z.boolean().optional(),
});

router.get('/recurring-expenses', async (_req, res) => {
  res.json({ data: await RecurringExpense.find({}).sort({ category: 1 }).lean() });
});

router.post('/recurring-expenses', async (req, res) => {
  const body = parse(recurringBody, req.body);
  const r = await RecurringExpense.create({ ...body, createdBy: req.auth!.userId });
  await audit(req, { action: 'recurring_expense.created', entity: 'RecurringExpense', entityId: r._id, details: { category: r.category, amountCents: r.amountCents } });
  res.status(201).json({ data: r });
});

router.patch('/recurring-expenses/:id', async (req, res) => {
  const body = parse(recurringBody.partial(), req.body);
  const r = await RecurringExpense.findOneAndUpdate({ _id: idParam(req.params.id) }, { $set: body }, { new: true });
  if (!r) throw notFound('Recurring expense');
  await audit(req, { action: 'recurring_expense.updated', entity: 'RecurringExpense', entityId: r._id, details: { fields: Object.keys(body) } });
  res.json({ data: r });
});

router.delete('/recurring-expenses/:id', async (req, res) => {
  const r = await RecurringExpense.findOneAndDelete({ _id: idParam(req.params.id) });
  if (!r) throw notFound('Recurring expense');
  await audit(req, { action: 'recurring_expense.removed', entity: 'RecurringExpense', entityId: r._id });
  res.json({ ok: true });
});

/** Records this month's bills once their day has come (runs daily; recording twice is impossible). */
export async function runRecurringExpenses(now = new Date()): Promise<number> {
  const thisPeriod = now.toISOString().slice(0, 7);
  const due = await RecurringExpense.find({ active: { $ne: false }, dayOfMonth: { $lte: now.getUTCDate() }, lastRunPeriod: { $ne: thisPeriod } });
  let made = 0;
  for (const r of due) {
    const number = await nextNumber('expense', 'EXP');
    await Expense.create({
      number, category: r.category, amountCents: r.amountCents, method: r.method, bankAccountId: r.bankAccountId, branchId: r.branchId,
      payee: r.payee, notes: r.notes, date: now, status: 'approved', approvedAt: now, recurringId: r._id, userId: r.createdBy,
    });
    await RecurringExpense.updateOne({ _id: r._id }, { $set: { lastRunPeriod: thisPeriod } });
    made++;
  }
  return made;
}

registerJob('expenses.recurring', async () => {
  await runRecurringExpenses();
});

// ---------- budgets ----------
router.get('/budgets', async (req, res) => {
  const q = parse(z.object({ period: period.optional() }), req.query);
  const p = q.period ?? new Date().toISOString().slice(0, 7);
  const [start, end] = [new Date(`${p}-01T00:00:00Z`), new Date(Date.UTC(Number(p.slice(0, 4)), Number(p.slice(5, 7)), 1))];
  const [budgets, spent] = await Promise.all([
    Budget.find({ period: p }).sort({ category: 1 }).lean(),
    Expense.aggregate([{ $match: { date: { $gte: start, $lt: end }, status: { $ne: 'rejected' } } }, { $group: { _id: '$category', cents: { $sum: '$amountCents' } } }]),
  ]);
  const by = new Map(spent.map((s) => [String(s._id), s.cents as number]));
  const rows = budgets.map((b) => {
    const used = by.get(b.category) ?? 0;
    return { ...b, spentCents: used, leftCents: b.amountCents - used, usedBp: b.amountCents ? Math.round((used / b.amountCents) * 10_000) : 0, over: used > b.amountCents };
  });
  // Categories spent on with no budget set, so nothing is hidden.
  const unbudgeted = [...by.entries()].filter(([c]) => !budgets.some((b) => b.category === c)).map(([category, cents]) => ({ category, spentCents: cents }));
  res.json({
    data: rows, unbudgeted, period: p,
    totals: { budgetCents: rows.reduce((s, r) => s + r.amountCents, 0), spentCents: [...by.values()].reduce((s, c) => s + c, 0) },
  });
});

router.put('/budgets', async (req, res) => {
  const body = parse(z.object({ period, category: z.string().trim().min(2).max(60), amountCents: positiveCents, branchId: objectId.nullable().optional(), notes: z.string().max(300).optional() }), req.body);
  const b = await Budget.findOneAndUpdate(
    { period: body.period, category: body.category, branchId: body.branchId ?? null },
    { $set: { amountCents: body.amountCents, notes: body.notes } },
    { new: true, upsert: true },
  );
  await audit(req, { action: 'budget.set', entity: 'Budget', entityId: b!._id, details: { period: body.period, category: body.category, amountCents: body.amountCents } });
  res.json({ data: b });
});

router.delete('/budgets/:id', async (req, res) => {
  const b = await Budget.findOneAndDelete({ _id: idParam(req.params.id) });
  if (!b) throw notFound('Budget');
  await audit(req, { action: 'budget.removed', entity: 'Budget', entityId: b._id });
  res.json({ ok: true });
});

export const expenseRoutes = router;
