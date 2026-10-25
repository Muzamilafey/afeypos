/**
 * Accounting: chart of accounts, journals (automatic and manual), general ledger, trial balance,
 * profit & loss, balance sheet and VAT. Statements post anything pending first, so they are always current.
 */
import { Router } from 'express';
import { z } from 'zod';
import { Account, JournalEntry, Tenant } from '../../models/index.js';
import { idParam, objectId, parse, escapeRegex } from '../../http/validate.js';
import { requirePermission } from '../../http/auth.js';
import { AppError, badRequest, notFound, unprocessable } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { toCsv } from '../../lib/csv.js';
import { env } from '../../config/env.js';
import { runAsPlatform } from '../../lib/context.js';
import { registerJob } from '../../jobs/queue.js';
import { localDateString, localMidnightUtc } from '../reports/routes.js';
import { ensureChart, postJournal, postPending, resetPostingFlags } from './posting.js';

const router = Router();

router.use('/accounting', (_req, _res, next) => {
  if (env().DEPLOYMENT_MODE === 'branch') throw new AppError(409, 'MANAGED_AT_HQ', 'Accounts are kept on the head-office server, which receives every branch’s transactions');
  next();
});

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const tzOf = (req: any) => req.tenant!.settings?.timezone ?? 'Africa/Nairobi';
const nextDay = (d: string) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10) + 1)).toISOString().slice(0, 10);
const NATURAL_DEBIT = new Set(['asset', 'expense']);

function send(res: any, format: string | undefined, name: string, rows: Record<string, unknown>[], body: Record<string, unknown>) {
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
    return res.send(toCsv(rows));
  }
  res.json(body);
}

/** Sum of debits and credits per account in a date window (and branch). */
async function sums(filter: { before?: Date; from?: Date; branchId?: unknown }) {
  const date: Record<string, Date> = {};
  if (filter.from) date.$gte = filter.from;
  if (filter.before) date.$lt = filter.before;
  const rows = await JournalEntry.aggregate([
    { $match: Object.keys(date).length ? { date } : {} },
    { $unwind: '$lines' },
    ...(filter.branchId ? [{ $match: { 'lines.branchId': filter.branchId } }] : []),
    { $group: { _id: '$lines.accountCode', debit: { $sum: '$lines.debitCents' }, credit: { $sum: '$lines.creditCents' } } },
  ]);
  return new Map(rows.map((r) => [r._id as string, { debit: r.debit as number, credit: r.credit as number }]));
}

async function accountsWithBalances(s: Map<string, { debit: number; credit: number }>) {
  const accounts = await Account.find({}).sort({ code: 1 }).lean();
  return accounts.map((a) => {
    const x = s.get(a.code) ?? { debit: 0, credit: 0 };
    return { code: a.code, name: a.name, type: a.type, subtype: a.subtype, key: a.key, active: a.active, debitCents: x.debit, creditCents: x.credit, balanceCents: NATURAL_DEBIT.has(a.type) ? x.debit - x.credit : x.credit - x.debit };
  });
}

function range(req: any, q: { from?: string; to?: string }) {
  const tz = tzOf(req);
  const today = localDateString(new Date(), tz);
  const to = q.to ?? today;
  const from = q.from ?? `${to.slice(0, 7)}-01`;
  return { from, to, start: localMidnightUtc(from, tz), end: localMidnightUtc(nextDay(to), tz) };
}

// ---------- chart of accounts ----------
router.get('/accounting/accounts', requirePermission('accounting.read'), async (req, res) => {
  const q = parse(z.object({ asOf: day.optional() }), req.query);
  await postPending();
  const asOf = q.asOf ?? localDateString(new Date(), tzOf(req));
  res.json({ data: await accountsWithBalances(await sums({ before: localMidnightUtc(nextDay(asOf), tzOf(req)) })), asOf });
});

const accountBody = z.object({ code: z.string().trim().regex(/^\d{3,6}$/, 'Account codes are 3 to 6 digits'), name: z.string().trim().min(2).max(100), type: z.enum(['asset', 'liability', 'equity', 'income', 'expense']), subtype: z.string().max(40).optional(), description: z.string().max(300).optional() });

router.post('/accounting/accounts', requirePermission('accounting.manage'), async (req, res) => {
  const body = parse(accountBody, req.body);
  await ensureChart();
  if (await Account.exists({ code: body.code })) throw unprocessable(`Account ${body.code} already exists`, 'DUPLICATE');
  const a = await Account.create(body);
  await audit(req, { action: 'accounting.account_created', entity: 'Account', entityId: a._id, details: { code: a.code } });
  res.status(201).json({ data: a });
});

