/**
 * A KRA ETR device (TIMS control unit / fiscal device) on the Afey POS computer. Every brand speaks its own protocol
 * to the device, so Afey POS talks to the program that comes with it on the PC, in one of two common ways:
 *
 *  - "http":   the program listens on this computer (e.g. http://127.0.0.1:4444); Afey POS POSTs the invoice as JSON
 *              and reads the signature from the JSON answer.
 *  - "folder": Afey POS writes the invoice as <invoice>.json into the program's inbox folder; the program writes its
 *              answer (JSON, or "key=value" / "key: value" lines) as <invoice>.json/.txt into the outbox folder.
 *  - "simulator": no device; for training and testing.
 *
 * The answer's field names differ between programs; the usual names are recognised, and each can be set in the
 * configuration (dotted paths, e.g. "data.cuInvoiceNumber"). See docs/KRA-ETR-DEVICE.md for the exact format.
 */
import fs from 'node:fs';
import path from 'node:path';
import { IntegrationError } from '../http.js';
import { classifyTransportError, FiscalDisconnectedError, FiscalUncertainError } from '../fiscal/adapter.js';
import type { EtimsGateway, EtimsItem, EtimsSale, EtimsSignature } from './client.js';

export interface EtrConfig {
  connection: 'http' | 'folder' | 'simulator';
  /** http: the program's address on this computer, and the path invoices are sent to. */
  url?: string;
  invoicePath?: string;
  /** folder: where invoices go and where the answers appear. */
  inbox?: string;
  outbox?: string;
  /** The control unit's serial number, when the answer does not carry it. */
  cuSerial?: string;
  timeoutSeconds?: number;
  /** Field names in the answer (dotted paths), when they are not one of the usual ones. */
  fieldInvoice?: string;
  fieldSerial?: string;
  fieldQr?: string;
  fieldDate?: string;
  /** Extra header for programs that want a key (e.g. "Authorization: Bearer x" or "X-Api-Key: x"). */
  authHeader?: string;
  /**
   * http: where the program answers "was this invoice signed?", from the maker's documentation, e.g.
   * "/invoice/{invoiceNumber}". Left empty when the program has no such query: an unanswered invoice then goes to
   * reconciliation instead of being sent again.
   */
  statusPath?: string;
}

/** The invoice as Afey POS sends it to the ETR program (documented in docs/KRA-ETR-DEVICE.md). */
export interface EtrInvoice {
  type: 'sale' | 'credit_note';
  invoiceNumber: string;
  relevantInvoiceNumber?: string;
  originalReceipt?: string;
  sequence: number;
  dateTime: string;
  seller: { name?: string; pin?: string };
  buyer: { pin?: string | null; name?: string | null; phone?: string | null };
  cashier: string;
  payment: string;
  items: { name: string; code: string; barcode?: string | null; hsCode?: string; quantity: number; unit: string; unitPrice: number; discount: number; total: number; taxCode: string; taxRate: number; taxAmount: number }[];
  totals: { taxable: number; tax: number; total: number; byTax: { code: string; rate: number; taxable: number; tax: number }[] };
}

export interface EtrSignature extends EtimsSignature {
  cuInvoiceNo: string;
  cuSerial: string;
  qrUrl?: string;
}

const PAYMENT: Record<string, string> = { '01': 'cash', '02': 'credit', '04': 'bank', '05': 'card', '06': 'mobile_money', '07': 'other' };
const RATE: Record<string, number> = { A: 0, B: 16, C: 0, D: 0, E: 8 };

