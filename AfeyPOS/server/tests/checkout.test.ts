import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, createProduct, openShift, rid, type Ctx, Client } from './helpers.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
let till: string;
let wh: string;
let cashier: Client;
let shiftId: string;

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'shopco', 'wholesale');
  await t.client.put('/settings/modules', { enabled: ['loyalty'] });
  till = t.locations.tills[0]._id;
  wh = t.locations.warehouses[0]._id;
  await t.client.post('/settings/users', { name: 'Cathy Cashier', email: 'cathy@shopco.test', password: 'Cathy1234', roles: ['cashier'], pin: '1234' });
  await t.client.post('/settings/users', { name: 'Manny Manager', email: 'manny@shopco.test', password: 'Manny1234', roles: ['branch_manager'], pin: '9876' });
  cashier = new Client(ctx.api, 'shopco');
  await cashier.login('cathy@shopco.test', 'Cathy1234');
  shiftId = (await openShift(cashier, till, 500000))._id;
});
afterAll(teardown);

const stock = async (productId: string) => (await t.client.get(`/inventory/levels?productId=${productId}&warehouseId=${wh}`)).body.data[0]?.qty ?? 0;

describe('checkout', () => {
  it('requires an open shift on the till', async () => {
    // A second till in the same branch has no open shift.
    const t2 = await t.client.post('/settings/tills', { branchId: t.locations.branches[0]._id, warehouseId: wh, name: 'Till 2', code: 'T2' });
    expect(t2.status).toBe(201);
    const p = await createProduct(t.client, { openingStock: [{ warehouseId: wh, qty: 5 }] });
    const r = await t.client.post('/sales', { clientRequestId: rid(), tillId: t2.body.data._id, lines: [{ productId: p._id, qty: 1 }], payments: [{ method: 'cash', amountCents: 10000 }] });
    expect(r.body.error.code).toBe('SHIFT_REQUIRED');
  });

  it('completes a cash sale with change, VAT-inclusive tax and stock deduction', async () => {
    const p = await createProduct(t.client, { name: 'Bread', prices: { retail: 6000 }, costCents: 4500, openingStock: [{ warehouseId: wh, qty: 10, unitCostCents: 4500 }] });
    const r = await cashier.post('/sales', { clientRequestId: rid(), tillId: till, lines: [{ productId: p._id, qty: 2 }], payments: [{ method: 'cash', amountCents: 12000, tenderedCents: 20000 }] });
    expect(r.status).toBe(201);
    const s = r.body.data;
    expect(s.totalCents).toBe(12000);
    expect(s.changeCents).toBe(8000);
    expect(s.taxCents).toBe(Math.round((12000 * 1600) / 11600));
    expect(s.netCents + s.taxCents).toBe(12000);
    // Cost of goods is recorded, but cashiers do not see cost prices.
    expect(s.costCents).toBeUndefined();
    expect((await t.client.get(`/sales/${s._id}`)).body.data.costCents).toBe(9000);
    expect(await stock(p._id)).toBe(8);
    const receipt = await cashier.get(`/sales/${s._id}/receipt?format=text`);
    expect(receipt.text).toContain(s.number);
    expect(receipt.text).toContain('Change');
    const escpos = await cashier.get(`/sales/${s._id}/receipt?format=escpos`);
    expect(Buffer.from(escpos.body.data.base64, 'base64')[0]).toBe(0x1b);
  });

  it('prints receipts with the layout chosen in Settings > Receipts', async () => {
    const sale = (await t.client.get('/sales?limit=1')).body.data[0];
    // Cashiers cannot change the receipt layout.
    expect((await cashier.put('/settings/receipt', { receipt: { template: 'bold' } })).status).toBe(403);
    const saved = await t.client.put('/settings/receipt', {
      receipt: { template: 'bold', paper: '58mm', title: 'CASH SALE', show: { poweredBy: false, cashier: false }, customFields: [{ label: 'Paybill', value: '123456', position: 'bottom' }], message: 'Double points on Friday', returnPolicy: 'Returns within 7 days' },
      receiptFooter: 'Karibu tena',
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data.receipt).toMatchObject({ template: 'bold', paper: '58mm', show: { poweredBy: false, cashier: false, taxPin: true } });
    const text = (await cashier.get(`/sales/${sale._id}/receipt?format=text`)).text;
    expect(text).toContain('CASH SALE');
    expect(text).toMatch(/Paybill:\s+123456/);
    expect(text).toContain('Double points on Friday');
    expect(text).toContain('Karibu tena');
    expect(text).not.toContain('Powered by Afey POS');
    expect(text).not.toContain('Served by');
    // 58 mm paper: 32 characters per line.
    expect(Math.max(...text.split('\n').map((l) => l.length))).toBeLessThanOrEqual(32);
    const html = (await cashier.get(`/sales/${sale._id}/receipt?format=html`)).text;
    expect(html).toContain('size:58mm');
    expect(html).toContain('<svg'); // receipt barcode
    // Preview renders unsaved settings without saving them.
    const preview = await t.client.post('/settings/receipt/preview', { receipt: { template: 'elegant', title: 'PREVIEW ONLY' }, format: 'text' });
    expect(preview.text).toContain('PREVIEW ONLY');
    expect((await t.client.get('/settings/receipt')).body.data.receipt.title).toBe('CASH SALE');
    await t.client.put('/settings/receipt', { receipt: {} });
  });

  it('rejects payments that do not equal the total', async () => {
    const p = await createProduct(t.client, { prices: { retail: 5000 }, openingStock: [{ warehouseId: wh, qty: 10 }] });
    const r = await cashier.post('/sales', { clientRequestId: rid(), tillId: till, lines: [{ productId: p._id, qty: 1 }], payments: [{ method: 'cash', amountCents: 4000 }] });
    expect(r.body.error.code).toBe('PAYMENT_MISMATCH');
    expect(await stock(p._id)).toBe(10);
  });

  it('accepts split payments (cash + card)', async () => {
    const p = await createProduct(t.client, { prices: { retail: 25000 }, openingStock: [{ warehouseId: wh, qty: 4 }] });
    const r = await cashier.post('/sales', { clientRequestId: rid(), tillId: till, lines: [{ productId: p._id, qty: 2 }], payments: [{ method: 'cash', amountCents: 20000 }, { method: 'card', amountCents: 30000, reference: 'POS-778' }] });
    expect(r.status).toBe(201);
    expect(r.body.data.payments).toHaveLength(2);
    expect(r.body.data.paidCents).toBe(50000);
  });

  it('is idempotent: duplicate submissions return the same sale and deduct stock once', async () => {
    const p = await createProduct(t.client, { prices: { retail: 1000 }, openingStock: [{ warehouseId: wh, qty: 10 }] });
    const body = { clientRequestId: rid(), tillId: till, lines: [{ productId: p._id, qty: 3 }], payments: [{ method: 'cash', amountCents: 3000 }] };
    const [r1, r2, r3] = await Promise.all([cashier.post('/sales', body), cashier.post('/sales', body), cashier.post('/sales', body)]);
    const ids = new Set([r1, r2, r3].filter((r) => r.status < 300).map((r) => r.body.data._id));
    expect(ids.size).toBe(1);
    expect(await stock(p._id)).toBe(7);
    const replay = await cashier.post('/sales', body);
    expect(replay.body.replay).toBe(true);
    // Same Idempotency-Key with a different body is refused.
    const key = rid();
    await cashier.post('/sales', { ...body, clientRequestId: rid() }, { 'Idempotency-Key': key });
    const mismatch = await cashier.post('/sales', { ...body, clientRequestId: rid() }, { 'Idempotency-Key': key });
    expect(mismatch.status).toBe(422);
  });

  it('never oversells under concurrent checkouts', async () => {
    const p = await createProduct(t.client, { prices: { retail: 1000 }, openingStock: [{ warehouseId: wh, qty: 5 }] });
    const attempts = Array.from({ length: 12 }, () => cashier.post('/sales', { clientRequestId: rid(), tillId: till, lines: [{ productId: p._id, qty: 1 }], payments: [{ method: 'cash', amountCents: 1000 }] }));
    const results = await Promise.all(attempts);
    const ok = results.filter((r) => r.status === 201).length;
    expect(ok).toBe(5);
    expect(results.filter((r) => r.status !== 201).every((r) => r.body.error.code === 'INSUFFICIENT_STOCK')).toBe(true);
    expect(await stock(p._id)).toBe(0);
  });

  it('requires discount permission and supervisor override above the cashier limit', async () => {
    const p = await createProduct(t.client, { prices: { retail: 10000 }, openingStock: [{ warehouseId: wh, qty: 10 }] });
    const small = await cashier.post('/sales', { clientRequestId: rid(), tillId: till, lines: [{ productId: p._id, qty: 1, discountCents: 500 }], payments: [{ method: 'cash', amountCents: 9500 }] });
    expect(small.status).toBe(201);
    const bigBody = { clientRequestId: rid(), tillId: till, lines: [{ productId: p._id, qty: 1, discountBp: 3000 }], payments: [{ method: 'cash', amountCents: 7000 }] };
    const denied = await cashier.post('/sales', bigBody);
    expect(denied.body.error.code).toBe('OVERRIDE_REQUIRED');
    const badSup = await cashier.post('/auth/override', { email: 'manny@shopco.test', pin: '0000', permission: 'sales.discount.override' });
    expect(badSup.status).toBe(401);
    const ov = await cashier.post('/auth/override', { email: 'manny@shopco.test', pin: '9876', permission: 'sales.discount.override' });
    expect(ov.status).toBe(200);
    const ok = await cashier.post('/sales', { ...bigBody, overrideToken: ov.body.overrideToken });
    expect(ok.status).toBe(201);
    expect(ok.body.data.overrides[0].action).toMatch(/discount/);
    // Override tokens are single-use.
    const reuse = await cashier.post('/sales', { ...bigBody, clientRequestId: rid(), overrideToken: ov.body.overrideToken });
    expect(reuse.status).toBe(403);
  });

  it('applies wholesale price lists, quantity tiers and customer-specific prices', async () => {
    await t.client.put('/settings/modules', { enabled: ['loyalty', 'customerPricing'] });
    const p = await createProduct(t.client, {
      prices: { retail: 10000, wholesale: 9000 }, minOrderQty: 0,
      priceTiers: [{ priceList: 'wholesale', minQty: 10, priceCents: 8500 }],
      openingStock: [{ warehouseId: wh, qty: 100 }],
    });
    const cust = (await t.client.post('/customers', { name: 'Mama Mboga', kind: 'wholesale', priceList: 'wholesale' })).body.data;
    const r1 = await cashier.post('/sales', { clientRequestId: rid(), tillId: till, customerId: cust._id, lines: [{ productId: p._id, qty: 5 }], payments: [{ method: 'cash', amountCents: 45000 }] });
    expect(r1.body.data.lines[0].unitPriceCents).toBe(9000);
    const r2 = await cashier.post('/sales', { clientRequestId: rid(), tillId: till, customerId: cust._id, lines: [{ productId: p._id, qty: 10 }], payments: [{ method: 'cash', amountCents: 85000 }] });
    expect(r2.body.data.lines[0].unitPriceCents).toBe(8500);
    await t.client.put('/customer-prices', { customerId: cust._id, productId: p._id, unitCode: 'pc', priceCents: 8000 });
    const r3 = await cashier.post('/sales', { clientRequestId: rid(), tillId: till, customerId: cust._id, lines: [{ productId: p._id, qty: 1 }], payments: [{ method: 'cash', amountCents: 8000 }] });
    expect(r3.body.data.lines[0].unitPriceCents).toBe(8000);
    // Cashiers cannot change prices themselves.
    const r4 = await cashier.post('/sales', { clientRequestId: rid(), tillId: till, lines: [{ productId: p._id, qty: 1, unitPriceCents: 1 }], payments: [{ method: 'cash', amountCents: 1 }] });
    expect(r4.body.error.code).toBe('OVERRIDE_REQUIRED');
  });

  it('sells on credit within the limit, needs approval above it, and allocates payments', async () => {
    const p = await createProduct(t.client, { prices: { retail: 50000 }, openingStock: [{ warehouseId: wh, qty: 20 }] });
    const cust = (await t.client.post('/customers', { name: 'Contractor Ltd', kind: 'contractor', creditLimitCents: 100000, phone: '0722000000' })).body.data;
    const walkIn = (await t.client.get('/customers?q=Walk-in')).body.data[0];
    const noCustomer = await t.client.post('/sales', { clientRequestId: rid(), tillId: till, customerId: walkIn._id, lines: [{ productId: p._id, qty: 1 }], payments: [{ method: 'credit', amountCents: 50000 }] });
    expect(noCustomer.body.error.code).toBe('CUSTOMER_REQUIRED');
    const cashierCredit = await cashier.post('/sales', { clientRequestId: rid(), tillId: till, customerId: cust._id, lines: [{ productId: p._id, qty: 1 }], payments: [{ method: 'credit', amountCents: 50000 }] });
    expect(cashierCredit.body.error.code).toBe('OVERRIDE_REQUIRED');
    const s1 = await t.client.post('/sales', { clientRequestId: rid(), tillId: till, customerId: cust._id, lines: [{ productId: p._id, qty: 2 }], payments: [{ method: 'credit', amountCents: 100000 }] });
    expect(s1.status).toBe(201);
    expect(s1.body.data.creditCents).toBe(100000);
    await t.client.post('/settings/users', { name: 'Sales Mgr', email: 'smgr@shopco.test', password: 'Smgr12345', roles: ['salesperson'] });
    const over = await t.client.post('/sales', { clientRequestId: rid(), tillId: till, customerId: cust._id, lines: [{ productId: p._id, qty: 1 }], payments: [{ method: 'credit', amountCents: 50000 }] });
    // Owner holds credit.approve, so the limit can be exceeded explicitly.
    expect(over.status).toBe(201);
    let c = (await t.client.get(`/customers/${cust._id}`)).body.data;
    expect(c.balanceCents).toBe(150000);
    const pay = await cashier.post(`/customers/${cust._id}/payments`, { clientRequestId: rid(), amountCents: 120000, method: 'cash', tillId: till });
    expect(pay.status).toBe(201);
    expect(pay.body.data.balanceCents).toBe(30000);
    const st = await t.client.get(`/customers/${cust._id}/statement`);
    expect(st.body.data.entries.map((e: any) => e.kind)).toEqual(['credit_sale', 'credit_sale', 'payment']);
    expect(st.body.data.ageing.total).toBe(30000);
    c = (await t.client.get(`/customers/${cust._id}`)).body.data;
    expect(c.balanceCents).toBe(30000);
  });

  it('processes partial returns with restock and refuses returning more than sold', async () => {
    const p = await createProduct(t.client, { prices: { retail: 11600 }, costCents: 5000, openingStock: [{ warehouseId: wh, qty: 10, unitCostCents: 5000 }] });
    const sale = (await cashier.post('/sales', { clientRequestId: rid(), tillId: till, lines: [{ productId: p._id, qty: 3 }], payments: [{ method: 'cash', amountCents: 34800 }] })).body.data;
    const lineId = sale.lines[0]._id;
    expect((await cashier.post(`/sales/${sale._id}/returns`, { clientRequestId: rid(), tillId: till, lines: [{ lineId, qty: 1 }], refundMethod: 'cash', reason: 'Wrong size' })).status).toBe(403);
    const ret = await t.client.post(`/sales/${sale._id}/returns`, { clientRequestId: rid(), tillId: till, lines: [{ lineId, qty: 2, restock: true }], refundMethod: 'cash', reason: 'Wrong size' });
    expect(ret.status).toBe(201);
    expect(ret.body.data.refundCents).toBe(23200);
    expect(await stock(p._id)).toBe(9);
    const tooMany = await t.client.post(`/sales/${sale._id}/returns`, { clientRequestId: rid(), tillId: till, lines: [{ lineId, qty: 2 }], refundMethod: 'cash', reason: 'Again' });
    expect(tooMany.body.error.code).toBe('RETURN_EXCEEDS_SOLD');
    const damaged = await t.client.post(`/sales/${sale._id}/returns`, { clientRequestId: rid(), tillId: till, lines: [{ lineId, qty: 1, restock: false }], refundMethod: 'cash', reason: 'Broken' });
    expect(damaged.status).toBe(201);
    expect(await stock(p._id)).toBe(9);
    const after = (await t.client.get(`/sales/${sale._id}`)).body.data;
    expect(after.status).toBe('returned');
  });

  it('voids a sale in an open shift, restocking and reversing cash', async () => {
    const p = await createProduct(t.client, { prices: { retail: 7000 }, openingStock: [{ warehouseId: wh, qty: 5 }] });
    const sale = (await cashier.post('/sales', { clientRequestId: rid(), tillId: till, lines: [{ productId: p._id, qty: 2 }], payments: [{ method: 'cash', amountCents: 14000 }] })).body.data;
    expect((await cashier.post(`/sales/${sale._id}/void`, { clientRequestId: rid(), reason: 'Mistake' })).status).toBe(403);
    const v = await t.client.post(`/sales/${sale._id}/void`, { clientRequestId: rid(), reason: 'Cashier mistake' });
    expect(v.body.data.status).toBe('voided');
    expect(await stock(p._id)).toBe(5);
  });

  it('converts a quotation into a sale exactly once', async () => {
    await t.client.put('/settings/modules', { enabled: ['loyalty', 'customerPricing'] });
    const p = await createProduct(t.client, { prices: { retail: 20000, wholesale: 18000 }, openingStock: [{ warehouseId: wh, qty: 10 }] });
    const q = await t.client.post('/documents', { type: 'quotation', branchId: t.locations.branches[0]._id, priceList: 'wholesale', customerName: 'Site A', lines: [{ productId: p._id, qty: 2 }] });
    expect(q.body.data.totalCents).toBe(36000);
    const print = await t.client.get(`/documents/${q.body.data._id}/print`);
    expect(print.text).toContain('QUOTATION');
    const sale = await t.client.post('/sales', { clientRequestId: rid(), tillId: till, priceList: 'wholesale', salesDocumentId: q.body.data._id, lines: [{ productId: p._id, qty: 2 }], payments: [{ method: 'cash', amountCents: 36000 }] });
    expect(sale.status).toBe(201);
    expect((await t.client.get(`/documents/${q.body.data._id}`)).body.data.status).toBe('converted');
    const again = await t.client.post('/sales', { clientRequestId: rid(), tillId: till, priceList: 'wholesale', salesDocumentId: q.body.data._id, lines: [{ productId: p._id, qty: 2 }], payments: [{ method: 'cash', amountCents: 36000 }] });
    expect(again.body.error.code).toBe('DOCUMENT_NOT_CONVERTIBLE');
    const dn = await t.client.post('/delivery-notes', { saleId: sale.body.data._id, driver: 'Juma', vehicle: 'KDA 123A' });
    expect(dn.status).toBe(201);
    expect((await t.client.post('/delivery-notes', { saleId: sale.body.data._id })).status).toBe(422);
  });

  it('reconciles the shift: expected vs counted cash', async () => {
    await cashier.post(`/shifts/${shiftId}/cash`, { type: 'cash_out', amountCents: 10000, reason: 'Paid porter' });
    await cashier.post(`/shifts/${shiftId}/cash`, { type: 'cash_in', amountCents: 2000, reason: 'Change top-up' });
    const sum = (await cashier.get(`/shifts/${shiftId}/summary`)).body.data;
    expect(sum.expectedCashCents).toBeGreaterThan(500000);
    const close = await cashier.post(`/shifts/${shiftId}/close`, { countedCashCents: sum.expectedCashCents - 500 });
    expect(close.status).toBe(200);
    expect(close.body.data.shift.varianceCents).toBe(-500);
    expect(close.body.data.shift.status).toBe('closed');
    const p = await createProduct(t.client, { openingStock: [{ warehouseId: wh, qty: 1 }] });
    const blocked = await cashier.post('/sales', { clientRequestId: rid(), tillId: till, lines: [{ productId: p._id, qty: 1 }], payments: [{ method: 'cash', amountCents: 10000 }] });
    expect(blocked.body.error.code).toBe('SHIFT_REQUIRED');
    // Re-open for later tests in other files is not needed.
  });
});
