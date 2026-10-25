import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, createProduct, openShift, rid, Client, BASE, type Ctx } from './helpers.js';
import { drainJobs } from '../src/jobs/queue.js';
import { ConsoleSmsProvider } from '../src/integrations/sms/index.js';
import { OnlineOrder, StockLevel } from '../src/models/index.js';
import { runAsPlatform } from '../src/lib/context.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
let shop: Client;
let till: string;
let wh: string;
let milk: any;
let bread: any;
let hidden: any;

const stock = async (productId: string) => (await runAsPlatform(() => StockLevel.findOne({ productId }).lean()))!;
const order = (extra: Record<string, unknown> = {}) => shop.post('/store/orders', {
  clientRequestId: rid(), customer: { name: 'Wanjiku Mwangi', phone: '0722111222' }, fulfilment: 'delivery', area: 'Kilimani', address: 'Argwings Kodhek Rd, Apt 4B',
  payment: 'on_delivery', lines: [{ productId: milk._id, qty: 4 }, { productId: bread._id, qty: 1 }], ...extra,
});

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'shopper', 'supermarket');
  till = t.locations.tills[0]._id;
  wh = t.locations.warehouses[0]._id;
  await openShift(t.client, till, 100_000);
  await t.client.post('/settings/integrations', { kind: 'mpesa', provider: 'mock', name: 'M-Pesa sim', settings: { shortCode: '174379', type: 'paybill' }, secrets: { consumerKey: 'k', consumerSecret: 's', passkey: 'p' } });
  await t.client.post('/settings/integrations', { kind: 'sms', provider: 'console', name: 'Dev SMS' });
  milk = await createProduct(t.client, { name: 'Milk 500ml', sku: 'MILK', prices: { retail: 6500 }, costCents: 4800, online: { enabled: true, featured: true, description: 'Fresh daily' }, openingStock: [{ warehouseId: wh, qty: 10 }] });
  bread = await createProduct(t.client, { name: 'Bread 400g', sku: 'BREAD', prices: { retail: 6000 }, costCents: 4500, online: { enabled: true }, openingStock: [{ warehouseId: wh, qty: 5 }] });
  hidden = await createProduct(t.client, { name: 'Cigarettes', sku: 'CIG', prices: { retail: 30000 }, openingStock: [{ warehouseId: wh, qty: 5 }] });
  shop = new Client(ctx.api, 'shopper'); // no sign-in: a website visitor
});
afterAll(teardown);

describe('storefront', () => {
  it('is closed until the shop is switched on', async () => {
    expect((await shop.get('/store/config')).body.error.code).toBe('STORE_CLOSED');
    const r = await t.client.patch('/settings/business', { settings: { store: { enabled: true, warehouseId: wh, deliveryAreas: [{ name: 'Kilimani', feeCents: 20000 }, { name: 'Westlands', feeCents: 30000 }], freeDeliveryAboveCents: 80000, notifyPhone: '0700000001', announcement: 'Free delivery above KES 2,000' } } });
    expect(r.status).toBe(200);
    const cfg = (await shop.get('/store/config')).body.data;
    expect(cfg).toMatchObject({ name: 'shopper shop', delivery: true, pickup: true, mpesa: true, payOnDelivery: true, announcement: 'Free delivery above KES 2,000' });
    expect(cfg.deliveryAreas).toHaveLength(2);
  });

  it('lists only products sold online, with stock', async () => {
    const list = (await shop.get('/store/products')).body.data;
    expect(list.map((p: any) => p.name)).toEqual(['Milk 500ml', 'Bread 400g']); // featured first
    expect(list[0]).toMatchObject({ priceCents: 6500, inStock: true, available: 10, description: 'Fresh daily' });
    expect((await shop.get(`/store/products/${hidden._id}`)).status).toBe(404);
    expect((await shop.get('/store/products?q=bread')).body.data).toHaveLength(1);
  });

  it('prices the basket with delivery fees and the free-delivery threshold, and refuses what is not in stock', async () => {
    const q = (await shop.post('/store/cart/quote', { fulfilment: 'delivery', area: 'Kilimani', lines: [{ productId: milk._id, qty: 2 }] })).body.data;
    expect(q).toMatchObject({ subtotalCents: 13000, deliveryFeeCents: 20000, totalCents: 33000, problems: [] });
    const free = (await shop.post('/store/cart/quote', { fulfilment: 'delivery', area: 'Westlands', lines: [{ productId: milk._id, qty: 10 }, { productId: bread._id, qty: 3 }] })).body.data;
    expect(free.deliveryFeeCents).toBe(0);
    const tooMany = (await shop.post('/store/cart/quote', { fulfilment: 'pickup', lines: [{ productId: bread._id, qty: 9 }] })).body.data;
    expect(tooMany.problems[0]).toMatch(/Only 5 Bread/);
    const notSold = (await shop.post('/store/cart/quote', { lines: [{ productId: hidden._id, qty: 1 }] })).body.data;
    expect(notSold.problems[0]).toMatch(/no longer sold online/);
  });

  it('accepts requests from the shop website on another domain (CORS, no cookies)', async () => {
    const pre = await ctx.api.options('/api/v1/store/products').set('Host', BASE).set('Origin', 'https://shop.example.co.ke').set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'content-type');
    expect(pre.headers['access-control-allow-origin']).toBe('https://shop.example.co.ke');
    expect(pre.headers['access-control-allow-credentials']).toBeUndefined();
  });
});

