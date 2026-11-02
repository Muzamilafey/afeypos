import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, createProduct, openShift, rid, Client, OWNER_PASSWORD, type Ctx } from './helpers.js';
import { AuditLog } from '../src/models/index.js';
import { Types } from 'mongoose';
import { runInTenant } from '../src/lib/context.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'secshop', 'supermarket', {}, ['multiBranch', 'stockTransfers']);
});
afterAll(teardown);

describe('accountability rules', () => {
  it('signs and numbers audit entries; an edited entry is caught', async () => {
    await t.client.put('/settings/checkout-rules', { rules: { security: { lockAfterMinutes: 5 } } });
    const v1 = (await t.client.get('/audit/verify')).body.data;
    expect(v1.ok).toBe(true);
    expect(v1.checked).toBeGreaterThan(0);
    const e = (await t.client.get('/audit?action=settings.checkout_rules_updated')).body.data[0];
    await runInTenant(new Types.ObjectId(String(t.tenant.id ?? t.tenant._id)), () => AuditLog.updateOne({ _id: e._id }, { $set: { 'actor.name': 'Someone else' } }));
    const v2 = (await t.client.get('/audit/verify')).body.data;
    expect(v2.ok).toBe(false);
    expect(v2.altered[0]).toMatchObject({ action: 'settings.checkout_rules_updated' });
    await runInTenant(new Types.ObjectId(String(t.tenant.id ?? t.tenant._id)), () => AuditLog.deleteOne({ _id: v2.altered[0].id }));
    const v3 = (await t.client.get('/audit/verify')).body.data;
    expect(v3.gaps.length).toBeGreaterThan(0);
    expect((await t.client.get('/settings/checkout-rules')).body.data.rules.security.lockAfterMinutes).toBe(5);
  });

  it('a quantity above the per-line limit needs a supervisor', async () => {
    await t.client.put('/settings/checkout-rules', { rules: { items: { maxQtyPerLine: 10 } } });
    const p = await createProduct(t.client, { name: 'Soap', sku: 'SOAP', prices: { retail: 1000 }, openingStock: [{ warehouseId: t.locations.warehouses[0]._id, qty: 100 }] });
    await t.client.post('/settings/users', { name: 'Cash', email: 'cash@secshop.test', password: 'Passw0rd!x', roles: ['cashier'] });
    const c = new Client(ctx.api, 'secshop');
    await c.login('cash@secshop.test', 'Passw0rd!x');
    const till = t.locations.tills[0]._id;
    const shift = await openShift(c, till);
    const sell = (qty: number, overrideToken?: string) => c.post('/sales', { clientRequestId: rid(), tillId: till, overrideToken, lines: [{ productId: p._id, qty }], payments: [{ method: 'cash', amountCents: qty * 1000 }] });
    expect((await sell(10)).status).toBe(201);
    const over = await sell(11);
    expect(over.body.error).toMatchObject({ code: 'OVERRIDE_REQUIRED' });
    expect(over.body.error.message).toMatch(/limit 10/);
    const token = (await c.post('/auth/override', { email: 'owner@secshop.test', password: OWNER_PASSWORD, permission: 'sales.qty.override' })).body.overrideToken;
    expect((await sell(11, token)).status).toBe(201);
    await c.post(`/shifts/${shift._id}/close`, { countedCashCents: 0 });
  });

  it('transfers wait for a manager when approval is required', async () => {
    await t.client.put('/settings/checkout-rules', { rules: { transfers: { approvalRequired: true } } });
    const b = (await t.client.post('/settings/branches', { name: 'Thika', code: 'THK' })).body.data;
    const p = await createProduct(t.client, { name: 'Rice', sku: 'RICE', prices: { retail: 1000 }, openingStock: [{ warehouseId: t.locations.warehouses[0]._id, qty: 10 }] });
    await t.client.post('/settings/users', { name: 'Store', email: 'store@secshop.test', password: 'Passw0rd!x', roles: ['warehouse_operator'] });
    const w = new Client(ctx.api, 'secshop');
    await w.login('store@secshop.test', 'Passw0rd!x');
    const tr = (await w.post('/inventory/transfers', { fromWarehouseId: t.locations.warehouses[0]._id, toWarehouseId: b.warehouse._id, lines: [{ productId: p._id, qty: 4 }] })).body.data;
    expect(tr.status).toBe('draft');
    expect((await w.post(`/inventory/transfers/${tr._id}/dispatch`, {})).body.error.code).toBe('TRANSFER_NOT_APPROVED');
    expect((await w.post(`/inventory/transfers/${tr._id}/approve`, {})).status).toBe(403);
    expect((await t.client.post(`/inventory/transfers/${tr._id}/approve`, {})).body.data.approvedAt).toBeTruthy();
    expect((await w.post(`/inventory/transfers/${tr._id}/dispatch`, {})).body.data.status).toBe('in_transit');
  });
});
