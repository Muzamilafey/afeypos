/**
 * A4 business documents as PDF (quotations, purchase orders, goods received notes, invoices).
 * One layout for all: business header with logo, document title and details, the other party,
 * a line table that continues over pages, totals, notes and an optional signature block.
 * Uses PDFKit's built-in Helvetica (WinAnsi), so text is reduced to characters that font can show.
 */
import fs from 'node:fs';
import PDFDocument from 'pdfkit';

export interface PdfColumn { label: string; width: number; align?: 'left' | 'right' | 'center' }
export interface PdfDocSpec {
  title: string;
  number: string;
  /** Label / value pairs under the title (date, valid until, PO reference...). */
  meta: [string, string][];
  business: { name: string; lines: string[]; logoPath?: string | null };
  party: { heading: string; name: string; lines: string[] };
  /** Optional second box (deliver to, payment details). */
  party2?: { heading: string; lines: string[] };
  columns: PdfColumn[];
  rows: string[][];
  totals: { label: string; value: string; bold?: boolean }[];
  notes?: string[];
  /** Signature lines at the end ("Received by", "Approved by"). */
  signatures?: string[];
  footer?: string;
  accent?: string;
}

const PAGE = { w: 595.28, h: 841.89, margin: 40 };

/** Helvetica in PDFKit only covers WinAnsi; replace the usual suspects and drop the rest. */
export function pdfText(s: unknown): string {
  return String(s ?? '')
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014]/g, '-').replace(/\u2026/g, '...').replace(/\u00d7/g, 'x').replace(/\u2192/g, '->')
    .replace(/[^\x20-\x7e\u00a0-\u00ff\n]/g, '');
}

