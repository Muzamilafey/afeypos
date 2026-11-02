import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, type Ctx } from './helpers.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'editshop', 'supermarket');
});
afterAll(teardown);

describe('editing an imported product', () => {
  it('a short barcode from the import (e.g. "67") does not block saving it again', async () => {
    const imp = await t.client.post('/products-import', { commit: true, rows: [{ name: 'nyanya', sku: '67', retail: '100', baseUnit: 'kg', category: 'Fresh produce', brand: 'n/a', barcode: '67', reorderLevel: '100' }] });
    expect(imp.status).toBe(200);
    const id = (await t.client.get('/products?q=nyanya')).body.data[0]._id;
    const p = (await t.client.get(`/products/${id}`)).body.data;
    // What the product page sends back: the product as loaded, with its edits.
    const r = await t.client.put(`/products/${id}`, { ...p, name: 'Nyanya (tomatoes)', categoryId: p.categoryId || null, brandId: p.brandId || null, plu: p.plu || null });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ name: 'Nyanya (tomatoes)', barcodes: [{ code: '67' }] });
  });
});
