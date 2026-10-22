import { formatMoney } from '@afeypos/shared';
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
  payments: { method: string; amountCents: number; reference?: string | null; tenderedCents?: number | null; changeCents?: number | null }[];
  changeCents?: number | null;
  creditCents?: number | null;
  status?: string;
}

function pad(left: string, right: string, width: number) {
  const space = Math.max(1, width - left.length - right.length);
  return (left + ' '.repeat(space) + right).slice(0, Math.max(width, left.length + right.length + 1));
}

function money(c: number, currency: string) {
  return formatMoney(c, currency).replace(/ /g, ' ');
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
    out.push(pad(p.method.toUpperCase() + (p.reference ? ` ${p.reference}` : ''), money(p.tenderedCents ?? p.amountCents, cur), width));
  }
  if (sale.changeCents) out.push(pad('Change', money(sale.changeCents, cur), width));
  if (sale.creditCents) out.push(pad('On account', money(sale.creditCents, cur), width));
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
  if (tenant.settings?.receiptFooter) b.line(tenant.settings.receiptFooter);
  b.barcode(sale.number).line().line('Powered by Afey POS').feed(4).cut();
  if (opts.openDrawer) b.openDrawer(0);
  return b.build();
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function renderReceiptHtml(tenant: ReceiptTenant, sale: ReceiptSale, cashierName?: string): string {
  const text = renderReceiptText(tenant, sale, 42, cashierName);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(sale.number)}</title><style>
  @page { size: 80mm auto; margin: 4mm; } body { font: 12px/1.35 ui-monospace, Menlo, Consolas, monospace; width: 72mm; margin: 0 auto; color: #000; }
  pre { white-space: pre-wrap; margin: 0; }</style></head><body><pre>${esc(text)}</pre></body></html>`;
}
