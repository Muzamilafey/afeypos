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

describe('cash drawer', () => {
  const KICK = Buffer.from([0x1b, 0x70, 0x00]);
  it('opens by itself for a cash sale, and the receipt then prints without a second kick', async () => {
    const sent: { name: string; data: Buffer }[] = [];
    const spy = vi.spyOn(localPrinter, 'printToLocalPrinter').mockImplementation(async (name, data) => { sent.push({ name, data }); });
    try {
      const open = await t.client.post('/hardware/drawer/open', { localPrinter: 'EPSON TM-T20', tillId: till, saleId: sale._id });
      expect(open.status).toBe(200);
      expect(sent[0]).toMatchObject({ name: 'EPSON TM-T20' });
      expect(sent[0]!.data.includes(Buffer.concat([KICK, Buffer.from([0x19, 0xfa])]))).toBe(true);
      expect(sent[0]!.data.includes(Buffer.from([0x1d, 0x56]))).toBe(false); // no paper cut, nothing printed
      const printed = await t.client.post(`/sales/${sale._id}/print`, { localPrinter: 'EPSON TM-T20', openDrawer: false });
      expect(printed.status).toBe(200);
      expect(sent[1]!.data.includes(KICK)).toBe(false);
      // The bridge's receipt can leave the kick out the same way.
      const esc = await t.client.get(`/sales/${sale._id}/receipt?format=escpos&drawer=0`);
      expect(Buffer.from(esc.body.data.base64, 'base64').includes(KICK)).toBe(false);
      const withKick = await t.client.get(`/sales/${sale._id}/receipt?format=escpos`);
      expect(Buffer.from(withKick.body.data.base64, 'base64').includes(KICK)).toBe(true);
      // Opening it with a sale is part of that sale: not recorded as a "no sale" opening.
      expect((await t.client.get('/audit?action=till.drawer_opened')).body.data).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('opening it without a sale is recorded with the reason', async () => {
    const spy = vi.spyOn(localPrinter, 'printToLocalPrinter').mockImplementation(async () => undefined);
    try {
      expect((await t.client.post('/hardware/drawer/open', { localPrinter: 'EPSON TM-T20', tillId: till, reason: 'Change for a customer' })).status).toBe(200);
      expect((await t.client.post('/hardware/drawer/opened', { tillId: till, reason: 'Bridge test' })).status).toBe(200);
      const log = (await t.client.get('/audit?action=till.drawer_opened')).body.data;
      expect(log.map((l: any) => l.details.reason).sort()).toEqual(['Bridge test', 'Change for a customer']);
      // Without a printer or a till there is nowhere to send it.
      expect((await t.client.post('/hardware/drawer/open', {})).status).toBe(400);
    } finally {
      spy.mockRestore();
    }
  });
});
