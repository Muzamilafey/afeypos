import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupApp, teardown, registerTenant, createProduct, openShift, rid, BASE, type Ctx } from './helpers.js';
import { Tenant } from '../src/models/index.js';
import { runAsPlatform } from '../src/lib/context.js';
import { createPaymentGateway, SimulatorGateway, type ChargeInput, type GatewayConfig } from '../src/integrations/payments/index.js';
import { parseAtValue } from '../src/integrations/payments/africastalking.js';
import { dialCode, toMsisdn } from '../src/integrations/payments/util.js';

// ---------------- fetch stub ----------------
type Call = { url: string; method: string; headers: Record<string, string>; body: any };
let calls: Call[] = [];
function stubFetch(handler: (c: Call) => { status?: number; body?: unknown; headers?: Record<string, string> }) {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const headers = Object.fromEntries(Object.entries((init.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    let body: any = init.body;
    try {
      body = typeof body === 'string' ? JSON.parse(body) : body;
    } catch {
      /* form body */
    }
    const c = { url: String(url), method: init.method ?? 'GET', headers, body };
    calls.push(c);
    const r = handler(c);
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...(r.headers ?? {}) } });
  });
}
afterEach(() => vi.unstubAllGlobals());

const gw = (provider: GatewayConfig['provider'], secrets: Record<string, string>, settings: Record<string, string> = {}) => createPaymentGateway({ provider, environment: 'sandbox', settings, secrets });
const charge = (over: Partial<ChargeInput> = {}): ChargeInput => ({
  reference: 'ref123', amountCents: 25000, currency: 'KES', flow: 'push', phone: '254712345678', email: 'a@b.co', description: 'Shop payment',
  callbackUrl: 'https://pos.example/hook', redirectUrl: 'https://pos.example/return', ...over,
});
const wh = (body: unknown, headers: Record<string, string> = {}) => {
  const raw = Buffer.from(JSON.stringify(body));
  return { rawBody: raw, body, query: {}, headers };
};

