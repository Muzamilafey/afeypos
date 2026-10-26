/**
 * Sale receipts and credit-note slips in three formats from one model: plain text (SMS/email, thermal fallback),
 * ESC/POS for thermal printers and HTML for browser printing. The layout follows Settings > Receipts
 * (template, paper width, what to show, extra fields); see RECEIPT_DEFAULTS in the shared package.
 */
import fs from 'node:fs';
import path from 'node:path';
import { code128Svg, formatMoney, mergeReceipt, paymentProviderLabel, RECEIPT_WIDTH_CHARS, type ReceiptSettings } from '@afeypos/shared';
import qrcode from 'qrcode-generator';
import { Branch, Customer, Till, User } from '../../models/index.js';
import { tenantFilePath } from '../files/routes.js';
import { EscPosBuilder } from './escpos.js';

interface ReceiptTenant {
  _id?: unknown;
  name: string;
  settings?: { currency?: string; receiptHeader?: string | null; receiptFooter?: string | null; taxPin?: string | null; timezone?: string; locale?: string; tagline?: string | null; logoFileId?: string | null; receipt?: unknown } | null;
  contact?: { phone?: string | null; address?: string | null; email?: string | null } | null;
}
interface ReceiptSale {
  number: string;
  completedAt: Date | string;
  lines: { name?: string | null; sku?: string | null; qty?: number | null; unitCode?: string | null; unitPriceCents?: number | null; listPriceCents?: number | null; totalCents?: number | null; discountCents?: number | null; cartDiscountCents?: number | null; taxRateBp?: number | null; taxCents?: number | null; serials?: string[] | null }[];
  grossCents?: number | null;
  discountCents?: number | null;
  taxCents?: number | null;
  totalCents: number;
  payments: { method: string; provider?: string | null; amountCents: number; reference?: string | null; tenderedCents?: number | null; changeCents?: number | null }[];
  changeCents?: number | null;
  creditCents?: number | null;
  status?: string;
  loyalty?: { earned?: number | null; redeemed?: number | null } | null;
  etims?: { status?: string | null; invcNo?: number | null; rcptNo?: number | null; totRcptNo?: number | null; intrlData?: string | null; rcptSign?: string | null; sdcId?: string | null; mrcNo?: string | null; sdcDateTime?: string | null; qrUrl?: string | null } | null;
}

export interface ReceiptOptions {
  /** Characters per line; defaults to the paper width in the receipt settings. */
  width?: number;
  cashierName?: string;
  tillName?: string;
  branchName?: string;
  customer?: { name: string; phone?: string | null; points?: number | null } | null;
  /** data: URI of the business logo (HTML only). */
  logoDataUri?: string | null;
  /** Unsaved settings (the Settings > Receipts preview). */
  settings?: ReceiptSettings;
  reprint?: boolean;
  openDrawer?: boolean;
}

/** "20261025143000" -> "25/10/2026 14:30:00" */
const etimsTime = (s?: string | null) => (s && /^\d{14}$/.test(s) ? `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)} ${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}` : (s ?? ''));

function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (word.length > width) {
        if (line) out.push(line);
        for (let i = 0; i < word.length; i += width) out.push(word.slice(i, i + width));
        line = '';
        continue;
      }
      if ((line ? line.length + 1 : 0) + word.length > width) {
        out.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    out.push(line);
  }
  return out;
}

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
  if (e.status !== 'signed') return ['KRA eTIMS: awaiting signature', 'Reprint this receipt for the signed copy'];
  return [
    'KRA eTIMS',
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
  if (left.length + right.length + 1 > width) left = left.slice(0, Math.max(1, width - right.length - 2)) + '…';
  return left + ' '.repeat(Math.max(1, Math.min(space, width - left.length - right.length))) + right;
}

const center = (s: string, width: number) => (s.length >= width ? s : ' '.repeat(Math.floor((width - s.length) / 2)) + s);

