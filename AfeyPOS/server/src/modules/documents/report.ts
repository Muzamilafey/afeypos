/**
 * Reports as PDF (download) and as print-ready HTML (Print), from one description of the report: the page
 * sends what it shows (title, filters, stat tiles, tables, notes) and both outputs lay it out the same way,
 * on the business letterhead, with repeated table headers, totals rows and "page x of y".
 */
import fs from 'node:fs';
import PDFDocument from 'pdfkit';
import { z } from 'zod';
import { pdfText, type PdfDocSpec } from './pdf.js';

const label = z.string().trim().max(120);
const cell = z.string().max(600);
export const reportSpecSchema = z.object({
  title: z.string().trim().min(1).max(120),
  subtitle: z.string().trim().max(300).optional(),
  /** Filters and context: Period, Branch, Grouped by... */
  meta: z.array(z.tuple([z.string().trim().max(60), z.string().trim().max(200)])).max(12).default([]),
  orientation: z.enum(['portrait', 'landscape']).optional(),
  sections: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('stats'), title: label.optional(), items: z.array(z.object({ label: z.string().max(80), value: z.string().max(80), hint: z.string().max(240).optional(), tone: z.enum(['red', 'green']).optional() })).min(1).max(40) }),
    z.object({
      kind: z.literal('table'), title: label.optional(),
      columns: z.array(z.object({ label: z.string().max(80), align: z.enum(['left', 'right', 'center']).optional() })).min(1).max(20),
      rows: z.array(z.array(cell).max(20)).max(10_000),
      /** Totals row(s), one value per column (empty strings for blank cells). */
      totals: z.array(z.array(cell).max(20)).max(5).optional(),
      empty: z.string().max(200).optional(),
    }),
    z.object({ kind: z.literal('text'), title: label.optional(), lines: z.array(z.string().max(2000)).min(1).max(200) }),
  ])).min(1).max(60),
});
export type ReportSpec = z.infer<typeof reportSpecSchema>;
type TableSection = Extract<ReportSpec['sections'][number], { kind: 'table' }>;

export interface ReportContext {
  business: { name: string; lines: string[]; logoPath?: string | null };
  generatedBy: string;
  generatedAt: string;
}

const ACCENT = '#1f3b57';
const INK = '#1d2430';
const MUTED = '#5b6573';
const LINE = '#d8dde4';
const ZEBRA = '#f4f6f9';
const TOTAL_BG = '#e9eef4';
const TONE = { red: '#b42318', green: '#067647' } as const;

const columnCount = (s: ReportSpec) => Math.max(0, ...s.sections.map((x) => (x.kind === 'table' ? x.columns.length : 0)));
export const isLandscape = (s: ReportSpec) => (s.orientation ? s.orientation === 'landscape' : columnCount(s) > 7);
const logoOk = (p?: string | null) => Boolean(p && /\.(png|jpe?g)$/i.test(p) && fs.existsSync(p));