describe('gateway adapters (stubbed HTTP; live APIs not exercised)', () => {
  it('normalises phone numbers per country', () => {
    expect(toMsisdn('0712 345 678', dialCode('KES'))).toBe('254712345678');
    expect(toMsisdn('0551234567', dialCode('GHS'))).toBe('233551234567');
    expect(toMsisdn('+256772123456', dialCode('UGX'))).toBe('256772123456');
    expect(toMsisdn('677123456', dialCode('XAF', 'MTN_MOMO_CMR'))).toBe('237677123456');
    expect(toMsisdn('12', '254')).toBeNull();
    expect(parseAtValue('KES 100.0000')).toEqual({ currency: 'KES', cents: 10000 });
  });

  it('Paystack: mobile money charge, verify, HMAC-SHA512 webhook', async () => {
    const p = gw('paystack', { secretKey: 'sk_test_abc' });
    stubFetch(() => ({ body: { status: true, data: { reference: 'ref123', status: 'pay_offline', display_text: 'Approve on your phone' } } }));
    const out = await p.charge(charge({ channel: 'mpesa' }));
    expect(out).toMatchObject({ status: 'pending', providerRef: 'ref123', message: 'Approve on your phone' });
    expect(calls[0].url).toBe('https://api.paystack.co/charge');
    expect(calls[0].headers.authorization).toBe('Bearer sk_test_abc');
    expect(calls[0].body).toMatchObject({ amount: 25000, currency: 'KES', reference: 'ref123', mobile_money: { phone: '+254712345678', provider: 'mpesa' } });

    stubFetch(() => ({ body: { status: true, data: { status: 'success', amount: 25000, currency: 'KES', reference: 'ref123', id: 99, receipt_number: 'RKX1' } } }));
    expect(await p.verify({ reference: 'ref123' })).toMatchObject({ status: 'succeeded', paidAmountCents: 25000, currency: 'KES', receiptNumber: 'RKX1' });
    stubFetch(() => ({ status: 404, body: { status: false, message: 'Transaction reference not found' } }));
    expect((await p.verify({ reference: 'nope' })).status).toBe('pending');

    const body = { event: 'charge.success', data: { reference: 'ref123' } };
    const sig = createHmac('sha512', 'sk_test_abc').update(JSON.stringify(body)).digest('hex');
    expect(p.webhook(wh(body, { 'x-paystack-signature': sig }))).toEqual({ reference: 'ref123' });
    expect(p.webhook(wh(body, { 'x-paystack-signature': 'f'.repeat(128) }))).toBeNull();
    expect(p.webhook(wh(body))).toBeNull();

    stubFetch(() => ({ body: { status: true, data: { authorization_url: 'https://checkout.paystack.com/xyz', access_code: 'xyz', reference: 'ref123' } } }));
    expect(await p.charge(charge({ flow: 'link' }))).toMatchObject({ status: 'pending', checkoutUrl: 'https://checkout.paystack.com/xyz' });
    expect(calls[0].url).toBe('https://api.paystack.co/transaction/initialize');
  });

  it('Pesapal: token, IPN registered once, hosted page, status by tracking id', async () => {
    const p = gw('pesapal', { consumerKey: 'ck', consumerSecret: 'cs' });
    stubFetch((c) => {
      if (c.url.endsWith('/api/Auth/RequestToken')) return { body: { token: 'tok-1', expiryDate: new Date(Date.now() + 300_000).toISOString(), status: '200' } };
      if (c.url.endsWith('/api/URLSetup/GetIpnList')) return { body: [] };
      if (c.url.endsWith('/api/URLSetup/RegisterIPN')) return { body: { ipn_id: 'ipn-9', url: c.body.url, status: '200' } };
      if (c.url.endsWith('/api/Transactions/SubmitOrderRequest')) return { body: { order_tracking_id: 'trk-1', merchant_reference: 'ref123', redirect_url: 'https://cybqa.pesapal.com/pay/trk-1', status: '200' } };
      return { body: { status_code: 1, payment_status_description: 'Completed', merchant_reference: 'ref123', amount: 250, currency: 'KES', confirmation_code: 'PSP123', payment_method: 'Visa' } };
    });
    const out = await p.charge(charge({ flow: 'link' }));
    expect(out).toMatchObject({ status: 'pending', providerRef: 'trk-1', checkoutUrl: 'https://cybqa.pesapal.com/pay/trk-1' });
    const order = calls.find((c) => c.url.endsWith('SubmitOrderRequest'))!;
    expect(order.url.startsWith('https://cybqa.pesapal.com/pesapalv3/')).toBe(true);
    expect(order.headers.authorization).toBe('Bearer tok-1');
    expect(order.body).toMatchObject({ id: 'ref123', amount: 250, currency: 'KES', notification_id: 'ipn-9', callback_url: 'https://pos.example/return' });
    expect(calls.find((c) => c.url.endsWith('RegisterIPN'))!.body).toEqual({ url: 'https://pos.example/hook', ipn_notification_type: 'GET' });
    // Second charge: the IPN id is remembered.
    await p.charge(charge({ flow: 'link', reference: 'ref124' }));
    expect(calls.filter((c) => c.url.endsWith('RegisterIPN'))).toHaveLength(1);
    expect(await p.verify({ reference: 'ref123', providerRef: 'trk-1' })).toMatchObject({ status: 'succeeded', paidAmountCents: 25000, receiptNumber: 'PSP123' });
    expect(await p.verify({ reference: 'other', providerRef: 'trk-1' })).toMatchObject({ status: 'pending', message: 'Reference mismatch' });
    expect(p.webhook({ rawBody: Buffer.alloc(0), body: {}, query: { OrderTrackingId: 'trk-1', OrderMerchantReference: 'ref123', OrderNotificationType: 'IPNCHANGE' }, headers: {} })).toEqual({ providerRef: 'trk-1', reference: 'ref123' });
  });

  it('Flutterwave: charge type from channel, verif-hash webhook, verify by tx_ref', async () => {
    const f = gw('flutterwave', { secretKey: 'FLWSECK_TEST-x', webhookHash: 'my-hash' });
    stubFetch(() => ({ body: { status: 'success', data: { id: 7, flw_ref: 'FLW-1', status: 'pending' } } }));
    await f.charge(charge({ channel: 'mobile_money_ghana:MTN', currency: 'GHS', phone: '233551234567' }));
    expect(calls[0].url).toBe('https://api.flutterwave.com/v3/charges?type=mobile_money_ghana');
    expect(calls[0].body).toMatchObject({ tx_ref: 'ref123', amount: 250, currency: 'GHS', network: 'MTN' });
    expect(f.webhook(wh({ data: { tx_ref: 'ref123' } }, { 'verif-hash': 'my-hash' }))).toEqual({ reference: 'ref123' });
    expect(f.webhook(wh({ data: { tx_ref: 'ref123' } }, { 'verif-hash': 'wrong!!' }))).toBeNull();
    stubFetch(() => ({ body: { status: 'success', data: { status: 'successful', tx_ref: 'ref123', amount: 250, currency: 'GHS', flw_ref: 'FLW-1' } } }));
    expect(await f.verify({ reference: 'ref123' })).toMatchObject({ status: 'succeeded', paidAmountCents: 25000, receiptNumber: 'FLW-1' });
    stubFetch(() => ({ body: { status: 'success', data: { status: 'successful', tx_ref: 'someone-else', amount: 250, currency: 'GHS' } } }));
    expect((await f.verify({ reference: 'ref123' })).status).toBe('pending');
  });

  it('pawaPay: UUID depositId, correspondent, status lookup', async () => {
    const p = gw('pawapay', { apiToken: 'tok' });
    const ref = p.newReference!();
    expect(ref).toMatch(/^[0-9a-f-]{36}$/);
    stubFetch(() => ({ body: { depositId: ref, status: 'ACCEPTED' } }));
    expect((await p.charge(charge({ reference: ref, channel: 'MTN_MOMO_UGA', currency: 'UGX', phone: '256772123456', amountCents: 500000 }))).status).toBe('pending');
    expect(calls[0].url).toBe('https://api.sandbox.pawapay.io/deposits');
    expect(calls[0].body).toMatchObject({ depositId: ref, amount: '5000', currency: 'UGX', correspondent: 'MTN_MOMO_UGA', payer: { type: 'MSISDN', address: { value: '256772123456' } } });
    stubFetch(() => ({ body: { depositId: ref, status: 'REJECTED', rejectionReason: { rejectionMessage: 'Invalid MSISDN' } } }));
    expect(await p.charge(charge({ reference: ref, channel: 'MTN_MOMO_UGA' }))).toMatchObject({ status: 'failed', message: 'Invalid MSISDN' });
    stubFetch(() => ({ body: [{ depositId: ref, status: 'COMPLETED', depositedAmount: '5000', currency: 'UGX', correspondentIds: { MTN_INIT: 'MP123' } }] }));
    expect(await p.verify({ reference: ref })).toMatchObject({ status: 'succeeded', paidAmountCents: 500000, currency: 'UGX', receiptNumber: 'MP123' });
  });

  it('Airtel Money: OAuth token, country headers, national msisdn, TS status', async () => {
    const a = gw('airtel', { clientId: 'cid', clientSecret: 'cs' }, { country: 'UG' });
    stubFetch((c) => (c.url.endsWith('/auth/oauth2/token') ? { body: { access_token: 'AT1', expires_in: 180 } } : { body: { data: { transaction: { id: 'AFY1', status: 'Success.' } }, status: { success: true, code: '200' } } }));
    expect((await a.charge(charge({ reference: 'AFY1', currency: 'UGX', phone: '256752123456', amountCents: 100000 }))).status).toBe('pending');
    const pay = calls.find((c) => c.url.endsWith('/merchant/v1/payments/'))!;
    expect(pay.headers).toMatchObject({ authorization: 'Bearer AT1', 'x-country': 'UG', 'x-currency': 'UGX' });
    expect(pay.body).toMatchObject({ subscriber: { msisdn: '752123456' }, transaction: { id: 'AFY1', amount: 1000 } });
    expect((await a.charge(charge({ currency: 'KES' }))).status).toBe('failed');
    stubFetch(() => ({ body: { data: { transaction: { id: 'AFY1', status: 'TS', airtel_money_id: 'MP2101' } } } }));
    expect(await a.verify({ reference: 'AFY1' })).toMatchObject({ status: 'succeeded', receiptNumber: 'MP2101' });
  });

  it('Kopo Kopo: Location header, host-pinned status lookup, HMAC-SHA256 webhook', async () => {
    const k = gw('kopokopo', { clientId: 'cid', clientSecret: 'cs', apiKey: 'k2key' }, { tillNumber: 'K000000' });
    const loc = 'https://sandbox.kopokopo.com/api/v1/incoming_payments/abc';
    stubFetch((c) => (c.url.endsWith('/oauth/token') ? { body: { access_token: 'K2', expires_in: 3600 } } : { status: 201, body: {}, headers: { location: loc } }));
    expect(await k.charge(charge())).toMatchObject({ status: 'pending', providerRef: loc });
    expect(calls.find((c) => c.url.endsWith('/incoming_payments'))!.body).toMatchObject({ payment_channel: 'M-PESA STK Push', till_number: 'K000000', subscriber: { phone_number: '+254712345678' }, amount: { currency: 'KES', value: 250 }, metadata: { reference: 'ref123' } });
    stubFetch((c) => (c.url.endsWith('/oauth/token') ? { body: { access_token: 'K2' } } : { body: { data: { id: 'abc', attributes: { status: 'Success', metadata: { reference: 'ref123' }, event: { resource: { reference: 'QKX9', amount: '250.0', currency: 'KES', sender_phone_number: '+254712345678' } } } } } }));
    expect(await k.verify({ reference: 'ref123', providerRef: loc })).toMatchObject({ status: 'succeeded', paidAmountCents: 25000, receiptNumber: 'QKX9' });
    const before = calls.length;
    expect((await k.verify({ reference: 'ref123', providerRef: 'https://evil.example/steal' })).status).toBe('pending');
    expect(calls.length).toBe(before);
    const body = { data: { attributes: { metadata: { reference: 'ref123' }, _links: { self: loc } } } };
    const sig = createHmac('sha256', 'k2key').update(JSON.stringify(body)).digest('hex');
    expect(k.webhook(wh(body, { 'x-kopokopo-signature': sig }))).toEqual({ reference: 'ref123', providerRef: loc });
    expect(k.webhook(wh(body, { 'x-kopokopo-signature': sig.replace(/.$/, '0') }))).toBeNull();
  });

  it('Hubtel, iPay, ZenoPay and Africa’s Talking request shapes', async () => {
    const h = gw('hubtel', { clientId: 'id', clientSecret: 'key' }, { merchantAccountNumber: '2017101' });
    stubFetch(() => ({ body: { ResponseCode: '0001', Data: { TransactionId: 'HT1' } } }));
    expect(await h.charge(charge({ currency: 'GHS', channel: 'mtn-gh', phone: '233551234567' }))).toMatchObject({ status: 'pending', providerRef: 'HT1' });
    expect(calls[0].url).toBe('https://rmp.hubtel.com/merchantaccount/merchants/2017101/receive/mobilemoney');
    expect(calls[0].headers.authorization).toBe(`Basic ${Buffer.from('id:key').toString('base64')}`);
    expect(calls[0].body).toMatchObject({ Channel: 'mtn-gh', Amount: 250, ClientReference: 'ref123', CustomerMsisdn: '233551234567' });
    stubFetch(() => ({ body: { responseCode: '0000', data: { status: 'Paid', amount: 250, currencyCode: 'GHS', clientReference: 'ref123', externalTransactionId: 'MTN77' } } }));
    expect(await h.verify({ reference: 'ref123' })).toMatchObject({ status: 'succeeded', paidAmountCents: 25000, receiptNumber: 'MTN77' });

    const ip = gw('ipay', { hashKey: 'hk' }, { vendorId: 'demo' });
    stubFetch((c) => (c.url.endsWith('/transact') ? { body: { status: 1, data: { sid: 'SID1' } } } : { body: { status: 1, text: 'Push sent' } }));
    expect(await ip.charge(charge())).toMatchObject({ status: 'pending', providerRef: 'SID1' });
    const init = calls[0].body;
    const expected = createHmac('sha256', 'hk').update(['0', 'ref123', 'ref123', '250', '254712345678', 'a@b.co', 'demo', 'KES', '', '', '', '', 'https://pos.example/hook', '1', '0'].join('')).digest('hex');
    expect(init.hash).toBe(expected);
    expect(calls[1].body).toMatchObject({ phone: '254712345678', sid: 'SID1', vid: 'demo', hash: createHmac('sha256', 'hk').update('254712345678demoSID1').digest('hex') });

    const z = gw('zenopay', { apiKey: 'zk' });
    stubFetch(() => ({ body: { status: 'success', resultcode: '000', order_id: 'ref123' } }));
    expect((await z.charge(charge({ currency: 'TZS', phone: '255712345678' }))).status).toBe('pending');
    expect(calls[0].headers['x-api-key']).toBe('zk');
    expect(calls[0].body).toMatchObject({ order_id: 'ref123', buyer_phone: '0712345678', amount: 250, webhook_url: 'https://pos.example/hook' });
    expect(z.webhook(wh({ order_id: 'ref123' }, { 'x-api-key': 'zk' }))).toEqual({ reference: 'ref123' });
    expect(z.webhook(wh({ order_id: 'ref123' }, { 'x-api-key': 'nope' }))).toBeNull();

    const at = gw('africastalking', { apiKey: 'atk' }, { username: 'sandbox', productName: 'Shop' });
    stubFetch(() => ({ body: { status: 'PendingConfirmation', transactionId: 'ATPid_1', description: 'Waiting for user input' } }));
    expect(await at.charge(charge())).toMatchObject({ status: 'pending', providerRef: 'ATPid_1' });
    expect(calls[0].url).toBe('https://payments.sandbox.africastalking.com/mobile/checkout/request');
    expect(calls[0].body).toMatchObject({ username: 'sandbox', productName: 'Shop', phoneNumber: '+254712345678', currencyCode: 'KES', amount: 250, metadata: { reference: 'ref123' } });
    stubFetch(() => ({ body: { status: 'Success', data: { status: 'Success', value: 'KES 250.0000', transactionId: 'ATPid_1', providerRefId: 'QKA1', requestMetadata: { reference: 'ref123' } } } }));
    expect(await at.verify({ reference: 'ref123', providerRef: 'ATPid_1' })).toMatchObject({ status: 'succeeded', paidAmountCents: 25000, currency: 'KES', receiptNumber: 'QKA1' });
  });

  it('refuses providers that are not available yet', () => {
    expect(() => gw('julypay', {})).toThrow(/not available/);
    expect(() => gw('paystack', {})).toThrow(/secret key is not configured/);
  });
});

