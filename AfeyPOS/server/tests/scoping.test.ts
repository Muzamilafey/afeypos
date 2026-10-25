import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { setupApp, teardown, registerTenant, createProduct, Client, type Ctx } from './helpers.js';
import { Product, Tenant } from '../src/models/index.js';
import { runInTenant, runAsPlatform, TenantContextError } from '../src/lib/context.js';

let ctx: Ctx;
let a: Awaited<ReturnType<typeof registerTenant>>;

beforeAll(async () => {
  ctx = await setupApp();
  a = await registerTenant(ctx.api, 'alpha', 'minimart');
});
afterAll(teardown);

describe('data scoping (one business per installation)', () => {
  it('fails closed when a query runs without business context', async () => {
    await expect(Product.find({}).exec()).rejects.toBeInstanceOf(TenantContextError);
    await expect(Product.countDocuments({}).exec()).rejects.toBeInstanceOf(TenantContextError);
    await expect(Product.aggregate([{ $match: {} }]).exec()).rejects.toBeInstanceOf(TenantContextError);
    await expect(Product.create({ name: 'x', sku: 'y' })).rejects.toBeInstanceOf(TenantContextError);
  });

  it('stamps and scopes every query, aggregate and upsert', async () => {
    await createProduct(a.client, { name: 'Alpha item', sku: 'A-1' });
    const ta = new Types.ObjectId(a.tenant.id);
    const foreign = new Types.ObjectId();
    const count = await runInTenant(ta, () => Product.countDocuments({}));
    const viaAgg = await runInTenant(ta, () => Product.aggregate([{ $count: 'n' }]));
    expect(viaAgg[0].n).toBe(count);
    await expect(runInTenant(ta, () => Product.find({ tenantId: foreign }).exec())).rejects.toBeInstanceOf(TenantContextError);
    await runInTenant(ta, () => Product.updateOne({ sku: 'UPSERTED' }, { $set: { name: 'up', baseUnit: 'pc' } }, { upsert: true }));
    const doc = await runAsPlatform(() => Product.findOne({ sku: 'UPSERTED' }).lean());
    expect(String(doc!.tenantId)).toBe(a.tenant.id);
  });

  it('rejects tokens from an earlier installation of the same server', async () => {
    const token = a.client.token;
    const old = await runAsPlatform(() => Tenant.findOne().lean());
    // Simulate a reinstall: the business record is replaced, so the old session belongs to another business.
    await runAsPlatform(async () => {
      await Tenant.deleteOne({ _id: old!._id });
      await Tenant.create({ ...old, _id: new Types.ObjectId(), slug: 'reinstalled' });
    });
    expect((await new Client(ctx.api, 'x').as(token).get('/products')).status).toBe(401);
  });

  it('blocks a suspended installation', async () => {
    await runAsPlatform(() => Tenant.updateOne({}, { $set: { status: 'suspended' } }));
    const r = await new Client(ctx.api, 'x').post('/auth/login', { email: 'owner@alpha.test', password: 'x' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('BUSINESS_SUSPENDED');
  });
});

describe('module configuration', () => {
  it('gates modules on the server and lets owners enable them later without losing data', async () => {
    const m = await registerTenant(ctx.api, 'mini', 'minimart');
    // A minimart has no quotations or weighed items until the owner enables them.
    const q = { type: 'quotation', branchId: m.locations.branches[0]._id, lines: [{ productId: new Types.ObjectId().toString(), qty: 1 }] };
    expect((await m.client.post('/documents', q)).body.error.code).toBe('MODULE_DISABLED');
    expect((await m.client.get('/inventory/batches')).status).toBe(200);
    await createProduct(m.client, { name: 'Kept', sku: 'KEEP-1' });
    const before = await m.client.get('/products');
    const r = await m.client.put('/settings/modules', { enabled: ['quotations', 'weighedItems'], disabled: ['loyalty'] });
    expect(r.status).toBe(200);
    expect(r.body.data.modules).toEqual(expect.arrayContaining(['quotations', 'weighedItems']));
    expect(r.body.data.modules).not.toContain('loyalty');
    const me = await m.client.get('/auth/me');
    expect(me.body.navigation.map((n: any) => n.key)).toContain('quotations');
    expect((await m.client.get('/products')).body.total).toBe(before.body.total);
  });

  it('supermarkets get departments, PLU/weighed items, tills, branches and wholesale prices', async () => {
    const s = await registerTenant(ctx.api, 'super', 'supermarket');
    const me = await s.client.get('/auth/me');
    expect(me.body.capabilities.productFields).toEqual(expect.arrayContaining(['department', 'plu', 'soldByWeight', 'expiry']));
    expect(me.body.capabilities.modules).toEqual(expect.arrayContaining(['multiTill', 'multiBranch', 'stockTransfers', 'weighedItems', 'priceLists']));
    expect(me.body.capabilities.priceLists).toEqual(expect.arrayContaining(['retail', 'wholesale']));
  });
});
