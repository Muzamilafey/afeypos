import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { setupApp, teardown, registerTenant, createProduct, openShift, rid, type Ctx } from './helpers.js';
import { handleC2B } from '../src/modules/payments/mpesa.js';
import { maskPhone } from '../src/modules/payments/ledgers.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
let till: string;
beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'ledgers', 'supermarket');
  till = t.locations.tills[0]._id;
  await openShift(t.client, till);
  await t.client.post('/settings/integrations', { kind: 'mpesa', provider: 'mock', name: 'Till', settings: { type: 'till', shortCode: '174379', tillNumber: '5544330' } });
});
afterAll(teardown);

describe('M-Pesa logs, M-Pesa payments and cash', () => {
  it('lists every Safaricom message and every successful payment, with phone numbers partly hidden', async () => {
    expect(maskPhone('254712345678')).toBe('0712***678');
    await handleC2B(new Types.ObjectId(t.tenant.id), { TransID: 'LEDG000001', TransAmount: '250.00', BusinessShortCode: '5544330', BillRefNumber: '', MSISDN: '254712345678', FirstName: 'Asha', TransTime: '20261102100000' }, '127.0.0.1');
    const logs = (await t.client.get('/payments/mpesa/logs')).body;
    expect(logs.data[0]).toMatchObject({ kind: 'c2b_confirmation', receipt: 'LEDG000001', amountCents: 25000, phone: '0712***678', payer: 'Asha', outcome: 'recorded' });
    expect(JSON.stringify(logs.data[0].payload)).not.toContain('254712345678');
    const got = (await t.client.get('/payments/mpesa/received?used=unused')).body;
    expect(got.data.map((r: any) => r.receiptNumber)).toContain('LEDG000001');
    expect(got.summary).toMatchObject({ count: 1, totalCents: 25000, usedCents: 0, unusedCents: 25000 });
    expect((await t.client.get('/payments/mpesa/received?q=LEDG000001')).body.data).toHaveLength(1);
  });

  it('lists cash taken on sales (with change) and cash refunded', async () => {
    const p = await createProduct(t.client, { name: 'Bread', sku: 'BRD1', prices: { retail: 6000 }, openingStock: [{ warehouseId: t.locations.warehouses[0]._id, qty: 10 }] });
    const sale = await t.client.post('/sales', { clientRequestId: rid(), tillId: till, lines: [{ productId: p._id, qty: 2 }], payments: [{ method: 'cash', amountCents: 12000, tenderedCents: 20000 }] });
    expect(sale.status).toBe(201);
    const ret = await t.client.post(`/sales/${sale.body.data._id}/returns`, { clientRequestId: rid(), tillId: till, refundMethod: 'cash', reason: 'Stale bread', lines: [{ lineId: sale.body.data.lines[0]._id, qty: 1 }] });
    expect(ret.status).toBe(201);
    const cash = (await t.client.get(`/payments/cash?tillId=${till}`)).body;
    expect(cash.summary).toMatchObject({ sales: 1, refunds: 1, cashInCents: 12000, refundsCents: 6000, netCents: 6000 });
    expect(cash.data.find((r: any) => r.kind === 'sale')).toMatchObject({ number: sale.body.data.number, amountCents: 12000, changeCents: 8000 });
    expect(cash.data.find((r: any) => r.kind === 'refund')).toMatchObject({ amountCents: -6000, tillId: till });
  });
});
