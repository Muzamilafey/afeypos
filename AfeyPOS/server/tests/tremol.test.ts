import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseZfp, TremolZfpClient, TremolGateway } from '../src/integrations/etims/tremol.js';
import type { EtimsSale } from '../src/integrations/etims/client.js';

// Stand-in for the ZFP Lab Server Direct API using response shapes from the supplied SDK XML files.
const calls: string[] = [];
let mode: 'ok' | 'refuse' | 'no-signature' = 'ok';
let currentInfoCount = 0;
let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '').replace(/^\//, ''));
    calls.push(path);
    const name = path.replace(/\(.*/, '');
    res.setHeader('Content-Type', 'application/xml');
    if (mode === 'refuse' && name === 'CashPayCloseReceipt') return res.end('<Res Code="58" Technical="Receipt not open"/>');
    if (name === 'ReadVersion') return res.end('<Res Code="0"><Res Name="Model" Value="Tremol G03"/></Res>');
    if (name === 'ReadSerialAndFiscalNums') return res.end('<Res Code="0"><Res Name="SerialNumber" Value="KRAMW011202207061496"/><Res Name="FMNumber" Value="FM001"/></Res>');
    if (name === 'ReadStatus') return res.end('<Res Code="0"><Res Name="Printer_not_ready_no_paper" Value="0"/></Res>');
    if (name === 'ReadVATrates') return res.end('<Res Code="0"><Res Name="VATrateE" Value="16.00%"/></Res>');
    if (name === 'ReadPLUallData') return res.end('<Res Code="0"><Res Name="PLUNum" Value="00001"/><Res Name="PLUName" Value="Milk"/><Res Name="OptionVATClass" Value="2"/></Res>');
    if (name === 'ReadLastReceiptNum') return res.end('<Res Code="0"><Res Name="TotalFiscalRcpCounter" Value="4"/><Res Name="TotalRefundRcpCounter" Value="0"/></Res>');
    if (name === 'ReadPayments') return res.end('<Res Code="0"><Res Name="NamePaym0" Value="Cash"/><Res Name="NamePaym1" Value="Card"/><Res Name="NamePaym2" Value="Bank"/><Res Name="NamePaym3" Value="Other"/></Res>');
    if (name === 'ReadCurrentReceiptInfo') {
      currentInfoCount += 1;
      if (currentInfoCount === 1) return res.end('<Res Code="0"><Res Name="OptionIsReceiptOpened" Value="0"/></Res>');
      return res.end('<Res Code="0"><Res Name="OptionIsReceiptOpened" Value="1"/><Res Name="SubtotalAmountVATGE" Value="116.00"/></Res>');
    }
    if (name === 'CashPayCloseReceipt') {
      if (mode === 'no-signature') return res.end('<Res Code="0"/>');
      return res.end('<Res Code="0"><Res Name="cuInvoiceNumber" Value="KRAMW011202207061496000000123"/><Res Name="cuSerialNumber" Value="KRAMW011202207061496"/><Res Name="qrCode" Value="https://itax.kra.go.ke/KRA-Portal/invoiceChk.htm?invoiceNo=123"/><Res Name="dateTime" Value="20261108120000"/></Res>');
    }
    return res.end('<Res Code="0"/>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const sale = (): EtimsSale => ({
  invcNo: 123, orgInvcNo: 0, trdInvcNo: '1001', custTin: null, custNm: null, salesTyCd: 'N', rcptTyCd: 'S', pmtTyCd: '01', salesSttsCd: '02',
  cfmDt: '20261108120000', salesDt: '20261108', totItemCnt: 1, taxblAmtB: 100, taxAmtB: 16, taxRtB: 16, totTaxblAmt: 100, totTaxAmt: 16, totAmt: 116,
  prchrAcptcYn: 'N', remark: null, regrId: 'pos', regrNm: 'POS', modrId: 'pos', modrNm: 'POS',
  receipt: { rptNo: 123, trdeNm: 'Shop', prchrAcptcYn: 'N' },
  itemList: [{ itemSeq: 1, itemCd: 'KE2NTU0000001', plu: '1', itemClsCd: '50202200', itemNm: 'Milk', bcd: null, pkgUnitCd: 'NT', pkg: 1, qtyUnitCd: 'U', qty: 1, prc: 116, splyAmt: 116, dcRt: 0, dcAmt: 0, taxTyCd: 'B', taxblAmt: 100, taxAmt: 16, totAmt: 116 }],
} as EtimsSale);

describe('Tremol ZFP Lab Server Direct API', () => {
  it('parses root and nested SDK result fields, including nonzero device codes', () => {
    expect(parseZfp('<Res Code="0" A="x"/>')).toMatchObject({ code: 0, attrs: { A: 'x' } });
    expect(parseZfp('<Res Code="0"><Res Name="Model" Value="G03 &amp; fiscal"/></Res>')).toMatchObject({ code: 0, attrs: { Model: 'G03 & fiscal' } });
    expect(parseZfp('<Res Code="58" Technical="busy"/>').code).toBe(58);
  });

  it('reads the model, serial and status for connection testing', async () => {
    const c = new TremolZfpClient({ url: base });
    expect((await c.readVersion()).attrs.Model).toBe('Tremol G03');
    expect((await c.readSerialAndFiscalNums()).attrs.SerialNumber).toBe('KRAMW011202207061496');
    expect((await c.readStatus()).attrs.Printer_not_ready_no_paper).toBe('0');
  });

  it('validates the programmed PLU and VAT, then follows the SDK receipt sequence', async () => {
    mode = 'ok';
    currentInfoCount = 0;
    calls.length = 0;
    const gateway = new TremolGateway({ url: base, operatorNum: '1', operatorPass: '0', vatClassByTaxCode: { B: '2' } });
    const sig = await gateway.saveSale(sale());
    const names = calls.map((c) => c.replace(/\(.*/, ''));
    expect(names).toEqual(['ReadStatus', 'ReadCurrentReceiptInfo', 'ReadVATrates', 'ReadPLUallData', 'OpenReceipt', 'SellPLUFromFD_DB', 'ReadCurrentReceiptInfo', 'CashPayCloseReceipt']);
    expect(calls.find((c) => c.startsWith('OpenReceipt('))).toContain('OperNum=1,OperPass=0,OptionReceiptFormat=1,OptionFiscalRcpPrintType=0');
    expect(calls.find((c) => c.startsWith('SellPLUFromFD_DB('))).toContain('OptionSign=+,PLUNum=00001,Price=116.00,Quantity=1');
    expect(sig.cuInvoiceNo).toBe('KRAMW011202207061496000000123');
    expect(sig.qrUrl).toContain('itax.kra.go.ke');
    expect(sig.rcptSign).toBe('KRAMW011202207061496000000123');
  });

  it('does not open a receipt without a product PLU', async () => {
    calls.length = 0;
    await expect(new TremolGateway({ url: base, vatClassByTaxCode: { B: '2' } }).saveSale({ ...sale(), itemList: [{ ...sale().itemList[0]!, plu: null }] })).rejects.toThrow(/needs its 1–5 digit Tremol PLU/);
    expect(calls).toEqual([]);
  });

  it('treats a nonzero device code as a refusal and never calls it signed', async () => {
    mode = 'refuse';
    currentInfoCount = 0;
    await expect(new TremolGateway({ url: base, vatClassByTaxCode: { B: '2' } }).saveSale(sale())).rejects.toThrow(/refused CashPayCloseReceipt/);
  });

  it('leaves a closed device receipt for reconciliation when the SDK has no KRA invoice signature', async () => {
    mode = 'no-signature';
    currentInfoCount = 0;
    await expect(new TremolGateway({ url: base, vatClassByTaxCode: { B: '2' } }).saveSale(sale())).rejects.toThrow(/did not include a KRA CU invoice number\/signature/);
  });

  it('refuses a non-local ZFP address', async () => {
    await expect(new TremolZfpClient({ url: 'http://8.8.8.8:4444/' }).readVersion()).rejects.toThrow(/this computer or the shop network/);
  });
});
