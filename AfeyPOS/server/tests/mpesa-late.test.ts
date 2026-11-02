import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, createProduct, openShift, rid, BASE, type Ctx } from './helpers.js';
import { buildStkCallback } from '../src/modules/payments/mpesa.js';
import { MockMpesaGateway } from '../src/integrations/mpesa/daraja.js';
import { Job, PaymentIntent, Tenant } from '../src/models/index.js';
import { runAsPlatform } from '../src/lib/context.js';
import { drainJobs } from '../src/jobs/queue.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
let till: string;
let wh: string;
let callbackBase: string;

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'latepay', 'minimart');
  till = t.locations.tills[0]._id;
  wh = t.locations.warehouses[0]._id;
  await t.client.post('/settings/integrations', { kind: 'mpesa', provider: 'mock', name: 'Till sim', settings: { shortCode: '174379', type: 'paybill' }, secrets: { consumerKey: 'k', consumerSecret: 's', passkey: 'p' } });
  const tenant = await runAsPlatform(() => Tenant.findOne().lean());
  callbackBase = `/api/v1/hooks/pay/${tenant!._id}/${tenant!.callbackToken}`;
  await openShift(t.client, till);
});
afterAll(teardown);

const callback = (payload: object) => ctx.api.post(`${callbackBase}/stk`).set('Host', BASE).send(payload);
const stk = async (amountCents: number) => (await t.client.post('/payments/mpesa/stk', { clientRequestId: rid(), amountCents, phone: '0712345678', tillId: till })).body.data;
const expire = async () => { await runAsPlatform(() => Job.updateMany({ type: 'mpesa.checkIntent' }, { $set: { runAt: new Date(0) } })); await drainJobs(); };

describe('money that arrives after a prompt was marked failed', () => {
  it('a late confirmation makes the payment usable on a sale, once', async () => {
    const p = await createProduct(t.client, { name: 'Bread', sku: 'BRD', prices: { retail: 6000 }, openingStock: [{ warehouseId: wh, qty: 10 }] });
    const i = await stk(6000);
    await expire();
    expect((await t.client.get(`/payments/intents/${i.id}`)).body.data.status).toBe('expired');
    // The customer's PIN went through late: Safaricom confirms after the till gave up.
    await callback(buildStkCallback(i.checkoutRequestId, 'm', 0, 60, '254712345678', 'LATE7777A1'));
    const after = (await t.client.get(`/payments/intents/${i.id}`)).body.data;
    expect(after).toMatchObject({ status: 'succeeded', receiptNumber: 'LATE7777A1', paidAmountCents: 6000 });
    // The cashier types the code from the customer's message and completes a sale with it.
    const look = await t.client.post('/payments/mpesa/lookup', { receipt: 'LATE7777A1', tillId: till, clientRequestId: rid() });
    expect(look.body.found).toBe(true);
    const sale = await t.client.post('/sales', { clientRequestId: rid(), tillId: till, lines: [{ productId: p._id, qty: 1 }], payments: [{ method: 'mpesa', amountCents: 6000, paymentIntentId: i.id }] });
    expect(sale.status).toBe(201);
    // Used once only.
    const again = await t.client.post('/payments/mpesa/lookup', { receipt: 'LATE7777A1', tillId: till, clientRequestId: rid() });
    expect(again.body.error.code).toBe('MPESA_ALREADY_USED');
  });

  it('an older record stuck as failed with its receipt is fixed when the code is typed', async () => {
    const i = await stk(5000);
    await expire();
    // How older versions left it: receipt saved, still marked expired.
    await runAsPlatform(() => PaymentIntent.updateOne({ _id: i.id }, { $set: { receiptNumber: 'OLDSTUCK01', paidAmountCents: 5000, resultDesc: 'Late confirmation after expired' } }));
    const look = await t.client.post('/payments/mpesa/lookup', { receipt: 'OLDSTUCK01', tillId: till, clientRequestId: rid() });
    expect(look.body.found).toBe(true);
    expect(look.body.data.status).toBe('succeeded');
  });

  it('"Check again" asks Safaricom and only frees the payment if it was paid', async () => {
    const paid = await stk(4000);
    await expire();
    MockMpesaGateway.queryResults.set(paid.checkoutRequestId, { ResponseCode: '0', ResultCode: '0', ResultDesc: 'The service request is processed successfully.' });
    const ok = await t.client.post(`/payments/intents/${paid.id}/recheck`, {});
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'succeeded', paidAmountCents: 4000 });

    const unpaid = await stk(3000);
    await expire();
    MockMpesaGateway.queryResults.set(unpaid.checkoutRequestId, { ResponseCode: '0', ResultCode: '1032', ResultDesc: 'Request cancelled by user' });
    const no = await t.client.post(`/payments/intents/${unpaid.id}/recheck`, {});
    expect(no.body.error.code).toBe('MPESA_NOT_PAID');
    expect((await t.client.get(`/payments/intents/${unpaid.id}`)).body.data.status).toBe('expired');
    // A successful one cannot be rechecked.
    expect((await t.client.post(`/payments/intents/${paid.id}/recheck`, {})).status).toBe(422);
  });
});
