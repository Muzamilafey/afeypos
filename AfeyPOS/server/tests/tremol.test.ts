import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseZfp, TremolZfpClient, TremolGateway } from '../src/integrations/etims/tremol.js';
import type { EtimsSale } from '../src/integrations/etims/client.js';

// A tiny stand-in for the Tremol ZFP Lab Server: records the commands it is asked and answers with XML.
const calls: string[] = [];
let mode: 'ok' | 'refuse' = 'ok';
let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '').replace(/^\//, ''));
    calls.push(path);
    const name = path.replace(/\(.*/, '');
    res.setHeader('Content-Type', 'application/xml');
    if (mode === 'refuse' && name === 'CloseReceipt') return res.end('<Res Code="58" Technical="Receipt not open"/>');
    if (name === 'ReadVersion') return res.end('<Res Code="0" SerialNumber="KRAMW011202207061496" Version="1.00"/>');
    if (name === 'ReadStatus') return res.end('<Res Code="0" Ready="1"/>');
    if (name === 'ReadLastAndTotalReceiptNum') return res.end('<Res Code="0" LastReceiptNum="42" TotalReceiptNum="42"/>');
    if (name === 'CloseReceipt') return res.end('<Res Code="0" cuInvoiceNumber="KRAMW011202207061496000000123" cuSerialNumber="KRAMW011202207061496" qrCode="https://itax.kra.go.ke/KRA-Portal/invoiceChk.htm?invoiceNo=123" dateTime="20261108120000"/>');
    return res.end('<Res Code="0"/>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const sale = (): EtimsSale => ({
  invcNo: 123, orgInvcNo: 0, trdInvcNo: 1001, custTin: null, custNm: null, salesTyCd: 'N', rcptTyCd: 'S', pmtTyCd: '01', salesSttsCd: '02',
  cfmDt: '20261108120000', salesDt: '20261108', totItemCnt: 1, taxblAmtB: 100, taxAmtB: 16, taxRtB: 16, totTaxblAmt: 100, totTaxAmt: 16, totAmt: 116,
  prchrAcptcYn: 'N', remark: null, regrId: 'pos', regrNm: 'POS', modrId: 'pos', modrNm: 'POS',
  receipt: { rptNo: 123, trdeNm: 'Shop', prchrAcptcYn: 'N' },
  itemList: [{ itemSeq: 1, itemCd: 'KE2NTU0000001', itemClsCd: '50202200', itemNm: 'Milk', bcd: null, pkgUnitCd: 'NT', pkg: 1, qtyUnitCd: 'U', qty: 1, prc: 116, splyAmt: 116, dcRt: 0, dcAmt: 0, taxTyCd: 'B', taxblAmt: 100, taxAmt: 16, totAmt: 116 }],
} as unknown as EtimsSale);

describe('Tremol ZFP Lab Server', () => {
  it('parses the XML answer and its Code', () => {
    expect(parseZfp('<Res Code="0" A="x"/>')).toMatchObject({ code: 0, attrs: { A: 'x' } });
    expect(parseZfp('﻿<Res Code="58" Technical="boom"/>').code).toBe(58);
  });

  it('reads the device version and status (connection test)', async () => {
    const c = new TremolZfpClient({ url: base });
    expect((await c.readVersion()).attrs.SerialNumber).toBe('KRAMW011202207061496');
    expect((await c.readStatus()).attrs.Ready).toBe('1');
  });

  it('issues a receipt with OpenReceipt → Sell → CloseReceipt and reads the CU signature', async () => {
    mode = 'ok';
    calls.length = 0;
    const sig = await new TremolGateway({ url: base, operatorNum: '1', operatorPass: '0000' }, { name: 'Shop', pin: 'P051234567X' }).saveSale(sale());
    const commands = calls.map((c) => c.replace(/\(.*/, ''));
    expect(commands).toEqual(['OpenReceipt', 'SellPLUwithSpecifiedVAT', 'CloseReceipt']);
    expect(sig.cuInvoiceNo).toBe('KRAMW011202207061496000000123');
    expect(sig.qrUrl).toContain('itax.kra.go.ke');
    expect(sig.rcptSign).toBe('KRAMW011202207061496000000123');
  });

  it('treats a non-zero device Code as a hard failure (never a silent success)', async () => {
    mode = 'refuse';
    await expect(new TremolGateway({ url: base }).saveSale(sale())).rejects.toThrow(/refused CloseReceipt/);
  });

  it('refuses a non-local ZFP address', async () => {
    await expect(new TremolZfpClient({ url: 'http://8.8.8.8:4444/' }).readVersion()).rejects.toThrow(/this computer or the shop network/);
  });
});
