/**
 * Tremol fiscal units through Tremol ZFP Lab Server's Direct API.
 *
 * This follows the bundled DirectAPI SDK signatures: OpenReceipt, SellPLUFromFD_DB,
 * Payment / CashPayCloseReceipt, and CloseReceipt. PLUs and VAT rates live in the
 * device; Afey POS reads them before opening a receipt and never programs the unit.
 */
import { IntegrationError } from '../http.js';
import { classifyTransportError, FiscalUncertainError, FiscalUnsupportedError } from '../fiscal/adapter.js';
import { readEtrSignature, type EtrConfig, type EtrSignature } from './etr.js';
import type { EtimsGateway, EtimsItem, EtimsSale } from './client.js';

type TaxCode = 'A' | 'B' | 'C' | 'D' | 'E';
type VatClass = '1' | '2' | '3' | '4' | '5';

export interface TremolConfig {
  url?: string;
  operatorNum?: string;
  operatorPass?: string;
  cuSerial?: string;
  timeoutSeconds?: number;
  /** KRA tax type to the unit's configured Tremol VAT class. These must be read from the unit's setup. */
  vatClassByTaxCode?: Partial<Record<TaxCode, VatClass>>;
  fieldInvoice?: string;
  fieldSerial?: string;
  fieldQr?: string;
  fieldDate?: string;
}

export interface TremolAnswer {
  code: number;
  attrs: Record<string, string>;
  raw: string;
}

function decodeXml(value: string) {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** ZFP replies may put result fields on the root Res element or in nested Res Name/Value elements. */
export function parseZfp(xml: string): TremolAnswer {
  const raw = xml.trim().replace(/^\uFEFF/, '');
  const attrs: Record<string, string> = {};
  const root = raw.match(/<Res\b([^>]*)\/?\s*>/i)?.[1] ?? raw.match(/<CommandResult\b([^>]*)\/?\s*>/i)?.[1] ?? '';
  for (const match of root.matchAll(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/g)) attrs[match[1]!] = decodeXml(match[3]!);
  for (const match of raw.matchAll(/<(?:Res|Result)\b([^>]*)\/?\s*>/gi)) {
    const childAttrs: Record<string, string> = {};
    for (const attr of match[1]!.matchAll(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/g)) childAttrs[attr[1]!.toLowerCase()] = decodeXml(attr[3]!);
    if (childAttrs.name && childAttrs.value !== undefined) attrs[childAttrs.name] = childAttrs.value;
  }
  const codeStr = attrs.Code ?? attrs.code ?? '0';
  const code = Number(codeStr);
  return { code: Number.isFinite(code) ? code : -1, attrs, raw };
}

/** ZFP Lab Server must be local to the till computer or the shop network. */
function assertLocal(url: string): URL {
  let u: URL;
  try { u = new URL(url); }
  catch { throw new IntegrationError(`"${url}" is not a valid Tremol ZFP Lab Server address`, undefined, undefined, false); }
  if (!/^https?:$/.test(u.protocol) || !/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|localhost$|\[::1\]$)/.test(u.hostname)) {
    throw new IntegrationError('Tremol ZFP Lab Server must be on this computer or the shop network (for example http://127.0.0.1:4444)', undefined, undefined, false);
  }
  return u;
}

function attr(attrs: Record<string, string>, key: string) {
  const actual = Object.keys(attrs).find((name) => name.toLowerCase() === key.toLowerCase());
  return actual ? attrs[actual] : undefined;
}

function money(n: number) { return (Math.round(n * 100) / 100).toFixed(2); }
function decimal(n: number, digits = 6) { return Number(n.toFixed(digits)).toString(); }
function numberValue(v: string | undefined) {
  if (v == null) return NaN;
  const n = Number(v.replace(/%/g, '').replace(',', '.').trim());
  return Number.isFinite(n) ? n : NaN;
}