// ---------------- API flows ----------------
let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
let till: string;
let wh2: string;
let hookBase: string;
let simId: string;

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'gatewayshop', 'minimart');
  till = t.locations.tills[0]._id;
  wh2 = t.locations.warehouses[0]._id;
  const tenant = await runAsPlatform(() => Tenant.findOne().lean());
  hookBase = `/api/v1/hooks/pay/${tenant!._id}/${tenant!.callbackToken}/gw`;
  await openShift(t.client, till);
  const sim = await t.client.post('/settings/integrations', { kind: 'payment', provider: 'simulator', name: 'Simulator' });
  expect(sim.status).toBe(201);
  simId = sim.body.data.id;
});
afterAll(teardown);

describe('gateway configuration', () => {
  it('validates providers and required fields, never returns secrets', async () => {
    expect((await t.client.post('/settings/integrations', { kind: 'payment', provider: 'julypay', name: 'July' })).status).toBe(400);
    const missing = await t.client.post('/settings/integrations', { kind: 'payment', provider: 'paystack', name: 'Paystack', secrets: { secretKey: 'sk_test_1' } });
    expect(missing.status).toBe(400);
    expect(missing.body.error.message).toContain('Fallback customer email');
    const ok = await t.client.post('/settings/integrations', { kind: 'payment', provider: 'paystack', name: 'Paystack', settings: { customerEmail: 'pay@shop.co.ke', currency: 'KES' }, secrets: { secretKey: 'sk_test_supersecret' } });
    expect(ok.status).toBe(201);
    expect(ok.body.data.secretsSet).toEqual(['secretKey']);
    expect(JSON.stringify(ok.body)).not.toContain('supersecret');
    const list = await t.client.get('/settings/integrations');
    expect(list.body.providers.payment).toContain('pawapay');
    expect(list.body.providers.payment).not.toContain('julypay');
    expect(list.body.data.find((c: any) => c.id === ok.body.data.id).webhookUrl).toContain(`/gw/${ok.body.data.id}`);
    expect((await t.client.post('/settings/integrations', { kind: 'payment', provider: 'simulator', name: 'Sim prod', environment: 'production' })).status).toBe(400);
  });

  it('lists gateways to cashiers without secrets', async () => {
    const r = await t.client.get(`/payments/gateways?tillId=${till}`);
    expect(r.status).toBe(200);
    const sim = r.body.data.find((g: any) => g.provider === 'simulator');
    expect(sim).toMatchObject({ label: 'Payment simulator', flows: ['push', 'link'], currency: 'KES' });
    expect(JSON.stringify(r.body)).not.toContain('sk_test');
  });
});

