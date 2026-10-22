import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, createProduct, openShift, rid, type Ctx } from './helpers.js';
import { localMidnightUtc, localDateString } from '../src/modules/reports/routes.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'reportco', 'retail');
});
afterAll(teardown);

describe('timezone handling', () => {
  it('converts local dates to UTC instants', () => {
    expect(localMidnightUtc('2026-03-10', 'Africa/Nairobi').toISOString()).toBe('2026-03-09T21:00:00.000Z');
    expect(localMidnightUtc('2026-07-01', 'Europe/London').toISOString()).toBe('2026-06-30T23:00:00.000Z');
    expect(localDateString(new Date('2026-03-09T21:30:00Z'), 'Africa/Nairobi')).toBe('2026-03-10');
  });
});

describe('financial reports', () => {
  it('separates revenue, tax, COGS, profit, returns, expenses and cash received', async () => {
    const wh = t.locations.warehouses[0]._id;
    const till = t.locations.tills[0]._id;
    const shift = await openShift(t.client, till, 100000);
    const p = await createProduct(t.client, { prices: { retail: 11600 }, costCents: 6000, openingStock: [{ warehouseId: wh, qty: 10, unitCostCents: 6000 }] });
    const cust = (await t.client.post('/customers', { name: 'Credit Customer', creditLimitCents: 1000000 })).body.data;
    // Cash sale of 2 and a credit sale of 3.
    const s1 = (await t.client.post('/sales', { clientRequestId: rid(), tillId: till, lines: [{ productId: p._id, qty: 2 }], payments: [{ method: 'cash', amountCents: 23200 }] })).body.data;
    await t.client.post('/sales', { clientRequestId: rid(), tillId: till, customerId: cust._id, lines: [{ productId: p._id, qty: 3 }], payments: [{ method: 'credit', amountCents: 34800 }] });
    // Return 1 from the cash sale.
    await t.client.post(`/sales/${s1._id}/returns`, { clientRequestId: rid(), tillId: till, lines: [{ lineId: s1.lines[0]._id, qty: 1 }], refundMethod: 'cash', reason: 'Changed mind' });
    await t.client.post('/expenses', { category: 'Transport', amountCents: 5000, method: 'cash', shiftId: shift._id });
    const r = (await t.client.get('/reports/profit')).body.data[0];
    expect(r.grossSalesCents).toBe(58000);
    expect(r.returnsCents).toBe(11600);
    expect(r.netRevenueCents).toBe(40000); // 4 units x 100.00 net of 16% VAT
    expect(r.outputTaxCents).toBe(6400);
    expect(r.cogsCents).toBe(24000);
    expect(r.grossProfitCents).toBe(16000);
    expect(r.expensesCents).toBe(5000);
    expect(r.operatingProfitCents).toBe(11000);
    expect(r.cashReceivedCents).toBe(23200 - 11600);
    expect(r.creditSalesCents).toBe(34800);
    const byProduct = (await t.client.get('/reports/sales?groupBy=product')).body.data;
    expect(byProduct[0].qty).toBe(5);
    const csv = await t.client.get('/reports/sales?groupBy=day&format=csv');
    expect(csv.headers['content-type']).toContain('text/csv');
    const val = (await t.client.get('/reports/inventory-valuation')).body;
    expect(val.totalValueCents).toBe(6 * 6000);
    expect(val.costingMethod).toBe('weighted_average');
    const dash = (await t.client.get('/reports/dashboard')).body.data;
    expect(dash.sales.count).toBe(2);
    expect(dash.receivablesCents).toBe(34800);
    const tax = (await t.client.get('/reports/tax')).body.data;
    expect(tax.outputTaxCents).toBe(6400);
    const sum = (await t.client.get(`/shifts/${shift._id}/summary`)).body.data;
    expect(sum.expectedCashCents).toBe(100000 + 23200 - 11600 - 5000);
    const exc = (await t.client.get('/reports/exceptions')).body.data;
    expect(exc.totals.returnsCents).toBe(11600);
  });
});
