import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, createProduct, openShift, rid, Client, OWNER_PASSWORD, type Ctx } from './helpers.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'wizshop', 'supermarket', {}, ['multiBranch', 'multiTill']);
});
afterAll(teardown);

describe('product wizard fields', () => {
  it('stores selling method, minimum price, stock limits, location and label settings', async () => {
    const p = await createProduct(t.client, {
      name: 'Sugar loose', sku: 'SUG-L', baseUnit: 'kg', allowFractional: true, sellingMethod: 'weight', minPriceCents: 14000, prices: { retail: 16000 },
      maxStock: 500, binLocation: 'A3-2', label: { copies: 2, showPrice: true }, units: [{ code: 'bag', name: 'Bag (50 kg)', factor: 50, prices: {} }],
    });
    const got = (await t.client.get(`/products/${p._id}`)).body.data;
    expect(got).toMatchObject({ sellingMethod: 'weight', minPriceCents: 14000, maxStock: 500, binLocation: 'A3-2', label: { copies: 2, showPrice: true } });
    const bad = await t.client.post('/products', { name: 'X', sku: 'X1', prices: { retail: 1000 }, minPriceCents: 2000 });
    expect(bad.body.error.message).toMatch(/minimum price is higher/);
  });

  it('refuses duplicate PLUs (0123 = 123) and barcodes with the product name', async () => {
    await createProduct(t.client, { name: 'Beef', sku: 'BEEF', plu: '123', barcodes: [{ code: '5901234123457', unitCode: 'pc' }] });
    const plu = await t.client.post('/products', { name: 'Goat', sku: 'GOAT', plu: '0123', prices: { retail: 100 } });
    expect(plu.status).toBe(409);
    expect(plu.body.error).toMatchObject({ code: 'DUPLICATE_PLU' });
    expect(plu.body.error.message).toMatch(/Beef/);
    const bc = await t.client.post('/products', { name: 'Goat', sku: 'GOAT', barcodes: [{ code: '5901234123457', unitCode: 'pc' }], prices: { retail: 100 } });
    expect(bc.body.error).toMatchObject({ code: 'DUPLICATE_BARCODE' });
  });

  it('sells at the branch price at that branch and the normal price elsewhere', async () => {
    const b = (await t.client.post('/settings/branches', { name: 'Kisumu', code: 'KSM' })).body.data;
    const till = (await t.client.post('/settings/tills', { branchId: b.branch._id, warehouseId: b.warehouse._id, name: 'Kisumu till', code: 'KS1' })).body.data;
    const p = await createProduct(t.client, {
      name: 'Soda', sku: 'SODA', prices: { retail: 6000 }, branchPrices: [{ branchId: b.branch._id, retail: 7000 }],
      units: [{ code: 'ctn', name: 'Crate', factor: 24, prices: { retail: 130000 } }],
      openingStock: [{ warehouseId: b.warehouse._id, qty: 100 }, { warehouseId: t.locations.warehouses[0]._id, qty: 100 }],
    });
    const sh = await openShift(t.client, till._id);
    const ks = await t.client.post('/sales', { clientRequestId: rid(), tillId: till._id, lines: [{ productId: p._id, qty: 1 }, { productId: p._id, unitCode: 'ctn', qty: 1 }], payments: [{ method: 'cash', amountCents: 7000 + 168000 }] });
    expect(ks.status).toBe(201);
    expect(ks.body.data.lines.map((l: any) => l.unitPriceCents)).toEqual([7000, 168000]);
    await t.client.post(`/shifts/${sh._id}/close`, { countedCashCents: 175000 });
    const main = await openShift(t.client, t.locations.tills[0]._id);
    const hq = await t.client.post('/sales', { clientRequestId: rid(), tillId: t.locations.tills[0]._id, lines: [{ productId: p._id, qty: 1 }, { productId: p._id, unitCode: 'ctn', qty: 1 }], payments: [{ method: 'cash', amountCents: 136000 }] });
    expect(hq.body.data.lines.map((l: any) => l.unitPriceCents)).toEqual([6000, 130000]);
    await t.client.post(`/shifts/${main._id}/close`, { countedCashCents: 136000 });
  });

  it('a price change below the minimum needs someone who manages prices', async () => {
    const p = await createProduct(t.client, { name: 'Rice', sku: 'RICE', prices: { retail: 20000 }, minPriceCents: 18000, openingStock: [{ warehouseId: t.locations.warehouses[0]._id, qty: 10 }] });
    await t.client.post('/settings/users', { name: 'Sup', email: 'sup@wizshop.test', password: 'Passw0rd!x', roles: ['cashier'] });
    const sup = new Client(ctx.api, 'wizshop');
    await sup.login('sup@wizshop.test', 'Passw0rd!x');
    const shift = await openShift(sup, t.locations.tills[0]._id);
    const sale = (price: number, overrideToken?: string) => sup.post('/sales', { clientRequestId: rid(), tillId: t.locations.tills[0]._id, overrideToken, lines: [{ productId: p._id, qty: 1, unitPriceCents: price }], payments: [{ method: 'cash', amountCents: price }] });
    // Above the minimum: the usual price-change approval.
    const above = await sale(19000);
    expect(above.body.error.message).toMatch(/price change on Rice/);
    const below = await sale(15000);
    expect(below.status).toBe(403);
    expect(below.body.error.message).toMatch(/below its minimum price/);
    const token = (await sup.post('/auth/override', { email: 'owner@wizshop.test', password: OWNER_PASSWORD, permission: 'prices.manage' })).body.overrideToken;
    expect((await sale(15000, token)).status).toBe(201);
    await sup.post(`/shifts/${shift._id}/close`, { countedCashCents: 0 });
  });

  it('staff without prices.manage cannot change the minimum or branch prices', async () => {
    const p = await createProduct(t.client, { name: 'Salt', sku: 'SALT', prices: { retail: 5000 } });
    await t.client.post('/settings/users', { name: 'Stock', email: 'stock@wizshop.test', password: 'Passw0rd!x', roles: ['inventory_manager'] });
    const sc = new Client(ctx.api, 'wizshop');
    await sc.login('stock@wizshop.test', 'Passw0rd!x');
    const cur = (await t.client.get(`/products/${p._id}`)).body.data;
    const { _id, tenantId, createdAt, updatedAt, __v, levels, variants, ...body } = cur;
    const r = await sc.put(`/products/${p._id}`, { ...body, minPriceCents: 100 });
    expect(r.body.error.message).toMatch(/prices.manage/);
    expect((await sc.put(`/products/${p._id}`, { ...body, binLocation: 'B1' })).status).toBe(200);
  });
});
