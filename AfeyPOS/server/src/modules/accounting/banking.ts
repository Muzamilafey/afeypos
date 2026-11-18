/**
 * Money accounts and the bank book: the real accounts money sits in (bank, M-Pesa, the safe, a petty-cash
 * float), deposits and withdrawals, transfers between them, bank charges and interest, and ticking entries off
 * against the bank's own statement (reconciliation).
 *
 * Every movement posts its own double entry, so the books stay right without anyone writing a journal.
 */
import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { Account, BankAccount, BankTransaction, JournalEntry } from '../../models/index.js';
import { idParam, objectId, parse, positiveCents } from '../../http/validate.js';
import { requirePermission } from '../../http/auth.js';
import { badRequest, notFound, unprocessable } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { nextNumber } from '../../lib/numbering.js';
import { assertBranchAccess } from '../../http/auth.js';
import { postJournal, postPending } from './posting.js';

export const bankingRoutes = Router();

const KINDS = ['bank', 'mpesa', 'cash', 'petty_cash', 'card', 'other'] as const;
const METHODS = ['cash', 'mpesa', 'bank', 'card', 'other'] as const;

const accountBody = z.object({
  name: z.string().trim().min(2).max(60),
  kind: z.enum(KINDS).default('bank'),
  bank: z.string().trim().max(60).optional(),
  accountNumber: z.string().trim().max(40).optional(),
  branchId: objectId.nullable().optional(),
  accountCode: z.string().trim().min(1).max(20),
  currency: z.string().trim().length(3).optional(),
  openingBalanceCents: z.number().int().optional(),
  openingDate: z.coerce.date().optional(),
  paymentMethods: z.array(z.enum(METHODS)).max(METHODS.length).default([]),
  active: z.boolean().optional(),
  notes: z.string().trim().max(300).optional(),
});

/** What the ledger says is in an account: its opening balance plus every posted movement on its ledger account. */
async function balances(accounts: { _id: unknown; accountCode: string; openingBalanceCents?: number }[]) {
  const codes = [...new Set(accounts.map((a) => a.accountCode))];
  const rows = await JournalEntry.aggregate([
    { $unwind: '$lines' },
    { $match: { 'lines.accountCode': { $in: codes } } },
    { $group: { _id: '$lines.accountCode', cents: { $sum: { $subtract: ['$lines.debitCents', '$lines.creditCents'] } } } },
  ]);
  const posted = new Map(rows.map((r) => [String(r._id), r.cents as number]));
  return new Map(accounts.map((a) => [String(a._id), (a.openingBalanceCents ?? 0) + (posted.get(a.accountCode) ?? 0)]));
}

bankingRoutes.get('/accounting/money-accounts', requirePermission('accounting.read'), async (req, res) => {
  await postPending();
  const q = parse(z.object({ active: z.coerce.boolean().optional() }), req.query);
  const rows = await BankAccount.find(q.active === undefined ? {} : { active: q.active }).sort({ name: 1 }).lean();
  const bal = await balances(rows);
  const pending = await BankTransaction.aggregate([{ $match: { reconciledAt: null } }, { $group: { _id: '$accountId', n: { $sum: 1 } } }]);
  const unreconciled = new Map(pending.map((p) => [String(p._id), p.n as number]));
  res.json({
    data: rows.map((a) => ({ ...a, balanceCents: bal.get(String(a._id)) ?? 0, unreconciled: unreconciled.get(String(a._id)) ?? 0 })),
    totalCents: rows.filter((a) => a.active !== false).reduce((s, a) => s + (bal.get(String(a._id)) ?? 0), 0),
  });
});

bankingRoutes.post('/accounting/money-accounts', requirePermission('accounting.manage'), async (req, res) => {
  const body = parse(accountBody, req.body);
  if (body.branchId) assertBranchAccess(req, body.branchId);
  if (!(await Account.exists({ code: body.accountCode }))) throw badRequest(`No account ${body.accountCode} in the chart of accounts`);
  const a = await BankAccount.create({ ...body, branchId: body.branchId ?? undefined });
  await audit(req, { action: 'bank_account.created', entity: 'BankAccount', entityId: a._id, details: { name: a.name, kind: a.kind } });
  res.status(201).json({ data: a });
});