describe('pay on delivery', () => {
  let number: string;
  let id: string;

  it('places the order, reserves stock, creates the customer and tells the shop', async () => {
    ConsoleSmsProvider.outbox.length = 0;
    expect((await order({ address: undefined })).body.error.message).toMatch(/delivery address/);
    const r = await order();
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ status: 'placed', totalCents: 4 * 6500 + 6000 + 20000, deliveryFeeCents: 20000, payment: { method: 'on_delivery', status: 'unpaid' } });
    number = r.body.data.number;
    expect(number).toMatch(/^WEB-/);
    expect((await stock(milk._id)).reserved).toBe(4);
    const customers = (await t.client.get('/customers?q=Wanjiku')).body.data;
    expect(customers[0]).toMatchObject({ phone: '0722111222', source: 'online shop' });
    await drainJobs();
    expect(ConsoleSmsProvider.outbox.find((m) => m.to === '254700000001')!.message).toContain(number);
    // Tracking needs the token or the phone number.
    expect((await shop.get(`/store/orders/${number}`)).status).toBe(404);
    expect((await shop.get(`/store/orders/${number}?phone=0722111222`)).body.data.status).toBe('placed');
    expect((await shop.get(`/store/orders/${number}?token=${r.body.data.token}`)).body.data.statusText).toBe('has been received');
  });

  it('staff accept, pack and dispatch it, and the customer gets SMS updates', async () => {
    const list = (await t.client.get('/online-orders?open=true')).body.data;
    id = list.find((o: any) => o.number === number)._id;
    expect((await t.client.post(`/online-orders/${id}/status`, { status: 'ready' })).body.error.code).toBe('BAD_TRANSITION');
    await t.client.post(`/online-orders/${id}/status`, { status: 'accepted' });
    await t.client.post(`/online-orders/${id}/status`, { status: 'picking' });
    expect((await t.client.post(`/online-orders/${id}/status`, { status: 'ready' })).body.error.code).toBe('BAD_TRANSITION'); // delivery order
    expect((await t.client.post(`/online-orders/${id}/status`, { status: 'out_for_delivery' })).body.data.status).toBe('out_for_delivery');
    ConsoleSmsProvider.outbox.length = 0;
    await drainJobs();
    expect(ConsoleSmsProvider.outbox.some((m) => m.to === '254722111222' && m.message.includes('is on the way'))).toBe(true);
  });

  it('completes as a sale when the rider collects the money; stock moves and the reservation is released', async () => {
    expect((await t.client.post(`/online-orders/${id}/complete`, { tillId: till, payments: [{ method: 'cash', amountCents: 1000 }] })).body.error.code).toBe('UNPAID');
    const r = await t.client.post(`/online-orders/${id}/complete`, { tillId: till, payments: [{ method: 'cash', amountCents: 52000 }] });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'completed', saleNumber: expect.stringMatching(/^RCP-/) });
    expect(r.body.sale.lines.map((l: any) => l.name)).toEqual(['Milk 500ml', 'Bread 400g', 'Delivery fee']);
    expect(r.body.sale.totalCents).toBe(52000);
    const s = await stock(milk._id);
    expect(s).toMatchObject({ qty: 6, reserved: 0 });
    expect((await t.client.post(`/online-orders/${id}/complete`, { tillId: till, payments: [] })).body.replay).toBe(true);
  });
});

