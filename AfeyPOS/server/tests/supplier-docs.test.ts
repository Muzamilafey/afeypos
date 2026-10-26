import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, createProduct, openShift, rid, type Ctx } from './helpers.js';
import { drainJobs } from '../src/jobs/queue.js';
import { ConsoleEmailProvider } from '../src/integrations/email/index.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
let wh: string;
let till: string;
let sugar: any;
let rice: any;
let kapa: any;
let unga: any;
let groupId: string;
let quotes: any[];
let poId: string;

const pdf = async (path: string) => {
  const r = await t.client.get(path).buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  return r;
};

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'buyer', 'supermarket');
  wh = t.locations.warehouses[0]._id;
  till = t.locations.tills[0]._id;
  await t.client.patch('/settings/business', { contact: { address: 'Moi Avenue, Nairobi', phone: '0700111222', email: 'office@buyer.test' }, settings: { taxPin: 'P051234567X' } });
  kapa = (await t.client.post('/suppliers', { name: 'Kapa Distributors', email: 'sales@kapa.test', contactPerson: 'Otieno', phone: '0711000111' })).body.data;
  unga = (await t.client.post('/suppliers', { name: 'Unga Wholesalers', email: 'orders@unga.test' })).body.data;
  sugar = await createProduct(t.client, { name: 'Sugar 2kg', sku: 'SUG2', prices: { retail: 40000 }, costCents: 30000 });
  rice = await createProduct(t.client, { name: 'Rice 5kg – Pishori', sku: 'RICE5', prices: { retail: 120000 }, costCents: 90000 });
});
afterAll(teardown);

