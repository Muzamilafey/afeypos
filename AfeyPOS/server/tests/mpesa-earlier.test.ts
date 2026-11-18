import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { setupApp, teardown, registerTenant, openShift, rid, type Ctx } from './helpers.js';
import { handleC2B } from '../src/modules/payments/mpesa.js';
import { PaymentIntent } from '../src/models/index.js';
import { runInTenant } from '../src/lib/context.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
let till: string;
let n = 0;
const pay = (amount: number, minutesAgo = 0) => {
  const receipt = `EARLY${String(++n).padStart(5, '0')}`;
  return handleC2B(new Types.ObjectId(t.tenant.id), { TransID: receipt, TransAmount: amount.toFixed(2), BusinessShortCode: '5544330', BillRefNumber: '', MSISDN: '254712345678', FirstName: 'Wanjiku', TransTime: '20261102120000' }, '127.0.0.1')
    .then(async () => {
      if (minutesAgo) await runInTenant(t.tenant.id, () => PaymentIntent.updateOne({ receiptNumber: receipt }, { $set: { completedAt: new Date(Date.now() - minutesAgo * 60_000) } }));
      return receipt;
    });
};
const wait = (amountCents: number) => t.client.post('/payments/mpesa/expect', { clientRequestId: rid(), amountCents, tillId: till });

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'early', 'supermarket');
  till = t.locations.tills[0]._id;
  await openShift(t.client, till);
  await t.client.post('/settings/integrations', { kind: 'mpesa', provider: 'mock', name: 'Till', settings: { type: 'till', shortCode: '174379', tillNumber: '5544330' } });
});
afterAll(teardown);

describe('the customer paid the Till before the cashier chose M-Pesa', () => {
  it('a payment of exactly this amount in the last 3 minutes is picked up at once', async () => {
    const receipt = await pay(150, 1);
    const r = await wait(15000);
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ status: 'succeeded', receiptNumber: receipt, paidAmountCents: 15000, payerName: 'Wanjiku' });
    // It counts once: the stand-alone record gave its receipt to the till's payment.
    expect((await t.client.get(`/payments/intents?q=${receipt}`)).body.data.map((i: any) => i.id)).toEqual([r.body.data.id]);
  });

  it('older than 3 minutes, or two payments of the same amount: not guessed, the till keeps waiting', async () => {
    await pay(220, 4);
    expect((await wait(22000)).body.data.status).toBe('pending');
    await pay(330, 1);
    await pay(330, 2);
    expect((await wait(33000)).body.data.status).toBe('pending');
  });

  it('"Not this payment": it goes back unused, the next wait skips it, and another payment is still found', async () => {
    const wrong = await pay(440, 1);
    const first = await wait(44000);
    expect(first.body.data).toMatchObject({ status: 'succeeded', receiptNumber: wrong });
    const r = await t.client.post(`/payments/intents/${first.body.data.id}/not-mine`, {});
    expect(r.body.data).toMatchObject({ released: true, receipt: wrong });
    // Back as an unused payment with its receipt (for the right sale, or to be found by its code).
    const back = (await t.client.get(`/payments/intents?q=${wrong}`)).body.data;
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ status: 'succeeded', allocatedCents: 0, receiptNumber: wrong });
    // Waiting again, skipping it: not offered again.
    const again = await t.client.post('/payments/mpesa/expect', { clientRequestId: rid(), amountCents: 44000, tillId: till, skipReceipts: [wrong] });
    expect(again.body.data.status).toBe('pending');
    // The customer's own payment arrives: matched to the wait.
    const right = await pay(440);
    expect((await t.client.get(`/payments/intents/${again.body.data.id}`)).body.data).toMatchObject({ status: 'succeeded', receiptNumber: right });
    // A payment already used on a sale cannot be put back.
    expect((await t.client.post(`/payments/intents/${back[0].id}/not-mine`, {})).status).toBe(404);
  });
});
