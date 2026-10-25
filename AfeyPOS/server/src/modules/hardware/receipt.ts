import { formatMoney, paymentProviderLabel } from '@afeypos/shared';
import qrcode from 'qrcode-generator';
import { EscPosBuilder } from './escpos.js';

interface ReceiptTenant {
  name: string;
  settings?: { currency?: string; receiptHeader?: string | null; receiptFooter?: string | null; taxPin?: string | null; timezone?: string; locale?: string } | null;
  contact?: { phone?: string | null; address?: string | null } | null;
}
interface ReceiptSale {
  number: string;
  completedAt: Date | string;
  lines: { name?: string | null; qty?: number | null; unitCode?: string | null; unitPriceCents?: number | null; totalCents?: number | null; discountCents?: number | null; serials?: string[] | null }[];
  grossCents?: number | null;
  discountCents?: number | null;
  taxCents?: number | null;
  totalCents: number;
  payments: { method: string; provider?: string | null; amountCents: number; reference?: string | null; tenderedCents?: number | null; changeCents?: number | null }[];
  changeCents?: number | null;
  creditCents?: number | null;
  status?: string;
  etims?: { status?: string | null; invcNo?: number | null; rcptNo?: number | null; totRcptNo?: number | null; intrlData?: string | null; rcptSign?: string | null; sdcId?: string | null; mrcNo?: string | null; sdcDateTime?: string | null; qrUrl?: string | null } | null;
}

/** "20261025143000" -> "25/10/2026 14:30:00" */
const etimsTime = (s?: string | null) => (s && /^\d{14}$/.test(s) ? `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)} ${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}` : (s ?? ''));

