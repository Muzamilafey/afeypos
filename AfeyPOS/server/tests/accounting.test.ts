import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, createProduct, openShift, rid, type Ctx } from './helpers.js';
import { JournalEntry } from '../src/models/index.js';
import { runAsPlatform } from '../src/lib/context.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
let till: string;
let wh: string;
let supplierId: string;
let customerId: string;
let product: any;

const today = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
const bal = (rows: any[], code: string) => rows.find((r) => r.code === code)?.balanceCents ?? 0;

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'books', 'supermarket');
  till = t.locations.tills[0]._id;
  wh = t.locations.warehouses[0]._id;
  await openShift(t.client, till, 500_000);
  supplierId = (await t.client.post('/suppliers', { name: 'Bidco Distributors' })).body.data._id;
  customerId = (await t.client.post('/customers', { name: 'Hotel Baraka', creditLimitCents: 10_000_000, phone: '0722000111' })).body.data._id;
  // Opening stock 10 @ 80, then 20 @ 80 received with VAT; selling price 116 incl. 16 % VAT.
  product = await createProduct(t.client, { name: 'Cooking oil 1L', sku: 'OIL1', prices: { retail: 11600 }, costCents: 8000, taxRateBp: 1600, openingStock: [{ warehouseId: wh, qty: 10 }] });
  expect((await t.client.post('/goods-receipts', { supplierId, warehouseId: wh, supplierInvoiceNo: 'B-77', taxCents: 25600, lines: [{ productId: product._id, qty: 20, unitCostCents: 8000 }] })).status).toBe(201);
  // Cash sale of 3, M-Pesa-like card sale of 2, credit sale of 5.
  await t.client.post('/sales', { clientRequestId: rid(), tillId: till, lines: [{ productId: product._id, qty: 3 }], payments: [{ method: 'cash', amountCents: 34800 }] });
  await t.client.post('/sales', { clientRequestId: rid(), tillId: till, lines: [{ productId: product._id, qty: 2 }], payments: [{ method: 'card', amountCents: 23200, reference: 'VISA1' }] });
  const credit = await t.client.post('/sales', { clientRequestId: rid(), tillId: till, customerId, lines: [{ productId: product._id, qty: 5 }], payments: [{ method: 'credit', amountCents: 58000 }] });
  expect(credit.status).toBe(201);
  // A voided sale, a return to the shelf, supplier and customer payments, an expense and a damage write-off.
  const v = await t.client.post('/sales', { clientRequestId: rid(), tillId: till, lines: [{ productId: product._id, qty: 1 }], payments: [{ method: 'cash', amountCents: 11600 }] });
  await t.client.post(`/sales/${v.body.data._id}/void`, { clientRequestId: rid(), reason: 'Wrong item' });
  const first = (await t.client.get('/sales?limit=10')).body.data.find((s: any) => s.payments[0].method === 'cash' && s.status === 'completed');
  await t.client.post(`/sales/${first._id}/returns`, { clientRequestId: rid(), tillId: till, lines: [{ lineId: first.lines[0]._id, qty: 1 }], refundMethod: 'cash', reasonCode: 'damaged', reason: 'Leaking' });
  await t.client.post(`/suppliers/${supplierId}/payments`, { clientRequestId: rid(), amountCents: 100_000, method: 'bank', reference: 'EFT1' });
  await t.client.post(`/customers/${customerId}/payments`, { clientRequestId: rid(), amountCents: 20_000, method: 'bank', reference: 'CHQ1' });
  await t.client.post('/expenses', { category: 'Electricity', amountCents: 11_600, taxCents: 1_600, method: 'mpesa', payee: 'KPLC' });
  await t.client.post('/inventory/adjustments', { warehouseId: wh, reason: 'damage', approveNow: true, lines: [{ productId: product._id, qty: -1 }] });
});
afterAll(teardown);

