import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, createProduct, openShift, rid, BASE, type Ctx } from './helpers.js';
import { buildStkCallback } from '../src/modules/payments/mpesa.js';
import { MockMpesaGateway, darajaTimestamp, stkPassword, parseStkCallback, parseDarajaDate } from '../src/integrations/mpesa/daraja.js';
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
