import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ean13CheckDigit, SCALE_FORMAT_PRESETS } from '@afeypos/shared';
import { setupApp, teardown, registerTenant, createProduct, type Ctx } from './helpers.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
const withCheck = (body: string) => body + ean13CheckDigit(body);

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'barco', 'supermarket');
});
afterAll(teardown);

describe('barcode engine', () => {
  it('verifies symbologies and matches UPC-A sent with or without the leading zero', async () => {
    await createProduct(t.client, { name: 'Cola 500ml', sku: 'COLA500', barcodes: [{ code: '036000291452', unitCode: 'pc' }] });
    const upc = (await t.client.get('/barcodes/verify?code=036000291452')).body.data;
    expect(upc).toMatchObject({ format: 'UPC-A', checkDigitValid: true, restricted: false });
    const ean = (await t.client.get('/barcodes/verify?code=0036000291452')).body.data;
    expect(ean.products[0].name).toBe('Cola 500ml');
    const look = await t.client.get('/products/lookup?code=0036000291452');
    expect(look.body.data.product.sku).toBe('COLA500');
  });

  it('generates internal in-store EAN-13 codes that are unique and marked internal', async () => {
    const r = (await t.client.post('/barcodes/generate', { count: 3 })).body.data;
    expect(r.codes).toHaveLength(3);
    expect(new Set(r.codes).size).toBe(3);
    expect(r.internal).toBe(true);
    for (const c of r.codes) {
      expect(c).toMatch(/^04\d{11}$/);
      expect((await t.client.get(`/barcodes/verify?code=${c}`)).body.data).toMatchObject({ checkDigitValid: true, restricted: true });
    }
    // A code already on a product is skipped.
    await createProduct(t.client, { name: 'Bread', sku: 'BRD1', barcodes: [{ code: withCheck('040000000004'), unitCode: 'pc' }] });
    const next = (await t.client.post('/barcodes/generate', {})).body.data.codes[0];
    expect(next).toBe(withCheck('040000000005'));
  });

  it('saves scale label formats and decodes weighed and priced labels at checkout', async () => {
    const weight = { id: 'w', ...SCALE_FORMAT_PRESETS[0] };
    const price = { id: 'p', ...SCALE_FORMAT_PRESETS[1] };
    const bad = await t.client.put('/settings/scale-barcodes', { formats: [{ ...weight, valueStart: 5 }] });
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toMatch(/overlap/);
    const clash = await t.client.put('/settings/scale-barcodes', { formats: [{ ...weight, prefix: '04' }] });
    expect(clash.body.error.message).toMatch(/internal barcodes/);
    expect((await t.client.put('/settings/scale-barcodes', { formats: [weight, price] })).status).toBe(200);
    expect((await t.client.get('/settings/scale-barcodes')).body.data).toMatchObject({ configured: true, internalPrefix: '04' });

    await createProduct(t.client, { name: 'Beef', sku: 'BEEF', plu: '123', baseUnit: 'kg', allowFractional: true, soldByWeight: true, prices: { retail: 80000 } });
    const w = (await t.client.get(`/products/lookup?code=${withCheck('210012301255')}`)).body.data;
    expect(w.product.sku).toBe('BEEF');
    expect(w.weighed).toMatchObject({ qty: 1.255 });
    const p = (await t.client.get(`/products/lookup?code=${withCheck('220012300450')}`)).body.data;
    expect(p.weighed).toMatchObject({ priceCents: 450 });
    const v = (await t.client.get(`/barcodes/verify?code=${withCheck('210012301255')}`)).body.data;
    expect(v.scale).toMatchObject({ formatId: 'w', itemCode: '00123', weight: 1.255, product: { sku: 'BEEF' } });
  });

  it('suggests the next SKU and PLU and flags possible duplicates', async () => {
    const cat = (await t.client.post('/categories', { name: 'Fresh Produce' })).body.data;
    await createProduct(t.client, { name: 'Sukuma wiki bunch', sku: 'FP-0007', categoryId: cat._id });
    expect((await t.client.get(`/catalog/next-sku?categoryId=${cat._id}`)).body.data.sku).toBe('FP-0008');
    expect((await t.client.get('/catalog/next-sku?name=Dairy')).body.data.sku).toBe('DAI-0001');

    await createProduct(t.client, { name: 'Lamb', sku: 'LAMB', plu: '1' });
    const plu = (await t.client.get('/catalog/next-plu?check=0123')).body.data;
    expect(plu.plu).toBe('2');
    expect(plu.check).toMatchObject({ free: false, product: { sku: 'BEEF' } });

    const sim = (await t.client.get('/catalog/similar?name=Sukuma%20wiki%201kg&barcode=036000291452')).body.data;
    expect(sim.exact[0]).toMatchObject({ sku: 'COLA500', matched: 'barcode' });
    expect(sim.similar[0].name).toBe('Sukuma wiki bunch');
    expect(sim.categories[0].name).toBe('Fresh Produce');
  });
});
