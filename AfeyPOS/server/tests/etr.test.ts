import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, createProduct, openShift, rid, type Ctx } from './helpers.js';
import { drainJobs } from '../src/jobs/queue.js';
import { Job } from '../src/models/index.js';
import { runAsPlatform } from '../src/lib/context.js';
import { EtrGateway, parseEtrAnswer, readEtrSignature } from '../src/integrations/etims/etr.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
let till: string;
let product: any;

const runJobs = async () => {
  await runAsPlatform(() => Job.updateMany({ status: 'queued' }, { $set: { runAt: new Date(0) } }));
  await drainJobs();
};
const addEtr = (name: string, settings: Record<string, unknown>) =>
  t.client.post('/settings/integrations', { kind: 'etims', provider: 'etr', name, settings: { tin: 'P051234567X', bhfId: '00', ...settings } });
const sell = (etimsConfigId: string) =>
  t.client.post('/sales', { clientRequestId: rid(), tillId: till, etimsConfigId, lines: [{ productId: product._id, qty: 2 }], payments: [{ method: 'cash', amountCents: 23200 }] });

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'etrshop', 'supermarket', {}, ['etims']);
  till = t.locations.tills[0]._id;
  await openShift(t.client, till);
  product = await createProduct(t.client, { name: 'Sugar 1kg', sku: 'SUG1', prices: { retail: 11600 }, taxRateBp: 1600, openingStock: [{ warehouseId: t.locations.warehouses[0]._id, qty: 50 }] });
});
afterAll(teardown);

describe('reading the ETR program\'s answer', () => {
  it('finds the usual field names, nested or not, and key=value text files', () => {
    expect(readEtrSignature({ data: { CUIN: '0040123450000000012', SerialNumber: 'KRAMW004012345', QRCode: 'https://itax.kra.go.ke/x?i=1' } }, { connection: 'http' }))
      .toMatchObject({ cuInvoiceNo: '0040123450000000012', cuSerial: 'KRAMW004012345', qrUrl: 'https://itax.kra.go.ke/x?i=1' });
    expect(parseEtrAnswer('CU Invoice Number = 0040\r\nqrCode: https://k/q')).toEqual({ 'CU Invoice Number': '0040', qrCode: 'https://k/q' });
    expect(readEtrSignature({ result: { invoice: { no: 'X1' } } }, { connection: 'http', fieldInvoice: 'result.invoice.no', cuSerial: 'CU-9' })).toMatchObject({ cuInvoiceNo: 'X1', cuSerial: 'CU-9' });
    expect(() => readEtrSignature({ error: 'Paper out' }, { connection: 'http' })).toThrow(/Paper out/);
  });
});