export function renderReportPdf(spec: ReportSpec, ctx: ReportContext): Promise<Buffer> {
  const landscape = isLandscape(spec);
  const doc = new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: 36, bufferPages: true, info: { Title: pdfText(spec.title), Author: pdfText(ctx.business.name), Creator: 'Afey POS' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const t = pdfText;
  const W = doc.page.width;
  const H = doc.page.height;
  const left = 36;
  const right = W - 36;
  const width = right - left;
  const bottom = H - 48;

  // ---- letterhead ----
  doc.rect(0, 0, W, 5).fill(ACCENT);
  let x = left;
  if (logoOk(ctx.business.logoPath)) {
    try {
      doc.image(ctx.business.logoPath!, left, 24, { fit: [50, 50] });
      x = left + 60;
    } catch {
      /* unreadable image: no logo */
    }
  }
  const headW = width * 0.48;
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(14).text(t(ctx.business.name), x, 26, { width: headW });
  doc.font('Helvetica').fontSize(8).fillColor(MUTED);
  for (const l of ctx.business.lines.filter(Boolean)) doc.text(t(l), x, undefined, { width: headW });
  const leftBottom = doc.y;
  doc.font('Helvetica-Bold').fontSize(18).fillColor(ACCENT).text(t(spec.title), left + width * 0.45, 24, { width: width * 0.55, align: 'right' });
  if (spec.subtitle) doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(t(spec.subtitle), left + width * 0.45, undefined, { width: width * 0.55, align: 'right' });
  let y = Math.max(leftBottom, doc.y) + 10;

  // ---- filters strip ----
  const meta: [string, string][] = [...spec.meta, ['Printed', ctx.generatedAt]];
  doc.font('Helvetica').fontSize(8);
  const metaText = meta.map(([k, v]) => `${t(k)}: ${t(v)}`);
  const metaH = doc.heightOfString(metaText.join('     '), { width: width - 20 }) + 12;
  doc.roundedRect(left, y, width, metaH, 3).fill(ZEBRA);
  let mx = left + 10;
  let my = y + 6;
  for (const [k, v] of meta) {
    const kw = doc.font('Helvetica-Bold').widthOfString(`${t(k)}: `);
    const vw = doc.font('Helvetica').widthOfString(t(v));
    if (mx + kw + vw > right - 10 && mx > left + 10) {
      mx = left + 10;
      my += 11;
    }
    doc.font('Helvetica-Bold').fillColor(MUTED).text(`${t(k)}: `, mx, my, { lineBreak: false });
    doc.font('Helvetica').fillColor(INK).text(t(v), mx + kw, my, { lineBreak: false, width: right - 10 - mx - kw });
    mx += kw + vw + 22;
  }
  y = Math.max(y + metaH, my + 14) + 14;

  const newPage = () => {
    doc.addPage();
    y = 36;
  };
  const ensure = (h: number) => {
    if (y + h > bottom) newPage();
  };
  const heading = (title?: string) => {
    if (!title) return;
    ensure(40);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(ACCENT).text(t(title), left, y, { width });
    y = doc.y + 2;
    doc.moveTo(left, y).lineTo(left + 28, y).lineWidth(1.5).strokeColor(ACCENT).stroke();
    y += 6;
  };

  for (const s of spec.sections) {
    if (s.kind === 'stats') {
      heading(s.title);
      const per = landscape ? 5 : 4;
      const gap = 8;
      const cw = (width - gap * (per - 1)) / per;
      for (let i = 0; i < s.items.length; i += per) {
        const row = s.items.slice(i, i + per);
        doc.font('Helvetica').fontSize(7);
        const hintH = Math.max(0, ...row.map((it) => (it.hint ? Math.min(doc.heightOfString(t(it.hint), { width: cw - 16 }), 18) : 0)));
        const ch = 38 + hintH;
        ensure(ch + gap);
        row.forEach((it, j) => {
          const cx = left + j * (cw + gap);
          doc.roundedRect(cx, y, cw, ch, 3).lineWidth(0.6).fillAndStroke('#ffffff', LINE);
          doc.rect(cx, y, 3, ch).fill(it.tone ? TONE[it.tone] : ACCENT);
          doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(t(it.label.toUpperCase()), cx + 10, y + 7, { width: cw - 16, lineBreak: false, ellipsis: true, characterSpacing: 0.3 });
          doc.font('Helvetica-Bold').fontSize(12.5).fillColor(it.tone ? TONE[it.tone] : INK).text(t(it.value), cx + 10, y + 17, { width: cw - 16, lineBreak: false, ellipsis: true });
          if (it.hint) doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(t(it.hint), cx + 10, y + 34, { width: cw - 16, height: 18, ellipsis: true });
        });
        y += ch + gap;
      }
      y += 8;
    } else if (s.kind === 'text') {
      heading(s.title);
      doc.font('Helvetica').fontSize(8.5).fillColor('#3a4350');
      for (const l of s.lines) {
        ensure(doc.heightOfString(t(l), { width }) + 4);
        doc.text(t(l), left, y, { width });
        y = doc.y + 3;
      }
      y += 8;
    } else {
      // Keep a table's title with its header and first rows.
      if (s.title) {
        ensure(70);
        heading(s.title);
      }
      y = pdfTable(doc, s, { left, width, bottom, y, newPage: () => { newPage(); return y; } });
      y += 12;
    }
  }

  // ---- footer on every page ----
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;
    doc.moveTo(left, H - 32).lineTo(right, H - 32).lineWidth(0.5).strokeColor(LINE).stroke();
    doc.font('Helvetica').fontSize(7).fillColor('#8a93a0');
    doc.text(t(`${ctx.business.name}  |  ${spec.title}  |  Printed ${ctx.generatedAt} by ${ctx.generatedBy}  |  Afey POS`), left, H - 26, { width: width - 70, lineBreak: false, ellipsis: true });
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, right - 70, H - 26, { width: 70, align: 'right', lineBreak: false });
  }
  doc.end();
  return done;
}

