import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, createProduct, openShift, rid, type Ctx } from './helpers.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
let till: string;
let wh: string;
let sugar: any;
let supplier: any;
const today = () => new Date().toISOString().slice(0, 10);
const period = `from=${today()}&to=${today()}`;

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'gaps', 'supermarket');
  till = t.locations.tills[0]._id;
  wh = t.locations.warehouses[0]._id;
  await openShift(t.client, till, 100000);
  supplier = (await t.client.post('/suppliers', { name: 'Kapa Ltd', email: 'kapa@gaps.test', phone: '0711000111' })).body.data;
  sugar = await createProduct(t.client, { name: 'Sugar 2kg', sku: 'GSUG', prices: { retail: 32000 }, costCents: 25000 });
  // Two deliveries at different buying prices, then a sale and an expense.
  for (const cost of [24000, 26000]) {
    const r = await t.client.post('/inventory/receive', { clientRequestId: rid(), warehouseId: wh, supplierId: supplier._id, lines: [{ productId: sugar._id, qty: 10, unitCostCents: cost }] });
    expect(r.status).toBe(201);
  }
  expect((await t.client.post('/sales', { clientRequestId: rid(), tillId: till, lines: [{ productId: sugar._id, qty: 2 }], payments: [{ method: 'cash', amountCents: 64000 }] })).status).toBe(201);
  await t.client.post('/expenses', { category: 'Transport', amountCents: 5000, method: 'cash' });
});
afterAll(teardown);

describe('reports that were missing', () => {
  it('supplier statement: what was bought, what was paid and what is left', async () => {
    const r = await t.client.get(`/suppliers/${supplier._id}/statement`);
    expect(r.status).toBe(200);
    expect(r.body.data.supplier.name).toBe('Kapa Ltd');
    // Two deliveries on credit: 240 + 260.
    expect(r.body.data.entries.map((e: any) => e.kind)).toEqual(['purchase', 'purchase']);
    expect(r.body.data.closingBalanceCents).toBe(500000);
    expect(r.body.data.ageing.total).toBe(500000);
    expect((await t.client.post(`/suppliers/${supplier._id}/statement/send`, {})).status).toBe(202);
  });

  it('stock ageing: how long stock has been standing, and the money in each age group', async () => {
    const r = await t.client.get('/reports/stock-ageing');
    expect(r.status).toBe(200);
    const row = r.body.data.find((x: any) => x.sku === 'GSUG');
    expect(row).toMatchObject({ qty: 18, daysInStock: 0, bucket: '0-30 days' });
    expect(row.valueCents).toBe(Math.round(18 * 25000));
    expect(r.body.totals.d0_30).toBeGreaterThan(0);
    expect(r.body.totalValueCents).toBe(r.body.totals.d0_30);
  });

  it('cash flow: money in and out, and the net movement', async () => {
    const r = await t.client.get(`/reports/cash-flow?${period}`);
    expect(r.status).toBe(200);
    expect(r.body.data.find((x: any) => x.what === 'Sales paid by cash')).toMatchObject({ direction: 'in', amountCents: 64000 });
    expect(r.body.data.find((x: any) => x.what === 'Expenses paid by cash')).toMatchObject({ direction: 'out', amountCents: 5000 });
    expect(r.body.summary).toMatchObject({ inCents: 64000, outCents: 5000, netCents: 59000 });
  });

  it('purchase history per product: every delivery and what it cost each time', async () => {
    const r = await t.client.get(`/reports/purchase-history?productId=${sugar._id}`);
    expect(r.status).toBe(200);
    expect(r.body.product.sku).toBe('GSUG');
    expect(r.body.data).toHaveLength(2);
    expect(r.body.data.map((x: any) => x.unitCostCents).sort()).toEqual([24000, 26000]);
    expect(r.body.data[0].supplier).toBe('Kapa Ltd');
    expect(r.body.summary).toMatchObject({ deliveries: 2, qty: 20, spentCents: 500000, lowestCostCents: 24000, highestCostCents: 26000 });
  });
});
