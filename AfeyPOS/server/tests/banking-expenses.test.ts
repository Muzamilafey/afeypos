import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, Client, type Ctx } from './helpers.js';
import { runRecurringExpenses } from '../src/modules/expenses/routes.js';
import { runInTenant } from '../src/lib/context.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
let bank: any;
let safe: any;
const month = () => new Date().toISOString().slice(0, 7);

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'books', 'supermarket', {}, ['accounting', 'expenses']);
  // The chart of accounts is created on first use.
  await t.client.post('/accounting/post', {});
});
afterAll(teardown);

describe('Accounts → money accounts, transfers and reconciliation', () => {
  it('sets up the usual accounts and shows what is in each', async () => {
    const made = await t.client.post('/accounting/money-accounts/defaults', {});
    expect(made.status).toBe(201);
    const list = (await t.client.get('/accounting/money-accounts')).body;
    expect(list.data.map((a: any) => a.name)).toEqual(expect.arrayContaining(['Cash in the safe', 'M-Pesa', 'Bank account']));
    bank = list.data.find((a: any) => a.name === 'Bank account');
    safe = list.data.find((a: any) => a.name === 'Cash in the safe');
    expect(bank.balanceCents).toBe(0);
    // A new account needs a real ledger account behind it.
    expect((await t.client.post('/accounting/money-accounts', { name: 'Nowhere', accountCode: '9999' })).status).toBe(400);
  });

  it('banking the day’s cash moves it from the safe to the bank, and posts both sides', async () => {
    const dep = await t.client.post('/accounting/bank-transactions', { accountId: bank.id ?? bank._id, kind: 'deposit', amountCents: 500000, reference: 'Slip 123' });
    expect(dep.status).toBe(201);
    expect(dep.body.data.journalId).toBeTruthy();
    const journal = (await t.client.get(`/accounting/journals/${dep.body.data.journalId}`)).body.data;
    expect(journal.lines.find((l: any) => l.debitCents === 500000).accountCode).toBe('1020');
    expect(journal.lines.find((l: any) => l.creditCents === 500000).accountCode).toBe('1005');
    const after = (await t.client.get('/accounting/money-accounts')).body.data.find((a: any) => a._id === (bank.id ?? bank._id));
    expect(after.balanceCents).toBe(500000);
  });

  it('transfers between accounts, and bank charges come off the balance', async () => {
    const id = (x: any) => x.id ?? x._id;
    expect((await t.client.post('/accounting/bank-transactions', { accountId: id(bank), kind: 'transfer', amountCents: 100000, toAccountId: id(bank) })).status).toBe(400);
    const tr = await t.client.post('/accounting/bank-transactions', { accountId: id(bank), kind: 'transfer', amountCents: 100000, toAccountId: id(safe) });
    expect(tr.status).toBe(201);
    await t.client.post('/accounting/bank-transactions', { accountId: id(bank), kind: 'charge', amountCents: 5000, memo: 'Monthly ledger fee' });
    const accounts = (await t.client.get('/accounting/money-accounts')).body.data;
    expect(accounts.find((a: any) => a._id === id(bank)).balanceCents).toBe(500000 - 100000 - 5000);
    expect(accounts.find((a: any) => a._id === id(safe)).balanceCents).toBe(100000 - 500000);
  });

  it('reconciles against the bank statement and shows what is still out', async () => {
    const id = bank.id ?? bank._id;
    const before = (await t.client.get(`/accounting/reconciliation?accountId=${id}&statementBalanceCents=395000`)).body;
    expect(before.summary.bookBalanceCents).toBe(395000);
    expect(before.summary.reconciledBalanceCents).toBe(0);
    expect(before.summary.differenceCents).toBe(395000);
    const journalIds = before.data.map((r: any) => r.journalId);
    const done = await t.client.post('/accounting/reconciliation', { accountId: id, journalIds, reconciled: true, statementRef: 'OCT-2026' });
    expect(done.body.data.changed).toBe(journalIds.length);
    const after = (await t.client.get(`/accounting/reconciliation?accountId=${id}&statementBalanceCents=395000`)).body;
    expect(after.summary.reconciledBalanceCents).toBe(395000);
    expect(after.summary.differenceCents).toBe(0);
    expect(after.data.every((r: any) => r.reconciledAt)).toBe(true);
    // A movement that is ticked off cannot simply be deleted.
    const tx = (await t.client.get(`/accounting/bank-transactions?accountId=${id}`)).body.data[0];
    expect((await t.client.delete(`/accounting/bank-transactions/${tx._id}`)).status).toBe(422);
  });
});

