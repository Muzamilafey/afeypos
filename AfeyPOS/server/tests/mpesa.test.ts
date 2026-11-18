import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupApp, teardown, registerTenant, createProduct, openShift, rid, BASE, Client, type Ctx } from './helpers.js';
import { buildStkCallback, callbackUrlProblems, startStk, urlToken } from '../src/modules/payments/mpesa.js';
import { resetEnv } from '../src/config/env.js';
import { runInTenant } from '../src/lib/context.js';
import { DarajaClient, MockMpesaGateway, explainC2BError, darajaTimestamp, stkPassword, parseStkCallback, parseDarajaDate } from '../src/integrations/mpesa/daraja.js';
import { Tenant } from '../src/models/index.js';
import { runAsPlatform } from '../src/lib/context.js';
import { drainJobs } from '../src/jobs/queue.js';
import { Job } from '../src/models/index.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
let till: string;
let wh: string;
let callbackBase: string;

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'paysafe', 'minimart');
  till = t.locations.tills[0]._id;
  wh = t.locations.warehouses[0]._id;
  const cfg = await t.client.post('/settings/integrations', { kind: 'mpesa', provider: 'mock', name: 'Till sim', settings: { shortCode: '174379', type: 'paybill' }, secrets: { consumerKey: 'k', consumerSecret: 's', passkey: 'p' } });
  expect(cfg.status).toBe(201);
  expect(cfg.body.data.secretsSet).toEqual(['consumerKey', 'consumerSecret', 'passkey']);
  expect(JSON.stringify(cfg.body)).not.toContain('"s"');
  const tenant = await runAsPlatform(() => Tenant.findOne().lean());
  callbackBase = `/api/v1/hooks/pay/${tenant!._id}/${tenant!.callbackToken}`;
  await openShift(t.client, till);
});
afterAll(teardown);

const callback = (payload: object, path = callbackBase) => ctx.api.post(`${path}/stk`).set('Host', BASE).send(payload);

async function stk(amountCents: number) {
  const r = await t.client.post('/payments/mpesa/stk', { clientRequestId: rid(), amountCents, phone: '0712345678', tillId: till });
  expect(r.status).toBe(201);
  return r.body.data;
}