function money(c: number, currency: string) {
  return formatMoney(c, currency).replace(/\u00a0/g, ' ');
}
const qtyText = (q?: number | null) => String(Math.round((q ?? 0) * 1000) / 1000);
const methodLabel = (p: ReceiptSale['payments'][number]) => (p.method === 'gateway' ? paymentProviderLabel(p.provider) : p.method === 'mpesa' ? 'M-Pesa' : p.method.charAt(0).toUpperCase() + p.method.slice(1));

/** Everything a receipt shows, already decided by the settings; each format only lays it out. */
interface ReceiptModel {
  s: ReceiptSettings;
  cur: string;
  business: string;
  tagline: string;
  contact: string[];
  header: string;
  title: string;
  banner: string[];
  meta: [string, string][];
  top: [string, string][];
  bottom: [string, string][];
  items: { name: string; sku: string; qty: string; one: boolean; unitPrice: string; total: string; discount: string; serials: string[] }[];
  itemCount: string;
  totals: { label: string; value: string; grand?: boolean }[];
  payments: [string, string][];
  taxSummary: { label: string; taxable: string; tax: string }[];
  savings: string;
  loyalty: [string, string][];
  qrUrl: string;
  message: string;
  returnPolicy: string;
  footer: string;
  barcode: string;
}

