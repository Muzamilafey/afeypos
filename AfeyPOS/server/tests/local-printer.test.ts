import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupApp, teardown, registerTenant, createProduct, openShift, rid, type Ctx } from './helpers.js';
import * as localPrinter from '../src/modules/hardware/localPrinter.js';
import { testSlipEscPos } from '../src/modules/hardware/receipt.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
let till: string;
let sale: any;

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'printshop', 'minimart');
  till = t.locations.tills[0]._id;
  await openShift(t.client, till, 100000);
  const p = await createProduct(t.client, { name: 'Milk', sku: 'PMILK', prices: { retail: 6500 }, openingStock: [{ warehouseId: t.locations.warehouses[0]._id, qty: 5 }] });
  sale = (await t.client.post('/sales', { clientRequestId: rid(), tillId: till, lines: [{ productId: p._id, qty: 1 }], payments: [{ method: 'cash', amountCents: 6500 }] })).body.data;
});
afterAll(teardown);

describe('printers on the Afey POS computer', () => {
  it('lists the printers installed on this computer for the till to choose', async () => {
    const spy = vi.spyOn(localPrinter, 'listLocalPrinters').mockResolvedValue([{ name: 'EPSON TM-T20', isDefault: true, port: 'USB001' }, { name: 'Office laser', isDefault: false }]);
    try {
      const r = await t.client.get('/hardware/printers/local');
      expect(r.status).toBe(200);
      expect(r.body.data.available).toBe(true);
      expect(r.body.data.printers.map((p: any) => p.name)).toEqual(['EPSON TM-T20', 'Office laser']);
    } finally {
      spy.mockRestore();
    }
  });

  it('says so, instead of failing, when the computer has no printer yet', async () => {
    const spy = vi.spyOn(localPrinter, 'listLocalPrinters').mockResolvedValue([]);
    try {
      const r = await t.client.get('/hardware/printers/local');
      expect(r.body.data).toMatchObject({ available: true, printers: [] });
      expect(r.body.data.reason).toMatch(/No printer is installed/);
    } finally {
      spy.mockRestore();
    }
  });

  it('prints a receipt to the chosen printer, as raw ESC/POS that cuts the paper', async () => {
    const sent: { name: string; data: Buffer }[] = [];
    const spy = vi.spyOn(localPrinter, 'printToLocalPrinter').mockImplementation(async (name, data) => { sent.push({ name, data }); });
    try {
      const r = await t.client.post(`/sales/${sale._id}/print`, { localPrinter: 'EPSON TM-T20', width: 32, openDrawer: true });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: true, printer: 'EPSON TM-T20' });
      const text = sent[0]!.data.toString('latin1');
      expect(sent[0]!.name).toBe('EPSON TM-T20');
      expect(text).toContain(sale.number);
      expect(text).toContain('Milk');
      expect(sent[0]!.data.includes(Buffer.from([0x1d, 0x56]))).toBe(true); // paper cut
      expect(sent[0]!.data.includes(Buffer.from([0x1b, 0x70, 0x00]))).toBe(true); // drawer, cash sale
    } finally {
      spy.mockRestore();
    }
  });

  it('a test slip names the printer and can open the drawer', () => {
    const slip = testSlipEscPos('Print Shop', 'EPSON TM-T20', 32, true).toString('latin1');
    expect(slip).toContain('TEST PRINT');
    expect(slip).toContain('Print Shop');
    expect(slip).toContain('EPSON TM-T20');
  });

  it('refuses a printer that is not installed, and bad names', async () => {
    const spy = vi.spyOn(localPrinter, 'listLocalPrinters').mockResolvedValue([{ name: 'EPSON TM-T20', isDefault: true }]);
    try {
      const gone = await t.client.post('/hardware/printers/local/test', { printer: 'Printer that was unplugged' });
      expect(gone.status).toBe(409);
      expect(gone.body.error.message).toMatch(/not installed/);
      expect((await t.client.post('/hardware/printers/local/test', { printer: 'bad;name | rm -rf' })).status).toBe(400);
    } finally {
      spy.mockRestore();
    }
  });
});
