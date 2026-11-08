/**
 * Tremol fiscal control units (e.g. the G03 Type B/C sold for KRA eTIMS by Total Solutions) are driven on the
 * till PC by the "Tremol ZFP Lab Server", a small program that listens on this computer (by default
 * http://127.0.0.1:4444/) and turns HTTP calls into the device's own fiscal commands.
 *
 * The ZFP HTTP interface is a GET whose PATH is the command and its arguments, e.g.
 *     GET http://127.0.0.1:4444/ReadVersion()
 *     GET http://127.0.0.1:4444/OpenReceipt(1,0000,0,...)
 * and the answer is a short XML element whose Code attribute is 0 on success and non-zero on error:
 *     <Res Code="0" .../>            (ok, maybe with extra attributes carrying returned values)
 *     <Res Code="58" Technical="..."/>  (the device refused the command)
 * A non-zero Code is ALWAYS treated as a failure here: a refused command is never read as success.
 *
 * A fiscal receipt is issued with the documented command sequence
 *     OpenReceipt(...) → SellPLUwithSpecifiedVAT(...) per line → CloseReceipt()
 * and the control-unit (SCU) invoice number, signature and QR link are read from the answers.
 *
 * IMPORTANT: the exact argument list of OpenReceipt / SellPLUwithSpecifiedVAT / CloseReceipt differs between
 * device models and firmware. The templates below follow Tremol's documented Kenya signatures, but every
 * deployment MUST confirm them against the ZFP manual for the installed G03 and verify a real test receipt on
 * the KRA portal before going live. Each template can be overridden in the device configuration without code
 * changes. See docs/KRA-ETR-DEVICE.md.
 */
import { IntegrationError } from '../http.js';
import { classifyTransportError, FiscalUncertainError } from '../fiscal/adapter.js';
import { readEtrSignature, toEtrInvoice, type EtrConfig, type EtrInvoice, type EtrSignature } from './etr.js';
import type { EtimsGateway, EtimsItem, EtimsSale } from './client.js';

export interface TremolConfig {
  /** The ZFP Lab Server address on this computer or the shop network (default http://127.0.0.1:4444/). */
  url?: string;
  /** Operator (cashier) number and password the device expects when opening a receipt. */
  operatorNum?: string;
  operatorPass?: string;
  cuSerial?: string;
  timeoutSeconds?: number;
  /**
   * Command templates (argument tokens). Placeholders in {curly braces} are filled per receipt / per line.
   * Leave empty to use the documented defaults below. Set them from your device's ZFP manual if they differ.
   */
  openReceiptArgs?: string[];
  sellLineArgs?: string[];
  closeReceiptArgs?: string[];
  /** Field names (dotted paths) in the answer, when not one of the usual ones. */
  fieldInvoice?: string;
  fieldSerial?: string;
  fieldQr?: string;
  fieldDate?: string;
}

// The device's VAT group for each KRA tax code (A exempt, B 16%, C zero, D non-VAT, E 8%). The default is the
// KRA tax-code letter itself; firmwares that expect a tax-group number (1..5) use the {vatClassNum} placeholder.
const VAT_CLASS_NUM: Record<string, string> = { A: '1', B: '2', C: '3', D: '4', E: '5' };

/** Documented default argument templates (verify against the installed device's ZFP manual). */
const DEFAULTS = {
  // OpenReceipt(OperNum, OperPass, receiptType, invoiceType, buyerPIN, buyerName)
  openReceiptArgs: ['{operatorNum}', '{operatorPass}', '{receiptType}', '{invoiceType}', '{buyerPin}', '{buyerName}'],
  // SellPLUwithSpecifiedVAT(name, VATclass, price, quantity, discountType, discountValue)
  sellLineArgs: ['{name}', '{vatClass}', '{price}', '{quantity}', '0', '0'],
  // CloseReceipt()
  closeReceiptArgs: [] as string[],
};

const num = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