describe('Expenses: approvals, budgets and bills that repeat', () => {
  it('an expense over the limit waits for a manager, who approves or turns it down', async () => {
    await t.client.patch('/settings/business', { settings: { expenses: { approvalAboveCents: 200000 } } });
    await t.client.post('/settings/users', { name: 'Clerk Caro', email: 'caro@books.test', password: 'CaroPass12345', roles: ['cashier'], extraPermissions: ['expenses.manage'] });
    const clerk = new Client(ctx.api, 'books');
    await clerk.login('caro@books.test', 'CaroPass12345');

    const small = await clerk.post('/expenses', { category: 'Airtime', amountCents: 50000 });
    expect(small.body.data.status).toBe('approved');
    const big = await clerk.post('/expenses', { category: 'Repairs', amountCents: 450000, payee: 'Fundi Joe' });
    expect(big.body).toMatchObject({ needsApproval: true, data: { status: 'pending' } });
    // The clerk cannot approve their own.
    expect((await clerk.post(`/expenses/${big.body.data._id}/decide`, { approve: true })).status).toBe(403);
    const ok = await t.client.post(`/expenses/${big.body.data._id}/decide`, { approve: true });
    expect(ok.body.data).toMatchObject({ status: 'approved' });
    expect((await t.client.post(`/expenses/${big.body.data._id}/decide`, { approve: false })).status).toBe(422);
    expect((await t.client.get('/expenses?status=pending')).body.data).toHaveLength(0);
    // An owner recording a large expense does not wait for anyone.
    expect((await t.client.post('/expenses', { category: 'Rent', amountCents: 900000 })).body.data.status).toBe('approved');
  });

  it('shows spending against the month’s budget, and what has no budget', async () => {
    expect((await t.client.put('/budgets', { period: month(), category: 'Airtime', amountCents: 100000 })).status).toBe(200);
    await t.client.put('/budgets', { period: month(), category: 'Transport', amountCents: 300000 });
    const b = (await t.client.get(`/budgets?period=${month()}`)).body;
    const airtime = b.data.find((x: any) => x.category === 'Airtime');
    expect(airtime).toMatchObject({ spentCents: 50000, leftCents: 50000, usedBp: 5000, over: false });
    expect(b.data.find((x: any) => x.category === 'Transport')).toMatchObject({ spentCents: 0, over: false });
    expect(b.unbudgeted.map((x: any) => x.category)).toEqual(expect.arrayContaining(['Repairs', 'Rent']));
  });

  it('records a monthly bill once, on the day it is due', async () => {
    const r = await t.client.post('/recurring-expenses', { category: 'Electricity', amountCents: 250000, dayOfMonth: 1, payee: 'Kenya Power', method: 'bank' });
    expect(r.status).toBe(201);
    const run = () => runInTenant(t.tenant.id, () => runRecurringExpenses());
    expect(await run()).toBe(1);
    // Running again the same month changes nothing.
    expect(await run()).toBe(0);
    const made = (await t.client.get('/expenses?category=Electricity')).body.data;
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ amountCents: 250000, payee: 'Kenya Power', status: 'approved' });
  });

  it('expenses download as CSV and can say which account paid', async () => {
    const paid = await t.client.post('/expenses', { category: 'Internet', amountCents: 80000, method: 'bank', bankAccountId: bank.id ?? bank._id });
    expect(paid.status).toBe(201);
    const csv = await t.client.get('/expenses?format=csv');
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('Internet');
  });
});