/** A table that continues over pages (header repeated); column widths follow the content. Returns the new y. */
function pdfTable(doc: PDFKit.PDFDocument, s: TableSection, o: { left: number; width: number; bottom: number; y: number; newPage: () => number }) {
  const t = pdfText;
  let y = o.y;
  const n = s.columns.length;
  const fs = n > 10 ? 7 : n > 7 ? 7.5 : 8.5;
  const pad = 5;
  // Natural widths, measured on a sample of rows (wide tables are long tables).
  const sample = s.rows.length > 400 ? s.rows.filter((_, i) => i % Math.ceil(s.rows.length / 400) === 0) : s.rows;
  const natural = s.columns.map((c, j) => {
    doc.font('Helvetica-Bold').fontSize(fs);
    let w = doc.widthOfString(t(c.label));
    doc.font('Helvetica').fontSize(fs);
    for (const r of sample) for (const line of t(r[j] ?? '').split('\n')) w = Math.max(w, doc.widthOfString(line));
    doc.font('Helvetica-Bold');
    for (const r of s.totals ?? []) for (const line of t(r[j] ?? '').split('\n')) w = Math.max(w, doc.widthOfString(line) + 1);
    return Math.min(Math.max(w + pad * 2, 28), 230);
  });
  const sum = natural.reduce((a, b) => a + b, 0);
  let widths: number[];
  if (sum <= o.width) {
    // Spare room goes to the text columns.
    const flex = s.columns.map((c, j) => (c.align === 'right' ? 0 : natural[j]!));
    const flexSum = flex.reduce((a, b) => a + b, 0) || sum;
    widths = natural.map((w, j) => w + ((flex[j] || (flexSum === sum ? w : 0)) / flexSum) * (o.width - sum));
  } else widths = natural.map((w) => (w / sum) * o.width);

  const showHead = s.columns.some((c) => c.label);
  const head = () => {
    if (!showHead) return;
    doc.font('Helvetica-Bold').fontSize(fs);
    const h = Math.max(18, ...s.columns.map((c, j) => doc.heightOfString(t(c.label), { width: widths[j]! - pad * 2 }) + 9));
    doc.rect(o.left, y, o.width, h).fill(ACCENT);
    let cx = o.left;
    doc.fillColor('#ffffff');
    s.columns.forEach((c, j) => {
      doc.text(t(c.label), cx + pad, y + 5, { width: widths[j]! - pad * 2, align: c.align ?? 'left' });
      cx += widths[j]!;
    });
    y += h;
  };
  const rowHeight = (r: string[], bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fs);
    return Math.max(16, ...s.columns.map((_, j) => doc.heightOfString(t(r[j] ?? ''), { width: widths[j]! - pad * 2 }) + 8));
  };
  const drawRow = (r: string[], h: number, fill?: string, bold = false) => {
    if (fill) doc.rect(o.left, y, o.width, h).fill(fill);
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fs).fillColor(INK);
    let cx = o.left;
    s.columns.forEach((c, j) => {
      doc.text(t(r[j] ?? ''), cx + pad, y + 4.5, { width: widths[j]! - pad * 2, align: c.align ?? 'left' });
      cx += widths[j]!;
    });
    y += h;
  };

  if (y + 40 > o.bottom) y = o.newPage();
  head();
  if (!s.rows.length) {
    doc.font('Helvetica-Oblique').fontSize(fs).fillColor(MUTED).text(t(s.empty ?? 'Nothing to show'), o.left + pad, y + 5, { width: o.width - pad * 2 });
    y += 20;
  }
  s.rows.forEach((r, i) => {
    const h = rowHeight(r);
    if (y + h > o.bottom) {
      y = o.newPage();
      head();
    }
    drawRow(r, h, i % 2 === 1 ? ZEBRA : undefined);
  });
  doc.moveTo(o.left, y).lineTo(o.left + o.width, y).lineWidth(0.6).strokeColor(LINE).stroke();
  for (const tr of s.totals ?? []) {
    const h = rowHeight(tr, true) + 2;
    if (y + h > o.bottom) {
      y = o.newPage();
      head();
    }
    drawRow(tr, h, TOTAL_BG, true);
  }
  if (s.totals?.length) doc.moveTo(o.left, y).lineTo(o.left + o.width, y).lineWidth(1).strokeColor(ACCENT).stroke();
  return y;
}