/** Fills {placeholders} in a template arg list from a context, then URL-encodes each argument. */
function render(tpl: string[], ctx: Record<string, string | number>) {
  return tpl.map((a) => a.replace(/\{(\w+)\}/g, (_, k) => String(ctx[k] ?? '')));
}

export interface TremolAnswer {
  code: number;
  attrs: Record<string, string>;
  raw: string;
}

/** Parses a ZFP answer: <Res Code="0" A="x" B="y"/> → { code:0, attrs:{A:'x',B:'y'} }. */
export function parseZfp(xml: string): TremolAnswer {
  const t = xml.trim().replace(/^\uFEFF/, '');
  const attrs: Record<string, string> = {};
  for (const m of t.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) attrs[m[1]!] = m[2]!;
  const codeStr = attrs.Code ?? attrs.code ?? '0';
  const code = Number(codeStr);
  return { code: Number.isFinite(code) ? code : -1, attrs, raw: t };
}

/** ZFP Lab Server addresses must be local to the shop, never the public internet. */
function assertLocal(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new IntegrationError(`"${url}" is not a valid address for the Tremol ZFP Lab Server`, undefined, undefined, false);
  }
  if (!/^https?:$/.test(u.protocol) || !/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|localhost$|\[::1\]$)/.test(u.hostname)) {
    throw new IntegrationError('The Tremol ZFP Lab Server must be on this computer or the shop network (e.g. http://127.0.0.1:4444)', undefined, undefined, false);
  }
  return u;
}

export class TremolZfpClient {
  constructor(private cfg: TremolConfig) {}

  private base() {
    return assertLocal(this.cfg.url || 'http://127.0.0.1:4444/');
  }
  private timeout() {
    return Math.min(120, Math.max(5, Number(this.cfg.timeoutSeconds) || 30)) * 1000;
  }

  /** One ZFP command: GET <base>/Command(arg,arg,...). Throws on transport error or a non-zero device Code. */
  async command(name: string, args: string[] = []): Promise<TremolAnswer> {
    const base = this.base();
    // The ZFP server parses the command from the path; arguments are URL-encoded and comma-separated inside ().
    const path = `${name}(${args.map((a) => encodeURIComponent(a)).join(',')})`;
    const target = new URL(path, base);
    let res: Response;
    try {
      res = await fetch(target, { signal: AbortSignal.timeout(this.timeout()) });
    } catch (err) {
      throw classifyTransportError(err, `Tremol ZFP Lab Server at ${base.origin}`);
    }
    const text = await res.text();
    if (!res.ok) throw new IntegrationError(`Tremol ZFP Lab Server answered HTTP ${res.status} for ${name}`, res.status, text.slice(0, 300), res.status >= 500);
    const ans = parseZfp(text);
    if (ans.code !== 0) {
      const why = ans.attrs.Technical || ans.attrs.technical || ans.attrs.Message || ans.attrs.message || `code ${ans.code}`;
      throw new IntegrationError(`Tremol device refused ${name}: ${why}`, 422, ans.raw.slice(0, 300), false);
    }
    return ans;
  }

  async readVersion() {
    return this.command('ReadVersion');
  }
  async readStatus() {
    return this.command('ReadStatus');
  }
  /** Last and total fiscal-receipt numbers: used to see whether a receipt was issued (reconciliation). */
  async readLastReceiptNum() {
    return this.command('ReadLastAndTotalReceiptNum');
  }

