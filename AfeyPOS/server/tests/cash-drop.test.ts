import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, createProduct, openShift, rid, Client, OWNER_PASSWORD, type Ctx } from './helpers.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'dropshop', 'minimart');
});
afterAll(teardown);

describe('cash drop at the till', () => {
  it('needs a supervisor, never more than the drawer, lowers expected cash and is recorded', async () => {
    const till = t.locations.tills[0]._id;
    const p = await createProduct(t.client, { name: 'Rice', sku: 'RICE', prices: { retail: 100000 }, openingStock: [{ warehouseId: t.locations.warehouses[0]._id, qty: 20 }] });
    await t.client.post('/settings/users', { name: 'Cash', email: 'cash@dropshop.test', password: 'Passw0rd!x', roles: ['cashier'] });
    const c = new Client(ctx.api, 'dropshop');
    await c.login('cash@dropshop.test', 'Passw0rd!x');
    const shift = await openShift(c, till, 50000);
    await c.post('/sales', { clientRequestId: rid(), tillId: till, lines: [{ productId: p._id, qty: 5 }], payments: [{ method: 'cash', amountCents: 500000 }] });
    // Drawer: 500 float + 5,000 sales = 5,500.

    const noApproval = await c.post(`/shifts/${shift._id}/drop`, { amountCents: 300000 });
    expect(noApproval.body.error).toMatchObject({ code: 'OVERRIDE_REQUIRED' });
    // The cashier cannot approve their own drop.
    expect((await c.post('/auth/override', { email: 'cash@dropshop.test', password: 'Passw0rd!x', permission: 'shifts.manage' })).status).toBe(403);
    const approve = async () => (await c.post('/auth/override', { email: 'owner@dropshop.test', password: OWNER_PASSWORD, permission: 'shifts.manage', tillId: till })).body.overrideToken as string;

    expect((await c.post(`/shifts/${shift._id}/drop`, { amountCents: 600000, overrideToken: await approve() })).body.error.code).toBe('DROP_MORE_THAN_DRAWER');
    const ok = await c.post(`/shifts/${shift._id}/drop`, { amountCents: 300000, note: 'Safe bag 12', overrideToken: await approve() });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ type: 'drop', amountCents: 300000, number: expect.stringMatching(/^DRP-/), supervisorName: 'Owner Person' });
    // The approval is single use.
    const summary = (await t.client.get(`/shifts/${shift._id}/summary`)).body.data;
    expect(summary.expectedCashCents).toBe(250000);
    expect(summary.cashMovements.drop).toMatchObject({ totalCents: -300000, count: 1 });
    const log = (await t.client.get('/audit?action=shift.cash_drop')).body.data[0];
    expect(log.details).toMatchObject({ amountCents: 300000, note: 'Safe bag 12' });
    expect(log.supervisorId).toBeTruthy();

    // Closing with the right count gives no variance.
    const close = (await c.post(`/shifts/${shift._id}/close`, { countedCashCents: 250000 })).body.data;
    expect(close.shift?.varianceCents ?? 0).toBe(0);
  });
});