const TAX_RATE: Record<TaxCode, number> = { A: 0, B: 16, C: 0, D: 0, E: 8 };
const BLOCKING_STATUS = [
  'FM_Read_only', 'Power_down_in_opened_fiscal_receipt', 'Printer_not_ready_overheat', 'DateTime_not_set',
  'DateTime_wrong', 'RAM_reset', 'Hardware_clock_error', 'Printer_not_ready_no_paper', 'Reports_registers_Overflow',
  'FM_error', 'FM_full', 'SD_card_full', 'No_FM_module',
];
const PAYMENTS: Record<string, { key: string; terms: string[] }> = {
  '02': { key: 'credit', terms: ['credit', 'account'] },
  '04': { key: 'bank', terms: ['bank', 'transfer'] },
  '05': { key: 'card', terms: ['card', 'visa', 'master', 'debit'] },
  '06': { key: 'mobile money', terms: ['mobile', 'mpesa', 'm-pesa'] },
  '07': { key: 'other', terms: ['other', 'voucher', 'loyalty'] },
};

export class TremolZfpClient {
  constructor(private cfg: TremolConfig) {}

  private base() { return assertLocal(this.cfg.url || 'http://127.0.0.1:4444/'); }
  private timeout() { return Math.min(120, Math.max(5, Number(this.cfg.timeoutSeconds) || 30)) * 1000; }

