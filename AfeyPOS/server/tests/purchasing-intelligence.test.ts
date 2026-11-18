import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, createProduct, openShift, rid, type Ctx } from './helpers.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
let wh: string;

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'buyshop', 'supermarket');
  wh = t.locations.warehouses[0]._id;
});
afterAll(teardown);

describe('purchasing intelligence', () => {
  it('suggests orders per supplier from sales, lead time and stock on order, and creates drafts only on request', async () => {
    const fast = (await t.client.post('/suppliers', { name: 'Fast Dist', leadTimeDays: 2 })).body.data;
    const slow = (await t.client.post('/suppliers', { name: 'Slow Dist', leadTimeDays: 10 })).body.data;
    expect(fast.leadTimeDays).toBe(2);
    const milk = await createProduct(t.client, { name: 'Milk', sku: 'MLK', prices: { retail: 6500 }, costCents: 5000, supplierId: fast._id });
    const flour = await createProduct(t.client, { name: 'Flour', sku: 'FLR', prices: { retail: 20000 }, costCents: 15000, supplierId: slow._id });
    // Deliveries (one with damaged units) then sales: 20 milk and 20 flour sold.
    await t.client.post('/goods-receipts', { supplierId: fast._id, warehouseId: wh, lines: [{ productId: milk._id, qty: 30, unitCostCents: 5000, damagedQty: 2, note: 'burst packets' }] });
    await t.client.post('/goods-receipts', { supplierId: slow._id, warehouseId: wh, lines: [{ productId: flour._id, qty: 30, unitCostCents: 15000 }] });
    const shift = await openShift(t.client, t.locations.tills[0]._id);
    const sale = await t.client.post('/sales', { clientRequestId: rid(), tillId: t.locations.tills[0]._id, lines: [{ productId: milk._id, qty: 20 }, { productId: flour._id, qty: 20 }], payments: [{ method: 'cash', amountCents: 20 * 6500 + 20 * 20000 }] });
    expect(sale.status).toBe(201);
    await t.client.post(`/shifts/${shift._id}/close`, { countedCashCents: 20 * 6500 + 20 * 20000 });

    const s = (await t.client.post('/purchase-orders/suggest', { warehouseId: wh, days: 28, coverDays: 14 })).body.data;
    expect(s.basis.note).toMatch(/estimate/);
    const bySupplier = Object.fromEntries(s.groups.map((g: any) => [g.supplier, g]));
    // Flour: 20/28 per day x (10 lead + 14 cover) = 17.1 -> 18 needed, 10 on hand -> 8. Milk: 20/28 x 2 x 1.5 = 2.1 reorder point, 10 on hand -> no order.
    expect(bySupplier['Slow Dist'].lines[0]).toMatchObject({ name: 'Flour', onHand: 10, leadDays: 10, suggestQty: 8, unitCostCents: 15000 });
    expect(bySupplier['Fast Dist']).toBeUndefined();
    expect((await t.client.get('/purchase-orders')).body.data).toHaveLength(0);

    const made = (await t.client.post('/purchase-orders/suggest', { warehouseId: wh, create: [{ supplierId: slow._id, lines: [{ productId: flour._id, qty: 8, unitCostCents: 15000 }] }] })).body.data;
    expect(made[0]).toMatchObject({ status: 'draft', totalCents: 120000 });
    // Now on order: no longer suggested.
    const again = (await t.client.post('/purchase-orders/suggest', { warehouseId: wh })).body.data;
    expect(again.groups.find((g: any) => g.supplier === 'Slow Dist')).toBeUndefined();
  });

  it('compares supplier prices for a product on more than price, and reports supplier performance', async () => {
    const a = (await t.client.post('/suppliers', { name: 'Cheap Co', leadTimeDays: 3 })).body.data;
    const b = (await t.client.post('/suppliers', { name: 'Steady Co', leadTimeDays: 3 })).body.data;
    const sugar = await createProduct(t.client, { name: 'Sugar', sku: 'SUG', prices: { retail: 30000 }, costCents: 20000 });
    // Cheap Co: cheaper but delivers late and short; Steady Co: on time and complete.
    const poA = (await t.client.post('/purchase-orders', { supplierId: a._id, warehouseId: wh, expectedAt: new Date(Date.now() - 5 * 86400_000), lines: [{ productId: sugar._id, qty: 10, unitCostCents: 19000 }] })).body.data;
    await t.client.post(`/purchase-orders/${poA._id}/send`, {});
    await t.client.post('/goods-receipts', { supplierId: a._id, warehouseId: wh, purchaseOrderId: poA._id, lines: [{ productId: sugar._id, qty: 5, unitCostCents: 19000, damagedQty: 1 }] });
    const poB = (await t.client.post('/purchase-orders', { supplierId: b._id, warehouseId: wh, expectedAt: new Date(Date.now() + 5 * 86400_000), lines: [{ productId: sugar._id, qty: 10, unitCostCents: 20000 }] })).body.data;
    await t.client.post(`/purchase-orders/${poB._id}/send`, {});
    await t.client.post('/goods-receipts', { supplierId: b._id, warehouseId: wh, purchaseOrderId: poB._id, lines: [{ productId: sugar._id, qty: 10, unitCostCents: 20000 }] });

    const grns = (await t.client.get('/goods-receipts')).body.data;
    const short = grns.find((g: any) => String(g.purchaseOrderId) === poA._id);
    expect(short.lines[0]).toMatchObject({ qty: 5, damagedQty: 1, shortQty: 5 });

    const perf = (await t.client.get('/reports/supplier-performance')).body.data;
    const pa = perf.find((x: any) => x.supplier === 'Cheap Co');
    const pb = perf.find((x: any) => x.supplier === 'Steady Co');
    expect(pa).toMatchObject({ orders: 1, delivered: 1, onTimePct: 0, fillRatePct: 50, damagedPct: 16.7 });
    expect(pb).toMatchObject({ onTimePct: 100, fillRatePct: 100, damagedPct: 0 });

    const cmp = (await t.client.get(`/products/${sugar._id}/supplier-prices`)).body.data;
    expect(cmp.suppliers).toHaveLength(2);
    expect(cmp.suppliers.find((x: any) => x.supplier === 'Cheap Co')).toMatchObject({ lastCostCents: 19000, onTimePct: 0 });
    // Steady Co wins despite costing 5% more.
    expect(cmp.suppliers[0].supplier).toBe('Steady Co');
    expect(cmp.basis).toMatch(/reliability/);
  });
});