function buildModel(tenant: ReceiptTenant, sale: ReceiptSale, opts: ReceiptOptions): ReceiptModel {
  const s = opts.settings ?? mergeReceipt(tenant.settings?.receipt);
  const cur = tenant.settings?.currency ?? 'KES';
  const m = (c: number) => money(c, cur);
  const when = new Date(sale.completedAt).toLocaleString(tenant.settings?.locale ?? 'en-KE', { timeZone: tenant.settings?.timezone ?? 'Africa/Nairobi', dateStyle: 'medium', timeStyle: 'short' });
  const meta: [string, string][] = [['Receipt No.', sale.number], ['Date', when]];
  if (s.show.branch && opts.branchName) meta.push(['Branch', opts.branchName]);
  if (s.show.till && opts.tillName) meta.push(['Till', opts.tillName]);
  if (s.show.cashier && opts.cashierName) meta.push(['Served by', opts.cashierName]);
  if (s.show.customer && opts.customer) meta.push(['Customer', [opts.customer.name, opts.customer.phone].filter(Boolean).join(' · ')]);

  const items = sale.lines.map((l) => ({
    name: l.name ?? '', sku: s.show.sku ? (l.sku ?? '') : '', one: l.qty === 1, qty: `${qtyText(l.qty)}${l.unitCode ? ` ${l.unitCode}` : ''}`,
    unitPrice: m(l.unitPriceCents ?? 0), total: m(l.totalCents ?? 0), discount: l.discountCents ? `-${m(l.discountCents)}` : '', serials: l.serials ?? [],
  }));
  const qtyTotal = sale.lines.reduce((a, l) => a + (l.qty ?? 0), 0);

  const totals: ReceiptModel['totals'] = [];
  const subtotal = sale.grossCents ?? sale.totalCents + (sale.discountCents ?? 0);
  if (sale.discountCents) totals.push({ label: 'Subtotal', value: m(subtotal) }, { label: 'Discounts', value: `-${m(sale.discountCents)}` });
  totals.push({ label: 'TOTAL', value: m(sale.totalCents), grand: true });
  if (sale.taxCents && !s.show.taxSummary) totals.push({ label: 'Incl. VAT', value: m(sale.taxCents) });

  const payments: [string, string][] = sale.payments.map((p) => [methodLabel(p) + (p.reference ? ` ${p.reference}` : ''), m(p.tenderedCents ?? p.amountCents)]);
  if (sale.changeCents) payments.push(['Change', m(sale.changeCents)]);
  if (sale.creditCents) payments.push(['On account', m(sale.creditCents)]);

  // VAT summary by rate (prices include tax): taxable amount and tax per rate.
  const byRate = new Map<number, { taxable: number; tax: number }>();
  for (const l of sale.lines) {
    if (l.taxRateBp == null && !l.taxCents) continue;
    const r = byRate.get(l.taxRateBp ?? 0) ?? { taxable: 0, tax: 0 };
    r.taxable += (l.totalCents ?? 0) - (l.taxCents ?? 0);
    r.tax += l.taxCents ?? 0;
    byRate.set(l.taxRateBp ?? 0, r);
  }
  const taxSummary = s.show.taxSummary && sale.taxCents
    ? [...byRate.entries()].sort((a, b) => b[0] - a[0]).map(([bp, v]) => ({ label: `VAT ${bp / 100}%`, taxable: m(v.taxable), tax: m(v.tax) }))
    : [];
  if (s.show.taxSummary && sale.taxCents && !taxSummary.length) taxSummary.push({ label: 'VAT', taxable: m(sale.totalCents - sale.taxCents), tax: m(sale.taxCents) });

  const saved = (sale.discountCents ?? 0) + sale.lines.reduce((a, l) => a + Math.max(0, ((l.listPriceCents ?? l.unitPriceCents ?? 0) - (l.unitPriceCents ?? 0)) * (l.qty ?? 0)), 0);
  const loyalty: [string, string][] = [];
  if (s.show.loyalty && opts.customer && (sale.loyalty?.earned || sale.loyalty?.redeemed || opts.customer.points)) {
    if (sale.loyalty?.earned) loyalty.push(['Points earned', String(sale.loyalty.earned)]);
    if (sale.loyalty?.redeemed) loyalty.push(['Points redeemed', String(sale.loyalty.redeemed)]);
    if (opts.customer.points != null) loyalty.push(['Points balance', String(opts.customer.points)]);
  }
  const custom = (pos: 'top' | 'bottom') => s.customFields.filter((f) => f.position === pos && (f.label || f.value)).map((f): [string, string] => [f.label, f.value]);
  const banner: string[] = [];
  if (opts.reprint) banner.push('*** REPRINT ***');
  if (sale.status === 'voided') banner.push('*** VOIDED ***');

  return {
    s, cur,
    business: tenant.name,
    tagline: s.show.tagline ? (tenant.settings?.tagline ?? '') : '',
    contact: [s.show.address ? tenant.contact?.address : null, s.show.phone && tenant.contact?.phone ? `Tel: ${tenant.contact.phone}` : null, s.show.email ? tenant.contact?.email : null, s.show.taxPin && tenant.settings?.taxPin ? `PIN: ${tenant.settings.taxPin}` : null].filter(Boolean) as string[],
    header: tenant.settings?.receiptHeader ?? '',
    title: s.title.trim(),
    banner, meta, top: custom('top'), bottom: custom('bottom'), items,
    itemCount: s.show.itemCount ? `${sale.lines.length} item${sale.lines.length === 1 ? '' : 's'}${qtyTotal !== sale.lines.length ? ` · ${qtyText(qtyTotal)} units` : ''}` : '',
    totals, payments, taxSummary,
    savings: s.show.savings && saved > 0 ? `You saved ${m(saved)} today!` : '',
    loyalty,
    qrUrl: s.show.qr && sale.etims?.status === 'signed' && sale.etims.qrUrl ? sale.etims.qrUrl : '',
    message: s.message.trim(),
    returnPolicy: s.returnPolicy.trim(),
    footer: tenant.settings?.receiptFooter ?? '',
    barcode: s.show.barcode && /^[\x20-\x7e]+$/.test(sale.number) ? sale.number : '',
  };
}

// ---------- text (and thermal) ----------

interface TextLine {
  text: string;
  bold?: boolean;
  big?: boolean;
  center?: boolean;
}