export function renderPdf(spec: PdfDocSpec): Promise<Buffer> {
  const accent = spec.accent ?? '#1f3b57';
  const doc = new PDFDocument({ size: 'A4', margin: PAGE.margin, bufferPages: true, info: { Title: pdfText(`${spec.title} ${spec.number}`), Author: pdfText(spec.business.name), Creator: 'Afey POS' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const left = PAGE.margin;
  const right = PAGE.w - PAGE.margin;
  const width = right - left;
  const t = pdfText;

  // ---- header ----
  doc.rect(0, 0, PAGE.w, 6).fill(accent);
  let x = left;
  if (spec.business.logoPath && /\.(png|jpe?g)$/i.test(spec.business.logoPath) && fs.existsSync(spec.business.logoPath)) {
    try {
      doc.image(spec.business.logoPath, left, 30, { fit: [56, 56] });
      x = left + 68;
    } catch {
      /* unreadable image: no logo */
    }
  }
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(16).text(t(spec.business.name), x, 32, { width: 270 });
  doc.font('Helvetica').fontSize(8.5).fillColor('#555');
  for (const l of spec.business.lines.filter(Boolean)) doc.text(t(l), x, undefined, { width: 270 });
  const headerBottom = doc.y;

  doc.font('Helvetica-Bold').fontSize(20).fillColor(accent).text(t(spec.title.toUpperCase()), left, 30, { width, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#111').text(t(spec.number), left, undefined, { width, align: 'right' });
  doc.font('Helvetica').fontSize(8.5).fillColor('#555');
  for (const [k, v] of spec.meta) doc.text(`${t(k)}: ${t(v)}`, left, undefined, { width, align: 'right' });
  let y = Math.max(headerBottom, doc.y) + 18;

  // ---- parties ----
  const boxW = spec.party2 ? (width - 12) / 2 : width;
  const box = (bx: number, heading: string, name: string | null, lines: string[]) => {
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(accent).text(t(heading.toUpperCase()), bx + 10, y + 8, { width: boxW - 20, characterSpacing: 0.6 });
    if (name) doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#111').text(t(name), bx + 10, undefined, { width: boxW - 20 });
    doc.font('Helvetica').fontSize(8.5).fillColor('#444');
    for (const l of lines.filter(Boolean)) doc.text(t(l), bx + 10, undefined, { width: boxW - 20 });
    return doc.y;
  };
  const b1 = box(left, spec.party.heading, spec.party.name, spec.party.lines);
  const b2 = spec.party2 ? box(left + boxW + 12, spec.party2.heading, null, spec.party2.lines) : b1;
  const boxH = Math.max(b1, b2) - y + 8;
  doc.roundedRect(left, y, boxW, boxH, 4).lineWidth(0.6).strokeColor('#d9dce1').stroke();
  if (spec.party2) doc.roundedRect(left + boxW + 12, y, boxW, boxH, 4).stroke();
  y += boxH + 16;

  // ---- table ----
  const total = spec.columns.reduce((a, c) => a + c.width, 0);
  const cols = spec.columns.map((c) => ({ ...c, w: (c.width / total) * width }));
  const head = () => {
    doc.rect(left, y, width, 20).fill(accent);
    let cx = left;
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#fff');
    for (const c of cols) {
      doc.text(t(c.label), cx + 5, y + 6, { width: c.w - 10, align: c.align ?? 'left', lineBreak: false });
      cx += c.w;
    }
    y += 20;
  };
  head();
  doc.font('Helvetica').fontSize(8.5);
  spec.rows.forEach((row, i) => {
    const h = Math.max(18, ...row.map((cell, j) => doc.heightOfString(t(cell), { width: cols[j]!.w - 10 }) + 9));
    if (y + h > PAGE.h - 110) {
      doc.addPage();
      y = PAGE.margin;
      head();
      doc.font('Helvetica').fontSize(8.5);
    }
    if (i % 2 === 1) doc.rect(left, y, width, h).fill('#f5f6f8');
    let cx = left;
    doc.fillColor('#222');
    row.forEach((cell, j) => {
      doc.text(t(cell), cx + 5, y + 5, { width: cols[j]!.w - 10, align: cols[j]!.align ?? 'left' });
      cx += cols[j]!.w;
    });
    y += h;
  });
  if (!spec.rows.length) {
    doc.fillColor('#777').text('No items', left + 5, y + 6);
    y += 20;
  }
  doc.moveTo(left, y).lineTo(right, y).lineWidth(0.6).strokeColor('#d9dce1').stroke();
  y += 8;

  // ---- totals ----
  if (spec.totals.length) {
    if (y + spec.totals.length * 16 > PAGE.h - 90) {
      doc.addPage();
      y = PAGE.margin;
    }
    const tw = 220;
    for (const row of spec.totals) {
      if (row.bold) {
        doc.rect(right - tw, y - 2, tw, 20).fill('#eef0f3');
        doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#111');
      } else doc.font('Helvetica').fontSize(9).fillColor('#333');
      doc.text(t(row.label), right - tw + 8, y + 3, { width: 110 });
      doc.text(t(row.value), right - 118, y + 3, { width: 110, align: 'right' });
      y += row.bold ? 22 : 16;
    }
  }

  // ---- notes and signatures ----
  y += 10;
  doc.x = left;
  doc.y = y;
  for (const n of (spec.notes ?? []).filter(Boolean)) {
    if (doc.y > PAGE.h - 100) doc.addPage();
    doc.font('Helvetica').fontSize(8.5).fillColor('#444').text(t(n), left, undefined, { width });
    doc.moveDown(0.5);
  }
  if (spec.signatures?.length) {
    if (doc.y > PAGE.h - 120) doc.addPage();
    const sy = doc.y + 30;
    const sw = (width - (spec.signatures.length - 1) * 20) / spec.signatures.length;
    spec.signatures.forEach((s, i) => {
      const sx = left + i * (sw + 20);
      doc.moveTo(sx, sy).lineTo(sx + sw, sy).lineWidth(0.6).strokeColor('#888').stroke();
      doc.font('Helvetica').fontSize(8).fillColor('#555').text(t(s), sx, sy + 4, { width: sw });
    });
  }

  // ---- footer on every page ----
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // Writing below the bottom margin would otherwise start a new page.
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7.5).fillColor('#888');
    doc.text(t(spec.footer ?? `${spec.business.name} - generated by Afey POS`), left, PAGE.h - 30, { width: width - 60, lineBreak: false });
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, right - 60, PAGE.h - 30, { width: 60, align: 'right', lineBreak: false });
  }
  doc.end();
  return done;
}