describe('automatic journals', () => {
  it('posts every document once and the trial balance balances', async () => {
    const r = await t.client.post('/accounting/post', {});
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ sales: 4, returns: 1, grns: 1 });
    const again = await t.client.post('/accounting/post', {});
    expect(Object.values(again.body.data).every((n) => n === 0)).toBe(true);
    const tb = (await t.client.get('/accounting/trial-balance')).body;
    expect(tb.balanced).toBe(true);
    expect(tb.totals.debitCents).toBeGreaterThan(0);
    const keys = (await runAsPlatform(() => JournalEntry.find({}).lean())).map((j) => j.sourceKey).filter(Boolean);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('agrees with stock valuation, receivables, payables, profit and VAT reports', async () => {
    const accounts = (await t.client.get('/accounting/accounts')).body.data;
    const stock = (await t.client.get('/reports/inventory-valuation')).body.totalValueCents;
    expect(Math.abs(bal(accounts, '1200') - stock)).toBeLessThanOrEqual(5);
    const receivables = (await t.client.get('/reports/receivables')).body.totalCents;
    expect(bal(accounts, '1100')).toBe(receivables);
    expect(bal(accounts, '1100')).toBe(58000 - 20000);
    const payables = (await t.client.get('/reports/payables')).body.totalCents;
    expect(bal(accounts, '2000')).toBe(payables);
    expect(bal(accounts, '2000')).toBe(160000 + 25600 - 100000);
    // Cash: 348 + 116 (voided, reversed) - 116 - 116 refund = 232 in the till.
    expect(bal(accounts, '1000')).toBe(34800 - 11600);
    expect(bal(accounts, '1030')).toBe(23200);
    expect(bal(accounts, '1010')).toBe(-11600);
    expect(bal(accounts, '1020')).toBe(20000 - 100000);

    const plr = (await t.client.get(`/accounting/profit-loss?from=${today()}&to=${today()}`)).body.data;
    const profit = (await t.client.get(`/reports/profit?from=${today()}&to=${today()}`)).body.data[0];
    expect(plr.netSalesCents).toBe(profit.netRevenueCents);
    // Ledger gross profit also carries the damaged stock written off; the sales report does not.
    const losses = plr.cogs.find((c: any) => c.code === '5100')?.amountCents ?? 0;
    expect(plr.grossProfitCents + losses).toBe(profit.grossProfitCents);
    expect(losses).toBe(8000);
    expect(plr.expenses.find((e: any) => e.name === 'Electricity').amountCents).toBe(10_000);

    const vat = (await t.client.get(`/accounting/vat?from=${today()}&to=${today()}`)).body.data;
    const tax = (await t.client.get(`/reports/tax?from=${today()}&to=${today()}`)).body.data;
    expect(vat.outputVatCents).toBe(tax.outputTaxCents);
    expect(vat.inputVatCents).toBe(25600 + 1600);
    expect(vat.netPayableCents).toBe(vat.outputVatCents - 27200);

    const bs = (await t.client.get('/accounting/balance-sheet')).body.data;
    expect(bs.balanced).toBe(true);
    expect(bs.earningsCents).toBe(plr.netProfitCents);
  });

  it('reverses a void and keeps the general ledger with running balances', async () => {
    const voids = (await t.client.get('/accounting/journals?q=Void')).body.data;
    expect(voids).toHaveLength(1);
    const led = (await t.client.get('/accounting/ledger/1000')).body;
    expect(led.closingCents).toBe(34800 - 11600);
    expect(led.data.at(-1).balanceCents).toBe(led.closingCents);
    const csv = await t.client.get('/accounting/ledger/1200?format=csv');
    expect(csv.text.split('\n')[0]).toContain('balanceCents');
  });

  it('rebuilding recreates the same books', async () => {
    const before = (await t.client.get('/accounting/trial-balance')).body;
    const r = await t.client.post('/accounting/post', { rebuild: true });
    expect(r.body.data.sales).toBe(4);
    const after = (await t.client.get('/accounting/trial-balance')).body;
    expect(after.data).toEqual(before.data);
  });
});

describe('manual journals and closing the books', () => {
  it('posts balanced manual journals, reverses them and respects the lock date', async () => {
    const bad = await t.client.post('/accounting/journals', { date: today(), memo: 'Unbalanced', lines: [{ accountCode: '1500', debitCents: 100 }, { accountCode: '3000', creditCents: 90 }] });
    expect(bad.status).toBe(400);
    const capital = await t.client.post('/accounting/journals', { date: today(), memo: 'Shelving bought by the owner', lines: [{ accountCode: '1500', debitCents: 5_000_000 }, { accountCode: '3000', creditCents: 5_000_000 }] });
    expect(capital.status).toBe(201);
    const auto = (await t.client.get('/accounting/journals?sourceType=Sale')).body.data[0];
    expect((await t.client.post(`/accounting/journals/${auto._id}/reverse`, {})).body.error.code).toBe('AUTOMATIC_JOURNAL');
    const rev = await t.client.post(`/accounting/journals/${capital.body.data._id}/reverse`, {});
    expect(rev.status).toBe(201);
    expect((await t.client.post(`/accounting/journals/${capital.body.data._id}/reverse`, {})).status).toBe(422);
    expect(bal((await t.client.get('/accounting/accounts')).body.data, '1500')).toBe(0);
    await t.client.patch('/accounting/settings', { lockDate: today() });
    const locked = await t.client.post('/accounting/journals', { date: today(), memo: 'Too late', lines: [{ accountCode: '1500', debitCents: 100 }, { accountCode: '3000', creditCents: 100 }] });
    expect(locked.body.error.code).toBe('PERIOD_LOCKED');
    await t.client.patch('/accounting/settings', { lockDate: null });
  });

  it('adds custom accounts and puts each expense category in its own account', async () => {
    expect((await t.client.post('/accounting/accounts', { code: '1510', name: 'Delivery motorbike', type: 'asset', subtype: 'fixed_asset' })).status).toBe(201);
    expect((await t.client.post('/accounting/accounts', { code: '1510', name: 'Dup', type: 'asset' })).status).toBe(422);
    expect((await t.client.patch('/accounting/accounts/1000', { active: false })).body.error.code).toBe('SYSTEM_ACCOUNT');
    const accounts = (await t.client.get('/accounting/accounts')).body.data;
    expect(accounts.find((a: any) => a.name === 'Electricity')).toMatchObject({ code: '6100', type: 'expense', balanceCents: 10_000 });
  });
});