describe('ETR device on the Afey POS computer', () => {
  it('checks the setup: a program address on this computer, or both folders', async () => {
    expect((await addEtr('Bad', { connection: 'http', url: 'https://example.com' })).status).toBe(400);
    expect((await addEtr('Bad', { connection: 'folder', inbox: 'C:\\ETR\\in' })).status).toBe(400);
  });

  it('simulator: the sale is signed and the receipt carries the CU invoice number', async () => {
    const cfg = await addEtr('ETR simulator', { connection: 'simulator', cuSerial: 'KRAMW004012345' });
    expect(cfg.status).toBe(201);
    expect((await t.client.post(`/settings/integrations/${cfg.body.data.id}/test`, {})).body.data).toMatchObject({ ok: true });
    const devices = (await t.client.get(`/etims/devices?tillId=${till}`)).body.data;
    expect(devices.find((d: any) => d.id === cfg.body.data.id)).toMatchObject({ mode: 'etr', serial: 'KRAMW004012345' });
    const sale = await sell(cfg.body.data.id);
    expect(sale.status).toBe(201);
    await runJobs();
    const signed = (await t.client.get(`/sales/${sale.body.data._id}`)).body.data.etims;
    expect(signed).toMatchObject({ status: 'signed', device: 'etr', cuSerial: 'KRAMW004012345' });
    expect(signed.cuInvoiceNo).toMatch(/^\d{19}$/);
    expect(signed.qrUrl).toMatch(/^https:\/\/itax\.kra\.go\.ke\//);
    const sent = EtrGateway.simulated.at(-1)!;
    expect(sent).toMatchObject({ type: 'sale', invoiceNumber: sale.body.data.number, seller: { pin: 'P051234567X' }, totals: { total: 232 } });
    expect(sent.seller.name).toBeTruthy();
    expect(sent.items[0]).toMatchObject({ name: 'Sugar 1kg', quantity: 2, taxCode: 'B', taxRate: 16 });
    const text = (await t.client.get(`/sales/${sale.body.data._id}/receipt?format=text`)).text;
    expect(text).toContain('KRA TIMS · ETR');
    expect(text).toContain(signed.cuInvoiceNo.slice(0, 10));
    expect(text).not.toContain('Receipt signature');
  });

  it('program on this computer (web address): sends the invoice as JSON and stores its answer', async () => {
    const received: any[] = [];
    const program = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.method !== 'POST') return res.writeHead(200).end('ETR program');
        const inv = JSON.parse(body);
        received.push({ path: req.url, key: req.headers['x-api-key'], inv });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: { cuInvoiceNumber: `0040123450${String(inv.sequence).padStart(9, '0')}`, cuSerialNumber: 'KRAMW004099999', verificationUrl: 'https://itax.kra.go.ke/check?no=1' } }));
      });
    });
    await new Promise<void>((r) => program.listen(0, '127.0.0.1', () => r()));
    const port = (program.address() as any).port;
    try {
      const cfg = await t.client.post('/settings/integrations', {
        kind: 'etims', provider: 'etr', name: 'Shop ETR', settings: { tin: 'P051234567X', bhfId: '00', connection: 'http', url: `http://127.0.0.1:${port}`, invoicePath: '/api/sign' },
        secrets: { authHeader: 'X-Api-Key: secret-123' },
      });
      expect(cfg.status).toBe(201);
      expect((await t.client.post(`/settings/integrations/${cfg.body.data.id}/test`, {})).body.data).toMatchObject({ ok: true });
      const sale = await sell(cfg.body.data.id);
      await runJobs();
      expect(received[0]).toMatchObject({ path: '/api/sign', key: 'secret-123', inv: { type: 'sale', invoiceNumber: sale.body.data.number, buyer: { pin: null } } });
      const signed = (await t.client.get(`/sales/${sale.body.data._id}`)).body.data.etims;
      expect(signed).toMatchObject({ status: 'signed', device: 'etr', cuSerial: 'KRAMW004099999', qrUrl: 'https://itax.kra.go.ke/check?no=1' });

      // A credit note names the original sale's CU invoice number.
      const lines = (await t.client.get(`/sales/${sale.body.data._id}`)).body.data.lines;
      const ret = await t.client.post(`/sales/${sale.body.data._id}/returns`, { clientRequestId: rid(), tillId: till, refundMethod: 'cash', reason: 'Damaged pack', lines: [{ lineId: lines[0]._id, qty: 1 }] });
      expect(ret.status).toBe(201);
      await runJobs();
      const credit = received.find((r) => r.inv.type === 'credit_note');
      expect(credit?.inv).toMatchObject({ relevantInvoiceNumber: signed.cuInvoiceNo, originalReceipt: sale.body.data.number });
    } finally {
      program.close();
    }
  });

  it('folder exchange: one invoice file per sale, sent once even when the device is slow, signed when it answers', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afey-etr-'));
    const inbox = path.join(dir, 'in');
    const outbox = path.join(dir, 'out');
    try {
      const cfg = await addEtr('Folder ETR', { connection: 'folder', inbox, outbox, cuSerial: 'KRAMW004077777', timeoutSeconds: 5 });
      expect(cfg.status).toBe(201);
      const sale = await sell(cfg.body.data.id);
      // The device program is not running: no answer in time, the sale waits for a retry.
      await runJobs();
      const file = path.join(inbox, `${sale.body.data.number}.json`);
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ type: 'sale', invoiceNumber: sale.body.data.number });
      expect((await t.client.get(`/sales/${sale.body.data._id}`)).body.data.etims.status).toBe('pending');
      // The program takes the file and answers in its outbox (key=value text).
      fs.rmSync(file);
      fs.mkdirSync(outbox, { recursive: true });
      fs.writeFileSync(path.join(outbox, `${sale.body.data.number}.txt`), 'CUIN=0040777770000000001\r\nQRCode=https://itax.kra.go.ke/q?1\r\n');
      await runJobs();
      // The retry did not drop the invoice in again: it read the answer.
      expect(fs.existsSync(file)).toBe(false);
      const signed = (await t.client.get(`/sales/${sale.body.data._id}`)).body.data.etims;
      expect(signed).toMatchObject({ status: 'signed', cuInvoiceNo: '0040777770000000001', cuSerial: 'KRAMW004077777' });
      expect(fs.existsSync(path.join(outbox, 'done', `${sale.body.data.number}.txt`))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