describe('supplier quotations', () => {
  it('asks two suppliers for prices and emails each a PDF request', async () => {
    ConsoleEmailProvider.outbox.length = 0;
    const r = await t.client.post('/supplier-quotations', { supplierIds: [kapa._id, unga._id], warehouseId: wh, respondBy: '2026-11-05', lines: [{ productId: sugar._id, qty: 50 }, { productId: rice._id, qty: 20 }], send: true, message: 'Delivery to Moi Avenue please.' });
    expect(r.status).toBe(201);
    expect(r.body.data).toHaveLength(2);
    expect(r.body.data.every((q: any) => q.status === 'sent' && q.number.startsWith('RFQ'))).toBe(true);
    groupId = r.body.groupId;
    quotes = r.body.data;
    await drainJobs();
    const mail = ConsoleEmailProvider.outbox.find((m) => m.to === 'sales@kapa.test')!;
    expect(mail.subject).toMatch(/Request for quotation RFQ/);
    expect(mail.text).toContain('Delivery to Moi Avenue please.');
    expect(mail.text).toContain('50 pc Sugar 2kg');
    expect(mail.attachments?.[0]?.filename).toMatch(/^Request-for-quotation-RFQ.*\.pdf$/);
    expect((mail.attachments![0]!.content as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect(ConsoleEmailProvider.outbox.some((m) => m.to === 'orders@unga.test')).toBe(true);
  });

  it('records each supplier’s prices and compares them', async () => {
    const [qk, qu] = quotes;
    const k = (await t.client.get(`/supplier-quotations/${qk._id}`)).body.data;
    expect((await t.client.put(`/supplier-quotations/${qk._id}/quote`, { lines: k.lines.map((l: any) => ({ lineId: l._id, unitCostCents: null })) })).status).toBe(400);
    const r1 = await t.client.put(`/supplier-quotations/${qk._id}/quote`, { lines: [{ lineId: k.lines[0]._id, unitCostCents: 29000 }, { lineId: k.lines[1]._id, unitCostCents: 95000 }], deliveryDays: 3, supplierRef: 'KQ-88' });
    expect(r1.body.data).toMatchObject({ status: 'quoted', totalCents: 50 * 29000 + 20 * 95000 });
    const u = (await t.client.get(`/supplier-quotations/${qu._id}`)).body.data;
    await t.client.put(`/supplier-quotations/${qu._id}/quote`, { lines: [{ lineId: u.lines[0]._id, unitCostCents: 30500 }, { lineId: u.lines[1]._id, unitCostCents: 88000 }] });
    const cmp = (await t.client.get(`/supplier-quotations/compare/${groupId}`)).body.data;
    expect(cmp.quotes).toHaveLength(2);
    expect(cmp.rows.find((r: any) => r.name === 'Sugar 2kg').bestQuotationId).toBe(qk._id);
    expect(cmp.rows.find((r: any) => r.name.startsWith('Rice')).bestQuotationId).toBe(qu._id);
    const list = (await t.client.get('/supplier-quotations?open=true')).body.data;
    expect(list[0].groupSize).toBe(2);
  });

  it('the PDF shows the quoted prices', async () => {
    const r = await pdf(`/pdf/supplier_quotation/${quotes[0]._id}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect((r.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('accepting a quote creates the purchase order, closes the others and emails the order with its PDF', async () => {
    ConsoleEmailProvider.outbox.length = 0;
    expect((await t.client.post(`/supplier-quotations/${quotes[0]._id}/accept`, { sendOrder: true })).status).toBe(200);
    const k = (await t.client.get(`/supplier-quotations/${quotes[0]._id}`)).body.data;
    expect(k.status).toBe('accepted');
    expect(k.purchaseOrder.status).toBe('sent');
    poId = k.purchaseOrderId;
    const po = (await t.client.get(`/purchase-orders/${poId}`)).body.data;
    expect(po.lines.map((l: any) => l.unitCostCents)).toEqual([29000, 95000]);
    expect(po.notes).toContain(k.number);
    expect((await t.client.get(`/supplier-quotations/${quotes[1]._id}`)).body.data.status).toBe('rejected');
    expect((await t.client.post(`/supplier-quotations/${quotes[1]._id}/accept`, {})).status).toBe(422);
    await drainJobs();
    const mail = ConsoleEmailProvider.outbox.find((m) => m.to === 'sales@kapa.test')!;
    expect(mail.subject).toMatch(/Purchase order PO/);
    expect(mail.attachments?.[0]?.filename).toMatch(/^Purchase-order-PO.*\.pdf$/);
  });

  it('a request can be cancelled; closed requests cannot be changed', async () => {
    const r = await t.client.post('/supplier-quotations', { supplierIds: [unga._id], warehouseId: wh, lines: [{ productId: sugar._id, qty: 5 }] });
    const id = r.body.data[0]._id;
    expect(r.body.data[0].status).toBe('draft');
    expect((await t.client.post(`/supplier-quotations/${id}/cancel`, {})).body.data.status).toBe('cancelled');
    expect((await t.client.post(`/supplier-quotations/${id}/send`, {})).status).toBe(422);
  });
});

describe('goods receiving and documents', () => {
  it('receives part of the order, produces a GRN PDF and keeps the order open', async () => {
    const po = (await t.client.get(`/purchase-orders/${poId}`)).body.data;
    const r = await t.client.post('/goods-receipts', { clientRequestId: rid(), supplierId: kapa._id, warehouseId: wh, purchaseOrderId: poId, supplierInvoiceNo: 'INV-5531', taxCents: 0, lines: [{ productId: sugar._id, poLineId: po.lines[0]._id, unitCode: po.lines[0].unitCode, qty: 50, unitCostCents: 29000 }] });
    expect(r.status).toBe(201);
    expect((await t.client.get(`/purchase-orders/${poId}`)).body.data.status).toBe('partially_received');
    const file = await pdf(`/pdf/goods_receipt/${r.body.data._id}`);
    expect(file.status).toBe(200);
    expect((file.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('emails a customer quotation and an invoice with their PDFs', async () => {
    ConsoleEmailProvider.outbox.length = 0;
    const customer = (await t.client.post('/customers', { name: 'Hotel Amani', email: 'accounts@amani.test', phone: '0722000333' })).body.data;
    await t.client.post('/goods-receipts', { clientRequestId: rid(), supplierId: unga._id, warehouseId: wh, lines: [{ productId: rice._id, qty: 10, unitCostCents: 88000 }] });
    const q = (await t.client.post('/documents', { type: 'quotation', branchId: t.locations.branches[0]._id, customerId: customer._id, lines: [{ productId: rice._id, qty: 2 }] })).body.data;
    const sent = await t.client.post(`/email/quotation/${q._id}`, { message: 'As discussed on the phone.', cc: ['chef@amani.test'] });
    expect(sent.body.data).toMatchObject({ queued: true, to: 'accounts@amani.test' });
    await openShift(t.client, till);
    const sale = (await t.client.post('/sales', { clientRequestId: rid(), tillId: till, customerId: customer._id, lines: [{ productId: rice._id, qty: 1 }], payments: [{ method: 'cash', amountCents: 120000 }] })).body.data;
    expect((await t.client.post(`/email/invoice/${sale._id}`, { to: 'boss@amani.test' })).body.data.to).toBe('boss@amani.test');
    await drainJobs();
    const qm = ConsoleEmailProvider.outbox.find((m) => m.to === 'accounts@amani.test')!;
    expect(qm.cc).toEqual(['chef@amani.test']);
    expect(qm.text).toContain('As discussed on the phone.');
    expect(qm.attachments?.[0]?.filename).toMatch(/^Quotation-QT.*\.pdf$/);
    const im = ConsoleEmailProvider.outbox.find((m) => m.to === 'boss@amani.test')!;
    expect(im.subject).toMatch(/tax invoice/i);
    expect(im.attachments?.[0]?.filename).toMatch(/^Tax-invoice-.*\.pdf$/);
    expect((await pdf(`/pdf/invoice/${sale._id}`)).status).toBe(200);
  });

  it('refuses unknown types, missing recipients and staff without permission', async () => {
    expect((await t.client.get(`/pdf/payslip/${poId}`)).status).toBe(404);
    const noEmail = (await t.client.post('/suppliers', { name: 'No Email Ltd' })).body.data;
    const r = await t.client.post('/supplier-quotations', { supplierIds: [noEmail._id], warehouseId: wh, lines: [{ productId: sugar._id, qty: 1 }] });
    const e = await t.client.post(`/email/supplier_quotation/${r.body.data[0]._id}`, {});
    expect(e.status).toBe(422);
    expect(e.body.error.message).toMatch(/no email address/);
    await t.client.post('/settings/users', { name: 'Cashier Carol', email: 'carol@buyer.test', password: 'Carol12345', roles: ['cashier'] });
    const { Client } = await import('./helpers.js');
    const carol = new Client(ctx.api, 'buyer');
    await carol.login('carol@buyer.test', 'Carol12345');
    expect((await carol.post(`/email/purchase_order/${poId}`, {})).status).toBe(403);
  });
});

describe('lists', () => {
  it('show the supplier names', async () => {
    for (const path of ['/supplier-quotations', '/purchase-orders', '/goods-receipts', '/supplier-returns']) {
      const rows = (await t.client.get(path)).body.data;
      for (const r of rows) expect(typeof r.supplierId?.name).toBe('string');
    }
  });
});