function textLines(model: ReceiptModel, sale: ReceiptSale, width: number): TextLine[] {
  const { s } = model;
  const compact = s.template === 'compact';
  const rule = s.template === 'elegant' ? center('~ ~ ~ ~ ~ ~ ~ ~', width) : s.template === 'bold' || s.template === 'modern' ? '='.repeat(width) : '-'.repeat(width);
  const out: TextLine[] = [];
  const push = (text: string, o: Omit<TextLine, 'text'> = {}) => out.push({ text, ...o });
  const kv = (pairs: [string, string][], colon = true) => pairs.forEach(([k, v]) => push(k ? pad(colon ? `${k}:` : k, v, width) : v));

  push(model.business, { bold: true, big: s.template === 'bold' || s.template === 'elegant', center: true });
  if (model.tagline) wrapText(model.tagline, width).forEach((l) => push(l, { center: true }));
  model.contact.forEach((c) => wrapText(c, width).forEach((l) => push(l, { center: true })));
  if (model.header) wrapText(model.header, width).forEach((l) => push(l, { center: true }));
  if (!compact) push('');
  if (model.title) push(model.title, { bold: true, center: true });
  model.banner.forEach((b) => push(b, { bold: true, center: true }));
  kv(model.meta);
  kv(model.top);
  push(rule);
  for (const it of model.items) {
    if (compact) {
      push(pad(`${it.one ? '' : `${it.qty} `}${it.name}`, it.total, width));
    } else {
      push(it.name.slice(0, width));
      const left = `  ${it.qty}${s.show.unitPrice ? ` x ${it.unitPrice}` : ''}${it.sku ? `  ${it.sku}` : ''}`;
      push(pad(left, it.total, width));
    }
    if (it.discount) push(pad('  Discount', it.discount, width));
    for (const sn of it.serials) push(`  S/N: ${sn}`);
  }
  push(rule);
  if (model.itemCount) push(model.itemCount);
  for (const t of model.totals) push(pad(t.label, t.value, width), { bold: t.grand, big: t.grand && s.template === 'bold' });
  if (model.payments.length) {
    if (!compact) push('');
    kv(model.payments, false);
  }
  if (model.taxSummary.length) {
    push(rule);
    if (!compact) push(pad('VAT summary', 'Taxable    Tax', width));
    for (const t of model.taxSummary) push(pad(t.label, `${t.taxable}  ${t.tax}`, width));
  }
  if (model.loyalty.length) {
    push(rule);
    kv(model.loyalty);
  }
  if (model.savings) push(model.savings, { bold: true, center: true });
  const etims = etimsLines(sale, width);
  if (etims.length) {
    push(rule);
    etims.forEach((l) => push(l));
  }
  if (model.bottom.length) {
    push(rule);
    kv(model.bottom);
  }
  if (model.message) {
    push('');
    wrapText(model.message, width).forEach((l) => push(l, { bold: true, center: true }));
  }
  if (model.returnPolicy) {
    push('');
    wrapText(model.returnPolicy, width).forEach((l) => push(l, { center: true }));
  }
  return out;
}

export function renderReceiptText(tenant: ReceiptTenant, sale: ReceiptSale, opts: ReceiptOptions = {}): string {
  const model = buildModel(tenant, sale, opts);
  const width = opts.width ?? RECEIPT_WIDTH_CHARS[model.s.paper];
  const lines = textLines(model, sale, width).map((l) => (l.center ? center(l.text, width) : l.text));
  const end = [model.footer ? wrapText(model.footer, width).map((l) => center(l, width)).join('\n') : '', model.s.show.poweredBy ? center('Powered by Afey POS', width) : ''].filter(Boolean);
  return [...lines, '', ...end].join('\n').replace(/\n{3,}/g, '\n\n');
}

export function renderReceiptEscPos(tenant: ReceiptTenant, sale: ReceiptSale, opts: ReceiptOptions = {}): Buffer {
  const model = buildModel(tenant, sale, opts);
  const width = opts.width ?? RECEIPT_WIDTH_CHARS[model.s.paper];
  const b = new EscPosBuilder(width);
  for (const l of textLines(model, sale, width)) {
    b.align(l.center ? 'center' : 'left');
    if (l.bold) b.bold(true);
    // Double size halves the characters per line: only for short text.
    if (l.big && l.text.trim().length <= width / 2) b.size(true).line(l.text.trim()).size(false);
    else b.line(l.text);
    if (l.bold) b.bold(false);
  }
  b.line().align('center');
  if (model.qrUrl) b.qr(model.qrUrl).line();
  if (model.footer) wrapText(model.footer, width).forEach((l) => b.line(l));
  if (model.barcode) b.barcode(model.barcode).line();
  if (model.s.show.poweredBy) b.line('Powered by Afey POS');
  b.feed(4).cut();
  if (opts.openDrawer) b.openDrawer(0);
  return b.build();
}

