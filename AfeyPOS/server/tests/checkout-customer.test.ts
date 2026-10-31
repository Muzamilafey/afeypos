import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, createProduct, openShift, rid, type Ctx } from './helpers.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
let till: string;
let milk: any;

const setRules = (customer: Record<string, unknown>) => t.client.put('/settings/checkout-rules', { rules: { customer } });
const sell = (body: Record<string, unknown> = {}) =>
  t.client.post('/sales', { clientRequestId: rid(), tillId: till, lines: [{ productId: milk._id, qty: 1 }], payments: [{ method: 'cash', amountCents: 10000 }], ...body });

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'loyalshop', 'supermarket', {}, ['loyalty']);
  till = t.locations.tills[0]._id;
  await openShift(t.client, till, 100000);
  milk = await createProduct(t.client, { name: 'Milk', sku: 'LMILK', prices: { retail: 10000 }, openingStock: [{ warehouseId: t.locations.warehouses[0]._id, qty: 100 }] });
});
afterAll(teardown);

describe('Checkout rules → customer phone and loyalty', () => {
  it('asks for the phone, makes the customer and gives them the points', async () => {
    expect((await setRules({ phone: 'ask', createFromPhone: true, awardLoyalty: true, required: false })).status).toBe(200);
    const sale = (await sell({ customerPhone: '0712 345 678' })).body.data;
    expect(sale.customerId).toBeTruthy();
    const customer = (await t.client.get(`/customers/${sale.customerId}`)).body.data;
    expect(customer.phone).toBe('254712345678');
    expect(customer.loyaltyPoints).toBeGreaterThan(0);
    // The same number next time is the same customer, not a second one.
    const again = (await sell({ customerPhone: '254712345678' })).body.data;
    expect(String(again.customerId)).toBe(String(sale.customerId));
    expect((await sell({ customerPhone: 'not a phone' })).status).toBe(400);
  });

  it('can demand a number before the sale is allowed', async () => {
    await setRules({ phone: 'ask', required: true });
    const r = await sell();
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('CUSTOMER_PHONE_REQUIRED');
    expect((await sell({ customerPhone: '0722000111' })).status).toBe(201);
  });

  it('switched off: the till collects nothing and the sale belongs to nobody', async () => {
    await setRules({ phone: 'off', required: false });
    const sale = (await sell({ customerPhone: '0733123456' })).body.data;
    expect(sale.customerId ?? null).toBeNull();
    expect((await t.client.get('/customers?q=0733123456')).body.data).toHaveLength(0);
  });

  it('can leave the points out while still knowing the customer', async () => {
    await setRules({ phone: 'ask', createFromPhone: true, awardLoyalty: false });
    const sale = (await sell({ customerPhone: '0700999888' })).body.data;
    expect(sale.customerId).toBeTruthy();
    expect((await t.client.get(`/customers/${sale.customerId}`)).body.data.loyaltyPoints ?? 0).toBe(0);
  });

  it('the rules come back as saved', async () => {
    await setRules({ phone: 'mpesa', createFromPhone: false, awardLoyalty: true, required: false });
    const r = await t.client.get('/settings/checkout-rules');
    expect(r.body.data.rules.customer).toEqual({ phone: 'mpesa', createFromPhone: false, awardLoyalty: true, required: false });
    expect(r.body.data.rules.mpesa).toEqual({ watchTillPayments: true, autoComplete: true });
  });
});
