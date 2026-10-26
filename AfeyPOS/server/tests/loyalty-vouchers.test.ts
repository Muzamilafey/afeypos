import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, createProduct, openShift, rid, type Ctx, Client } from './helpers.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
let till: string;
let wh: string;
let cashier: Client;
let product: any;
let customer: any;

const sell = (payments: object[], opts: { customerId?: string; qty?: number } = {}) =>
  cashier.post('/sales', { clientRequestId: rid(), tillId: till, customerId: opts.customerId, lines: [{ productId: product._id, qty: opts.qty ?? 1 }], payments });

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'rewardsco', 'minimart');
  await t.client.put('/settings/modules', { enabled: ['loyalty'] });
  till = t.locations.tills[0]._id;
  wh = t.locations.warehouses[0]._id;
  await t.client.post('/settings/users', { name: 'Cleo Cashier', email: 'cleo@rewards.test', password: 'Cleo12345', roles: ['cashier'] });
  cashier = new Client(ctx.api, 'rewardsco');
  await cashier.login('cleo@rewards.test', 'Cleo12345');
  await openShift(cashier, till, 100000);
  product = await createProduct(t.client, { prices: { retail: 50000 }, openingStock: [{ warehouseId: wh, qty: 100 }] });
  customer = (await t.client.post('/customers', { name: 'Wanjiku Mwangi', phone: '0711222333' })).body.data;
});
afterAll(teardown);

describe('loyalty program', () => {
  it('owner sets the rules; a member joins with a card and a welcome bonus', async () => {
    expect((await cashier.put('/loyalty/program', { welcomeBonus: 50 })).status).toBe(403);
    const r = await t.client.put('/loyalty/program', { name: 'Duka Rewards', pointsPerUnitCents: 10000, pointValueCents: 100, minRedeemPoints: 20, maxRedeemBp: 5000, welcomeBonus: 50, tierMultipliersBp: { Bronze: 20000 } });
    expect(r.status).toBe(200);
    expect(r.body.data.program).toMatchObject({ name: 'Duka Rewards', welcomeBonus: 50 });
    const joined = await t.client.post(`/loyalty/members/${customer._id}/enroll`, {});
    expect(joined.body.data.loyaltyCardNo).toMatch(/^LC\d{10}$/);
    expect(joined.body.data.loyaltyPoints).toBe(50);
    customer = joined.body.data;
    // Joining again keeps the card and gives no second bonus.
    expect((await t.client.post(`/loyalty/members/${customer._id}/enroll`, {})).body.data.loyaltyPoints).toBe(50);
    // The till finds the member by card.
    const found = await cashier.get(`/loyalty/lookup?code=${customer.loyaltyCardNo}`);
    expect(found.body.data).toMatchObject({ name: 'Wanjiku Mwangi', loyaltyPoints: 50 });
  });

  it('earns faster in a better tier, and spends points within the program limits', async () => {
    // KES 500 at 1 point per KES 100, Bronze earns double: 10 points.
    const s = await sell([{ method: 'cash', amountCents: 50000 }], { customerId: customer._id });
    expect(s.status).toBe(201);
    expect(s.body.data.loyalty.earned).toBe(10);
    // Below the minimum of 20 points.
    expect((await sell([{ method: 'loyalty', amountCents: 1000 }, { method: 'cash', amountCents: 49000 }], { customerId: customer._id })).body.error.code).toBe('POINTS_BELOW_MINIMUM');
    // Over half the sale.
    const over = await sell([{ method: 'loyalty', amountCents: 6000 }, { method: 'cash', amountCents: 44000 }], { customerId: customer._id });
    expect(over.status).toBe(201); // 60 points = KES 60, far below 50% of KES 500
    const r = await cashier.get(`/loyalty/redeemable?customerId=${customer._id}&totalCents=2000`);
    expect(r.body.data.points).toBe(0); // 50% of KES 20 = 10 points, under the minimum of 20
    const hist = (await t.client.get(`/loyalty/members/${customer._id}/history`)).body.data;
    expect(hist.map((h: any) => h.kind)).toEqual(expect.arrayContaining(['bonus', 'earn', 'redeem']));
  });

  it('adjustments need the loyalty permission and a reason; voids reverse points', async () => {
    expect((await cashier.post(`/loyalty/members/${customer._id}/adjust`, { points: 100, note: 'Goodwill' })).status).toBe(403);
    const before = (await t.client.get(`/loyalty/lookup?code=${customer.loyaltyCardNo}`)).body.data.loyaltyPoints;
    const adj = await t.client.post(`/loyalty/members/${customer._id}/adjust`, { points: 100, note: 'Goodwill for late delivery' });
    expect(adj.body.data.balance).toBe(before + 100);
    expect((await t.client.post(`/loyalty/members/${customer._id}/adjust`, { points: -1_000_000, note: 'Too many' })).status).toBe(400);
    const s = await sell([{ method: 'cash', amountCents: 50000 }], { customerId: customer._id });
    const mid = (await t.client.get(`/loyalty/lookup?code=${customer.loyaltyCardNo}`)).body.data.loyaltyPoints;
    expect((await t.client.post(`/sales/${s.body.data._id}/void`, { clientRequestId: rid(), reason: 'Wrong customer' })).status).toBe(200);
    expect((await t.client.get(`/loyalty/lookup?code=${customer.loyaltyCardNo}`)).body.data.loyaltyPoints).toBe(mid - 10);
  });
});