function isoFromEtims(d: string) {
  // yyyyMMddHHmmss in East Africa Time -> ISO with +03:00
  return /^\d{14}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(8, 10)}:${d.slice(10, 12)}:${d.slice(12, 14)}+03:00` : new Date().toISOString();
}

export function toEtrInvoice(sale: EtimsSale & { tin?: string }, seller: { name?: string; pin?: string } = {}): EtrInvoice {
  const credit = sale.rcptTyCd === 'R';
  const byTax = ['A', 'B', 'C', 'D', 'E'].map((code) => ({ code, rate: RATE[code]!, taxable: Number((sale as any)[`taxblAmt${code}`] ?? 0), tax: Number((sale as any)[`taxAmt${code}`] ?? 0) })).filter((t) => t.taxable || t.tax);
  return {
    type: credit ? 'credit_note' : 'sale',
    invoiceNumber: String(sale.trdInvcNo ?? sale.invcNo),
    // Credit note: the original sale's CU invoice number (TIMS asks for it), else its receipt number.
    ...(credit ? { relevantInvoiceNumber: String((sale as any).orgCuInvoiceNo ?? (sale as any).orgTrdInvcNo ?? sale.orgInvcNo ?? ''), originalReceipt: String((sale as any).orgTrdInvcNo ?? '') } : {}),
    sequence: sale.invcNo,
    dateTime: isoFromEtims(sale.cfmDt),
    seller: { name: seller.name ?? sale.receipt?.trdeNm ?? undefined, pin: seller.pin },
    buyer: { pin: sale.custTin ?? null, name: sale.custNm ?? null, phone: sale.receipt?.custMblNo ?? null },
    cashier: sale.regrNm ?? 'POS',
    payment: PAYMENT[sale.pmtTyCd] ?? 'other',
    items: sale.itemList.map((i) => ({
      name: i.itemNm, code: i.itemCd, barcode: i.bcd ?? null, ...(i.itemClsCd && i.itemClsCd !== '99000000' ? { hsCode: i.itemClsCd } : {}),
      quantity: i.qty, unit: i.qtyUnitCd, unitPrice: i.prc, discount: i.dcAmt, total: i.totAmt, taxCode: i.taxTyCd, taxRate: RATE[i.taxTyCd] ?? 0, taxAmount: i.taxAmt,
    })),
    totals: { taxable: sale.totTaxblAmt, tax: sale.totTaxAmt, total: sale.totAmt, byTax },
  };
}

/** Reads a dotted path ("data.cu.invoice") from an object. */
function pick(obj: any, p?: string) {
  if (!p) return undefined;
  return p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function first(obj: any, own: string | undefined, names: string[]) {
  const v = pick(obj, own);
  if (v != null && v !== '') return String(v);
  // The usual names, at the top level or one level down (e.g. { data: {...} } / { result: {...} }).
  for (const scope of [obj, obj?.data, obj?.result, obj?.response]) {
    if (!scope || typeof scope !== 'object') continue;
    for (const n of names) {
      const hit = Object.keys(scope).find((k) => k.toLowerCase() === n.toLowerCase());
      if (hit && scope[hit] != null && scope[hit] !== '') return String(scope[hit]);
    }
  }
  return undefined;
}

/** Parses an answer file: JSON, or "key=value" / "key: value" lines. */
export function parseEtrAnswer(text: string): any {
  const t = text.trim().replace(/^\uFEFF/, '');
  if (t.startsWith('{')) return JSON.parse(t);
  const out: Record<string, string> = {};
  for (const line of t.split(/\r?\n/)) {
    const m = line.match(/^\s*([^=:]+?)\s*[=:]\s*(.*)$/);
    if (m) out[m[1]!.trim()] = m[2]!.trim();
  }
  return out;
}

export function readEtrSignature(answer: any, cfg: EtrConfig): EtrSignature {
  const error = first(answer, undefined, ['error', 'errorMessage', 'message_error']);
  const ok = first(answer, undefined, ['success', 'ok', 'status']);
  const invoice = first(answer, cfg.fieldInvoice, ['cuInvoiceNumber', 'cuInvoiceNo', 'controlUnitInvoiceNumber', 'CUIN', 'invoiceNumberCU', 'cu_invoice_number', 'MiddlewareInvoiceNumber', 'InvoiceNumber']);
  if (!invoice) {
    const why = error ?? (ok && /false|fail|error/i.test(ok) ? `the device answered "${ok}"` : 'the answer has no CU invoice number');
    throw new IntegrationError(`ETR device did not sign the invoice: ${why}. If it signed, set the answer's field name in the configuration.`, 422, answer, false);
  }
  const serial = first(answer, cfg.fieldSerial, ['cuSerialNumber', 'cuSerialNo', 'controlUnitSerialNumber', 'CUSN', 'serialNumber', 'cu_serial_number', 'SerialNumber']) ?? cfg.cuSerial ?? '';
  const qr = first(answer, cfg.fieldQr, ['qrCode', 'qrUrl', 'verificationUrl', 'verifyUrl', 'qr_code', 'QRCode', 'link']);
  const date = first(answer, cfg.fieldDate, ['dateTime', 'cuDateTime', 'signedAt', 'date', 'DateTime']);
  const digits = invoice.replace(/\D/g, '');
  const seq = Number(digits.slice(-9)) || 0;
  return {
    cuInvoiceNo: invoice, cuSerial: serial, qrUrl: qr && /^https?:\/\//i.test(qr) ? qr : undefined,
    // The eTIMS fields the receipt and reports already use.
    curRcptNo: seq, totRcptNo: seq, intrlData: '', rcptSign: invoice, sdcId: serial, sdcDateTime: date ?? '',
  };
}

