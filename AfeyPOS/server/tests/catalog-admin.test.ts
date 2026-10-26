import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, createProduct, type Ctx, Client } from './helpers.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
let cashier: Client;
let wh: string;

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'catalogco', 'minimart');
  wh = t.locations.warehouses[0]._id;
  await t.client.post('/settings/users', { name: 'Cash Ier', email: 'ci@catalog.test', password: 'Cash12345', roles: ['cashier'] });
  cashier = new Client(ctx.api, 'catalogco');
  await cashier.login('ci@catalog.test', 'Cash12345');
});
afterAll(teardown);

describe('inventory catalogue admin', () => {
  it('categories and brands with product counts; in-use ones cannot be deleted', async () => {
    const cat = (await t.client.post('/categories', { name: 'Drinks' })).body.data;
    expect((await t.client.post('/categories', { name: 'Drinks' })).status).toBe(409);
    const brand = (await t.client.post('/brands', { name: 'Coca-Cola' })).body.data;
    expect((await cashier.post('/brands', { name: 'X' })).status).toBe(403);
    await createProduct(t.client, { name: 'Coke 500ml', categoryId: cat._id, brandId: brand._id });
    const cats = (await t.client.get('/categories?withCounts=true')).body.data;
    expect(cats.find((c: any) => c.name === 'Drinks').productCount).toBe(1);
    expect((await t.client.get('/brands?withCounts=true')).body.data[0]).toMatchObject({ name: 'Coca-Cola', productCount: 1 });
    expect((await t.client.delete(`/categories/${cat._id}`)).status).toBe(409);
    expect((await t.client.delete(`/brands/${brand._id}`)).status).toBe(409);
    expect((await t.client.patch(`/brands/${brand._id}`, { name: 'Coca Cola' })).body.data.name).toBe('Coca Cola');
    const spare = (await t.client.post('/brands', { name: 'Spare' })).body.data;
    expect((await t.client.delete(`/brands/${spare._id}`)).status).toBe(200);
  });

  it('units: common ones are listed with usage; used units cannot be deleted', async () => {
    const units = (await t.client.get('/units')).body.data;
    expect(units.map((u: any) => u.code)).toEqual(expect.arrayContaining(['pc', 'kg', 'ctn']));
    expect(units.find((u: any) => u.code === 'pc').productCount).toBeGreaterThan(0);
    const created = await t.client.post('/units', { code: 'ctn24', name: 'Carton of 24' });
    expect(created.status).toBe(201);
    expect((await t.client.post('/units', { code: 'ctn24', name: 'Again' })).status).toBe(409);
    const pc = units.find((u: any) => u.code === 'pc');
    expect((await t.client.delete(`/units/${pc._id}`)).status).toBe(409);
    expect((await t.client.delete(`/units/${created.body.data._id}`)).status).toBe(200);
  });

  it('stock alerts list out-of-stock and low products, with a summary for the menu badge', async () => {
    await createProduct(t.client, { name: 'Low sugar', reorderLevel: 10, openingStock: [{ warehouseId: wh, qty: 3 }] });
    await createProduct(t.client, { name: 'Plenty rice', reorderLevel: 10, openingStock: [{ warehouseId: wh, qty: 50 }] });
    const a = (await cashier.get('/inventory/alerts')).body.data;
    expect(a.outOfStock.map((x: any) => x.product.name)).toContain('Coke 500ml');
    expect(a.low.map((x: any) => x.product.name)).toEqual(['Low sugar']);
    expect((await cashier.get('/inventory/alerts?summary=true')).body.data.counts).toMatchObject({ outOfStock: 1, low: 1, total: 2 });
  });

  it('verifies barcodes: check digit, format and the product it belongs to', async () => {
    const p = await createProduct(t.client, { name: 'Milk 500ml', barcodes: [{ code: '6001234567899', unitCode: 'pc' }], openingStock: [{ warehouseId: wh, qty: 5 }] });
    const ok = (await cashier.get('/barcodes/verify?code=6001234567899')).body.data;
    expect(ok).toMatchObject({ format: 'EAN-13', checkDigitValid: true });
    expect(ok.products[0]).toMatchObject({ _id: p._id, unitCode: 'pc' });
    const bad = (await cashier.get('/barcodes/verify?code=6001234567890')).body.data;
    expect(bad).toMatchObject({ checkDigitValid: false, products: [] });
    expect((await cashier.get('/barcodes/verify?code=HELLO-1')).body.data.format).toBe('Code 128 / text');
  });
});
