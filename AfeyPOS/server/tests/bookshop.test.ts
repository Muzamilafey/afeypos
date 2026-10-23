import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, createProduct, openShift, rid, BASE, type Ctx } from './helpers.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
let till: string;
let wh: string;

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'readmore', 'bookshop');
  till = t.locations.tills[0]._id;
  wh = t.locations.warehouses[0]._id;
  await openShift(t.client, till);
});
afterAll(teardown);

describe('bookshop business type', () => {
  it('is offered at setup and enables book fields and school-account modules', async () => {
    const types = await ctx.api.get('/api/v1/public/business-types').set('Host', BASE);
    expect(types.body.data.map((x: any) => x.type)).toContain('bookshop');
    const me = await t.client.get('/auth/me');
    const caps = me.body.data?.capabilities ?? me.body.capabilities;
    expect(caps.productFields).toEqual(expect.arrayContaining(['isbn', 'author', 'publisher', 'gradeLevel']));
    expect(caps.modules).toEqual(expect.arrayContaining(['customerCredit', 'quotations', 'salesOrders', 'invoices']));
    expect(caps.priceLists).toEqual(['retail', 'wholesale']);
  });

  it('stores ISBN-13, makes it scannable from any ISBN form, and searches by author', async () => {
    const book = await createProduct(t.client, {
      name: 'Field Guide to Testing', sku: 'BK-1', prices: { retail: 120000 },
      attributes: { isbn: '0-306-40615-2', author: 'Wanjiru Kamau', publisher: 'Lakeside Press', gradeLevel: 'Form 3', bookCondition: 'New' },
      openingStock: [{ warehouseId: wh, qty: 5 }],
    });
    expect(book.attributes.isbn).toBe('9780306406157');
    expect(book.barcodes).toEqual([{ code: '9780306406157', unitCode: 'pc' }]);

    for (const code of ['9780306406157', '978-0-306-40615-7', '0306406152']) {
      const r = await t.client.get(`/products/lookup?code=${encodeURIComponent(code)}`);
      expect(r.status).toBe(200);
      expect(r.body.data.product._id).toBe(book._id);
    }
    const byAuthor = await t.client.get('/products?q=kamau');
    expect(byAuthor.body.data.map((p: any) => p._id)).toContain(book._id);
    expect((await t.client.get('/products?q=form%203')).body.data.map((p: any) => p._id)).toContain(book._id);

    // A second-hand copy shares the ISBN: no barcode clash, still found by ISBN search.
    const used = await createProduct(t.client, { name: 'Field Guide to Testing (used)', sku: 'BK-1U', prices: { retail: 60000 }, attributes: { isbn: '9780306406157', author: 'Wanjiru Kamau', bookCondition: 'Used - good' } });
    expect(used.barcodes).toEqual([]);
    const byIsbn = await t.client.get('/products?q=0-306-40615-2');
    expect(byIsbn.body.data.map((p: any) => p._id)).toEqual(expect.arrayContaining([book._id, used._id]));

    const bad = await t.client.post('/products', { name: 'Typo', sku: 'BK-BAD', prices: { retail: 100 }, attributes: { isbn: '0-306-40615-3' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toContain('ISBN');

    const sale = await t.client.post('/sales', { clientRequestId: rid(), tillId: till, lines: [{ productId: book._id, qty: 2 }], payments: [{ method: 'cash', amountCents: 240000, tenderedCents: 240000 }] });
    expect(sale.status).toBe(201);
  });
});
