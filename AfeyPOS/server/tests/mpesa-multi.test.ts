import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { setupApp, teardown, registerTenant, openShift, rid, Client, OWNER_PASSWORD, type Ctx } from './helpers.js';
import { handleC2B } from '../src/modules/payments/mpesa.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
let tills: any[];
let branches: any[];
let shopTill: string;
let kioskTill: string;

const addMpesa = (name: string, settings: Record<string, unknown>, usedBy: Record<string, unknown> = {}) =>
  t.client.post('/settings/integrations', { kind: 'mpesa', provider: 'mock', name, settings, secrets: { consumerKey: 'k', consumerSecret: 's', passkey: 'p' }, ...usedBy });

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'twopesa', 'supermarket', {}, ['multiTill', 'multiBranch']);
  branches = (await t.client.get('/settings/locations')).body.data.branches;
  const second = await t.client.post('/settings/tills', { branchId: branches[0]._id, warehouseId: (await t.client.get('/settings/locations')).body.data.warehouses[0]._id, name: 'Kiosk', code: 'K1' });
  expect(second.status).toBe(201);
  tills = (await t.client.get('/settings/locations')).body.data.tills;
  shopTill = tills[0]._id;
  kioskTill = tills.find((x: any) => x.code === 'K1')._id;
  await openShift(t.client, shopTill);
});
afterAll(teardown);

describe('two M-Pesa accounts at once', () => {
  it('the till lists the accounts it may use and the cashier picks one', async () => {
    const shop = await addMpesa('Shop till', { shortCode: '174379', type: 'till', tillNumber: '3163960' });
    const kiosk = await addMpesa('Kiosk paybill', { shortCode: '400200', type: 'paybill' }, { tillIds: [kioskTill] });
    expect([shop.status, kiosk.status]).toEqual([201, 201]);

    const forShop = (await t.client.get(`/payments/mpesa/accounts?tillId=${shopTill}`)).body.data;
    expect(forShop.map((a: any) => a.name)).toEqual(['Shop till']);
    expect(forShop[0]).toMatchObject({ isDefault: true, payTo: { type: 'till', number: '3163960' }, stk: true });
    // The kiosk has its own account first, then the shared one: it may use either.
    const forKiosk = (await t.client.get(`/payments/mpesa/accounts?tillId=${kioskTill}`)).body.data;
    expect(forKiosk.map((a: any) => a.name)).toEqual(['Kiosk paybill', 'Shop till']);
    expect(forKiosk[0].payTo).toEqual({ type: 'paybill', number: '400200' });

    // Waiting for a payment uses the till's own account by default, or the one the cashier chose.
    const own = await t.client.post('/payments/mpesa/expect', { clientRequestId: rid(), amountCents: 100, tillId: kioskTill });
    expect(own.body.data.payTo).toEqual({ type: 'paybill', number: '400200' });
    const chosen = await t.client.post('/payments/mpesa/expect', { clientRequestId: rid(), amountCents: 100, tillId: kioskTill, configId: shop.body.data.id });
    expect(chosen.body.data.payTo).toEqual({ type: 'till', number: '3163960' });
    // An account of another till cannot be used here.
    const other = await t.client.post('/payments/mpesa/expect', { clientRequestId: rid(), amountCents: 100, tillId: shopTill, configId: kiosk.body.data.id });
    expect(other.status).toBe(400);
    expect(other.body.error.message).toMatch(/cannot be used at this till/);
  });

  it('a payment reaches the waiting till even when another account holds the same Till number', async () => {
    // Two configs on one Safaricom till number (one per branch): the money is the same pot.
    const b2 = await t.client.post('/settings/branches', { name: 'Westlands', code: 'WST' });
    const a = await addMpesa('Main branch till', { shortCode: '174379', type: 'till', tillNumber: '5544330' });
    const b = await addMpesa('Westlands till', { shortCode: '174379', type: 'till', tillNumber: '5544330' }, { branchIds: [b2.body.data.branch._id] });
    expect([a.status, b.status]).toEqual([201, 201]);
    // The till waits with one config…
    const waiting = await t.client.post('/payments/mpesa/expect', { clientRequestId: rid(), amountCents: 700, tillId: shopTill, configId: a.body.data.id });
    expect(waiting.status).toBe(201);
    // …and Safaricom's confirmation matches the other config first (same number). It must still complete the sale.
    await handleC2B(new Types.ObjectId(t.tenant.id), { TransID: 'TWOCFG0001', TransAmount: '7.00', BusinessShortCode: '5544330', BillRefNumber: '', MSISDN: '254712345678', FirstName: 'Asha', TransTime: '20261031120000' }, '127.0.0.1');
    const after = await t.client.get(`/payments/intents/${waiting.body.data.id}`);
    expect(after.body.data).toMatchObject({ status: 'succeeded', receiptNumber: 'TWOCFG0001', paidAmountCents: 700, payerName: 'Asha' });
    // The receipt is on the till's own payment only: it was not recorded twice under the other account.
    const withReceipt = (await t.client.get('/payments/intents?q=TWOCFG0001')).body.data;
    expect(withReceipt.map((i: any) => i.id)).toEqual([waiting.body.data.id]);
  });
});

describe('removing an integration', () => {
  it('only an owner or administrator may remove one, and not while money is still coming', async () => {
    const cfg = await addMpesa('Old paybill', { shortCode: '999111', type: 'paybill' });
    const id = cfg.body.data.id;
    await t.client.post('/settings/users', { name: 'Manny', email: 'manny@twopesa.test', password: 'MannyPass12345', roles: ['branch_manager'], extraPermissions: ['integrations.manage'] });
    const manager = new Client(ctx.api, 'twopesa');
    await manager.login('manny@twopesa.test', 'MannyPass12345');
    // A manager can turn it off but not remove it.
    expect((await manager.delete(`/settings/integrations/${id}`)).status).toBe(200);
    expect((await manager.delete(`/settings/integrations/${id}?remove=true`)).status).toBe(403);
    expect((await t.client.get('/settings/integrations')).body.data.find((c: any) => c.id === id)).toBeTruthy();
    // The owner removes it for good.
    const gone = await t.client.delete(`/settings/integrations/${id}?remove=true`);
    expect(gone.status).toBe(200);
    expect(gone.body.data).toMatchObject({ removed: true });
    expect((await t.client.get('/settings/integrations')).body.data.find((c: any) => c.id === id)).toBeUndefined();
    expect((await t.client.delete(`/settings/integrations/${id}?remove=true`)).status).toBe(404);
  });

  it('an M-Pesa account with a payment still waiting is kept until it is finished', async () => {
    const cfg = await addMpesa('Busy till', { shortCode: '174379', type: 'till', tillNumber: '7788990' }, { tillIds: [kioskTill] });
    const waiting = await t.client.post('/payments/mpesa/expect', { clientRequestId: rid(), amountCents: 500, tillId: kioskTill, configId: cfg.body.data.id });
    expect(waiting.status).toBe(201);
    const refused = await t.client.delete(`/settings/integrations/${cfg.body.data.id}?remove=true`);
    expect(refused.status).toBe(422);
    expect(refused.body.error.message).toMatch(/still waiting/);
    await t.client.post(`/payments/intents/${waiting.body.data.id}/cancel`, {});
    expect((await t.client.delete(`/settings/integrations/${cfg.body.data.id}?remove=true`)).status).toBe(200);
  });
});