  /** Issues one receipt (sale or credit note) and returns the control-unit signature read from the device. */
  async issueReceipt(invoice: EtrInvoice): Promise<EtrSignature> {
    const credit = invoice.type === 'credit_note';
    await this.command('OpenReceipt', render(this.cfg.openReceiptArgs?.length ? this.cfg.openReceiptArgs : DEFAULTS.openReceiptArgs, {
      operatorNum: this.cfg.operatorNum || '1',
      operatorPass: this.cfg.operatorPass || '0000',
      // Receipt type: 0 sale, 1 credit note (confirm the device's own codes).
      receiptType: credit ? '1' : '0',
      invoiceType: credit ? '1' : '0',
      buyerPin: invoice.buyer.pin ?? '',
      buyerName: (invoice.buyer.name ?? '').slice(0, 60),
      relevantInvoiceNumber: invoice.relevantInvoiceNumber ?? '',
      invoiceNumber: invoice.invoiceNumber,
    }));

    for (const line of invoice.items) {
      await this.command('SellPLUwithSpecifiedVAT', render(this.cfg.sellLineArgs?.length ? this.cfg.sellLineArgs : DEFAULTS.sellLineArgs, {
        name: line.name.slice(0, 72),
        vatClass: line.taxCode || 'B',
        vatClassNum: VAT_CLASS_NUM[line.taxCode] ?? '2',
        price: num(line.unitPrice),
        quantity: num(line.quantity),
        total: num(line.total),
        taxRate: num(line.taxRate),
      }));
    }

    const close = await this.command('CloseReceipt', this.cfg.closeReceiptArgs?.length ? render(this.cfg.closeReceiptArgs, {}) : DEFAULTS.closeReceiptArgs);
    // The SCU invoice number / signature / QR can be on the CloseReceipt answer; if not, read it explicitly.
    let attrs = close.attrs;
    if (!this.hasSignature(attrs)) {
      try {
        attrs = { ...attrs, ...(await this.command('ReadLastReceiptQRcodeData')).attrs };
      } catch {
        /* older firmware without the QR read: fall through and let readEtrSignature report what is missing */
      }
    }
    const asEtr: EtrConfig = { connection: 'http', cuSerial: this.cfg.cuSerial, fieldInvoice: this.cfg.fieldInvoice, fieldSerial: this.cfg.fieldSerial, fieldQr: this.cfg.fieldQr, fieldDate: this.cfg.fieldDate };
    return readEtrSignature(attrs, asEtr);
  }

  private hasSignature(attrs: Record<string, string>) {
    const keys = Object.keys(attrs).map((k) => k.toLowerCase());
    return keys.some((k) => k.includes('invoice') || k.includes('cuin') || k.includes('rcpt') || k.includes('qr'));
  }

  /** Was a receipt with this number already issued? Compares the device's last receipt number. */
  async findIssued(invoice: EtrInvoice): Promise<EtrSignature | null> {
    const ans = await this.readLastReceiptNum();
    const last = Number(ans.attrs.LastReceiptNum ?? ans.attrs.lastReceiptNum ?? ans.attrs.Last ?? 0);
    // The device cannot be asked for a specific past invoice, only its latest; if our sequence is above the
    // device's last number, it was certainly not issued — safe to (re)send.
    if (last < invoice.sequence) return null;
    throw new FiscalUncertainError(`The Tremol device's last receipt number is ${last}; cannot tell whether invoice ${invoice.invoiceNumber} (sequence ${invoice.sequence}) was issued. Check the device journal.`);
  }
}

/** The fiscal gateway for a Tremol control unit reached through the ZFP Lab Server. */
export class TremolGateway implements EtimsGateway {
  private client: TremolZfpClient;
  constructor(cfg: TremolConfig, private seller: { name?: string; pin?: string } = {}) {
    this.client = new TremolZfpClient(cfg);
  }

  /** "Initialise": confirm the ZFP Lab Server answers and the device reports its version. */
  async initialize() {
    const v = await this.client.readVersion();
    return { sdcId: v.attrs.SerialNumber ?? v.attrs.serialNumber ?? undefined };
  }

  /** TIMS control units keep no item list; nothing to register in advance. */
  async saveItem(_item: EtimsItem) {}

  async saveSale(sale: EtimsSale): Promise<EtrSignature> {
    return this.client.issueReceipt(toEtrInvoice(sale, this.seller));
  }

  async findSale(sale: EtimsSale): Promise<EtrSignature | null> {
    return this.client.findIssued(toEtrInvoice(sale, this.seller));
  }
}