// ---------------------------------------------------------------- HTML (Print)

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const nl = (s: string) => esc(s).replace(/\n/g, '<br>');

/** The logo as a data URI, so the print window needs no signed-in request. */
export function logoDataUri(p?: string | null): string | null {
  if (!logoOk(p)) return null;
  try {
    const buf = fs.readFileSync(p!);
    if (buf.length > 1_500_000) return null;
    return `data:image/${/\.png$/i.test(p!) ? 'png' : 'jpeg'};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

export const PRINT_CSS = `
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:${INK};font-size:10.5px;line-height:1.4;-webkit-print-color-adjust:exact;print-color-adjust:exact;background:#fff}
.page{max-width:1100px;margin:0 auto;padding:18px 22px 28px}
.bar{height:5px;background:${ACCENT};margin:-18px -22px 16px}
.head{display:flex;justify-content:space-between;gap:24px;align-items:flex-start}
.biz{display:flex;gap:12px;align-items:flex-start;max-width:55%}
.biz img{width:54px;height:54px;object-fit:contain}
.biz h1{font-size:17px;margin:0 0 2px;color:${INK}}
.biz div.l{color:${MUTED};font-size:9.5px}
.ttl{text-align:right}
.ttl h2{font-size:21px;margin:0;color:${ACCENT};letter-spacing:.2px}
.ttl .no{font-weight:700;font-size:12px;margin-top:2px}
.ttl .sub,.ttl .m{color:${MUTED};font-size:9.5px}
.meta{margin:12px 0 16px;background:${ZEBRA};border-radius:4px;padding:7px 10px;display:flex;flex-wrap:wrap;gap:4px 22px;font-size:9.5px}
.meta b{color:${MUTED};font-weight:600}
h3{font-size:12px;color:${ACCENT};margin:16px 0 7px;padding-bottom:3px;border-bottom:1.5px solid ${ACCENT};display:inline-block}
.sec{break-inside:auto}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:6px}
.landscape .stats{grid-template-columns:repeat(5,1fr)}
.stat{border:1px solid ${LINE};border-left:3px solid ${ACCENT};border-radius:4px;padding:6px 9px;break-inside:avoid}
.stat.red{border-left-color:${TONE.red}}.stat.green{border-left-color:${TONE.green}}
.stat .k{font-size:8px;text-transform:uppercase;letter-spacing:.4px;color:${MUTED}}
.stat .v{font-size:15px;font-weight:700;font-variant-numeric:tabular-nums}
.stat.red .v{color:${TONE.red}}.stat.green .v{color:${TONE.green}}
.stat .h{font-size:8.5px;color:${MUTED}}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
thead{display:table-header-group}
tfoot{display:table-row-group}
th{background:${ACCENT};color:#fff;text-align:left;font-weight:600;padding:5px 7px;font-size:9.5px}
td{padding:4px 7px;border-bottom:1px solid #edf0f4;vertical-align:top}
tbody tr:nth-child(even) td{background:${ZEBRA}}
tr{break-inside:avoid}
.r{text-align:right}.c{text-align:center}
tr.tot td{background:${TOTAL_BG};font-weight:700;border-top:1px solid ${ACCENT};border-bottom:1px solid ${ACCENT}}
td.empty{color:${MUTED};font-style:italic;text-align:center;padding:12px}
p.t{margin:0 0 4px;color:#3a4350}
.foot{margin-top:22px;padding-top:6px;border-top:1px solid ${LINE};color:#8a93a0;font-size:8.5px;display:flex;justify-content:space-between}
@media screen{body{background:#eef1f5}.page{background:#fff;margin:16px auto;box-shadow:0 2px 12px rgba(0,0,0,.08)}}
@media print{.page{max-width:none;padding:0}.bar{margin:0 0 14px}}
`;

export function letterheadHtml(business: ReportContext['business'], right: string) {
  const logo = logoDataUri(business.logoPath);
  return `<div class="bar"></div><div class="head"><div class="biz">${logo ? `<img src="${logo}" alt="">` : ''}<div><h1>${esc(business.name)}</h1>${business.lines.filter(Boolean).map((l) => `<div class="l">${esc(l)}</div>`).join('')}</div></div><div class="ttl">${right}</div></div>`;
}

export function printPage(title: string, landscape: boolean, body: string, footLeft: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${PRINT_CSS}
@page{size:A4 ${landscape ? 'landscape' : 'portrait'};margin:12mm 11mm 14mm}
@page{@bottom-right{content:"Page " counter(page) " of " counter(pages);font:8px Arial,sans-serif;color:#8a93a0}}
</style></head><body class="${landscape ? 'landscape' : ''}"><div class="page">${body}<div class="foot"><span>${footLeft}</span><span>Afey POS</span></div></div></body></html>`;
}

export function renderReportHtml(spec: ReportSpec, ctx: ReportContext): string {
  const landscape = isLandscape(spec);
  const al = (a?: string) => (a === 'right' ? ' class="r"' : a === 'center' ? ' class="c"' : '');
  const parts: string[] = [];
  parts.push(letterheadHtml(ctx.business, `<h2>${esc(spec.title)}</h2>${spec.subtitle ? `<div class="sub">${esc(spec.subtitle)}</div>` : ''}`));
  parts.push(`<div class="meta">${[...spec.meta, ['Printed', ctx.generatedAt] as [string, string]].map(([k, v]) => `<span><b>${esc(k)}:</b> ${esc(v)}</span>`).join('')}</div>`);
  for (const s of spec.sections) {
    const h = s.title ? `<h3>${esc(s.title)}</h3>` : '';
    if (s.kind === 'stats') {
      parts.push(`<div class="sec">${h}<div class="stats">${s.items.map((i) => `<div class="stat ${i.tone ?? ''}"><div class="k">${esc(i.label)}</div><div class="v">${esc(i.value)}</div>${i.hint ? `<div class="h">${esc(i.hint)}</div>` : ''}</div>`).join('')}</div></div>`);
    } else if (s.kind === 'text') {
      parts.push(`<div class="sec">${h}${s.lines.map((l) => `<p class="t">${nl(l)}</p>`).join('')}</div>`);
    } else {
      const head = s.columns.some((c) => c.label) ? `<thead><tr>${s.columns.map((c) => `<th${al(c.align)}>${esc(c.label)}</th>`).join('')}</tr></thead>` : '';
      const body = s.rows.length
        ? s.rows.map((r) => `<tr>${s.columns.map((c, j) => `<td${al(c.align)}>${nl(r[j] ?? '')}</td>`).join('')}</tr>`).join('')
        : `<tr><td class="empty" colspan="${s.columns.length}">${esc(s.empty ?? 'Nothing to show')}</td></tr>`;
      const tot = (s.totals ?? []).map((r) => `<tr class="tot">${s.columns.map((c, j) => `<td${al(c.align)}>${nl(r[j] ?? '')}</td>`).join('')}</tr>`).join('');
      parts.push(`<div class="sec">${h}<table>${head}<tbody>${body}${tot}</tbody></table></div>`);
    }
  }
  return printPage(spec.title, landscape, parts.join(''), `${esc(ctx.business.name)} &middot; ${esc(spec.title)} &middot; printed ${esc(ctx.generatedAt)} by ${esc(ctx.generatedBy)}`);
}

/** Business documents (invoice, quotation, purchase order...) as a print page that matches their PDF. */
export function renderDocumentHtml(spec: PdfDocSpec): string {
  const al = (a?: string) => (a === 'right' ? ' class="r"' : a === 'center' ? ' class="c"' : '');
  const right = `<h2>${esc(spec.title.toUpperCase())}</h2><div class="no">${esc(spec.number)}</div>${spec.meta.map(([k, v]) => `<div class="m">${esc(k)}: ${esc(v)}</div>`).join('')}`;
  const box = (heading: string, name: string | null, lines: string[]) => `<div class="party"><div class="ph">${esc(heading)}</div>${name ? `<div class="pn">${esc(name)}</div>` : ''}${lines.filter(Boolean).map((l) => `<div>${esc(l)}</div>`).join('')}</div>`;
  const parties = `<div class="parties">${box(spec.party.heading, spec.party.name, spec.party.lines)}${spec.party2 ? box(spec.party2.heading, null, spec.party2.lines) : ''}</div>`;
  const head = `<thead><tr>${spec.columns.map((c) => `<th${al(c.align)} style="width:${c.width}%">${esc(c.label)}</th>`).join('')}</tr></thead>`;
  const rows = spec.rows.length ? spec.rows.map((r) => `<tr>${spec.columns.map((c, j) => `<td${al(c.align)}>${nl(r[j] ?? '')}</td>`).join('')}</tr>`).join('') : `<tr><td class="empty" colspan="${spec.columns.length}">No items</td></tr>`;
  const totals = spec.totals.length ? `<table class="totals">${spec.totals.map((t) => `<tr class="${t.bold ? 'b' : ''}"><td>${esc(t.label)}</td><td class="r">${esc(t.value)}</td></tr>`).join('')}</table>` : '';
  const notes = (spec.notes ?? []).filter(Boolean).map((n) => `<p class="t">${nl(n)}</p>`).join('');
  const sigs = spec.signatures?.length ? `<div class="sigs">${spec.signatures.map((s) => `<div class="sig">${esc(s)}</div>`).join('')}</div>` : '';
  const css = `<style>.parties{display:flex;gap:12px;margin:16px 0}.party{flex:1;border:1px solid ${LINE};border-radius:4px;padding:8px 10px;color:#444}.ph{font-size:8.5px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:${ACCENT}}.pn{font-weight:700;font-size:12px;color:${INK}}
table.totals{width:260px;margin:10px 0 0 auto}table.totals td{border:0;padding:3px 8px;background:none!important}table.totals tr.b td{background:${TOTAL_BG}!important;font-weight:700;font-size:12px}
.notes{margin-top:14px}.sigs{display:flex;gap:24px;margin-top:46px}.sig{flex:1;border-top:1px solid #888;padding-top:4px;color:${MUTED};font-size:9.5px}</style>`;
  return printPage(`${spec.title} ${spec.number}`, false, `${css}${letterheadHtml(spec.business, right)}${parties}<table>${head}<tbody>${rows}</tbody></table>${totals}<div class="notes">${notes}</div>${sigs}`, esc(spec.footer ?? `${spec.business.name} - generated by Afey POS`));
}