// ---------- HTML (browser printing and the Settings preview) ----------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const nl = (s: string) => esc(s).replace(/\n/g, '<br>');

const TEMPLATE_CSS: Record<ReceiptSettings['template'], string> = {
  classic: `body{font-family:ui-monospace,Menlo,Consolas,"Courier New",monospace}.rule{border-top:1px dashed #000}.grand{font-size:1.25em}`,
  modern: `body{font-family:"Open Sans",system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}.biz{letter-spacing:.02em}.rule{border-top:1px solid #000}
    .items thead th{border-bottom:1.5px solid #000;font-size:.78em;text-transform:uppercase;letter-spacing:.06em;padding-bottom:3px}
    .grandbox{border:2px solid #000;border-radius:6px;padding:6px 8px;margin:6px 0}.title{background:#000;color:#fff;padding:2px 0;border-radius:3px}`,
  compact: `body{font-family:ui-monospace,Menlo,Consolas,monospace;line-height:1.2}.rule{border-top:1px dotted #000;margin:3px 0}.sec{margin:3px 0}.grand{font-size:1.1em}`,
  bold: `body{font-family:"Arial Black","Helvetica Neue",Arial,sans-serif}.biz{font-size:1.8em;text-transform:uppercase;line-height:1.05}.rule{border-top:3px solid #000}
    .grandbox{background:#000;color:#fff;padding:7px 8px;margin:6px 0;-webkit-print-color-adjust:exact;print-color-adjust:exact}.grand{font-size:1.4em}.title{border:2px solid #000;padding:2px 0}`,
  elegant: `body{font-family:Georgia,"Times New Roman",serif}.biz{font-size:1.6em;font-style:italic;font-weight:400}.title{letter-spacing:.3em;font-size:.85em}
    .rule{border:0;text-align:center;height:auto}.rule::before{content:"\\2766";display:block;font-size:1em;line-height:1.2}.grand{font-size:1.25em}.sec{margin:9px 0}`,
};

