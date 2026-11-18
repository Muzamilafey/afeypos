import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { setupApp, teardown, registerTenant, openShift, createProduct, rid, type Ctx } from './helpers.js';
import { buildStkCallback, handleC2B, handleStkCallback } from '../src/modules/payments/mpesa.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
let till: string;
let wh: string;
const tenantId = () => new Types.ObjectId(t.tenant.id);

const addMpesa = (name: string, settings: Record<string, unknown>) =>
  t.client.post('/settings/integrations', { kind: 'mpesa', provider: 'mock', name, settings, secrets: { consumerKey: 'k', consumerSecret: 's', passkey: 'p' } });

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'partspesa', 'supermarket');
  till = t.locations.tills[0]._id;
  wh = t.locations.warehouses[0]._id;
  await openShift(t.client, till);
});
afterAll(teardown);

describe('M-Pesa prompts (STK) and payments to the Till (C2B) set up separately', () => {
  it('a prompt-only and a C2B-only account for one Till are one M-Pesa at the till, and both pay the same sale', async () => {
    const stkOnly = await addMpesa('Till prompts', { type: 'till', shortCode: '1261162', tillNumber: '1731901', c2bEnabled: false });
    const c2bOnly = await addMpesa('Till payments', { type: 'till', shortCode: '1261162', tillNumber: '1731901', stkEnabled: false });
    expect([stkOnly.status, c2bOnly.status]).toEqual([201, 201]);

    // The cashier sees one account that can do both.
    const accounts = (await t.client.get(`/payments/mpesa/accounts?tillId=${till}`)).body.data;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ id: c2bOnly.body.data.id, payTo: { type: 'till', number: '1731901' }, stk: true, c2b: true });

    // A prompt with that account goes through the prompt account…
    const prompt = await t.client.post('/payments/mpesa/stk', { clientRequestId: rid(), amountCents: 30000, phone: '0712345678', tillId: till, configId: accounts[0].id });
    expect(prompt.status).toBe(201);
    await handleStkCallback(tenantId(), buildStkCallback(prompt.body.data.checkoutRequestId, 'm', 0, 300, '254712345678', 'STKPART001'), '127.0.0.1');
    // …and waiting for a payment to the Till goes through the C2B account.
    const waiting = await t.client.post('/payments/mpesa/expect', { clientRequestId: rid(), amountCents: 20000, tillId: till, configId: stkOnly.body.data.id });
    expect(waiting.status).toBe(201);
    expect(waiting.body.data.payTo).toEqual({ type: 'till', number: '1731901' });
    await handleC2B(tenantId(), { TransID: 'C2BPART001', TransAmount: '200.00', BusinessShortCode: '1731901', BillRefNumber: '', MSISDN: '254722000111', FirstName: 'Wanjiru', TransTime: '20261101110000' }, '127.0.0.1');
    expect((await t.client.get(`/payments/intents/${waiting.body.data.id}`)).body.data).toMatchObject({ status: 'succeeded', receiptNumber: 'C2BPART001' });

    // One sale paid partly by the prompt and partly to the Till: both count as M-Pesa.
    const p = await createProduct(t.client, { prices: { retail: 50000 }, openingStock: [{ warehouseId: wh, qty: 5 }] });
    const sale = await t.client.post('/sales', {
      clientRequestId: rid(), tillId: till, lines: [{ productId: p._id, qty: 1 }],
      payments: [{ method: 'mpesa', amountCents: 30000, paymentIntentId: prompt.body.data.id }, { method: 'mpesa', amountCents: 20000, paymentIntentId: waiting.body.data.id }],
    });
    expect(sale.status).toBe(201);
    expect(sale.body.data.payments.filter((x: any) => x.method === 'mpesa').reduce((a: number, x: any) => a + x.amountCents, 0)).toBe(50000);
  });

  it('a prompt to a Till is reported twice (C2B first, then the prompt): it counts once and the sale completes', async () => {
    const accounts = (await t.client.get(`/payments/mpesa/accounts?tillId=${till}`)).body.data;
    const prompt = await t.client.post('/payments/mpesa/stk', { clientRequestId: rid(), amountCents: 100, phone: '0726151104', tillId: till, configId: accounts[0].id });
    expect(prompt.status).toBe(201);
    // Safaricom's C2B confirmation for the same payment arrives before the prompt's callback…
    await handleC2B(tenantId(), { TransID: 'UK1DY0CRQ8', TransAmount: '1.00', BusinessShortCode: '1731901', BillRefNumber: '', MSISDN: '254726151104', FirstName: 'MUZAMIL', TransTime: '20261101143200' }, '127.0.0.1');
    // …then the callback with the same receipt: no "Duplicate receipt", the prompt has the payment.
    await handleStkCallback(tenantId(), buildStkCallback(prompt.body.data.checkoutRequestId, 'm', 0, 1, '254726151104', 'UK1DY0CRQ8'), '127.0.0.1');
    const after = (await t.client.get(`/payments/intents/${prompt.body.data.id}`)).body.data;
    expect(after).toMatchObject({ status: 'succeeded', receiptNumber: 'UK1DY0CRQ8', paidAmountCents: 100, payerName: 'MUZAMIL' });
    // The receipt is on one payment only, so it cannot be used twice.
    expect((await t.client.get('/payments/intents?q=UK1DY0CRQ8')).body.data.map((i: any) => i.id)).toEqual([prompt.body.data.id]);
    const p = await createProduct(t.client, { prices: { retail: 100 }, openingStock: [{ warehouseId: wh, qty: 5 }] });
    const sale = await t.client.post('/sales', { clientRequestId: rid(), tillId: till, lines: [{ productId: p._id, qty: 1 }], payments: [{ method: 'mpesa', amountCents: 100, paymentIntentId: prompt.body.data.id }] });
    expect(sale.status).toBe(201);
    const reuse = await t.client.post('/payments/mpesa/lookup', { receipt: 'UK1DY0CRQ8', tillId: till, clientRequestId: rid() });
    expect(reuse.body.error.code).toBe('MPESA_ALREADY_USED');

    // The other order (prompt first, then C2B) is ignored as a repeat, and adds the payer's name.
    const second = await t.client.post('/payments/mpesa/stk', { clientRequestId: rid(), amountCents: 200, phone: '0726151104', tillId: till, configId: accounts[0].id });
    await handleStkCallback(tenantId(), buildStkCallback(second.body.data.checkoutRequestId, 'm', 0, 2, '254726151104', 'UK1DY0CRQ9'), '127.0.0.1');
    await handleC2B(tenantId(), { TransID: 'UK1DY0CRQ9', TransAmount: '2.00', BusinessShortCode: '1731901', BillRefNumber: '', MSISDN: '254726151104', FirstName: 'ASHA', TransTime: '20261101143300' }, '127.0.0.1');
    expect((await t.client.get('/payments/intents?q=UK1DY0CRQ9')).body.data).toHaveLength(1);
  });

  it('with prompts turned off the till says so, and C2B registration uses its own number', async () => {
    const t2 = await addMpesa('Paybill payments only', { type: 'paybill', shortCode: '400500', stkEnabled: false, c2bShortCode: '400501' });
    expect(t2.status).toBe(201);
    const refused = await t.client.post('/payments/mpesa/stk', { clientRequestId: rid(), amountCents: 1000, phone: '0712345678', tillId: till, configId: t2.body.data.id });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('MPESA_STK_OFF');
    const plan = (await t.client.get(`/settings/integrations/${t2.body.data.id}/register-c2b`)).body.data;
    expect(plan.shortCode).toBe('400501');

    // With C2B turned off, URLs cannot be registered and the till cannot wait for a payment with it.
    const noC2b = await addMpesa('Prompts only', { type: 'paybill', shortCode: '400600', c2bEnabled: false });
    const reg = await t.client.post(`/settings/integrations/${noC2b.body.data.id}/register-c2b`, {});
    expect(reg.status).toBe(400);
    expect(reg.body.error.message).toMatch(/Turn on "Customer pays the Paybill\/Till \(C2B\)"/);
    const wait = await t.client.post('/payments/mpesa/expect', { clientRequestId: rid(), amountCents: 1000, tillId: till, configId: noC2b.body.data.id });
    expect(wait.status).toBe(409);
    expect(wait.body.error.code).toBe('MPESA_C2B_OFF');
  });
});