describe('Daraja helpers', () => {
  it('builds the STK password and EAT timestamp', () => {
    const ts = darajaTimestamp(new Date('2026-01-01T00:00:00Z'));
    expect(ts).toBe('20260101030000');
    expect(stkPassword('174379', 'pk', ts)).toBe(Buffer.from('174379pk20260101030000').toString('base64'));
    expect(parseDarajaDate('20260101030000')!.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    const parsed = parseStkCallback(buildStkCallback('ws_1', 'm1', 0, 150, '254712345678', 'RCP123'));
    expect(parsed).toMatchObject({ checkoutRequestId: 'ws_1', resultCode: 0, amount: 150, receiptNumber: 'RCP123' });
  });
});

describe('STK push lifecycle', () => {
  it('validates amounts and phone numbers', async () => {
    expect((await t.client.post('/payments/mpesa/stk', { clientRequestId: rid(), amountCents: 1050, phone: '0712345678' })).status).toBe(400);
    expect((await t.client.post('/payments/mpesa/stk', { clientRequestId: rid(), amountCents: 1000, phone: '12345' })).status).toBe(400);
  });

  it('a pending STK request cannot pay for a sale; a confirmed one can, once', async () => {
    const p = await createProduct(t.client, { prices: { retail: 15000 }, openingStock: [{ warehouseId: wh, qty: 10 }] });
    const intent = await stk(15000);
    expect(intent.status).toBe('pending');
    expect(MockMpesaGateway.pushes.at(-1)!.callbackUrl).toContain('/stk');
    const sale = { tillId: till, lines: [{ productId: p._id, qty: 1 }], payments: [{ method: 'mpesa', amountCents: 15000, paymentIntentId: intent.id }] };
    const early = await t.client.post('/sales', { clientRequestId: rid(), ...sale });
    expect(early.body.error.code).toBe('MPESA_NOT_AVAILABLE');
    const cb = await callback(buildStkCallback(intent.checkoutRequestId, 'm', 0, 150, '254712345678', 'QWE123RTY'));
    expect(cb.body.ResultCode).toBe(0);
    const after = (await t.client.get(`/payments/intents/${intent.id}`)).body.data;
    expect(after.status).toBe('succeeded');
    expect(after.receiptNumber).toBe('QWE123RTY');
    const ok = await t.client.post('/sales', { clientRequestId: rid(), ...sale });
    expect(ok.status).toBe(201);
    expect(ok.body.data.payments[0].reference).toBe('QWE123RTY');
    const twice = await t.client.post('/sales', { clientRequestId: rid(), ...sale });
    expect(twice.body.error.code).toBe('MPESA_NOT_AVAILABLE');
  });

  it('processes duplicate callbacks idempotently and rejects receipt reuse', async () => {
    const i1 = await stk(1000);
    const payload = buildStkCallback(i1.checkoutRequestId, 'm', 0, 10, '254712345678', 'DUP0001');
    await callback(payload);
    await callback(payload);
    await callback(payload);
    const events = (await t.client.get('/payments/mpesa/events')).body.data.filter((e: any) => e.payload?.Body?.stkCallback?.CheckoutRequestID === i1.checkoutRequestId);
    expect(events.map((e: any) => e.outcome).sort()).toEqual(['duplicate', 'duplicate', 'succeeded']);
    // A different intent claiming the same receipt is not double-counted.
    const i2 = await stk(1000);
    await callback(buildStkCallback(i2.checkoutRequestId, 'm', 0, 10, '254712345678', 'DUP0001'));
    expect((await t.client.get(`/payments/intents/${i2.id}`)).body.data.status).toBe('failed');
  });

  it('fails on amount mismatch and maps cancellation result codes', async () => {
    const i = await stk(5000);
    await callback(buildStkCallback(i.checkoutRequestId, 'm', 0, 1, '254712345678', 'LOW0001'));
    expect((await t.client.get(`/payments/intents/${i.id}`)).body.data.status).toBe('failed');
    const c = await stk(5000);
    await callback(buildStkCallback(c.checkoutRequestId, 'm', 1032, 0, '254712345678'));
    expect((await t.client.get(`/payments/intents/${c.id}`)).body.data.status).toBe('cancelled');
  });

  it('ignores callbacks with a wrong secret or an unknown business id', async () => {
    const i = await stk(2000);
    const bad = await callback(buildStkCallback(i.checkoutRequestId, 'm', 0, 20, '254712345678', 'FAKE001'), callbackBase.replace(/[^/]+$/, 'wrongtoken'));
    expect(bad.body.ResultCode).toBe(0);
    expect((await t.client.get(`/payments/intents/${i.id}`)).body.data.status).toBe('pending');
    const tenant = await runAsPlatform(() => Tenant.findOne().lean());
    await callback(buildStkCallback(i.checkoutRequestId, 'm', 0, 20, '254712345678', 'FAKE002'), `/api/v1/hooks/pay/${'0'.repeat(24)}/${tenant!.callbackToken}`);
    expect((await t.client.get(`/payments/intents/${i.id}`)).body.data.status).toBe('pending');
  });

  it('expires pending intents through the status-check job when no callback arrives', async () => {
    const i = await stk(3000);
    await runAsPlatform(() => Job.updateMany({ type: 'mpesa.checkIntent' }, { $set: { runAt: new Date(0) } }));
    await drainJobs();
    expect((await t.client.get(`/payments/intents/${i.id}`)).body.data.status).toBe('expired');
  });

  it('confirms through the status query when the callback is lost', async () => {
    const i = await stk(4000);
    MockMpesaGateway.queryResults.set(i.checkoutRequestId, { ResponseCode: '0', ResultCode: '0', ResultDesc: 'The service request is processed successfully.' });
    const q = await t.client.post(`/payments/intents/${i.id}/query`);
    expect(q.body.data.status).toBe('succeeded');
    // The late callback fills in the receipt number without double-counting.
    await callback(buildStkCallback(i.checkoutRequestId, 'm', 0, 40, '254712345678', 'LATE001'));
    const after = (await t.client.get(`/payments/intents/${i.id}`)).body.data;
    expect(after.receiptNumber).toBe('LATE001');
    expect(after.paidAmountCents).toBe(4000);
  });
});

describe('C2B', () => {
  it('records paybill/till payments once and lets cashiers allocate them', async () => {
    const payload = { TransactionType: 'Pay Bill', TransID: 'C2B0000001', TransTime: '20261022101500', TransAmount: '250.00', BusinessShortCode: '174379', BillRefNumber: 'INV1', MSISDN: '254712345678', FirstName: 'Jane' };
    const r1 = await ctx.api.post(`${callbackBase}/c2b/confirmation`).set('Host', BASE).send(payload);
    expect(r1.body.ResultCode).toBe(0);
    await ctx.api.post(`${callbackBase}/c2b/confirmation`).set('Host', BASE).send(payload);
    const list = (await t.client.get('/payments/intents?source=c2b&unallocated=true')).body.data;
    expect(list).toHaveLength(1);
    expect(list[0].paidAmountCents).toBe(25000);
    const p = await createProduct(t.client, { prices: { retail: 25000 }, openingStock: [{ warehouseId: wh, qty: 2 }] });
    const sale = await t.client.post('/sales', { clientRequestId: rid(), tillId: till, lines: [{ productId: p._id, qty: 1 }], payments: [{ method: 'mpesa', amountCents: 25000, paymentIntentId: list[0].id }] });
    expect(sale.status).toBe(201);
    expect((await t.client.get('/payments/intents?source=c2b&unallocated=true')).body.data).toHaveLength(0);
    const rec = await t.client.get('/payments/mpesa/reconciliation');
    expect(rec.status).toBe(200);
  });
});

describe('customer pays the Paybill/Till directly (offline payment)', () => {
  const sale = (p: any, amountCents: number, intentId: string) => t.client.post('/sales', { clientRequestId: rid(), tillId: till, lines: [{ productId: p._id, qty: 1 }], payments: [{ method: 'mpesa', amountCents, paymentIntentId: intentId }] });

  it('Paybill: gives an account number for the sale and matches the payment to it', async () => {
    const p = await createProduct(t.client, { prices: { retail: 32000 }, openingStock: [{ warehouseId: wh, qty: 5 }] });
    const ex = await t.client.post('/payments/mpesa/expect', { clientRequestId: rid(), amountCents: 32000, tillId: till });
    expect(ex.status).toBe(201);
    expect(ex.body.data.payTo).toEqual({ type: 'paybill', number: '174379' });
    expect(ex.body.data.accountReference).toMatch(/^T1\d{4}$/);
    expect((await sale(p, 32000, ex.body.data.id)).body.error.code).toBe('MPESA_NOT_AVAILABLE');
    // Another customer's payment to the same paybill with a different account is not matched to this sale.
    await t.client.post('/payments/mpesa/simulate-c2b', { amountCents: 32000, account: 'SOMEONE', tillId: till });
    expect((await t.client.get(`/payments/intents/${ex.body.data.id}`)).body.data.status).toBe('pending');
    const paid = await t.client.post('/payments/mpesa/simulate-c2b', { amountCents: 32000, account: ex.body.data.accountReference.toLowerCase(), tillId: till, receipt: 'PBL1234567' });
    expect(paid.status).toBe(200);
    const done = (await t.client.get(`/payments/intents/${ex.body.data.id}`)).body.data;
    expect(done).toMatchObject({ status: 'succeeded', receiptNumber: 'PBL1234567', paidAmountCents: 32000 });
    expect((await sale(p, 32000, ex.body.data.id)).status).toBe(201);
  });

  it('Buy Goods: matches by amount only when exactly one sale is waiting for it', async () => {
    const cfgs = (await t.client.get('/settings/integrations')).body.data.filter((c: any) => c.kind === 'mpesa');
    expect((await t.client.patch(`/settings/integrations/${cfgs[0].id}`, { settings: { shortCode: '174379', type: 'till', tillNumber: '5551234' } })).status).toBe(200);
    const one = await t.client.post('/payments/mpesa/expect', { clientRequestId: rid(), amountCents: 15000, tillId: till });
    expect(one.body.data.payTo).toEqual({ type: 'till', number: '5551234' });
    expect(one.body.data.accountReference).toBeUndefined();
    await t.client.post('/payments/mpesa/simulate-c2b', { amountCents: 15000, tillId: till, receipt: 'BGD0000001' });
    expect((await t.client.get(`/payments/intents/${one.body.data.id}`)).body.data.status).toBe('succeeded');
    // Two tills waiting for the same amount: ambiguous, so the payment stays unallocated for a cashier to pick.
    const a = await t.client.post('/payments/mpesa/expect', { clientRequestId: rid(), amountCents: 8000, tillId: till });
    const b = await t.client.post('/payments/mpesa/expect', { clientRequestId: rid(), amountCents: 8000, tillId: till });
    await t.client.post('/payments/mpesa/simulate-c2b', { amountCents: 8000, tillId: till, receipt: 'BGD0000002' });
    expect((await t.client.get(`/payments/intents/${a.body.data.id}`)).body.data.status).toBe('pending');
    expect((await t.client.get(`/payments/intents/${b.body.data.id}`)).body.data.status).toBe('pending');
    const open = (await t.client.get('/payments/intents?source=c2b&unallocated=true&provider=mpesa')).body.data;
    expect(open.map((i: any) => i.receiptNumber)).toContain('BGD0000002');
    await t.client.patch(`/settings/integrations/${cfgs[0].id}`, { settings: { shortCode: '174379', type: 'paybill' } });
  });

  it('looks up the code from the customer SMS, or verifies it with Safaricom, and refuses reuse', async () => {
    const found = await t.client.post('/payments/mpesa/lookup', { receipt: 'bgd0000002', clientRequestId: rid(), tillId: till });
    expect(found.body).toMatchObject({ found: true, data: { receiptNumber: 'BGD0000002', paidAmountCents: 8000 } });
    const used = await t.client.post('/payments/mpesa/lookup', { receipt: 'PBL1234567', clientRequestId: rid(), tillId: till });
    expect(used.body.error.code).toBe('MPESA_ALREADY_USED');
    expect((await t.client.post('/payments/mpesa/lookup', { receipt: 'no', clientRequestId: rid() })).status).toBe(400);
    // Not in the system yet (C2B URL not registered, or the callback was lost): ask Safaricom.
    const v = await t.client.post('/payments/mpesa/lookup', { receipt: 'SJK3AB12CD', clientRequestId: rid(), tillId: till });
    expect(v.status).toBe(202);
    expect(v.body.verifying).toBe(true);
    expect(MockMpesaGateway.statusQueries.at(-1)!.transactionId).toBe('SJK3AB12CD');
    const ok = await t.client.post(`/payments/mpesa/simulate-status/${v.body.data.id}`, { amountCents: 45000 });
    expect(ok.body.data).toMatchObject({ status: 'succeeded', receiptNumber: 'SJK3AB12CD', paidAmountCents: 45000, payerName: 'SIMULATED CUSTOMER' });
    // A second check of a code Safaricom does not confirm fails cleanly.
    const bad = await t.client.post('/payments/mpesa/lookup', { receipt: 'ZZZ0000000', clientRequestId: rid(), tillId: till });
    expect((await t.client.post(`/payments/mpesa/simulate-status/${bad.body.data.id}`, { amountCents: 100, completed: false })).body.data.status).toBe('failed');
  });
});

describe('M-Pesa B2C payouts (salaries, refunds)', () => {
  it('needs a second person to approve, sends once, and is paid only on Safaricom’s result', async () => {
    const created = await t.client.post('/payments/payouts', { payouts: [{ purpose: 'salary', amountCents: 2500000, phone: '0712345678', payeeName: 'Jane Wanjiku', ref: { type: 'PayrollRun', number: 'PR-2026-10' } }] });
    expect(created.status).toBe(201);
    const id = created.body.data[0]._id;
    // A manager trusted with payouts still needs someone else to approve their own request...
    await t.client.post('/settings/users', { name: 'Mo Manager', email: 'mo@paysafe.test', password: 'MoManager123', roles: ['branch_manager'], extraPermissions: ['payouts.request', 'payouts.approve'] });
    const mo = new Client(ctx.api, 'paysafe');
    await mo.login('mo@paysafe.test', 'MoManager123');
    const own = (await mo.post('/payments/payouts', { payouts: [{ purpose: 'refund', amountCents: 50000, phone: '0712345678' }] })).body.data[0]._id;
    expect((await mo.post('/payments/payouts/approve', { ids: [own] })).status).toBe(403);
    expect((await t.client.post('/payments/payouts/approve', { ids: [own] })).body.data.approved).toBe(1);
    // ...while the owner (or a business administrator) may approve what they requested themselves.
    const mine = (await t.client.post('/payments/payouts', { payouts: [{ purpose: 'refund', amountCents: 10000, phone: '0712345678' }] })).body.data[0]._id;
    expect((await t.client.post('/payments/payouts/approve', { ids: [mine] })).body.data.approved).toBe(1);
    await t.client.post('/settings/users', { name: 'Fiona Finance', email: 'fiona@paysafe.test', password: 'Fiona12345', roles: ['business_admin'] });
    const fiona = new Client(ctx.api, 'paysafe');
    await fiona.login('fiona@paysafe.test', 'Fiona12345');
    expect((await fiona.post('/payments/payouts/send', { ids: [id] })).body.data[0].status).toBe('skipped');
    expect((await fiona.post('/payments/payouts/approve', { ids: [id] })).body.data.approved).toBe(1);
    const sent = await fiona.post('/payments/payouts/send', { ids: [id] });
    expect(sent.body.data[0].status).toBe('sent');
    expect(MockMpesaGateway.payouts.at(-1)).toMatchObject({ amount: 25000, phone: '254712345678', commandId: 'SalaryPayment' });
    expect((await fiona.post('/payments/payouts/send', { ids: [id] })).body.data[0].status).toBe('skipped');
    const done = await fiona.post(`/payments/payouts/${id}/simulate`, {});
    expect(done.body.data).toMatchObject({ status: 'succeeded', receiverName: 'Jane Wanjiku' });
    expect(done.body.data.receiptNumber).toBeTruthy();
  });
});

describe('C2B URL registration', () => {
  it('spots URLs Safaricom would refuse', () => {
    expect(callbackUrlProblems('https://hq.myshop.co.ke/api/v1/hooks/pay/a/b/c2b/confirmation', 'production')).toEqual([]);
    expect(callbackUrlProblems('http://localhost:4000/x', 'sandbox').join(' ')).toMatch(/private address/);
    expect(callbackUrlProblems('http://192.168.1.5:4000/x', 'production').join(' ')).toMatch(/HTTPS/);
    expect(callbackUrlProblems('https://mpesa-shop.co.ke/x', 'production').join(' ')).toMatch(/"mpesa"/);
    // A random token that happens to spell a refused word is sent hex-encoded instead.
    expect(urlToken('abcSqLxyz')).toMatch(/^h[0-9a-f]+$/);
    expect(urlToken('abcdef')).toBe('abcdef');
  });

  it('explains Daraja errors in plain language', () => {
    expect(explainC2BError({ body: { errorCode: '500.003.1001', errorMessage: 'Urls are already registered' } }, 'production')).toMatch(/only be registered once/);
    expect(explainC2BError({ status: 401, body: { errorMessage: 'Invalid Access Token' } }, 'sandbox')).toMatch(/consumer key/);
    expect(explainC2BError({ body: { errorMessage: 'Invalid ShortCode' } }, 'sandbox')).toMatch(/store \(head office\) number/);
  });

  it('registers with the configured short code and records the result', async () => {
    const cfg = (await t.client.get('/settings/integrations')).body.data.find((c: any) => c.name === 'Till sim');
    const plan = await t.client.get(`/settings/integrations/${cfg.id}/register-c2b`);
    expect(plan.body.data).toMatchObject({ shortCode: '174379', blocking: [] });
    const r = await t.client.post(`/settings/integrations/${cfg.id}/register-c2b`, {});
    expect(r.status).toBe(200);
    expect(MockMpesaGateway.registrations.at(-1)).toMatchObject({ shortCode: '174379', confirmationUrl: expect.stringMatching(/\/c2b\/confirmation$/), validationUrl: expect.stringMatching(/\/c2b\/validation$/) });
    expect(MockMpesaGateway.registrations.at(-1)!.confirmationUrl).not.toMatch(/m-?pesa|safaricom/i);
    const saved = (await t.client.get('/settings/integrations')).body.data.find((c: any) => c.id === cfg.id);
    expect(saved.c2bRegistration).toMatchObject({ ok: true, shortCode: '174379' });
    expect(saved.c2bRegistration.lastConfirmationAt).toBeUndefined();

    // A test payment proves the URLs end to end.
    const test = await t.client.post(`/settings/integrations/${cfg.id}/test-c2b`, { amount: 1 });
    expect(test.status).toBe(200);
    const after = (await t.client.get('/settings/integrations')).body.data.find((c: any) => c.id === cfg.id);
    expect(after.c2bRegistration.lastConfirmationAt).toBeTruthy();
  });

  it('refuses to register private addresses with Safaricom, and reports Daraja refusals', async () => {
    const cfg = await t.client.post('/settings/integrations', { kind: 'mpesa', provider: 'daraja', name: 'Sandbox till', environment: 'sandbox', settings: { shortCode: '600999', type: 'paybill' }, secrets: { consumerKey: 'k2', consumerSecret: 's2', passkey: 'p2' } });
    expect(cfg.status).toBe(201);
    const r = await t.client.post(`/settings/integrations/${cfg.body.data.id}/register-c2b`, {});
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('C2B_URL_INVALID');
    expect(r.body.error.message).toMatch(/API_PUBLIC_URL/);

    // The client itself: an error answer from Safaricom is an error, even with HTTP 200.
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) =>
      String(url).includes('oauth') ? new Response(JSON.stringify({ access_token: 'tok', expires_in: '3599' })) : new Response(JSON.stringify({ errorCode: '500.003.1001', errorMessage: 'Urls are already registered' }), { status: 500 }));
    try {
      const client = new DarajaClient({ environment: 'production', consumerKey: 'ck-c2b', consumerSecret: 'cs', passkey: 'p', shortCode: '123456', type: 'paybill' });
      const err = await client.registerC2BUrls('https://hq.example.co.ke/c', 'https://hq.example.co.ke/v', '123456').catch((e) => e);
      expect(explainC2BError(err, 'production')).toMatch(/only be registered once/);
      const body = JSON.parse((fetchMock.mock.calls.at(-1)![1] as any).body);
      expect(body).toEqual({ ShortCode: '123456', ResponseType: 'Completed', ConfirmationURL: 'https://hq.example.co.ke/c', ValidationURL: 'https://hq.example.co.ke/v' });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('an STK prompt Safaricom refuses says why (not "could not reach M-Pesa")', async () => {
    const cfg = (await t.client.post('/settings/integrations', { kind: 'mpesa', provider: 'daraja', name: 'Live till', environment: 'production', settings: { shortCode: '174379', type: 'till', tillNumber: '3163960' }, secrets: { consumerKey: 'k3', consumerSecret: 's3', passkey: 'p3' } })).body.data;
    const tenant = await runAsPlatform(() => Tenant.findById(t.tenant.id).lean());
    const start = () => runInTenant(tenant!._id, () => startStk({ tenant, clientRequestId: rid(), amountCents: 100, phone: '0712345678', configId: cfg.id }));
    // A private / http callback address can never work with Safaricom.
    expect(await start().catch((e) => e.code)).toBe('MPESA_CALLBACK_NOT_PUBLIC');
    const before = process.env.API_PUBLIC_URL;
    process.env.API_PUBLIC_URL = 'https://hq.example.co.ke';
    resetEnv();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) =>
      String(url).includes('oauth') ? new Response(JSON.stringify({ access_token: 'tok', expires_in: '3599' })) : new Response(JSON.stringify({ requestId: 'x', errorCode: '400.002.02', errorMessage: 'Bad Request - Invalid BusinessShortCode' }), { status: 400 }));
    try {
      const err = await start().catch((e) => e);
      expect(err.code).toBe('MPESA_REJECTED');
      expect(err.message).toMatch(/Invalid BusinessShortCode/);
      expect(err.message).toMatch(/store \(head office\) number/);
      // Buy Goods: CustomerBuyGoodsOnline to the till number.
      const body = JSON.parse((fetchMock.mock.calls.at(-1)![1] as any).body);
      expect(body).toMatchObject({ TransactionType: 'CustomerBuyGoodsOnline', BusinessShortCode: '174379', PartyB: '3163960', CallBackURL: expect.stringMatching(/^https:\/\/hq\.example\.co\.ke\//) });
    } finally {
      fetchMock.mockRestore();
      if (before === undefined) delete process.env.API_PUBLIC_URL;
      else process.env.API_PUBLIC_URL = before;
      resetEnv();
    }
  });
});

describe('M-Pesa per branch and per till', () => {
  it('a till uses its own M-Pesa, else its branch’s (all its tills), else the one for all branches', async () => {
    expect((await t.client.put('/settings/modules', { enabled: ['multiTill', 'multiBranch'] })).status).toBe(200);
    const mainBranch = t.locations.branches[0]._id;
    const counter2 = (await t.client.post('/settings/tills', { branchId: mainBranch, warehouseId: wh, name: 'Counter 2', code: 'C2' })).body.data._id;
    const b = (await t.client.post('/settings/branches', { name: 'Garissa Road', code: 'GRS' })).body.data;
    const grsTill = (await t.client.post('/settings/tills', { branchId: b.branch._id, warehouseId: b.warehouse._id, name: 'GRS till', code: 'GRS1' })).body.data._id;
    const secrets = { consumerKey: 'k', consumerSecret: 's', passkey: 'p' };
    const forBranch = await t.client.post('/settings/integrations', { kind: 'mpesa', provider: 'mock', name: 'Garissa Road M-Pesa', branchIds: [b.branch._id], settings: { shortCode: '174379', type: 'till', tillNumber: '7770001' }, secrets });
    expect(forBranch.status).toBe(201);
    const forTill = await t.client.post('/settings/integrations', { kind: 'mpesa', provider: 'mock', name: 'Counter 2 M-Pesa', tillIds: [counter2], settings: { shortCode: '174379', type: 'till', tillNumber: '7770002' }, secrets });
    expect(forTill.status).toBe(201);
    // A till-only config also lists the till's branch (so a branch server receives it by sync).
    expect(forTill.body.data.branchIds).toEqual([mainBranch]);
    const payTo = async (tillId: string) => (await t.client.post('/payments/mpesa/expect', { clientRequestId: rid(), amountCents: 1000, tillId })).body.data.payTo;
    expect(await payTo(counter2)).toEqual({ type: 'till', number: '7770002' });
    expect(await payTo(grsTill)).toEqual({ type: 'till', number: '7770001' });
    expect((await payTo(till)).number).not.toMatch(/^777000/); // the business-wide M-Pesa
    // Without its own and without a business-wide M-Pesa, a branch never borrows another branch's.
    const all = (await t.client.get('/settings/integrations')).body.data.filter((c: any) => c.kind === 'mpesa' && !c.branchIds.length && !c.tillIds.length);
    for (const c of all) await t.client.patch(`/settings/integrations/${c.id}`, { branchIds: [mainBranch] });
    const b2 = (await t.client.post('/settings/branches', { name: 'Eastleigh', code: 'EST' })).body.data;
    const estTill = (await t.client.post('/settings/tills', { branchId: b2.branch._id, warehouseId: b2.warehouse._id, name: 'EST till', code: 'EST1' })).body.data._id;
    const none = await t.client.post('/payments/mpesa/expect', { clientRequestId: rid(), amountCents: 1000, tillId: estTill });
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe('MPESA_NOT_CONFIGURED');
    for (const c of all) await t.client.patch(`/settings/integrations/${c.id}`, { branchIds: [] });
  });
});