/** ETR programs run on this computer or the shop network: never reach out to the internet from here. */
function assertLocal(url: string) {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new IntegrationError(`"${url}" is not a valid address for the ETR program`, undefined, undefined, false);
  }
  if (!/^https?:$/.test(u.protocol) || !/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|localhost$|\[::1\]$)/.test(u.hostname)) {
    throw new IntegrationError('The ETR program must be on this computer or the shop network (e.g. http://127.0.0.1:4444)', undefined, undefined, false);
  }
  return u;
}

export class EtrGateway implements EtimsGateway {
  static simulated: EtrInvoice[] = [];
  static simulatedSigned = new Map<string, EtrSignature>();
  constructor(private cfg: EtrConfig, private seller: { name?: string; pin?: string } = {}) {}

  private timeout() {
    return Math.min(120, Math.max(5, Number(this.cfg.timeoutSeconds) || 30)) * 1000;
  }

  /** "Initialise device": checks the program answers (http) or the folders can be used (folder). */
  async initialize() {
    if (this.cfg.connection === 'simulator') return { sdcId: this.cfg.cuSerial || 'KRAMW000SIM0001' };
    if (this.cfg.connection === 'folder') {
      for (const dir of [this.cfg.inbox, this.cfg.outbox]) {
        if (!dir) throw new IntegrationError('Set both the inbox and the outbox folder of the ETR program', undefined, undefined, false);
        try {
          fs.mkdirSync(dir, { recursive: true });
          fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
        } catch {
          throw new IntegrationError(`Afey POS cannot use the folder ${dir}`, undefined, undefined, false);
        }
      }
      return { sdcId: this.cfg.cuSerial || undefined };
    }
    const u = assertLocal(this.cfg.url ?? '');
    try {
      await fetch(u, { signal: AbortSignal.timeout(5000) });
    } catch (err: any) {
      throw new IntegrationError(`The ETR program does not answer at ${u.origin} (${err?.message ?? 'no answer'}). Is it running?`);
    }
    return { sdcId: this.cfg.cuSerial || undefined };
  }

  /** Whether a status query exists for this connection. */
  get canFindSale() {
    return this.cfg.connection !== 'http' || Boolean(this.cfg.statusPath);
  }

  /**
   * Was this invoice already signed? simulator: its own record; folder: the program's answer file (or "never sent");
   * http: the program's documented status address (statusPath). null means not recorded: safe to send.
   */
  async findSale(sale: EtimsSale): Promise<EtrSignature | null> {
    const invoice = toEtrInvoice(sale, this.seller);
    if (this.cfg.connection === 'simulator') return EtrGateway.simulatedSigned.get(invoice.invoiceNumber) ?? null;
    if (this.cfg.connection === 'folder') {
      const { inbox, outbox } = this.cfg;
      if (!inbox || !outbox) throw new IntegrationError('Set both the inbox and the outbox folder of the ETR program', undefined, undefined, false);
      const name = invoice.invoiceNumber.replace(/[^\w.-]/g, '_');
      for (const dir of [outbox, path.join(outbox, 'done')]) {
        for (const ext of ['.json', '.txt', '.out', '']) {
          const f = path.join(dir, `${name}${ext}`);
          if (fs.existsSync(f) && fs.statSync(f).isFile()) {
            const text = fs.readFileSync(f, 'utf8');
            if (!text.trim()) continue;
            const sig = readEtrSignature(parseEtrAnswer(text), this.cfg);
            if (dir === outbox) {
              fs.mkdirSync(path.join(outbox, 'done'), { recursive: true });
              fs.renameSync(f, path.join(outbox, 'done', path.basename(f)));
            }
            return sig;
          }
        }
      }
      if (!fs.existsSync(path.join(path.dirname(path.resolve(outbox)), '.afey-sent', name))) return null;
      throw new FiscalUncertainError(`${invoice.invoiceNumber} was handed to the ETR program, which has not answered yet`);
    }
    if (!this.cfg.statusPath) throw new IntegrationError('This ETR program has no status address set', 501, undefined, false);
    const u = assertLocal(this.cfg.url ?? '');
    const target = new URL(this.cfg.statusPath.replace('{invoiceNumber}', encodeURIComponent(invoice.invoiceNumber)).replace(/^\/?/, '/'), u);
    let res: Response;
    try {
      res = await fetch(target, { headers: this.headers(), signal: AbortSignal.timeout(this.timeout()) });
    } catch (err) {
      throw classifyTransportError(err, `ETR program at ${target.origin}`);
    }
    if (res.status === 404) return null;
    const text = await res.text();
    if (!res.ok) throw new FiscalUncertainError(`ETR program status query answered ${res.status}`, text.slice(0, 500));
    try {
      return readEtrSignature(parseEtrAnswer(text), this.cfg);
    } catch {
      // An answer without a CU invoice number does not prove the invoice was not signed.
      throw new FiscalUncertainError(`ETR program status query for ${invoice.invoiceNumber} has no CU invoice number`, text.slice(0, 500));
    }
  }

