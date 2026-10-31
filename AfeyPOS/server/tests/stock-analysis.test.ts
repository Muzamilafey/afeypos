import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, createProduct, openShift, rid, type Ctx } from './helpers.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
let till: string;
let wh: string;
let milk: any;
let bread: any;
let soap: any;
const today = () => new Date().toISOString().slice(0, 10);

const sell = (lines: { productId: string; qty: number }[], amountCents: number) =>
  t.client.post('/sales', { clientRequestId: rid(), tillId: till, lines, payments: [{ method: 'cash', amountCents }] });

const analysis = (query: Record<string, unknown>) => t.client.get(`/reports/stock-analysis?${new URLSearchParams({ from: today(), to: today(), ...query } as any)}`);

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'analysis', 'supermarket');
  till = t.locations.tills[0]._id;
  wh = t.locations.warehouses[0]._id;
  await openShift(t.client, till, 500000);
  milk = await createProduct(t.client, { name: 'Milk 500ml', sku: 'AMILK', prices: { retail: 6500 }, costCents: 5000, openingStock: [{ warehouseId: wh, qty: 100 }] });
  bread = await createProduct(t.client, { name: 'Bread 400g', sku: 'ABREAD', prices: { retail: 6000 }, costCents: 4000, openingStock: [{ warehouseId: wh, qty: 60 }] });
  soap = await createProduct(t.client, { name: 'Bar soap', sku: 'ASOAP', prices: { retail: 15000 }, costCents: 10000, openingStock: [{ warehouseId: wh, qty: 500 }] });
  // Milk and bread go together in three receipts; soap sells once, so its 500 pieces are far too many.
  for (let i = 0; i < 3; i++) expect((await sell([{ productId: milk._id, qty: 7 }, { productId: bread._id, qty: 7 }], 7 * 6500 + 7 * 6000)).status).toBe(201);
  expect((await sell([{ productId: soap._id, qty: 1 }], 15000)).status).toBe(201);
});
afterAll(teardown);

describe('Reports → Stock analysis', () => {
  it('pairs: products bought together, how often, and how much of one goes with the other', async () => {
    const r = await analysis({ tab: 'pairs' });
    expect(r.status).toBe(200);
    expect(r.body.receipts).toBe(3);
    const pair = r.body.data[0];
    expect([pair.a, pair.b].sort()).toEqual(['Bread 400g', 'Milk 500ml']);
    expect(pair.count).toBe(3);
    // Every receipt with milk also had bread.
    expect(pair.withABp).toBe(10_000);
    expect(pair.withBBp).toBe(10_000);
  });

  it('prediction by days: sales rate, days left, the day it runs out and what to order', async () => {
    const r = await analysis({ tab: 'forecastDays', days: '7', leadDays: '2', coverDays: '7' });
    expect(r.status).toBe(200);
    const m = r.body.data.find((x: any) => x.sku === 'AMILK');
    // 21 sold in the last 7 days = 3 a day; 79 left ≈ 26 days.
    expect(m).toMatchObject({ onHand: 79, perDay: 3, daysLeft: 26, expected7: 21, expected30: 90, status: 'enough' });
    expect(new Date(m.outOn).getTime()).toBeGreaterThan(Date.now());
    // Enough milk for now, so nothing to order; the summary counts the whole shop.
    expect(m.orderQty).toBe(0);
    expect(r.body.summary).toMatchObject({ orderNow: 0 });
    expect(r.body.data.find((x: any) => x.sku === 'ASOAP')).toMatchObject({ onHand: 499, status: 'enough' });
  });

  it('prediction by months: what the month used and what the next three need', async () => {
    const r = await analysis({ tab: 'forecastMonths', days: '7' });
    expect(r.status).toBe(200);
    expect(r.body.months).toHaveLength(6);
    expect(r.body.nextMonths).toHaveLength(3);
    const m = r.body.data.find((x: any) => x.sku === 'AMILK');
    expect(m.lastMonth).toBe(21);
    expect(m.expectedPerMonth).toBeCloseTo(91.2, 0);
    // 3 months need ~274, 79 in stock: the rest is ordered.
    expect(m.orderForNext3).toBeGreaterThan(190);
    expect(m.orderCostCents).toBe(m.orderForNext3 * 5000);
  });

  it('money in slow stock: what lasts too long, and the money standing in it', async () => {
    const r = await analysis({ tab: 'overstock', days: '7', leadDays: '2', coverDays: '7' });
    expect(r.status).toBe(200);
    const s = r.body.data.find((x: any) => x.sku === 'ASOAP');
    // 1 sold in 7 days; 499 in stock is years of cover.
    expect(s.monthsOfCover).toBeGreaterThan(100);
    expect(s.excess).toBeGreaterThan(490);
    expect(r.body.totalExcessValueCents).toBeGreaterThan(0);
    // Milk sells fast enough not to count as overstock.
    expect(r.body.data.find((x: any) => x.sku === 'AMILK')).toBeUndefined();
  });

  it('busy days and months', async () => {
    const r = await analysis({ tab: 'seasonality' });
    expect(r.status).toBe(200);
    expect(r.body.data.weekdays.reduce((a: number, w: any) => a + w.count, 0)).toBe(4);
    expect(r.body.data.months.at(-1).month).toBe(today().slice(0, 7));
  });

  it('is CSV-downloadable and needs the stock permission', async () => {
    const csv = await analysis({ tab: 'forecastDays', format: 'csv' });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.split('\n')[0]).toContain('daysLeft');
    await t.client.post('/settings/users', { name: 'Cash Only', email: 'cash@analysis.test', password: 'CashOnly12345', roles: ['cashier'], deniedPermissions: ['inventory.read'] });
    const { Client } = await import('./helpers.js');
    const cashier = new Client(ctx.api, 'analysis');
    await cashier.login('cash@analysis.test', 'CashOnly12345');
    expect((await cashier.get('/reports/stock-analysis?tab=pairs')).status).toBe(403);
  });
});