describe('gift vouchers', () => {
  let code: string;
  it('sells a voucher for cash into the drawer, and prints it', async () => {
    expect((await cashier.post('/vouchers', { amountCents: 100000 })).status).toBe(403);
    const r = await t.client.post('/vouchers', { amountCents: 100000, source: 'sold', payment: { method: 'cash', tillId: till } });
    expect(r.status).toBe(201);
    code = r.body.data[0].code;
    expect(code).toMatch(/^GV-[A-HJ-NP-Z2-9]{8}$/);
    const shift = (await cashier.get(`/shifts/current?tillId=${till}`)).body.data;
    const summary = (await t.client.get(`/shifts/${shift._id}/summary`)).body.data;
    expect(summary.cashMovements.cash_in.totalCents).toBe(100000);
    const html = await t.client.get(`/vouchers/print?ids=${r.body.data[0]._id}`);
    expect(html.text).toContain(code);
    const promo = await t.client.post('/vouchers', { amountCents: 20000, quantity: 3, source: 'promo', expiresAt: new Date(Date.now() + 86400_000).toISOString() });
    expect(promo.body.data).toHaveLength(3);
    expect((await t.client.post('/vouchers', { amountCents: 20000, source: 'sold' })).status).toBe(400);
  });

  it('pays part of a sale with a voucher, keeps the rest, and refuses more than the balance', async () => {
    expect((await cashier.get(`/vouchers/check?code=${code}`)).body.data).toMatchObject({ balanceCents: 100000, usable: true });
    const s = await sell([{ method: 'voucher', reference: code.toLowerCase(), amountCents: 50000 }]);
    expect(s.status).toBe(201);
    expect(s.body.data.payments[0]).toMatchObject({ method: 'voucher', reference: code });
    expect((await cashier.get(`/vouchers/check?code=${code}`)).body.data.balanceCents).toBe(50000);
    const tooMuch = await sell([{ method: 'voucher', reference: code, amountCents: 100000 }], { qty: 2 });
    expect(tooMuch.body.error.code).toBe('VOUCHER_NOT_AVAILABLE');
    expect(tooMuch.body.error.message).toMatch(/only has 500\.00 left/);
    // Spend the rest: used up.
    await sell([{ method: 'voucher', reference: code, amountCents: 50000 }]);
    const used = (await cashier.get(`/vouchers/check?code=${code}`)).body.data;
    expect(used).toMatchObject({ status: 'used', usable: false });
    // A void puts the money back on the voucher.
    const last = (await t.client.get('/sales?limit=1')).body.data[0];
    await t.client.post(`/sales/${last._id}/void`, { clientRequestId: rid(), reason: 'Customer changed mind' });
    expect((await cashier.get(`/vouchers/check?code=${code}`)).body.data).toMatchObject({ status: 'active', balanceCents: 50000 });
  });

  it('cancelled vouchers cannot be spent', async () => {
    const list = (await t.client.get(`/vouchers?q=${code}`)).body.data;
    await t.client.post(`/vouchers/${list[0]._id}/cancel`, { reason: 'Reported stolen' });
    const r = await sell([{ method: 'voucher', reference: code, amountCents: 50000 }]);
    expect(r.body.error.message).toMatch(/cancelled/);
    const all = await t.client.get('/vouchers');
    expect(all.body.outstanding.count).toBe(3);
  });

  it('books vouchers as money owed to holders until they are spent', async () => {
    await t.client.put('/settings/modules', { enabled: ['loyalty', 'accounting'] });
    expect((await t.client.post('/accounting/post', {})).status).toBe(200);
    const tb = (await t.client.get('/accounting/trial-balance')).body;
    expect(tb.balanced).toBe(true);
    const acc = (await t.client.get('/accounting/accounts')).body.data.find((a: any) => a.code === '2310');
    // Sold 1,000 + promotions 600 - spent 1,000 + void put back 500 = 1,100 still owed (incl. the cancelled 500).
    expect(Math.abs(acc.balanceCents)).toBe(110000);
  });
});