bankingRoutes.patch('/accounting/money-accounts/:id', requirePermission('accounting.manage'), async (req, res) => {
  const body = parse(accountBody.partial(), req.body);
  if (body.accountCode && !(await Account.exists({ code: body.accountCode }))) throw badRequest(`No account ${body.accountCode} in the chart of accounts`);
  const a = await BankAccount.findOneAndUpdate({ _id: idParam(req.params.id) }, { $set: { ...body, ...(body.branchId === null ? { branchId: undefined } : {}) } }, { new: true });
  if (!a) throw notFound('Money account');
  await audit(req, { action: 'bank_account.updated', entity: 'BankAccount', entityId: a._id, details: { fields: Object.keys(body) } });
  res.json({ data: a });
});

bankingRoutes.delete('/accounting/money-accounts/:id', requirePermission('accounting.manage'), async (req, res) => {
  const id = idParam(req.params.id);
  if (await BankTransaction.exists({ $or: [{ accountId: id }, { toAccountId: id }] })) throw unprocessable('This account has movements recorded against it; make it inactive instead', 'ACCOUNT_IN_USE');
  const a = await BankAccount.findOneAndDelete({ _id: id });
  if (!a) throw notFound('Money account');
  await audit(req, { action: 'bank_account.removed', entity: 'BankAccount', entityId: id, details: { name: a.name } });
  res.json({ ok: true });
});

const txBody = z.object({
  accountId: objectId,
  kind: z.enum(['deposit', 'withdrawal', 'transfer', 'charge', 'interest']),
  toAccountId: objectId.optional(),
  amountCents: positiveCents.refine((v) => v > 0, 'Enter an amount'),
  date: z.coerce.date().optional(),
  reference: z.string().trim().max(60).optional(),
  memo: z.string().trim().max(200).optional(),
  /** Money taken out of a till drawer and banked. */
  shiftId: objectId.optional(),
});

