import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, createProduct, openShift, rid, Client, type Ctx } from './helpers.js';
import { Sale, StockMovement } from '../src/models/index.js';
import { runAsPlatform } from '../src/lib/context.js';
import { returnPolicy } from '../src/modules/sales/returns.js';
import { abcClass } from '../src/modules/reports/retail.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
let cashier: Client;
let till: string;
let wh: string;
let milk: any;
let bread: any;
let soap: any;

const sell = (c: Client, lines: { productId: string; qty: number; discountCents?: number }[], payments: any[]) => c.post('/sales', { clientRequestId: rid(), tillId: till, lines, payments });

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'mart', 'supermarket');
  till = t.locations.tills[0]._id;
  wh = t.locations.warehouses[0]._id;
  await t.client.post('/settings/users', { name: 'Cathy Cashier', email: 'cathy@mart.test', password: 'Cathy1234', roles: ['cashier'], pin: '1234' });
  await t.client.post('/settings/users', { name: 'Manny Manager', email: 'manny@mart.test', password: 'Manny1234', roles: ['branch_manager'], pin: '9876' });
  cashier = new Client(ctx.api, 'mart');
  await cashier.login('cathy@mart.test', 'Cathy1234');
  await openShift(cashier, till, 500000);
  milk = await createProduct(t.client, { name: 'Milk 500ml', sku: 'MILK', prices: { retail: 6500 }, costCents: 4800, attributes: { department: 'Dairy' }, reorderLevel: 30, reorderQty: 48, openingStock: [{ warehouseId: wh, qty: 40 }] });
  bread = await createProduct(t.client, { name: 'Bread 400g', sku: 'BREAD', prices: { retail: 6000 }, costCents: 4500, attributes: { department: 'Bakery' }, openingStock: [{ warehouseId: wh, qty: 30 }] });
  soap = await createProduct(t.client, { name: 'Bar soap', sku: 'SOAP', prices: { retail: 15000 }, costCents: 11000, attributes: { department: 'Household' }, openingStock: [{ warehouseId: wh, qty: 10 }] });
});
afterAll(teardown);

describe('return policy', () => {
  it('needs approval outside the window or above the approval amount', () => {
    const now = new Date('2026-10-25T10:00:00Z');
    expect(returnPolicy({ returns: { windowDays: 14, approvalAboveCents: 0 } }, new Date('2026-10-20T10:00:00Z'), 100_000, now)).toEqual([]);
    expect(returnPolicy({ returns: { windowDays: 14, approvalAboveCents: 0 } }, new Date('2026-10-01T10:00:00Z'), 100, now)[0]).toMatch(/24 days ago/);
    expect(returnPolicy({ returns: { windowDays: 0, approvalAboveCents: 50_000 } }, new Date('2025-01-01'), 60_000, now)).toEqual(['refund above the approval amount']);
    expect(abcClass(0.5)).toBe('A');
    expect(abcClass(0.9)).toBe('B');
    expect(abcClass(0.99)).toBe('C');
  });
});

