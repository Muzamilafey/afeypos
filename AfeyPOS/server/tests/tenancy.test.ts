import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { setupApp, teardown, registerTenant, createProduct, Client, BASE, type Ctx } from './helpers.js';
import { Product, Tenant } from '../src/models/index.js';
import { runInTenant, runAsPlatform, TenantContextError } from '../src/lib/context.js';

let ctx: Ctx;
let a: Awaited<ReturnType<typeof registerTenant>>;
let b: Awaited<ReturnType<typeof registerTenant>>;

beforeAll(async () => {
  ctx = await setupApp();
  a = await registerTenant(ctx.api, 'alpha', 'minimart');
  b = await registerTenant(ctx.api, 'bravo', 'hardware');
});
afterAll(teardown);

describe('subdomain resolution', () => {
  it('returns 404 for unknown tenants and the bare domain', async () => {
    expect((await ctx.api.get('/api/v1/auth/me').set('Host', `nobody.${BASE}`)).status).toBe(404);
    expect((await ctx.api.get('/api/v1/products').set('Host', BASE)).status).toBe(404);
  });
  it('ignores the X-Tenant header unless explicitly allowed', async () => {
    const r = await ctx.api.get('/api/v1/public/config').set('Host', BASE).set('X-Tenant', 'alpha');
    expect(r.body.tenant).toBeNull();
  });
  it('resolves custom domains', async () => {
    await runAsPlatform(() => Tenant.updateOne({ slug: 'alpha' }, { $set: { customDomains: ['shop.alpha-example.co.ke'] } }));
    const r = await ctx.api.get('/api/v1/public/config').set('Host', 'shop.alpha-example.co.ke');
    expect(r.body.tenant.slug).toBe('alpha');
  });
});

describe('tenant isolation', () => {
  it('rejects a token from one tenant on another tenant host', async () => {
    const stolen = new Client(ctx.api, 'bravo').as(a.client.token);
    const r = await stolen.get('/products');
    expect(r.status).toBe(401);
  });

  it('prevents cross-tenant reads and writes by id (IDOR)', async () => {
    const p = await createProduct(a.client, { name: 'Alpha secret', sku: 'A-1' });
    expect((await b.client.get(`/products/${p._id}`)).status).toBe(404);
    expect((await b.client.put(`/products/${p._id}`, { name: 'hijack', sku: 'A-1' })).status).toBe(404);
    expect((await b.client.delete(`/products/${p._id}`)).status).toBe(404);
    const list = await b.client.get('/products?q=Alpha');
    expect(list.body.data).toHaveLength(0);
    // Same SKU is allowed in another tenant (compound unique index tenantId+sku).
    await createProduct(b.client, { name: 'Bravo item', sku: 'A-1' });
    // B cannot sell A's product even with its id.
    const r = await b.client.post('/sales', { clientRequestId: 'cross-tenant-1', tillId: b.locations.tills[0]._id, lines: [{ productId: p._id, qty: 1 }], payments: [] });
    expect([404, 409]).toContain(r.status);
  });

  it('fails closed when a query runs without tenant context', async () => {
    await expect(Product.find({}).exec()).rejects.toBeInstanceOf(TenantContextError);
    await expect(Product.countDocuments({}).exec()).rejects.toBeInstanceOf(TenantContextError);
    await expect(Product.aggregate([{ $match: {} }]).exec()).rejects.toBeInstanceOf(TenantContextError);
    await expect(Product.create({ name: 'x', sku: 'y' })).rejects.toBeInstanceOf(TenantContextError);
  });

  it('scopes queries, aggregates and upserts to the current tenant', async () => {
    const ta = new Types.ObjectId(a.tenant.id);
    const tb = new Types.ObjectId(b.tenant.id);
    const aCount = await runInTenant(ta, () => Product.countDocuments({}));
    const viaAgg = await runInTenant(ta, () => Product.aggregate([{ $count: 'n' }]));
    expect(viaAgg[0].n).toBe(aCount);
    // Explicitly asking for another tenant's data inside a tenant context is refused.
    await expect(runInTenant(ta, () => Product.find({ tenantId: tb }).exec())).rejects.toBeInstanceOf(TenantContextError);
    await expect(runInTenant(ta, () => Product.create({ tenantId: tb, name: 'x', sku: 'zz' }))).rejects.toBeInstanceOf(TenantContextError);
    await runInTenant(tb, () => Product.updateOne({ sku: 'UPSERTED' }, { $set: { name: 'up', baseUnit: 'pc' } }, { upsert: true }));
    const doc = await runAsPlatform(() => Product.findOne({ sku: 'UPSERTED' }).lean());
    expect(String(doc!.tenantId)).toBe(String(tb));
  });

  it('blocks suspended tenants', async () => {
    await registerTenant(ctx.api, 'suspendme');
    await runAsPlatform(() => Tenant.updateOne({ slug: 'suspendme' }, { $set: { status: 'suspended' } }));
    const r = await new Client(ctx.api, 'suspendme').post('/auth/login', { email: 'owner@suspendme.test', password: 'x' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('TENANT_SUSPENDED');
  });
});

describe('business-type configuration', () => {
  it('gates modules on the server', async () => {
    // Minimart has no quotations module; hardware does.
    const q = { type: 'quotation', branchId: a.locations.branches[0]._id, lines: [{ productId: new Types.ObjectId().toString(), qty: 1 }] };
    expect((await a.client.post('/documents', q)).body.error.code).toBe('MODULE_DISABLED');
    expect((await a.client.get('/inventory/transfers')).status).toBe(403);
    expect((await b.client.get('/inventory/batches')).status).toBe(403);
    expect((await a.client.get('/inventory/batches')).status).toBe(200);
  });

  it('owners can enable modules later without losing data', async () => {
    const before = await a.client.get('/products');
    const r = await a.client.put('/settings/modules', { enabled: ['quotations'], disabled: [] });
    expect(r.status).toBe(200);
    expect(r.body.data.modules).toContain('quotations');
    const me = await a.client.get('/auth/me');
    expect(me.body.navigation.map((n: any) => n.key)).toContain('quotations');
    const after = await a.client.get('/products');
    expect(after.body.total).toBe(before.body.total);
  });

  it('plan entitlements restrict modules in the cloud', async () => {
    const r = await a.client.put('/settings/modules', { enabled: ['multiBranch'] });
    expect(r.status).toBe(402);
    expect(r.body.error.code).toBe('PLAN_UPGRADE_REQUIRED');
  });

  it('hardware tenants get contractor pricing and fractional quantities', async () => {
    const me = await b.client.get('/auth/me');
    expect(me.body.capabilities.priceLists).toContain('contractor');
    expect(me.body.capabilities.checkout.allowFractionalQty).toBe(true);
    expect(me.body.capabilities.productFields).toContain('dimensions');
  });
});