bankingRoutes.get('/accounting/bank-transactions', requirePermission('accounting.read'), async (req, res) => {
  const q = parse(z.object({
    accountId: objectId.optional(), reconciled: z.enum(['true', 'false']).optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional(),
    page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(200).default(50),
  }), req.query);
  const filter: Record<string, unknown> = {};
  if (q.accountId) filter.accountId = q.accountId;
  if (q.reconciled === 'true') filter.reconciledAt = { $ne: null };
  if (q.reconciled === 'false') filter.reconciledAt = null;
  if (q.from || q.to) filter.date = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  const [data, total] = await Promise.all([
    BankTransaction.find(filter).sort({ date: -1, _id: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    BankTransaction.countDocuments(filter),
  ]);
  res.json({ data, total, page: q.page, limit: q.limit });
});

/** Records the movement and posts it: both sides for a transfer, the bank's account and cash/charges otherwise. */
bankingRoutes.post('/accounting/bank-transactions', requirePermission('accounting.manage'), async (req, res) => {
  const body = parse(txBody, req.body);
  const from = await BankAccount.findById(body.accountId).lean();
  if (!from) throw notFound('Money account');
  if (from.active === false) throw badRequest(`${from.name} is not in use any more`);
  const to = body.toAccountId ? await BankAccount.findById(body.toAccountId).lean() : null;
  if (body.kind === 'transfer') {
    if (!to) throw badRequest('Choose the account the money goes to');
    if (String(to._id) === String(from._id)) throw badRequest('Choose two different accounts');
  }
  const date = body.date ?? new Date();
  const number = await nextNumber('bank_tx', 'BNK');
  const amount = body.amountCents;
  const name = (x: { name: string }) => x.name;
  // The other side of the movement, by its role in the chart of accounts (codes can be renumbered).
  const chart = new Map((await Account.find({ key: { $in: ['cash_transit', 'bank_charges', 'bank_interest'] } }, { key: 1, code: 1 }).lean()).map((a) => [a.key as string, a.code]));
  const codeFor = (key: string) => chart.get(key) ?? { cash_transit: '1005', bank_charges: '6960', bank_interest: '4400' }[key]!;

  // What the movement does to each ledger account.
  const lines =
    body.kind === 'transfer'
      ? [{ accountCode: to!.accountCode, debitCents: amount, memo: `From ${name(from)}` }, { accountCode: from.accountCode, creditCents: amount, memo: `To ${name(to!)}` }]
      : body.kind === 'deposit' || body.kind === 'interest'
        ? [{ accountCode: from.accountCode, debitCents: amount }, { accountCode: body.kind === 'interest' ? codeFor('bank_interest') : codeFor('cash_transit'), creditCents: amount, memo: body.kind === 'interest' ? 'Bank interest' : 'Cash banked' }]
        : [{ accountCode: body.kind === 'charge' ? codeFor('bank_charges') : codeFor('cash_transit'), debitCents: amount, memo: body.kind === 'charge' ? 'Bank charges' : 'Cash withdrawn' }, { accountCode: from.accountCode, creditCents: amount }];
  for (const l of lines) {
    if (!(await Account.exists({ code: l.accountCode }))) throw unprocessable(`The chart of accounts has no account ${l.accountCode}; add it under Accounts → Chart of accounts`, 'ACCOUNT_MISSING');
  }
  const memo = body.memo || { deposit: `Deposit into ${name(from)}`, withdrawal: `Withdrawal from ${name(from)}`, transfer: `Transfer ${name(from)} → ${to ? name(to) : ''}`, charge: `Bank charges on ${name(from)}`, interest: `Interest on ${name(from)}` }[body.kind];
  const tx = await BankTransaction.create({
    number, accountId: from._id, kind: body.kind, toAccountId: to?._id, amountCents: amount, date,
    reference: body.reference, memo, branchId: from.branchId, shiftId: body.shiftId, userId: req.auth!.userId,
  });
  const journal = await postJournal(null, { date, memo, source: { type: 'BankTransaction', id: tx._id, number }, key: `banktx:${tx._id}`, branchId: from.branchId, lines, manual: false, createdBy: req.auth!.userId });
  if (journal) await BankTransaction.updateOne({ _id: tx._id }, { $set: { journalId: journal._id } });
  await audit(req, { action: 'bank_transaction.created', entity: 'BankTransaction', entityId: tx._id, details: { kind: body.kind, amountCents: amount, account: from.name } });
  res.status(201).json({ data: { ...tx.toObject(), journalId: journal?._id } });
});

bankingRoutes.delete('/accounting/bank-transactions/:id', requirePermission('accounting.manage'), async (req, res) => {
  const tx = await BankTransaction.findById(idParam(req.params.id));
  if (!tx) throw notFound('Movement');
  if (tx.reconciledAt) throw unprocessable('This movement is already ticked off against a statement; untick it first', 'ALREADY_RECONCILED');
  // The journal is reversed rather than deleted, so the books keep their history.
  if (tx.journalId) {
    const j = await JournalEntry.findById(tx.journalId).lean();
    if (j) {
      await postJournal(null, {
        date: new Date(), memo: `Reversal of ${j.number} (${j.memo})`, source: { type: 'BankTransaction', id: tx._id, number: tx.number }, key: `banktx-rev:${tx._id}`,
        branchId: tx.branchId, reversalOf: j._id, createdBy: req.auth!.userId,
        lines: j.lines.map((l: any) => ({ accountCode: l.accountCode, debitCents: l.creditCents, creditCents: l.debitCents, memo: l.memo })),
      });
      await JournalEntry.updateOne({ _id: j._id }, { $set: { reversedBy: tx._id } });
    }
  }
  await BankTransaction.deleteOne({ _id: tx._id });
  await audit(req, { action: 'bank_transaction.removed', entity: 'BankTransaction', entityId: tx._id, details: { number: tx.number } });
  res.json({ ok: true });
});

/**
 * Reconciliation: everything that touched the account's ledger up to the statement date, what is already
 * ticked off, and the difference against the balance the bank says. A clean reconciliation ends at zero.
 */
bankingRoutes.get('/accounting/reconciliation', requirePermission('accounting.read'), async (req, res) => {
  await postPending();
  const q = parse(z.object({ accountId: objectId, to: z.coerce.date().optional(), statementBalanceCents: z.coerce.number().int().optional() }), req.query);
  const account = await BankAccount.findById(q.accountId).lean();
  if (!account) throw notFound('Money account');
  const to = q.to ?? new Date();
  const entries = await JournalEntry.aggregate([
    { $match: { date: { $lte: to }, 'lines.accountCode': account.accountCode } },
    { $unwind: '$lines' },
    { $match: { 'lines.accountCode': account.accountCode } },
    { $project: { number: 1, date: 1, memo: 1, source: 1, amountCents: { $subtract: ['$lines.debitCents', '$lines.creditCents'] } } },
    { $sort: { date: -1, _id: -1 } },
    { $limit: 1000 },
  ]);
  const txs = await BankTransaction.find({ accountId: account._id, date: { $lte: to } }, { journalId: 1, reconciledAt: 1, statementRef: 1, number: 1 }).lean();
  const byJournal = new Map(txs.filter((t) => t.journalId).map((t) => [String(t.journalId), t]));
  const rows = entries.map((e) => {
    const tx = byJournal.get(String(e._id));
    return {
      journalId: e._id, bankTransactionId: tx?._id ?? null, number: e.number, date: e.date, memo: e.memo, source: e.source,
      amountCents: e.amountCents, reconciledAt: tx?.reconciledAt ?? null, statementRef: tx?.statementRef ?? null,
    };
  });
  const booked = (account.openingBalanceCents ?? 0) + rows.reduce((s, r) => s + r.amountCents, 0);
  const ticked = (account.openingBalanceCents ?? 0) + rows.filter((r) => r.reconciledAt).reduce((s, r) => s + r.amountCents, 0);
  res.json({
    data: rows,
    account: { id: account._id, name: account.name, accountCode: account.accountCode, kind: account.kind },
    summary: {
      bookBalanceCents: booked, reconciledBalanceCents: ticked, notReconciledCents: booked - ticked,
      statementBalanceCents: q.statementBalanceCents ?? null,
      differenceCents: q.statementBalanceCents === undefined ? null : q.statementBalanceCents - ticked,
      toDate: to,
    },
  });
});

/**
 * Ticks movements off against the statement (or unticks them). Entries that came from a sale or an expense
 * have no bank movement of their own, so one is recorded for them first, with no journal of its own.
 */
bankingRoutes.post('/accounting/reconciliation', requirePermission('accounting.manage'), async (req, res) => {
  const body = parse(z.object({
    accountId: objectId,
    journalIds: z.array(objectId).min(1).max(500),
    reconciled: z.boolean().default(true),
    statementRef: z.string().trim().max(60).optional(),
  }), req.body);
  const account = await BankAccount.findById(body.accountId).lean();
  if (!account) throw notFound('Money account');
  const when = body.reconciled ? new Date() : null;
  let changed = 0;
  for (const journalId of body.journalIds) {
    const existing = await BankTransaction.findOne({ accountId: account._id, journalId });
    if (existing) {
      await BankTransaction.updateOne({ _id: existing._id }, body.reconciled ? { $set: { reconciledAt: when, reconciledBy: req.auth!.userId, statementRef: body.statementRef } } : { $set: { reconciledAt: null, statementRef: undefined }, $unset: { reconciledBy: 1 } });
      changed++;
      continue;
    }
    if (!body.reconciled) continue;
    const j = await JournalEntry.findById(journalId).lean();
    if (!j) continue;
    const cents = j.lines.filter((l: any) => l.accountCode === account.accountCode).reduce((s: number, l: any) => s + (l.debitCents - l.creditCents), 0);
    await BankTransaction.create({
      number: await nextNumber('bank_tx', 'BNK'), accountId: account._id, kind: cents >= 0 ? 'deposit' : 'withdrawal', amountCents: Math.abs(cents) || 1,
      date: j.date, memo: j.memo, reference: j.source?.number, branchId: account.branchId, journalId: j._id,
      reconciledAt: when, reconciledBy: req.auth!.userId, statementRef: body.statementRef, userId: req.auth!.userId,
    });
    changed++;
  }
  await audit(req, { action: body.reconciled ? 'bank.reconciled' : 'bank.unreconciled', entity: 'BankAccount', entityId: account._id, details: { count: changed, statementRef: body.statementRef } });
  res.json({ data: { changed } });
});

/** Opening balances and ledger codes used when a business sets its money accounts up for the first time. */
export const DEFAULT_MONEY_ACCOUNTS: { name: string; kind: (typeof KINDS)[number]; accountCode: string; paymentMethods: string[] }[] = [
  { name: 'Cash in the safe', kind: 'cash', accountCode: '1005', paymentMethods: ['cash'] },
  { name: 'M-Pesa', kind: 'mpesa', accountCode: '1010', paymentMethods: ['mpesa'] },
  { name: 'Bank account', kind: 'bank', accountCode: '1020', paymentMethods: ['bank', 'card'] },
];

bankingRoutes.post('/accounting/money-accounts/defaults', requirePermission('accounting.manage'), async (req, res) => {
  const made: unknown[] = [];
  for (const d of DEFAULT_MONEY_ACCOUNTS) {
    if (await BankAccount.exists({ name: d.name })) continue;
    if (!(await Account.exists({ code: d.accountCode }))) continue;
    made.push(await BankAccount.create({ ...d, branchId: undefined as unknown as Types.ObjectId }));
  }
  res.status(201).json({ data: made });
});