describe('returns', () => {
  let saleId: string;
  let saleNumber: string;

  it('finds the sale from the scanned receipt number', async () => {
    const s = await sell(cashier, [{ productId: milk._id, qty: 4 }, { productId: bread._id, qty: 2 }], [{ method: 'cash', amountCents: 38000 }]);
    expect(s.status).toBe(201);
    saleId = s.body.data._id;
    saleNumber = s.body.data.number;
    const found = await cashier.get(`/sales/lookup?code=${saleNumber.toLowerCase()}`);
    expect(found.body.data.map((x: any) => x._id)).toEqual([saleId]);
    const detail = await cashier.get(`/sales/${saleId}`);
    expect(detail.body.data.returnPolicy).toMatchObject({ windowDays: 14, outsideWindow: false });
  });

  it('a cashier needs a supervisor to approve a return', async () => {
    const sale = (await cashier.get(`/sales/${saleId}`)).body.data;
    const body = { clientRequestId: rid(), tillId: till, lines: [{ lineId: sale.lines[0]._id, qty: 1 }], refundMethod: 'cash', reasonCode: 'damaged', reason: 'Leaking pack' };
    const denied = await cashier.post(`/sales/${saleId}/returns`, body);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('OVERRIDE_REQUIRED');
    // Nothing was restocked or refunded by the refused attempt.
    expect((await t.client.get(`/sales/${saleId}`)).body.data.lines[0].returnedQty).toBe(0);
    const ov = await cashier.post('/auth/override', { email: 'manny@mart.test', pin: '9876', permission: 'sales.return' });
    const ok = await cashier.post(`/sales/${saleId}/returns`, { ...body, overrideToken: ov.body.overrideToken });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ refundCents: 6500, reasonCode: 'damaged' });
    expect(ok.body.data.approvedBy).toBeTruthy();

    const slip = await t.client.get(`/returns/${ok.body.data._id}/receipt?format=text`);
    expect(slip.text).toContain(`CREDIT NOTE ${ok.body.data.number}`);
    expect(slip.text).toContain(`For receipt ${saleNumber}`);
    expect(slip.text).toContain('Milk 500ml');
  });

  it('sales outside the return window need returns.approve, even for staff with sales.return', async () => {
    const s = await sell(cashier, [{ productId: soap._id, qty: 2 }], [{ method: 'cash', amountCents: 30000 }]);
    await runAsPlatform(() => Sale.updateOne({ _id: s.body.data._id }, { $set: { completedAt: new Date(Date.now() - 30 * 86400_000) } }));
    const detail = (await t.client.get(`/sales/${s.body.data._id}`)).body.data;
    expect(detail.returnPolicy.outsideWindow).toBe(true);
    const body = { clientRequestId: rid(), tillId: till, lines: [{ lineId: detail.lines[0]._id, qty: 1, restock: false }], refundMethod: 'cash', reasonCode: 'quality', reason: 'Wrong scent' };
    const denied = await cashier.post(`/sales/${s.body.data._id}/returns`, body);
    expect(denied.body.error.code).toBe('OVERRIDE_REQUIRED');
    expect(denied.body.error.message).toMatch(/30 days ago/);
    // An override for the plain return permission is not enough.
    const weak = await cashier.post('/auth/override', { email: 'manny@mart.test', pin: '9876', permission: 'sales.return' });
    expect((await cashier.post(`/sales/${s.body.data._id}/returns`, { ...body, overrideToken: weak.body.overrideToken })).status).toBe(403);
    const ov = await cashier.post('/auth/override', { email: 'manny@mart.test', pin: '9876', permission: 'returns.approve' });
    const ok = await cashier.post(`/sales/${s.body.data._id}/returns`, { ...body, clientRequestId: rid(), overrideToken: ov.body.overrideToken });
    expect(ok.status).toBe(201);
    expect(ok.body.data.approvalReasons[0]).toMatch(/return window/);
    // Owner holds returns.approve and needs no override.
    const own = await t.client.post(`/sales/${s.body.data._id}/returns`, { ...body, clientRequestId: rid() });
    expect(own.status).toBe(201);
  });

  it('M-Pesa refunds create a B2C payout for approval', async () => {
    const s = await sell(t.client, [{ productId: bread._id, qty: 1 }], [{ method: 'cash', amountCents: 6000 }]);
    const sale = (await t.client.get(`/sales/${s.body.data._id}`)).body.data;
    const r = await t.client.post(`/sales/${sale._id}/returns`, { clientRequestId: rid(), lines: [{ lineId: sale.lines[0]._id, qty: 1 }], refundMethod: 'mpesa', mpesaPhone: '0712 345 678', reasonCode: 'not_wanted', reason: 'Bought twice' });
    expect(r.status).toBe(201);
    const ret = (await t.client.get(`/returns/${r.body.data._id}`)).body.data;
    expect(ret.payout).toMatchObject({ status: 'draft', amountCents: 6000, phone: '254712345678' });
    const payouts = (await t.client.get('/payments/payouts')).body.data;
    expect(payouts.find((x: any) => x._id === ret.payout._id).purpose).toBe('refund');
  });

  it('lists returns with the sale and staff names', async () => {
    const list = await t.client.get(`/returns?q=${saleNumber}`);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ saleNumber, processedByName: 'Cathy Cashier', approvedByName: 'Manny Manager' });
    const mine = await cashier.get('/returns');
    expect(mine.body.data.every((r: any) => r.processedByName === 'Cathy Cashier')).toBe(true);
  });
});