describe('gateway payments at checkout (simulator)', () => {
  const start = (body: Record<string, unknown>) => t.client.post(`/payments/gateways/${simId}/charge`, { clientRequestId: rid(), tillId: till, ...body });

  it('pending → simulated confirmation → sale, used once', async () => {
    const p = await createProduct(t.client, { prices: { retail: 30000 }, openingStock: [{ warehouseId: wh2, qty: 10 }] });
    const r = await start({ amountCents: 30000, phone: '0712345678' });
    expect(r.status).toBe(201);
    const intent = r.body.data;
    expect(intent).toMatchObject({ status: 'pending', provider: 'simulator', source: 'push', currency: 'KES' });
    expect(SimulatorGateway.charges.at(-1)!.callbackUrl).toContain(`/gw/${simId}`);
    const sale = { tillId: till, lines: [{ productId: p._id, qty: 1 }], payments: [{ method: 'gateway', amountCents: 30000, paymentIntentId: intent.id }] };
    expect((await t.client.post('/sales', { clientRequestId: rid(), ...sale })).body.error.code).toBe('PAYMENT_NOT_AVAILABLE');
    // A gateway intent cannot be passed off as M-Pesa.
    expect((await t.client.post('/sales', { clientRequestId: rid(), ...sale, payments: [{ ...sale.payments[0], method: 'mpesa' }] })).body.error.code).toBe('MPESA_NOT_AVAILABLE');
    const sim = await t.client.post(`/payments/gateways/simulate/${intent.id}`, { status: 'succeeded' });
    expect(sim.body.data.status).toBe('succeeded');
    const ok = await t.client.post('/sales', { clientRequestId: rid(), ...sale });
    expect(ok.status).toBe(201);
    expect(ok.body.data.payments[0]).toMatchObject({ method: 'gateway', provider: 'simulator' });
    expect(ok.body.data.payments[0].reference).toMatch(/^SIM/);
    expect((await t.client.post('/sales', { clientRequestId: rid(), ...sale })).body.error.code).toBe('PAYMENT_NOT_AVAILABLE');
  });

  it('marks amount mismatches failed and supports idempotent retries and links', async () => {
    const req = { clientRequestId: rid(), tillId: till, amountCents: 20000, phone: '0712345678' };
    const a = await t.client.post(`/payments/gateways/${simId}/charge`, req);
    const b = await t.client.post(`/payments/gateways/${simId}/charge`, req);
    expect(b.body.replay).toBe(true);
    expect(b.body.data.id).toBe(a.body.data.id);
    const sim = await t.client.post(`/payments/gateways/simulate/${a.body.data.id}`, { status: 'succeeded', amountCents: 10000 });
    expect(sim.body.data.status).toBe('failed');
    expect(sim.body.data.resultDesc).toContain('mismatch');

    expect((await start({ amountCents: 1050, phone: '0712345678' })).status).toBe(400); // mobile money needs whole units
    expect((await start({ amountCents: 1000 })).status).toBe(400); // phone required for push
    const rejected = await start({ amountCents: 1000, phone: '0700000000' });
    expect(rejected.body.error.code).toBe('PAYMENT_REJECTED');
    const link = await start({ amountCents: 1050, flow: 'link' });
    expect(link.status).toBe(201);
    expect(link.body.data.checkoutUrl).toContain('/api/v1/public/payment-return');
    const cancelled = await t.client.post(`/payments/intents/${link.body.data.id}/cancel`, {});
    expect(cancelled.body.data.status).toBe('cancelled');
    // Late confirmation after cancel is recorded for reconciliation, not completed.
    await t.client.post(`/payments/gateways/simulate/${link.body.data.id}`, { status: 'succeeded' });
    const rec = await t.client.get('/payments/online/reconciliation');
    expect(rec.body.data.lateConfirmations.some((i: any) => i.id === link.body.data.id)).toBe(true);
  });
});