  /** Direct API form: GET /Command(Name=value,Name=value). */
  async command(name: string, args: Record<string, string | number> = {}): Promise<TremolAnswer> {
    const base = this.base();
    const query = Object.entries(args).map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`).join(',');
    const target = new URL(`${name}(${query})`, base);
    let response: Response;
    try { response = await fetch(target, { signal: AbortSignal.timeout(this.timeout()) }); }
    catch (err) { throw classifyTransportError(err, `Tremol ZFP Lab Server at ${base.origin}`); }
    const text = await response.text();
    if (!response.ok) throw new IntegrationError(`Tremol ZFP Lab Server answered HTTP ${response.status} for ${name}`, response.status, text.slice(0, 500), response.status >= 500);
    const result = parseZfp(text);
    if (result.code !== 0) {
      const why = attr(result.attrs, 'Technical') ?? attr(result.attrs, 'Message') ?? `device error ${result.code}`;
      throw new IntegrationError(`Tremol device refused ${name}: ${why}`, 422, result.raw.slice(0, 500), false);
    }
    return result;
  }

  async readVersion() { return this.command('ReadVersion'); }
  async readStatus() { return this.command('ReadStatus'); }
  async readSerialAndFiscalNums() { return this.command('ReadSerialAndFiscalNums'); }
  async readLastReceiptNum() { return this.command('ReadLastReceiptNum'); }
  async readVatRates() { return this.command('ReadVATrates'); }
  async readPlu(plu: string) { return this.command('ReadPLUallData', { PLUNum: plu }); }
  async readPayments() { return this.command('ReadPayments'); }
  async readCurrentReceiptInfo() { return this.command('ReadCurrentReceiptInfo'); }

  async initialize() {
    const [version, serial, status] = await Promise.all([this.readVersion(), this.readSerialAndFiscalNums(), this.readStatus()]);
    return {
      model: attr(version.attrs, 'Model'),
      serial: attr(serial.attrs, 'SerialNumber') ?? this.cfg.cuSerial,
      fiscalMemory: attr(serial.attrs, 'FMNumber'),
      status: status.attrs,
    };
  }

  private vatClass(code: string): VatClass {
    if (!'ABCDE'.includes(code)) throw new IntegrationError(`KRA tax code "${code}" is not supported by the Tremol adapter`, undefined, undefined, false);
    const configured = this.cfg.vatClassByTaxCode?.[code as TaxCode];
    if (!configured || !/^[1-5]$/.test(configured)) throw new IntegrationError(`Configure the Tremol VAT class for KRA tax code ${code} (in the unit's VAT settings) before sending receipts`, undefined, undefined, false);
    return configured;
  }

  /** Check configured product PLUs and VAT groups before opening a fiscal receipt. */
  private async preflight(sale: EtimsSale) {
    if (!sale.itemList.length) throw new IntegrationError('Tremol cannot sign an empty receipt', undefined, undefined, false);
    const lines = sale.itemList.map((line) => {
      const plu = String(line.plu ?? '').trim();
      if (!/^\d{1,5}$/.test(plu)) throw new IntegrationError(`Product "${line.itemNm}" needs its 1–5 digit Tremol PLU before it can be sold`, undefined, undefined, false);
      if (!Number.isFinite(line.qty) || line.qty <= 0 || !Number.isFinite(line.prc) || line.prc < 0 || !Number.isFinite(line.dcAmt) || line.dcAmt < 0) {
        throw new IntegrationError(`Product "${line.itemNm}" has an invalid quantity, price, or discount`, undefined, undefined, false);
      }
      return { line, plu: String(Number(plu)).padStart(5, '0'), vatClass: this.vatClass(line.taxTyCd) };
    });
    const status = (await this.readStatus()).attrs;
    const faults = BLOCKING_STATUS.filter((name) => attr(status, name) === '1');
    if (faults.length) throw new IntegrationError(`Tremol is connected but not ready: ${faults.join(', ')}`, 409, status, false);
    const current = await this.readCurrentReceiptInfo();
    if (attr(current.attrs, 'OptionIsReceiptOpened') === '1') throw new IntegrationError('The Tremol device already has an open receipt. Close or cancel it on the device before sending another sale.', 409, current.attrs, false);

    const rates = (await this.readVatRates()).attrs;
    const plUs = new Map<string, TremolAnswer>();
    for (const { plu } of lines) if (!plUs.has(plu)) plUs.set(plu, await this.readPlu(plu));
    for (const { line, plu, vatClass } of lines) {
      const item = plUs.get(plu)!.attrs;
      if (String(Number(attr(item, 'PLUNum'))) !== String(Number(plu))) throw new IntegrationError(`Tremol did not return the configured PLU ${Number(plu)}`, 422, item, false);
      const actualClass = attr(item, 'OptionVATClass');
      if (actualClass !== vatClass) throw new IntegrationError(`PLU ${Number(plu)} (${line.itemNm}) uses Tremol VAT class ${actualClass ?? 'unknown'}, but KRA tax code ${line.taxTyCd} is configured for class ${vatClass}`, 422, item, false);
      const taxClassName: Record<VatClass, string> = { '1': 'A', '2': 'E', '3': 'J', '4': 'K', '5': 'M' };
      const deviceRate = numberValue(attr(rates, `VATrate${taxClassName[vatClass]}`));
      if (!Number.isFinite(deviceRate) || Math.abs(deviceRate - TAX_RATE[line.taxTyCd as TaxCode]) > 0.001) {
        throw new IntegrationError(`Tremol VAT rate for class ${taxClassName[vatClass]} (${Number.isFinite(deviceRate) ? `${deviceRate}%` : 'unavailable'}) does not match KRA tax code ${line.taxTyCd} (${TAX_RATE[line.taxTyCd as TaxCode]}%)`, 422, rates, false);
      }
    }

    let paymentSlot: number | undefined;
    if (sale.pmtTyCd !== '01') {
      const requirement = PAYMENTS[sale.pmtTyCd];
      if (!requirement) throw new IntegrationError(`Tremol payment type ${sale.pmtTyCd} is not supported`, undefined, undefined, false);
      const payments = (await this.readPayments()).attrs;
      const candidates = [0, 1, 2, 3].filter((slot) => {
        const label = attr(payments, `NamePaym${slot}`)?.toLowerCase() ?? '';
        return requirement.terms.some((term) => label.includes(term));
      });
      if (candidates.length !== 1) throw new IntegrationError(`Set exactly one Tremol payment label to match ${requirement.key}, then retry`, 422, payments, false);
      paymentSlot = candidates[0];
    }
    return { lines, paymentSlot };
  }

  async issueReceipt(sale: EtimsSale): Promise<EtrSignature> {
    if (sale.rcptTyCd !== 'S') throw new FiscalUnsupportedError('Credit notes/refund receipts (the supplied SDK requires the original Tremol receipt number)', 'Tremol ZFP Lab Server');
    const prepared = await this.preflight(sale);
    const operatorNum = this.cfg.operatorNum || '1';
    const operatorPass = this.cfg.operatorPass || '0';
    await this.command('OpenReceipt', { OperNum: operatorNum, OperPass: operatorPass, OptionReceiptFormat: 1, OptionFiscalRcpPrintType: 0 });
    let receiptCancelled = false;
    try {
      for (const { line, plu } of prepared.lines) {
        const discountRate = line.splyAmt > 0 ? -(line.dcAmt / line.splyAmt) * 100 : 0;
        await this.command('SellPLUFromFD_DB', {
          OptionSign: '+', PLUNum: plu, Price: money(line.prc), Quantity: decimal(line.qty),
          ...(line.dcAmt ? { DiscAddP: decimal(discountRate, 5) } : {}),
        });
      }
      const info = await this.readCurrentReceiptInfo();
      const expected = money(sale.totAmt);
      const classes = ['A', 'E', 'J', 'K', 'M'];
      const actual = money(classes.reduce((sum, c) => sum + (numberValue(attr(info.attrs, `SubtotalAmountVATG${c}`)) || 0), 0));
      if (actual !== expected) {
        await this.command('CancelReceipt');
        receiptCancelled = true;
        throw new IntegrationError(`Tremol receipt total ${actual} does not match POS total ${expected}; the open receipt was cancelled`, 422, info.attrs, false);
      }
    } catch (err) {
      if (receiptCancelled) throw err;
      try { await this.command('CancelReceipt'); }
      catch (cancelError) { throw new FiscalUncertainError('Tremol could not confirm cancellation of the open receipt after a line error; check the device before retrying', cancelError); }
      throw err;
    }

    let close: TremolAnswer;
    try {
      if (sale.pmtTyCd === '01') close = await this.command('CashPayCloseReceipt');
      else {
        await this.command('Payment', { OptionPaymentType: prepared.paymentSlot!, OptionChange: 1, Amount: money(sale.totAmt) });
        close = await this.command('CloseReceipt');
      }
    } catch (err) {
      // A lost reply while paying/closing may mean the receipt was already finalized.
      if (err instanceof IntegrationError && !err.retryable) {
        try { await this.command('CancelReceipt'); }
        catch (cancelError) { throw new FiscalUncertainError('Tremol refused payment/close and its open receipt could not be cancelled; check the device before retrying', cancelError); }
        throw err;
      }
      throw new FiscalUncertainError('Tremol payment/close did not return a definitive result; check the device journal before retrying', err);
    }

    const signatureConfig: EtrConfig = {
      connection: 'http', cuSerial: this.cfg.cuSerial,
      fieldInvoice: this.cfg.fieldInvoice, fieldSerial: this.cfg.fieldSerial, fieldQr: this.cfg.fieldQr, fieldDate: this.cfg.fieldDate,
    };
    try { return readEtrSignature(close.attrs, signatureConfig); }
    catch {
      const last = (await this.readLastReceiptNum().catch(() => ({ attrs: {} }))).attrs;
      throw new FiscalUncertainError(
        `Tremol closed the local fiscal receipt, but the SDK answer did not include a KRA CU invoice number/signature. The receipt counter is ${attr(last, 'TotalFiscalRcpCounter') ?? 'unavailable'}; reconcile the device journal before retrying.`,
        { close: close.attrs, lastReceipt: last },
      );
    }
  }
}

export class TremolGateway implements EtimsGateway {
  private client: TremolZfpClient;
  constructor(private cfg: TremolConfig) { this.client = new TremolZfpClient(cfg); }

  async initialize() {
    const device = await this.client.initialize();
    return { cuSerial: device.serial };
  }
  async testConnection(): Promise<string> {
    const device = await this.client.initialize();
    return `Tremol ZFP Lab Server is connected${device.model ? ` (${device.model})` : ''}${device.serial ? ` · CU ${device.serial}` : ''}`;
  }
  async saveItem(_item: EtimsItem) { /* ZFP SDK sells its own programmed PLUs; Afey never changes the fiscal unit's catalogue. */ }
  async saveSale(sale: EtimsSale): Promise<EtrSignature> {
    return this.client.issueReceipt(sale);
  }
}