describe('supermarket reports', () => {
  beforeAll(async () => {
    await sell(t.client, [{ productId: milk._id, qty: 10, discountCents: 1000 }], [{ method: 'cash', amountCents: 64000 }]);
    await sell(t.client, [{ productId: bread._id, qty: 3 }], [{ method: 'card', amountCents: 18000 }]);
  });

  it('returns report: reasons, methods, cashiers and products', async () => {
    const r = (await t.client.get('/reports/returns')).body.data;
    expect(r.summary.count).toBe(4);
    expect(r.byReason.map((x: any) => x.name)).toEqual(expect.arrayContaining(['Damaged', 'Quality problem', 'Changed mind']));
    expect(r.byMethod.find((x: any) => x._id === 'mpesa').refundCents).toBe(6000);
    expect(r.byCashier.find((x: any) => x.name === 'Cathy Cashier')).toMatchObject({ count: 2, approved: 2 });
    expect(r.summary.returnRateBp).toBeGreaterThan(0);
    const csv = await t.client.get('/reports/returns?format=csv');
    expect(csv.text.split('\n')[0]).toContain('saleNumber');
  });

  it('daily Z summary', async () => {
    const r = (await t.client.get('/reports/daily-summary')).body;
    expect(r.data).toHaveLength(1);
    const d = r.data[0];
    expect(d.salesCount).toBe(4); // the backdated sale falls outside today
    expect(d.cardCents).toBe(18000);
    expect(d.returnsCount).toBe(4);
    expect(d.netCollectedCents).toBe(d.cashCents + d.mpesaCents + d.cardCents + d.bankCents - (6500 + 15000 + 15000 + 6000));
  });

  it('basket analysis, discounts and sales by department and weekday', async () => {
    const b = (await t.client.get('/reports/basket')).body.data;
    expect(b.summary.transactions).toBe(4);
    expect(b.summary.avgBasketCents).toBe(Math.round(b.summary.grossCents / 4));
    expect(b.heatmap.reduce((a: number, h: any) => a + h.count, 0)).toBe(4);
    expect(b.buckets.reduce((a: number, h: any) => a + h.count, 0)).toBe(4);
    const d = (await t.client.get('/reports/discounts')).body.data;
    expect(d.totalCents).toBe(1000);
    expect(d.byProduct[0]).toMatchObject({ name: 'Milk 500ml', discountCents: 1000 });
    const dep = (await t.client.get('/reports/sales?groupBy=department')).body.data;
    expect(dep.find((x: any) => x.name === 'Dairy')).toMatchObject({ qty: 14 });
    const wd = (await t.client.get('/reports/sales?groupBy=weekday')).body.data;
    expect(wd).toHaveLength(1);
    expect(wd[0].count).toBe(4);
  });

  it('product performance with ABC classes and days of cover', async () => {
    const r = (await t.client.get('/reports/product-performance')).body;
    expect(r.data[0]).toMatchObject({ name: 'Milk 500ml', abc: 'A', rank: 1 });
    const m = r.data[0];
    expect(m.qtySold).toBe(13); // 14 sold, 1 returned
    expect(m.marginBp).toBeGreaterThan(0);
    expect(m.daysOfCover).toBeGreaterThanOrEqual(0);
    expect(r.classes.map((c: any) => c.class)).toEqual(['A', 'B', 'C']);
  });

  it('dead stock and reorder suggestions', async () => {
    const slow = await createProduct(t.client, { name: 'Tinned peas', sku: 'PEAS', costCents: 9000, openingStock: [{ warehouseId: wh, qty: 5 }] });
    const dead = (await t.client.get('/reports/dead-stock?days=1')).body;
    // Created today, so not dead yet at 1 day.
    expect(dead.data.find((x: any) => x.name === 'Tinned peas')).toBeUndefined();
    await runAsPlatform(() => StockMovement.updateMany({ productId: slow._id }, { $set: { at: new Date(Date.now() - 40 * 86400_000) } }));
    const dead2 = (await t.client.get('/reports/dead-stock?days=30')).body;
    expect(dead2.data.find((x: any) => x.name === 'Tinned peas')).toMatchObject({ qty: 5, valueCents: 45000, lastSoldAt: null });

    const re = (await t.client.get('/reports/reorder?days=7&leadDays=3&coverDays=7')).body;
    const milkRow = re.data.find((x: any) => x.name === 'Milk 500ml');
    // 40 - 14 sold + 1 restocked = 27 on hand, below the reorder level of 30.
    expect(milkRow).toMatchObject({ onHand: 27, onOrder: 0, reorderPoint: 30 });
    expect(milkRow.suggestQty).toBeGreaterThanOrEqual(48);
    expect(re.data.find((x: any) => x.name === 'Bar soap')).toBeUndefined();
  });
});