describe('M-Pesa at checkout', () => {
  let number: string;
  let token: string;

  it('sends an STK push, waits for payment, and keeps the payment for the order', async () => {
    const r = await order({ payment: 'mpesa', fulfilment: 'pickup', area: undefined, address: undefined, lines: [{ productId: bread._id, qty: 2 }] });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ status: 'pending_payment', totalCents: 12000, payment: { method: 'mpesa', status: 'pending' } });
    number = r.body.data.number;
    token = r.body.data.token;
    const paid = await shop.post(`/store/orders/${number}/simulate-payment?token=${token}`, {});
    expect(paid.body.data).toMatchObject({ status: 'placed', payment: { status: 'paid' } });
    // Not offered at the till as an unused M-Pesa payment.
    const unallocated = (await t.client.get('/payments/intents?unallocated=true')).body.data;
    expect(unallocated).toHaveLength(0);
  });

  it('a cashier completes it with the M-Pesa payment, at the price the customer was given', async () => {
    // The price went up after the order; the customer pays what they were quoted.
    await t.client.put(`/products/${bread._id}`, { ...(await t.client.get(`/products/${bread._id}`)).body.data, prices: { retail: 7000 } });
    await t.client.post('/settings/users', { name: 'Cathy Cashier', email: 'cathy@shopper.test', password: 'Cathy1234', roles: ['cashier'] });
    const cashier = new Client(ctx.api, 'shopper');
    await cashier.login('cathy@shopper.test', 'Cathy1234');
    const till2 = (await t.client.post('/settings/tills', { branchId: t.locations.branches[0]._id, warehouseId: wh, name: 'Online desk', code: 'T9' })).body.data._id;
    await openShift(cashier, till2);
    const o = (await cashier.get('/online-orders?status=placed')).body.data.find((x: any) => x.number === number);
    await cashier.post(`/online-orders/${o._id}/status`, { status: 'accepted' });
    await cashier.post(`/online-orders/${o._id}/status`, { status: 'ready' });
    const r = await cashier.post(`/online-orders/${o._id}/complete`, { tillId: till2 });
    expect(r.body.error ?? null).toBeNull();
    expect(r.status).toBe(200);
    expect(r.body.sale.payments[0]).toMatchObject({ method: 'mpesa', amountCents: 12000 });
    expect(r.body.sale.lines[0].unitPriceCents).toBe(6000);
    expect((await shop.get(`/store/orders/${number}?token=${token}`)).body.data.status).toBe('completed');
  });
});

describe('cancelling and expiry', () => {
  it('cancelling a paid order releases stock and creates the M-Pesa refund for approval', async () => {
    const r = await order({ payment: 'mpesa', fulfilment: 'pickup', area: undefined, address: undefined, lines: [{ productId: milk._id, qty: 1 }] });
    await shop.post(`/store/orders/${r.body.data.number}/simulate-payment?token=${r.body.data.token}`, {});
    expect((await stock(milk._id)).reserved).toBe(1);
    const o = (await t.client.get(`/online-orders?q=${r.body.data.number}`)).body.data[0];
    const c = await t.client.post(`/online-orders/${o._id}/status`, { status: 'cancelled', note: 'Out of stock at the branch' });
    expect(c.body.data.payment.status).toBe('refund_due');
    expect((await stock(milk._id)).reserved).toBe(0);
    const payouts = (await t.client.get('/payments/payouts')).body.data;
    expect(payouts.find((p: any) => p.ref?.number === r.body.data.number)).toMatchObject({ purpose: 'refund', amountCents: 6500, status: 'draft' });
  });

  it('cancels unpaid M-Pesa orders after two hours', async () => {
    const r = await order({ payment: 'mpesa', fulfilment: 'pickup', area: undefined, address: undefined, lines: [{ productId: milk._id, qty: 2 }] });
    expect((await stock(milk._id)).reserved).toBe(2);
    await runAsPlatform(() => OnlineOrder.collection.updateOne({ number: r.body.data.number }, { $set: { createdAt: new Date(Date.now() - 3 * 3600_000) } }));
    const { enqueue } = await import('../src/jobs/queue.js');
    const { runInTenant } = await import('../src/lib/context.js');
    await runInTenant(t.tenant.id, () => enqueue('store.expireUnpaid', {}));
    await drainJobs();
    expect((await shop.get(`/store/orders/${r.body.data.number}?token=${r.body.data.token}`)).body.data.status).toBe('cancelled');
    expect((await stock(milk._id)).reserved).toBe(0);
  });
});