describe('gateway webhooks (Paystack, stubbed provider API)', () => {
  let cfgId: string;
  beforeAll(async () => {
    const r = await t.client.post('/settings/integrations', { kind: 'payment', provider: 'paystack', name: 'Paystack KE', settings: { customerEmail: 'pay@shop.co.ke' }, secrets: { secretKey: 'sk_test_hook' } });
    cfgId = r.body.data.id;
  });
  const signed = (body: object, key = 'sk_test_hook') => ctx.api.post(`${hookBase}/${cfgId}`).set('Host', BASE).set('Content-Type', 'application/json').set('x-paystack-signature', createHmac('sha512', key).update(JSON.stringify(body)).digest('hex')).send(JSON.stringify(body));

  it('confirms only after the verify API agrees, and ignores forged webhooks', async () => {
    let verifyAmount = 45000;
    stubFetch((c) => {
      if (c.url.endsWith('/charge')) return { body: { status: true, data: { reference: c.body.reference, status: 'pay_offline' } } };
      if (c.url.includes('/transaction/verify/')) return { body: { status: true, data: { status: 'success', amount: verifyAmount, currency: 'KES', reference: decodeURIComponent(c.url.split('/').pop()!), id: 5 } } };
      return { status: 404, body: {} };
    });
    const r = await t.client.post(`/payments/gateways/${cfgId}/charge`, { clientRequestId: rid(), tillId: till, amountCents: 45000, phone: '0712345678', channel: 'mpesa' });
    expect(r.status).toBe(201);
    const intent = r.body.data;
    const ref = intent.reference;

    // Wrong signature: ignored (still pending), but acknowledged.
    const forged = await signed({ event: 'charge.success', data: { reference: ref } }, 'attacker');
    expect(forged.status).toBe(200);
    expect((await t.client.get(`/payments/intents/${intent.id}`)).body.data.status).toBe('pending');
    // Bad callback token: ignored.
    await ctx.api.post(`${hookBase.replace(/\/[a-f0-9]+\/gw$/, '/deadbeef/gw')}/${cfgId}`).set('Host', BASE).send({ data: { reference: ref } });
    expect((await t.client.get(`/payments/intents/${intent.id}`)).body.data.status).toBe('pending');

    const ok = await signed({ event: 'charge.success', data: { reference: ref, amount: 1 } });
    expect(ok.status).toBe(200);
    const after = (await t.client.get(`/payments/intents/${intent.id}`)).body.data;
    expect(after.status).toBe('succeeded');
    expect(after.paidAmountCents).toBe(45000);
    expect(calls.some((c) => c.url.endsWith(`/transaction/verify/${ref}`))).toBe(true);

    // A second intent where the provider reports a different amount is failed, whatever the webhook says.
    const r2 = await t.client.post(`/payments/gateways/${cfgId}/charge`, { clientRequestId: rid(), tillId: till, amountCents: 45000, phone: '0712345678', channel: 'mpesa' });
    verifyAmount = 100;
    await signed({ event: 'charge.success', data: { reference: r2.body.data.reference, amount: 45000 } });
    expect((await t.client.get(`/payments/intents/${r2.body.data.id}`)).body.data.status).toBe('failed');
    const events = await t.client.get('/payments/online/events');
    expect(events.body.data.some((e: any) => e.outcome === 'bad_signature')).toBe(true);
  });

  it('requires a network for providers with channel lists', async () => {
    const r = await t.client.post(`/payments/gateways/${cfgId}/charge`, { clientRequestId: rid(), tillId: till, amountCents: 1000, phone: '0712345678' });
    expect(r.status).toBe(400);
  });
});