router.patch('/accounting/accounts/:code', requirePermission('accounting.manage'), async (req, res) => {
  const body = parse(z.object({ name: z.string().trim().min(2).max(100).optional(), description: z.string().max(300).optional(), active: z.boolean().optional() }), req.body);
  const a = await Account.findOne({ code: String(req.params.code) });
  if (!a) throw notFound('Account');
  if (a.key && body.active === false) throw unprocessable('Accounts used by automatic posting cannot be deactivated', 'SYSTEM_ACCOUNT');
  Object.assign(a, body);
  await a.save();
  res.json({ data: a });
});

// ---------- journals ----------
router.get('/accounting/journals', requirePermission('accounting.read'), async (req, res) => {
  const q = parse(z.object({ from: day.optional(), to: day.optional(), accountCode: z.string().optional(), sourceType: z.string().optional(), manual: z.coerce.boolean().optional(), q: z.string().max(60).optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
  await postPending();
  const r = range(req, q);
  const filter: Record<string, unknown> = { date: { $gte: r.start, $lt: r.end } };
  if (q.accountCode) filter['lines.accountCode'] = q.accountCode;
  if (q.sourceType) filter['source.type'] = q.sourceType;
  if (q.manual !== undefined) filter.manual = q.manual;
  if (q.q) filter.$or = [{ number: new RegExp(escapeRegex(q.q), 'i') }, { memo: new RegExp(escapeRegex(q.q), 'i') }, { 'source.number': new RegExp(escapeRegex(q.q), 'i') }];
  const [data, total] = await Promise.all([JournalEntry.find(filter).sort({ date: -1, _id: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), JournalEntry.countDocuments(filter)]);
  res.json({ data, total, page: q.page, limit: q.limit, period: { from: r.from, to: r.to } });
});

router.get('/accounting/journals/:id', requirePermission('accounting.read'), async (req, res) => {
  const j = await JournalEntry.findById(idParam(req.params.id)).lean();
  if (!j) throw notFound('Journal');
  res.json({ data: j });
});

async function lockDate(req: any): Promise<string | null> {
  const t = await runAsPlatform(() => Tenant.findById(req.tenant!._id, { settings: 1 }).lean());
  return (t?.settings as any)?.accounting?.lockDate ?? null;
}

const lineBody = z.object({ accountCode: z.string().trim(), debitCents: z.number().int().min(0).default(0), creditCents: z.number().int().min(0).default(0), branchId: objectId.optional(), memo: z.string().max(200).optional() });

router.post('/accounting/journals', requirePermission('accounting.manage'), async (req, res) => {
  const body = parse(z.object({ date: day, memo: z.string().trim().min(2).max(300), lines: z.array(lineBody).min(2).max(100) }), req.body);
  const lock = await lockDate(req);
  if (lock && body.date <= lock) throw unprocessable(`The books are closed up to ${lock}`, 'PERIOD_LOCKED');
  await ensureChart();
  const codes = new Set((await Account.find({ active: true }, { code: 1 }).lean()).map((a) => a.code));
  for (const l of body.lines) {
    if (!codes.has(l.accountCode)) throw badRequest(`Unknown or inactive account ${l.accountCode}`);
    if ((l.debitCents > 0) === (l.creditCents > 0)) throw badRequest('Each line is either a debit or a credit');
  }
  const j = await postJournal(null, { date: localMidnightUtc(body.date, tzOf(req)), memo: body.memo, manual: true, createdBy: req.auth!.userId, source: { type: 'Manual' }, lines: body.lines });
  await audit(req, { action: 'accounting.journal_posted', entity: 'JournalEntry', entityId: j?._id, details: { number: j?.number, totalCents: j?.totalCents } });
  res.status(201).json({ data: j });
});

router.post('/accounting/journals/:id/reverse', requirePermission('accounting.manage'), async (req, res) => {
  const body = parse(z.object({ date: day.optional() }), req.body ?? {});
  const j = await JournalEntry.findById(idParam(req.params.id));
  if (!j) throw notFound('Journal');
  if (!j.manual) throw unprocessable('Automatic journals follow their documents: void or return the document instead', 'AUTOMATIC_JOURNAL');
  if (j.reversedBy) throw unprocessable('This journal has already been reversed', 'ALREADY_REVERSED');
  const date = body.date ?? localDateString(new Date(), tzOf(req));
  const lock = await lockDate(req);
  if (lock && date <= lock) throw unprocessable(`The books are closed up to ${lock}`, 'PERIOD_LOCKED');
  const r = await postJournal(null, { date: localMidnightUtc(date, tzOf(req)), memo: `Reversal of ${j.number}: ${j.memo ?? ''}`, manual: true, createdBy: req.auth!.userId, reversalOf: j._id, source: { type: 'Manual' }, lines: j.lines.map((l) => ({ accountCode: l.accountCode, debitCents: l.creditCents, creditCents: l.debitCents, branchId: l.branchId ?? undefined, memo: l.memo ?? undefined })) });
  j.reversedBy = r!._id;
  await j.save();
  res.status(201).json({ data: r });
});

/** Posts anything outstanding now (also runs every few minutes in the background). */
router.post('/accounting/post', requirePermission('accounting.manage'), async (req, res) => {
  const body = parse(z.object({ rebuild: z.boolean().default(false) }), req.body ?? {});
  if (body.rebuild) {
    // Automatic journals are recreated from their documents; manual journals stay.
    await JournalEntry.deleteMany({ manual: { $ne: true } });
    await resetPostingFlags();
    await audit(req, { action: 'accounting.rebuilt' });
  }
  res.json({ data: await postPending() });
});

router.patch('/accounting/settings', requirePermission('accounting.manage'), async (req, res) => {
  const body = parse(z.object({ lockDate: day.nullable() }), req.body);
  await runAsPlatform(() => Tenant.updateOne({ _id: req.tenant!._id }, body.lockDate ? { $set: { 'settings.accounting.lockDate': body.lockDate } } : { $unset: { 'settings.accounting.lockDate': 1 } }));
  await audit(req, { action: 'accounting.lock_date', details: { lockDate: body.lockDate } });
  res.json({ data: { lockDate: body.lockDate } });
});

router.get('/accounting/settings', requirePermission('accounting.read'), async (req, res) => {
  res.json({ data: { lockDate: await lockDate(req) } });
});

// ---------- statements ----------
router.get('/accounting/ledger/:code', requirePermission('accounting.read'), async (req, res) => {
  const q = parse(z.object({ from: day.optional(), to: day.optional(), format: z.enum(['json', 'csv']).optional() }), req.query);
  await postPending();
  const a = await Account.findOne({ code: String(req.params.code) }).lean();
  if (!a) throw notFound('Account');
  const r = range(req, q);
  const sign = NATURAL_DEBIT.has(a.type) ? 1 : -1;
  const before = (await sums({ before: r.start })).get(a.code) ?? { debit: 0, credit: 0 };
  let balance = sign * (before.debit - before.credit);
  const opening = balance;
  const journals = await JournalEntry.find({ date: { $gte: r.start, $lt: r.end }, 'lines.accountCode': a.code }).sort({ date: 1, _id: 1 }).lean();
  const rows: Record<string, unknown>[] = [];
  for (const j of journals) for (const l of j.lines.filter((x) => x.accountCode === a.code)) {
    balance += sign * ((l.debitCents ?? 0) - (l.creditCents ?? 0));
    rows.push({ date: j.date, number: j.number, memo: l.memo ?? j.memo, source: j.source?.number ?? '', journalId: j._id, debitCents: l.debitCents, creditCents: l.creditCents, balanceCents: balance });
  }
  send(res, q.format, `ledger-${a.code}`, rows, { data: rows, account: a, openingCents: opening, closingCents: balance, period: { from: r.from, to: r.to } });
});

router.get('/accounting/trial-balance', requirePermission('accounting.read'), async (req, res) => {
  const q = parse(z.object({ asOf: day.optional(), branchId: objectId.optional(), format: z.enum(['json', 'csv']).optional() }), req.query);
  await postPending();
  const asOf = q.asOf ?? localDateString(new Date(), tzOf(req));
  const rows = (await accountsWithBalances(await sums({ before: localMidnightUtc(nextDay(asOf), tzOf(req)), branchId: q.branchId }))).filter((r) => r.debitCents || r.creditCents);
  const out = rows.map((r) => {
    const net = r.debitCents - r.creditCents;
    return { code: r.code, name: r.name, type: r.type, debitCents: net > 0 ? net : 0, creditCents: net < 0 ? -net : 0 };
  });
  const totals = { debitCents: out.reduce((s, r) => s + r.debitCents, 0), creditCents: out.reduce((s, r) => s + r.creditCents, 0) };
  send(res, q.format, `trial-balance-${asOf}`, out, { data: out, totals, balanced: totals.debitCents === totals.creditCents, asOf });
});

router.get('/accounting/profit-loss', requirePermission('accounting.read'), async (req, res) => {
  const q = parse(z.object({ from: day.optional(), to: day.optional(), branchId: objectId.optional(), format: z.enum(['json', 'csv']).optional() }), req.query);
  await postPending();
  const r = range(req, q);
  const rows = await accountsWithBalances(await sums({ from: r.start, before: r.end, branchId: q.branchId }));
  const pick = (f: (a: any) => boolean) => rows.filter((a) => f(a) && (a.debitCents || a.creditCents)).map((a) => ({ code: a.code, name: a.name, amountCents: a.balanceCents }));
  const sum = (x: { amountCents: number }[]) => x.reduce((s, a) => s + a.amountCents, 0);
  const revenue = pick((a) => a.type === 'income' && a.subtype === 'sales');
  const cogs = pick((a) => a.type === 'expense' && a.subtype === 'cogs');
  const otherIncome = pick((a) => a.type === 'income' && a.subtype !== 'sales');
  const expenses = pick((a) => a.type === 'expense' && a.subtype !== 'cogs');
  const netSales = sum(revenue);
  const grossProfit = netSales - sum(cogs);
  const netProfit = grossProfit + sum(otherIncome) - sum(expenses);
  const flat = [...revenue.map((x) => ({ section: 'Revenue', ...x })), ...cogs.map((x) => ({ section: 'Cost of sales', ...x })), ...otherIncome.map((x) => ({ section: 'Other income', ...x })), ...expenses.map((x) => ({ section: 'Expenses', ...x })), { section: 'Net profit', code: '', name: '', amountCents: netProfit }];
  send(res, q.format, `profit-loss-${r.from}-${r.to}`, flat, { data: { revenue, cogs, otherIncome, expenses, netSalesCents: netSales, grossProfitCents: grossProfit, grossMarginBp: netSales ? Math.round((grossProfit / netSales) * 10_000) : 0, netProfitCents: netProfit }, period: { from: r.from, to: r.to } });
});

router.get('/accounting/balance-sheet', requirePermission('accounting.read'), async (req, res) => {
  const q = parse(z.object({ asOf: day.optional(), format: z.enum(['json', 'csv']).optional() }), req.query);
  await postPending();
  const asOf = q.asOf ?? localDateString(new Date(), tzOf(req));
  const rows = await accountsWithBalances(await sums({ before: localMidnightUtc(nextDay(asOf), tzOf(req)) }));
  const pick = (t: string) => rows.filter((a) => a.type === t && (a.debitCents || a.creditCents)).map((a) => ({ code: a.code, name: a.name, subtype: a.subtype, amountCents: a.balanceCents }));
  const sum = (x: { amountCents: number }[]) => x.reduce((s, a) => s + a.amountCents, 0);
  const assets = pick('asset');
  const liabilities = pick('liability');
  const equity = pick('equity');
  const earnings = sum(pick('income')) - sum(pick('expense'));
  const totals = { assetsCents: sum(assets), liabilitiesCents: sum(liabilities), equityCents: sum(equity) + earnings };
  const flat = [...assets.map((x) => ({ section: 'Assets', ...x })), ...liabilities.map((x) => ({ section: 'Liabilities', ...x })), ...equity.map((x) => ({ section: 'Equity', ...x })), { section: 'Equity', code: '', name: 'Profit to date', subtype: 'equity', amountCents: earnings }];
  send(res, q.format, `balance-sheet-${asOf}`, flat, { data: { assets, liabilities, equity, earningsCents: earnings, totals, balanced: totals.assetsCents === totals.liabilitiesCents + totals.equityCents }, asOf });
});

router.get('/accounting/vat', requirePermission('accounting.read'), async (req, res) => {
  const q = parse(z.object({ from: day.optional(), to: day.optional() }), req.query);
  await postPending();
  const r = range(req, q);
  const s = await sums({ from: r.start, before: r.end });
  const out = await Account.findOne({ key: 'vat_output' }).lean();
  const inp = await Account.findOne({ key: 'vat_input' }).lean();
  const o = s.get(out!.code) ?? { debit: 0, credit: 0 };
  const i = s.get(inp!.code) ?? { debit: 0, credit: 0 };
  const output = o.credit - o.debit;
  const input = i.debit - i.credit;
  res.json({ data: { outputVatCents: output, outputOnSalesCents: o.credit, outputReversedOnReturnsCents: o.debit, inputVatCents: input, netPayableCents: output - input }, period: { from: r.from, to: r.to }, note: 'VAT on the VAT 3 return is due by the 20th of the following month. Input VAT counts only with valid supplier eTIMS invoices.' });
});

registerJob('accounting.post', async () => {
  if (env().DEPLOYMENT_MODE === 'branch') return;
  await postPending();
});

export const accountingRoutes = router;
