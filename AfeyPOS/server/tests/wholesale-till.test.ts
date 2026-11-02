import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, createProduct, openShift, rid, Client, OWNER_PASSWORD, type Ctx } from './helpers.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'wholeshop', 'minimart');
});
afterAll(teardown);

describe('wholesale at the till (checkout rules)', () => {
  it('is off by default, then follows the rule and its approval setting', async () => {
    const till = t.locations.tills[0]._id;
    const p = await createProduct(t.client, { name: 'Sugar 2kg', sku: 'SUG2', prices: { retail: 26000, wholesale: 24000 }, openingStock: [{ warehouseId: t.locations.warehouses[0]._id, qty: 50 }] });
    await t.client.post('/settings/users', { name: 'Cash', email: 'cash@wholeshop.test', password: 'Passw0rd!x', roles: ['cashier'] });
    const c = new Client(ctx.api, 'wholeshop');
    await c.login('cash@wholeshop.test', 'Passw0rd!x');
    const shift = await openShift(c, till);
    const sell = (overrideToken?: string) => c.post('/sales', { clientRequestId: rid(), tillId: till, priceList: 'wholesale', overrideToken, lines: [{ productId: p._id, qty: 1 }], payments: [{ method: 'cash', amountCents: 24000 }] });

    expect((await t.client.get('/settings/checkout-rules')).body.data.rules.pricing).toEqual({ wholesaleAtTill: false, wholesaleNeedsApproval: false });
    const off = await sell();
    expect(off.body.error.code).toBe('WHOLESALE_OFF');
    // Retail still sells.
    expect((await c.post('/sales', { clientRequestId: rid(), tillId: till, lines: [{ productId: p._id, qty: 1 }], payments: [{ method: 'cash', amountCents: 26000 }] })).status).toBe(201);

    await t.client.put('/settings/checkout-rules', { rules: { pricing: { wholesaleAtTill: true } } });
    const on = await sell();
    expect(on.status).toBe(201);
    expect(on.body.data.lines[0].unitPriceCents).toBe(24000);

    await t.client.put('/settings/checkout-rules', { rules: { pricing: { wholesaleNeedsApproval: true } } });
    expect((await t.client.get('/settings/checkout-rules')).body.data.rules.pricing).toEqual({ wholesaleAtTill: true, wholesaleNeedsApproval: true });
    const needs = await sell();
    expect(needs.body.error.code).toBe('OVERRIDE_REQUIRED');
    const token = (await c.post('/auth/override', { email: 'owner@wholeshop.test', password: OWNER_PASSWORD, permission: 'sales.price.override' })).body.overrideToken;
    expect((await sell(token)).status).toBe(201);
    await c.post(`/shifts/${shift._id}/close`, { countedCashCents: 0 });
  });
});