  private headers() {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
    const auth = this.cfg.authHeader?.match(/^\s*([\w-]+)\s*:\s*(.+)$/);
    if (auth) headers[auth[1]!] = auth[2]!.trim();
    return headers;
  }

  /** TIMS devices do not need items registered in advance. */
  async saveItem(_item: EtimsItem) {}

  async saveSale(sale: EtimsSale): Promise<EtrSignature> {
    const invoice = toEtrInvoice(sale, this.seller);
    if (this.cfg.connection === 'simulator') {
      EtrGateway.simulated.push(invoice);
      const serial = this.cfg.cuSerial || 'KRAMW000SIM0001';
      const no = `${serial.replace(/\D/g, '').padStart(10, '0').slice(-10)}${String(sale.invcNo).padStart(9, '0')}`;
      const sig = readEtrSignature({ cuInvoiceNumber: no, cuSerialNumber: serial, qrCode: `https://itax.kra.go.ke/KRA-Portal/invoiceChk.htm?actionCode=loadPage&invoiceNo=${no}`, dateTime: invoice.dateTime }, this.cfg);
      EtrGateway.simulatedSigned.set(invoice.invoiceNumber, sig);
      return sig;
    }
    return this.cfg.connection === 'folder' ? this.viaFolder(invoice) : this.viaHttp(invoice);
  }

  private async viaHttp(invoice: EtrInvoice) {
    const u = assertLocal(this.cfg.url ?? '');
    const target = new URL((this.cfg.invoicePath || '/invoice').replace(/^\/?/, '/'), u);
    let res: Response;
    try {
      res = await fetch(target, { method: 'POST', headers: this.headers(), body: JSON.stringify(invoice), signal: AbortSignal.timeout(this.timeout()) });
    } catch (err: any) {
      // Not reachable (nothing sent): retried once it is back. Sent but no answer: it may be signed, so it is checked first.
      throw classifyTransportError(err, `ETR program at ${target.origin}`);
    }
    const text = await res.text();
    let body: any;
    try {
      body = parseEtrAnswer(text);
    } catch {
      body = { error: text.slice(0, 200) };
    }
    if (!res.ok) throw new IntegrationError(`ETR program refused the invoice (${res.status}): ${first(body, undefined, ['error', 'message', 'errorMessage']) ?? text.slice(0, 200)}`, res.status, body, res.status >= 500);
    return readEtrSignature(body, this.cfg);
  }

  private async viaFolder(invoice: EtrInvoice) {
    const { inbox, outbox } = this.cfg;
    if (!inbox || !outbox) throw new IntegrationError('Set both the inbox and the outbox folder of the ETR program', undefined, undefined, false);
    const name = invoice.invoiceNumber.replace(/[^\w.-]/g, '_');
    try {
      fs.mkdirSync(inbox, { recursive: true });
      fs.accessSync(inbox, fs.constants.W_OK);
    } catch (err: any) {
      throw new FiscalDisconnectedError(`Afey POS cannot write to the ETR inbox ${inbox} (${err?.code ?? err?.message})`);
    }
    // Sent once only: a retry waits for the answer and never hands the device the same invoice twice.
    const sentDir = path.join(path.dirname(path.resolve(outbox)), '.afey-sent');
    const sent = path.join(sentDir, name);
    if (!fs.existsSync(sent)) {
      // Written under a temporary name, then renamed, so the program never reads half a file.
      const tmp = path.join(inbox, `${name}.json.part`);
      fs.writeFileSync(tmp, JSON.stringify(invoice, null, 2));
      fs.renameSync(tmp, path.join(inbox, `${name}.json`));
      fs.mkdirSync(sentDir, { recursive: true });
      fs.writeFileSync(sent, new Date().toISOString());
    }
    const deadline = Date.now() + this.timeout();
    while (Date.now() < deadline) {
      for (const ext of ['.json', '.txt', '.out', '']) {
        const f = path.join(outbox, `${name}${ext}`);
        if (!fs.existsSync(f)) continue;
        const text = fs.readFileSync(f, 'utf8');
        if (!text.trim()) continue;
        const sig = readEtrSignature(parseEtrAnswer(text), this.cfg);
        // Keep the answer for the records, out of the way of the next one.
        const done = path.join(outbox, 'done');
        fs.mkdirSync(done, { recursive: true });
        fs.renameSync(f, path.join(done, path.basename(f)));
        return sig;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    // Still in the inbox: the program will answer later, and the retry picks the answer up.
    throw new FiscalUncertainError(`The ETR program did not answer for ${invoice.invoiceNumber} within ${Math.round(this.timeout() / 1000)} s. Is it running and watching ${inbox}?`);
  }
}
