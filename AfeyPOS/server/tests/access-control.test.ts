import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, createProduct, openShift, rid, Client, type Ctx } from './helpers.js';
import { AuditLog } from '../src/models/index.js';
import { runInTenant } from '../src/lib/context.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
let A: { branch: string; wh: string; till: string };
let B: { branch: string; wh: string; till: string };
let milk: any;

async function user(email: string, data: Record<string, unknown>, by: Client = t.client) {
  const r = await by.post('/settings/users', { name: email.split('@')[0], email, password: 'Passw0rd!x', ...data });
  if (r.status !== 201) throw new Error(`user ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  const c = new Client(ctx.api, 'guarded');
  await c.login(email, 'Passw0rd!x');
  return { id: r.body.data._id as string, c };
}

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'guarded', 'supermarket');
  A = { branch: t.locations.branches[0]._id, wh: t.locations.warehouses[0]._id, till: t.locations.tills[0]._id };
  const b = (await t.client.post('/settings/branches', { name: 'Westlands', code: 'WL' })).body.data;
  const till = (await t.client.post('/settings/tills', { branchId: b.branch._id, warehouseId: b.warehouse._id, name: 'WL till', code: 'WL1' })).body.data;
  B = { branch: b.branch._id, wh: b.warehouse._id, till: till._id };
  milk = await createProduct(t.client, { name: 'Milk 500ml', sku: 'MILK', prices: { retail: 6500 }, costCents: 4800, openingStock: [{ warehouseId: A.wh, qty: 50 }, { warehouseId: B.wh, qty: 20 }] });
  await openShift(t.client, A.till);
  await t.client.post('/sales', { clientRequestId: rid(), tillId: A.till, lines: [{ productId: milk._id, qty: 1 }], payments: [{ method: 'cash', amountCents: 6500 }] });
});
afterAll(teardown);

describe('custom roles and per-user permissions', () => {
  it('a custom role gives exactly its permissions', async () => {
    const role = (await t.client.post('/settings/roles', { name: 'Shelf filler', permissions: ['products.read', 'inventory.read', 'inventory.stocktake'] })).body.data;
    expect(role.key).toBe('custom:shelf-filler');
    const sf = await user('filler@guarded.test', { roles: [role.key] });
    expect((await sf.c.get('/inventory/levels')).status).toBe(200);
    expect((await sf.c.get('/sales')).status).toBe(403);
    expect((await sf.c.get('/reports/dashboard')).status).toBe(403);
    const me = (await sf.c.get('/auth/me')).body;
    expect(me.permissions.sort()).toEqual(['inventory.read', 'inventory.stocktake', 'products.read']);
    // Changing the role changes the user at once (no new sign-in).
    await t.client.put(`/settings/roles/${role.key}`, { name: 'Shelf filler', permissions: ['products.read'] });
    expect((await sf.c.get('/inventory/levels')).status).toBe(403);
    expect((await t.client.delete(`/settings/roles/${role.key}`)).body.error.code).toBe('ROLE_IN_USE');
  });

  it('grants and denials adjust one user without a new role', async () => {
    const c = await user('cashier1@guarded.test', { roles: ['cashier'], deniedPermissions: ['customers.read'], extraPermissions: ['reports.read'] });
    expect((await c.c.get('/customers')).status).toBe(403);
    expect((await c.c.get('/reports/sales')).status).toBe(200);
    const access = (await t.client.get(`/settings/users/${c.id}/access`)).body.data.permissions;
    expect(access.find((p: any) => p.permission === 'customers.read')).toMatchObject({ allowed: false, denied: true, from: ['Cashier'] });
    expect(access.find((p: any) => p.permission === 'reports.read')).toMatchObject({ allowed: true, from: ['granted to this user'] });
  });

  it('owners cannot be denied anything', async () => {
    const me = (await t.client.get('/auth/me')).body;
    expect(me.permissions).toContain('settings.manage');
  });

  it('supervisor approval uses the supervisor’s effective permissions', async () => {
    await user('sup@guarded.test', { roles: ['branch_manager'], deniedPermissions: ['sales.void'] });
    const cashier = await user('cashier2@guarded.test', { roles: ['cashier'] });
    const r = await cashier.c.post('/auth/override', { email: 'sup@guarded.test', password: 'Passw0rd!x', permission: 'sales.void' });
    expect(r.status).toBe(403);
    expect((await cashier.c.post('/auth/override', { email: 'sup@guarded.test', password: 'Passw0rd!x', permission: 'sales.discount.override' })).status).toBe(200);
  });
});

describe('no escalation', () => {
  let hr: Awaited<ReturnType<typeof user>>;

  beforeAll(async () => {
    const role = (await t.client.post('/settings/roles', { name: 'People manager', permissions: ['users.manage', 'sales.create', 'sales.read', 'products.read', 'shifts.open'] })).body.data;
    hr = await user('people@guarded.test', { roles: [role.key] });
  });

  it('cannot give permissions they do not have', async () => {
    expect((await hr.c.post('/settings/users', { name: 'Xavier Test', email: 'x1@guarded.test', password: 'Passw0rd!x', roles: ['business_admin'] })).status).toBe(403);
    const x2 = await hr.c.post('/settings/users', { name: 'Xavier Test', email: 'x2@guarded.test', password: 'Passw0rd!x', roles: ['cashier'] }); // cashier has customers.read etc.
    expect(x2.status).toBe(403);
    expect(x2.body.error.message).toMatch(/do not have yourself: .*See customers/);
    expect((await hr.c.post('/settings/users', { name: 'Xavier Test', email: 'x3@guarded.test', password: 'Passw0rd!x', roles: ['cashier'], deniedPermissions: ['inventory.read', 'customers.read', 'sales.discount', 'cash.movement', 'customers.payments', 'orders.manage'] })).status).toBe(201);
    expect((await hr.c.post('/settings/roles', { name: 'Power', permissions: ['settings.manage'] })).status).toBe(403);
  });

  it('cannot change more powerful users, owners, or their own access', async () => {
    const admins = (await t.client.get('/settings/users')).body.data;
    const owner = admins.find((u: any) => u.roles.includes('tenant_owner'));
    expect((await hr.c.patch(`/settings/users/${owner._id}`, { password: 'Hijack123!x' })).status).toBe(403);
    const mgr = admins.find((u: any) => u.email === 'sup@guarded.test');
    const disable = await hr.c.patch(`/settings/users/${mgr._id}`, { status: 'disabled' });
    expect(disable.status).toBe(403);
    expect(disable.body.error.message).toMatch(/can do things you cannot/);
    expect((await hr.c.patch(`/settings/users/${hr.id}`, { extraPermissions: ['settings.manage'] })).body.error.message).toMatch(/your own roles/);
    expect((await t.client.patch(`/settings/users/${owner._id}`, { roles: ['business_admin'] })).status).toBe(403);
  });

  it('branch-limited managers only manage users of their branches', async () => {
    const m = await user('bm@guarded.test', { roles: ['business_admin'], branchIds: [B.branch] });
    expect((await m.c.post('/settings/users', { name: 'Yusuf Test', email: 'y1@guarded.test', password: 'Passw0rd!x', roles: ['cashier'] })).status).toBe(403);
    expect((await m.c.post('/settings/users', { name: 'Yusuf Test', email: 'y2@guarded.test', password: 'Passw0rd!x', roles: ['cashier'], branchIds: [A.branch] })).status).toBe(403);
    expect((await m.c.post('/settings/users', { name: 'Yusuf Test', email: 'y3@guarded.test', password: 'Passw0rd!x', roles: ['cashier'], branchIds: [B.branch] })).status).toBe(201);
  });
});

describe('branch isolation', () => {
  let westlands: Awaited<ReturnType<typeof user>>;
  let saleA: any;

  beforeAll(async () => {
    westlands = await user('wl@guarded.test', { roles: ['branch_manager'], branchIds: [B.branch] });
    saleA = (await t.client.get('/sales')).body.data[0];
  });

  it('does not show or let them open other branches’ records', async () => {
    expect((await westlands.c.get('/sales')).body.data).toHaveLength(0);
    expect((await westlands.c.get(`/sales/${saleA._id}`)).status).toBe(404);
    expect((await westlands.c.get(`/reports/sales?branchId=${A.branch}`)).status).toBe(403);
    const levels = (await westlands.c.get('/inventory/levels')).body.data;
    expect(levels.every((l: any) => String(l.warehouseId?._id ?? l.warehouseId) === B.wh)).toBe(true);
    const tills = (await westlands.c.get('/settings/locations')).body.data.tills;
    expect(tills.map((x: any) => x._id)).toEqual([B.till]);
  });

  it('cannot sell or open a shift at another branch', async () => {
    expect((await westlands.c.post('/shifts', { tillId: A.till, openingFloatCents: 0 })).status).toBeGreaterThanOrEqual(403);
    await openShift(westlands.c, B.till);
    const sale = await westlands.c.post('/sales', { clientRequestId: rid(), tillId: B.till, lines: [{ productId: milk._id, qty: 1 }], payments: [{ method: 'cash', amountCents: 6500 }] });
    expect(sale.status).toBe(201);
    expect((await westlands.c.get('/sales')).body.data).toHaveLength(1);
  });

  it('transfers: only the sending branch dispatches and only the receiving branch receives', async () => {
    const tr = (await t.client.post('/inventory/transfers', { fromWarehouseId: A.wh, toWarehouseId: B.wh, lines: [{ productId: milk._id, qty: 5 }] })).body.data;
    expect((await westlands.c.post(`/inventory/transfers/${tr._id}/dispatch`, {})).status).toBe(403);
    expect((await t.client.post(`/inventory/transfers/${tr._id}/dispatch`, {})).status).toBe(200);
    const r = await westlands.c.post(`/inventory/transfers/${tr._id}/receive`, {});
    expect(r.body.error ?? null).toBeNull();
    expect(r.body.data.status).toBe('received');
    const level = (await westlands.c.get('/inventory/levels')).body.data.find((l: any) => String(l.productId?._id ?? l.productId) === milk._id);
    expect(level.qty).toBe(24); // 20 + 5 received - 1 sold
  });

  it('records refused attempts in the audit trail', async () => {
    const rows = await runInTenant(t.tenant.id, () => AuditLog.find({ action: 'access.denied' }).lean());
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r: any) => /branch/i.test(r.details?.reason))).toBe(true);
  });
});

describe('cost prices', () => {
  it('are hidden from staff without “See cost prices and margins”', async () => {
    const cashier = await user('cashier3@guarded.test', { roles: ['cashier'] });
    const p = (await cashier.c.get(`/products/${milk._id}`)).body.data;
    expect(p.name).toBe('Milk 500ml');
    expect(p.costCents).toBeUndefined();
    const sale = (await t.client.get('/sales')).body.data[0];
    expect((await t.client.get(`/sales/${sale._id}`)).body.data.lines[0].costCents).toBeGreaterThan(0);
    expect((await t.client.get(`/products/${milk._id}`)).body.data.costCents).toBe(4800);
  });

  it('and cannot be overwritten by them', async () => {
    const role = (await t.client.post('/settings/roles', { name: 'Catalogue clerk', permissions: ['products.read', 'products.manage'] })).body.data;
    const clerk = await user('clerk@guarded.test', { roles: [role.key] });
    const p = (await clerk.c.get(`/products/${milk._id}`)).body.data;
    expect((await clerk.c.put(`/products/${milk._id}`, { ...p, name: 'Milk 500ml fresh', costCents: 0 })).status).toBe(200);
    const after = (await t.client.get(`/products/${milk._id}`)).body.data;
    expect(after).toMatchObject({ name: 'Milk 500ml fresh', costCents: 4800 });
  });
});