export function renderReceiptHtml(tenant: ReceiptTenant, sale: ReceiptSale, opts: ReceiptOptions = {}): string {
  const model = buildModel(tenant, sale, opts);
  const { s } = model;
  const paperMm = s.paper === '58mm' ? 58 : 80;
  const bodyMm = paperMm - 8;
  const fontPx = { small: 11, normal: 12.5, large: 14 }[s.fontSize];
  const kv = (pairs: [string, string][], cls = '') => pairs.map(([k, v]) => `<div class="kv ${cls}"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('');
  const rule = '<div class="rule"></div>';
  let qrSvg = '';
  if (model.qrUrl) {
    const qr = qrcode(0, 'M');
    qr.addData(model.qrUrl);
    qr.make();
    qrSvg = `<div class="qr">${qr.createSvgTag({ cellSize: 3, margin: 2, scalable: true })}<div class="small">Scan to verify with KRA</div></div>`;
  }
  const compact = s.template === 'compact';
  const items = model.items.map((it) => compact
    ? `<tr><td>${it.one ? '' : `${esc(it.qty)} × `}${esc(it.name)}${it.discount ? `<div class="small">Discount ${esc(it.discount)}</div>` : ''}</td><td class="r">${esc(it.total)}</td></tr>`
    : `<tr><td><div class="iname">${esc(it.name)}</div>${it.sku ? `<div class="small">${esc(it.sku)}</div>` : ''}${it.discount ? `<div class="small">Discount ${esc(it.discount)}</div>` : ''}${it.serials.map((x) => `<div class="small">S/N ${esc(x)}</div>`).join('')}</td>
       <td class="c">${esc(it.qty)}</td>${s.show.unitPrice ? `<td class="r">${esc(it.unitPrice)}</td>` : ''}<td class="r">${esc(it.total)}</td></tr>`).join('');
  const head = compact ? '' : `<thead><tr><th class="l">Item</th><th class="c">Qty</th>${s.show.unitPrice ? '<th class="r">Price</th>' : ''}<th class="r">Total</th></tr></thead>`;
  const grand = model.totals.find((t) => t.grand)!;
  const etims = etimsLines(sale, 40);

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(sale.number)}</title><style>
  @page{size:${paperMm}mm auto;margin:4mm}
  *{box-sizing:border-box}html{background:#fff}
  body{width:${bodyMm}mm;max-width:100%;margin:0 auto;padding:2mm 0;color:#000;font-size:${fontPx}px;line-height:1.4}
  .c{text-align:center;white-space:nowrap}.r{text-align:right;white-space:nowrap}.l{text-align:left}
  .logo{display:block;margin:0 auto 4px;max-width:60%;max-height:22mm;object-fit:contain}
  .biz{font-weight:700;font-size:1.35em;text-align:center}
  .muted{text-align:center;font-size:.92em}.small{font-size:.82em}
  .title{text-align:center;font-weight:700;margin:6px 0 4px}.banner{text-align:center;font-weight:700}
  .sec{margin:6px 0}.rule{margin:6px 0}
  .kv{display:flex;justify-content:space-between;gap:8px}.kv span:last-child{text-align:right}
  table.items{width:100%;border-collapse:collapse}.items td,.items th{padding:2px 0;vertical-align:top}.items td+td,.items th+th{padding-left:6px}
  .iname{font-weight:600}
  .grand{font-weight:800}.grandbox{margin:4px 0}
  .tax td{padding:1px 0}.tax td+td{padding-left:6px}
  .savings{text-align:center;font-weight:700;margin:6px 0}
  .msg{text-align:center;font-weight:700}
  .qr{text-align:center;margin:8px 0}.qr svg{width:32mm;height:32mm}
  .bc{text-align:center;margin:8px 0 2px}.bc svg{max-width:85%;height:12mm}
  .etims{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.8em;word-break:break-all}
  ${TEMPLATE_CSS[s.template]}
  @media screen{body{padding:14px 12px;box-shadow:0 1px 3px rgba(0,0,0,.15);margin:10px auto}html{background:#e9ebee}body{background:#fff}}
  </style></head><body>
  ${s.show.logo && opts.logoDataUri ? `<img class="logo" src="${opts.logoDataUri}" alt="">` : ''}
  <div class="biz">${esc(model.business)}</div>
  ${model.tagline ? `<div class="muted"><em>${esc(model.tagline)}</em></div>` : ''}
  ${model.contact.map((c) => `<div class="muted">${esc(c)}</div>`).join('')}
  ${model.header ? `<div class="muted sec">${nl(model.header)}</div>` : ''}
  ${model.title ? `<div class="title">${esc(model.title)}</div>` : ''}
  ${model.banner.map((b) => `<div class="banner">${esc(b)}</div>`).join('')}
  <div class="sec">${kv(model.meta)}${kv(model.top)}</div>
  ${rule}
  <table class="items">${head}<tbody>${items}</tbody></table>
  ${rule}
  ${model.itemCount ? `<div class="small">${esc(model.itemCount)}</div>` : ''}
  ${model.totals.filter((t) => !t.grand).map((t) => `<div class="kv"><span>${esc(t.label)}</span><span>${esc(t.value)}</span></div>`).join('')}
  <div class="grandbox"><div class="kv grand"><span>${esc(grand.label)}</span><span>${esc(grand.value)}</span></div></div>
  ${model.payments.length ? `<div class="sec">${kv(model.payments)}</div>` : ''}
  ${model.taxSummary.length ? `${rule}<table class="items tax small"><thead><tr><th class="l">VAT summary</th><th class="r">Taxable</th><th class="r">Tax</th></tr></thead><tbody>${model.taxSummary.map((t) => `<tr><td>${esc(t.label)}</td><td class="r">${esc(t.taxable)}</td><td class="r">${esc(t.tax)}</td></tr>`).join('')}</tbody></table>` : ''}
  ${model.loyalty.length ? `${rule}<div class="sec">${kv(model.loyalty)}</div>` : ''}
  ${model.savings ? `<div class="savings">${esc(model.savings)}</div>` : ''}
  ${etims.length ? `${rule}<div class="etims">${etims.map(esc).join('<br>')}</div>` : ''}
  ${qrSvg}
  ${model.bottom.length ? `${rule}<div class="sec">${kv(model.bottom)}</div>` : ''}
  ${model.message ? `<div class="msg sec">${nl(model.message)}</div>` : ''}
  ${model.returnPolicy ? `<div class="muted small sec">${nl(model.returnPolicy)}</div>` : ''}
  ${model.footer ? `<div class="muted sec">${nl(model.footer)}</div>` : ''}
  ${model.barcode ? `<div class="bc">${code128Svg(model.barcode, 40, 1.4)}<div class="small">${esc(model.barcode)}</div></div>` : ''}
  ${s.show.poweredBy ? '<div class="muted small">Powered by Afey POS</div>' : ''}
  </body></html>`;
  return html.replace(/\n\s+/g, '\n');
}

// ---------- context ----------

function logoDataUri(tenant: ReceiptTenant): string | null {
  const id = tenant.settings?.logoFileId;
  if (!id || !tenant._id) return null;
  const file = tenantFilePath(String(tenant._id), id);
  if (!file) return null;
  const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' }[path.extname(file)] ?? 'image/png';
  try {
    return `data:${type};base64,${fs.readFileSync(file).toString('base64')}`;
  } catch {
    return null;
  }
}

/** Names of the cashier, till, branch and customer printed on a receipt (inside the tenant context). */
export async function receiptContext(tenant: ReceiptTenant, sale: { cashierId?: unknown; tillId?: unknown; branchId?: unknown; customerId?: unknown }, userId?: unknown): Promise<ReceiptOptions> {
  const [user, till, branch, customer] = await Promise.all([
    userId ?? sale.cashierId ? User.findById(userId ?? sale.cashierId, { name: 1 }).lean() : null,
    sale.tillId ? Till.findById(sale.tillId, { name: 1, code: 1 }).lean() : null,
    sale.branchId ? Branch.findById(sale.branchId, { name: 1 }).lean() : null,
    sale.customerId ? Customer.findById(sale.customerId, { name: 1, phone: 1, loyaltyPoints: 1 }).lean() : null,
  ]);
  return {
    cashierName: user?.name,
    tillName: till ? `${till.name}${till.code ? ` (${till.code})` : ''}` : undefined,
    branchName: branch?.name,
    customer: customer ? { name: customer.name, phone: customer.phone, points: customer.loyaltyPoints } : null,
    logoDataUri: logoDataUri(tenant),
  };
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

/** A realistic sale for the Settings > Receipts preview. */
export function sampleSale(): ReceiptSale {
  return {
    number: 'RCP-000123', completedAt: new Date(),
    lines: [
      { name: 'Fresh Milk 500ml', sku: 'MILK500', qty: 2, unitCode: 'pc', unitPriceCents: 6500, listPriceCents: 6500, totalCents: 13000, taxRateBp: 0, taxCents: 0 },
      { name: 'White Bread 400g', sku: 'BRD400', qty: 1, unitCode: 'pc', unitPriceCents: 6000, listPriceCents: 6500, totalCents: 6000, taxRateBp: 1600, taxCents: 828 },
      { name: 'Sugar 2kg', sku: 'SUG2KG', qty: 1, unitCode: 'pc', unitPriceCents: 32000, listPriceCents: 32000, totalCents: 30000, discountCents: 2000, taxRateBp: 1600, taxCents: 4138 },
      { name: 'Bananas (loose)', sku: 'BAN', qty: 1.25, unitCode: 'kg', unitPriceCents: 12000, listPriceCents: 12000, totalCents: 15000, taxRateBp: 0, taxCents: 0 },
    ],
    grossCents: 66000, discountCents: 2000, taxCents: 4966, totalCents: 64000,
    payments: [{ method: 'mpesa', amountCents: 40000, reference: 'SJK3AB12CD' }, { method: 'cash', amountCents: 24000, tenderedCents: 30000 }],
    changeCents: 6000, loyalty: { earned: 6, redeemed: 0 },
  };
}