/** The KRA eTIMS block every fiscal receipt must carry once the invoice is signed. */
export function etimsLines(sale: ReceiptSale, width: number): string[] {
  const e = sale.etims;
  if (!e) return [];
  const wrap = (label: string, v: string) => {
    const out: string[] = [];
    let rest = `${label}${v}`;
    while (rest.length > width) {
      out.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    out.push(rest);
    return out;
  };
  if (e.status !== 'signed') return ['-'.repeat(width), 'KRA eTIMS: awaiting signature', 'Reprint this receipt for the signed copy'];
  return [
    '-'.repeat(width), 'KRA eTIMS',
    pad('CU Invoice No.', `${e.sdcId ?? ''}/${e.rcptNo ?? ''}`, width),
    pad('SCU ID', e.sdcId ?? '', width),
    pad('MRC No.', e.mrcNo ?? '', width),
    pad('Invoice No.', String(e.invcNo ?? ''), width),
    pad('Date', etimsTime(e.sdcDateTime), width),
    ...wrap('Internal data: ', e.intrlData ?? ''),
    ...wrap('Receipt signature: ', e.rcptSign ?? ''),
  ];
}

function pad(left: string, right: string, width: number) {
  const space = Math.max(1, width - left.length - right.length);
  return (left + ' '.repeat(space) + right).slice(0, Math.max(width, left.length + right.length + 1));
}

function money(c: number, currency: string) {
  return formatMoney(c, currency).replace(/\u00a0/g, ' ');
}

export function receiptLines(tenant: ReceiptTenant, sale: ReceiptSale, width = 42, cashierName?: string): string[] {
  const cur = tenant.settings?.currency ?? 'KES';
  const out: string[] = [];
  const when = new Date(sale.completedAt).toLocaleString(tenant.settings?.locale ?? 'en-KE', { timeZone: tenant.settings?.timezone ?? 'Africa/Nairobi' });
  out.push(`Receipt: ${sale.number}`, `Date: ${when}`);
  if (cashierName) out.push(`Served by: ${cashierName}`);
  if (sale.status === 'voided') out.push('*** VOIDED ***');
  out.push('-'.repeat(width));
  for (const l of sale.lines) {
    out.push((l.name ?? '').slice(0, width));
    out.push(pad(`  ${l.qty} ${l.unitCode ?? ''} x ${money(l.unitPriceCents ?? 0, cur)}`, money(l.totalCents ?? 0, cur), width));
    if (l.discountCents) out.push(pad('  Discount', '-' + money(l.discountCents, cur), width));
    for (const s of l.serials ?? []) out.push(`  S/N: ${s}`);
  }
  out.push('-'.repeat(width));
  if (sale.discountCents) out.push(pad('Discounts', '-' + money(sale.discountCents, cur), width));
  out.push(pad('TOTAL', money(sale.totalCents, cur), width));
  if (sale.taxCents) out.push(pad('Incl. tax', money(sale.taxCents, cur), width));
  for (const p of sale.payments) {
    const label = p.method === 'gateway' ? paymentProviderLabel(p.provider) : p.method === 'mpesa' ? 'M-Pesa' : p.method;
    out.push(pad(label.toUpperCase() + (p.reference ? ` ${p.reference}` : ''), money(p.tenderedCents ?? p.amountCents, cur), width));
  }
  if (sale.changeCents) out.push(pad('Change', money(sale.changeCents, cur), width));
  if (sale.creditCents) out.push(pad('On account', money(sale.creditCents, cur), width));
  out.push(...etimsLines(sale, width));
  return out;
}

export function renderReceiptText(tenant: ReceiptTenant, sale: ReceiptSale, width = 42, cashierName?: string): string {
  const head = [tenant.name, tenant.settings?.receiptHeader, tenant.contact?.phone ? `Tel: ${tenant.contact.phone}` : null, tenant.settings?.taxPin ? `PIN: ${tenant.settings.taxPin}` : null].filter(Boolean) as string[];
  return [...head, '', ...receiptLines(tenant, sale, width, cashierName), '', tenant.settings?.receiptFooter ?? '', 'Powered by Afey POS'].join('\n');
}

export function renderReceiptEscPos(tenant: ReceiptTenant, sale: ReceiptSale, opts: { width?: number; openDrawer?: boolean; cashierName?: string } = {}): Buffer {
  const width = opts.width ?? 42;
  const b = new EscPosBuilder(width);
  b.align('center').bold(true).size(true).line(tenant.name).size(false).bold(false);
  if (tenant.settings?.receiptHeader) b.line(tenant.settings.receiptHeader);
  if (tenant.contact?.phone) b.line(`Tel: ${tenant.contact.phone}`);
  if (tenant.settings?.taxPin) b.line(`PIN: ${tenant.settings.taxPin}`);
  b.align('left').line();
  for (const l of receiptLines(tenant, sale, width, opts.cashierName)) {
    if (l.startsWith('TOTAL')) b.bold(true).line(l).bold(false);
    else b.line(l);
  }
  b.line().align('center');
  if (sale.etims?.status === 'signed' && sale.etims.qrUrl) b.qr(sale.etims.qrUrl).line();
  if (tenant.settings?.receiptFooter) b.line(tenant.settings.receiptFooter);
  b.barcode(sale.number).line().line('Powered by Afey POS').feed(4).cut();
  if (opts.openDrawer) b.openDrawer(0);
  return b.build();
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function renderReceiptHtml(tenant: ReceiptTenant, sale: ReceiptSale, cashierName?: string): string {
  const text = renderReceiptText(tenant, sale, 42, cashierName);
  let qrSvg = '';
  if (sale.etims?.status === 'signed' && sale.etims.qrUrl) {
    const qr = qrcode(0, 'M');
    qr.addData(sale.etims.qrUrl);
    qr.make();
    qrSvg = `<div class="qr">${qr.createSvgTag({ cellSize: 3, margin: 2, scalable: true })}<div>Scan to verify with KRA</div></div>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(sale.number)}</title><style>
  @page { size: 80mm auto; margin: 4mm; } body { font: 12px/1.35 ui-monospace, Menlo, Consolas, monospace; width: 72mm; margin: 0 auto; color: #000; }
  pre { white-space: pre-wrap; margin: 0; } .qr { text-align: center; margin: 8px 0; } .qr svg { width: 34mm; height: 34mm; }</style></head><body><pre>${esc(text)}</pre>${qrSvg}</body></html>`;
}

interface ReceiptReturn {
  number: string;
  createdAt: Date | string;
  lines: { name?: string | null; qty?: number | null; refundCents?: number | null; taxCents?: number | null }[];
  refundCents?: number | null;
  refundMethod?: string | null;
  reason?: string | null;
  isVoid?: boolean | null;
  etims?: ReceiptSale['etims'];
}

/** A return printed as a credit note: same layout as a receipt, refund lines and the KRA block of the credit note. */
export function creditNoteAsReceipt(ret: ReceiptReturn, sale: { number: string }): { header: string; sale: ReceiptSale } {
  const lines = ret.lines.map((l) => ({ name: l.name, qty: l.qty, unitCode: '', unitPriceCents: l.qty ? Math.round((l.refundCents ?? 0) / l.qty) : 0, totalCents: l.refundCents }));
  const method = ret.refundMethod === 'credit_note' ? 'store credit' : ret.refundMethod === 'account' ? 'to account' : (ret.refundMethod ?? 'cash');
  return {
    header: `CREDIT NOTE ${ret.number}\nFor receipt ${sale.number}${ret.reason ? `\nReason: ${ret.reason}` : ''}`,
    sale: {
      number: ret.number, completedAt: ret.createdAt, lines, totalCents: ret.refundCents ?? 0, taxCents: ret.lines.reduce((a, l) => a + (l.taxCents ?? 0), 0),
      payments: [{ method: `refund ${method}`, amountCents: ret.refundCents ?? 0 }], etims: ret.etims,
    },
  };
}
