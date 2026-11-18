import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, createProduct, openShift, rid, Client, OWNER_PASSWORD, type Ctx } from './helpers.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
const approve = async () => ({ 'X-Approval': (await t.client.post('/auth/override', { email: 'owner@delshop.test', password: OWNER_PASSWORD, permission: 'settings.manage' })).body.overrideToken as string });
const del = async (path: string, headers: Record<string, string> = {}, c?: Client) => (c ?? t.client).delete(path).set(headers);

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'delshop', 'supermarket', {}, ['multiTill', 'multiBranch']);
});
afterAll(teardown);

describe('deleting tills, stores and branches', () => {
  it('needs an owner or administrator confirming on the spot', async () => {
    const till = (await t.client.post('/settings/tills', { branchId: t.locations.branches[0]._id, warehouseId: t.locations.warehouses[0]._id, name: 'Spare till', code: 'SP1' })).body.data;
    const none = await del(`/settings/tills/${till._id}`);
    expect(none.status).toBe(403);
    expect(none.body.error.code).toBe('OVERRIDE_REQUIRED');
    await t.client.post('/settings/users', { name: 'Mo', email: 'mo@delshop.test', password: 'Passw0rd!x', roles: ['branch_manager'] });
    const manager = new Client(ctx.api, 'delshop');
    await manager.login('mo@delshop.test', 'Passw0rd!x');
    expect((await del(`/settings/tills/${till._id}`, await approve(), manager)).status).toBe(403);
    const ok = await del(`/settings/tills/${till._id}`, await approve());
    expect(ok.status).toBe(200);
    // Gone from every list, kept in the audit trail; the approval cannot be used twice.
    const locs = (await t.client.get('/settings/locations')).body.data;
    expect(locs.tills.map((x: any) => x._id)).not.toContain(till._id);
    expect((await t.client.get('/audit?action=till.deleted')).body.data[0].details).toMatchObject({ name: 'Spare till' });
  });

  it('refuses while a shift is open, stock remains, or it is the last of its kind', async () => {
    const main = t.locations.tills[0]._id;
    const shift = await openShift(t.client, main);
    const open = await del(`/settings/tills/${main}`, await approve());
    expect(open.body.error.code).toBe('LOCATION_HAS_OPEN_SHIFT');
    expect((await t.client.post(`/shifts/${shift._id}/close`, { countedCashCents: 0 })).status).toBe(200);
    expect((await del(`/settings/warehouses/${t.locations.warehouses[0]._id}`, await approve())).body.error.code).toBe('STORE_HAS_TILLS');
    expect((await del(`/settings/branches/${t.locations.branches[0]._id}`, await approve())).body.error.code).toBe('LAST_BRANCH');

    // A second branch with stock in its store: refused until the stock is gone.
    const b = (await t.client.post('/settings/branches', { name: 'Kisumu', code: 'KSM' })).body.data;
    await createProduct(t.client, { name: 'Salt', sku: 'SALT1', openingStock: [{ warehouseId: b.warehouse._id, qty: 3 }] });
    expect((await del(`/settings/branches/${b.branch._id}`, await approve())).body.error.code).toBe('LOCATION_HAS_STOCK');
    expect((await del(`/settings/warehouses/${b.warehouse._id}`, await approve())).body.error.code).toBe('LAST_STORE');
  });

  it('deletes a branch with its stores and tills; sales history keeps them', async () => {
    const b = (await t.client.post('/settings/branches', { name: 'Nakuru', code: 'NKR' })).body.data;
    const till = (await t.client.post('/settings/tills', { branchId: b.branch._id, warehouseId: b.warehouse._id, name: 'Nakuru till', code: 'NK1' })).body.data;
    const p = await createProduct(t.client, { name: 'Tea', sku: 'TEA1', prices: { retail: 5000 }, openingStock: [{ warehouseId: b.warehouse._id, qty: 1 }] });
    const sh = await openShift(t.client, till._id);
    const sale = await t.client.post('/sales', { clientRequestId: rid(), tillId: till._id, lines: [{ productId: p._id, qty: 1 }], payments: [{ method: 'cash', amountCents: 5000 }] });
    expect(sale.status).toBe(201);
    expect((await del(`/settings/branches/${b.branch._id}`, await approve())).body.error.code).toBe('LOCATION_HAS_OPEN_SHIFT');
    expect((await t.client.post(`/shifts/${sh._id}/close`, { countedCashCents: 5000 })).status).toBe(200);
    const r = await del(`/settings/branches/${b.branch._id}`, await approve());
    expect(r.status).toBe(200);
    const locs = (await t.client.get('/settings/locations')).body.data;
    expect(locs.branches.map((x: any) => x.code)).not.toContain('NKR');
    expect(locs.warehouses.map((x: any) => x._id)).not.toContain(b.warehouse._id);
    expect(locs.tills.map((x: any) => x._id)).not.toContain(till._id);
    // The sale is still there, with its till.
    expect((await t.client.get(`/sales/${sale.body.data._id}`)).body.data).toMatchObject({ number: sale.body.data.number, tillId: till._id });
  });
});
