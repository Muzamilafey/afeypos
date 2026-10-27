/**
 * PDF and Print for reports. The page's report area is read into a plain description (stat tiles, tables,
 * line lists, notes) and the server lays it out on the business letterhead, as a PDF file or a print page,
 * so both look the same and match what is on screen.
 *
 * What is picked up inside the report area:
 *   [data-stat]            a stat tile ([data-stat-label], [data-stat-value], [data-stat-hint], data-tone)
 *   <table>                a table (thead → columns, tbody → rows, tfoot → totals; "num" cells align right)
 *   [data-lines]           a list of "label … amount" rows ([data-line] / [data-line-total]); its value names the two columns
 *   [data-report-text]     a paragraph
 *   [data-report-empty]    "nothing here" text
 * Section titles come from the nearest [data-report-title]. Buttons, inputs, charts and [data-report-skip] are left out.
 */
import { api, ApiError } from './api';

export interface ReportSpec {
  title: string;
  subtitle?: string;
  meta: [string, string][];
  orientation?: 'portrait' | 'landscape';
  sections: (
    | { kind: 'stats'; title?: string; items: { label: string; value: string; hint?: string; tone?: 'red' | 'green' }[] }
    | { kind: 'table'; title?: string; columns: { label: string; align?: 'left' | 'right' | 'center' }[]; rows: string[][]; totals?: string[][]; empty?: string }
    | { kind: 'text'; title?: string; lines: string[] }
  )[];
}

const SKIP = 'button, input, select, textarea, svg, canvas, nav, [role="tablist"], [data-report-skip]';
const clean = (s: string | null | undefined) => (s ?? '').replace(/[ \t\r\f\v\u00a0]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();

/** Visible text of an element, without its buttons and icons. */
function textOf(el: Element | null): string {
  if (!el) return '';
  const c = el.cloneNode(true) as Element;
  c.querySelectorAll(SKIP).forEach((x) => x.remove());
  // Block children read as separate lines.
  c.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
  c.querySelectorAll('div, p, li').forEach((d) => d.prepend('\n'));
  // Side-by-side spans ("Gross profit" "Ksh 1,000") keep a space between them.
  c.querySelectorAll('span, a').forEach((x) => x.append(' '));
  return clean(c.textContent);
}

function titleFor(el: Element, root: Element): string | undefined {
  const t = el.parentElement?.closest('[data-report-title]');
  return t && root.contains(t) && t !== root ? t.getAttribute('data-report-title') || undefined : undefined;
}

const alignOf = (cell: Element): 'left' | 'right' | 'center' | undefined => {
  if (cell.classList.contains('num')) return 'right';
  const a = getComputedStyle(cell).textAlign;
  return a === 'right' || a === 'end' ? 'right' : a === 'center' ? 'center' : undefined;
};

function rowCells(tr: HTMLTableRowElement, width: number): string[] {
  const out: string[] = [];
  for (const td of Array.from(tr.cells)) {
    out.push(textOf(td));
    for (let i = 1; i < td.colSpan; i++) out.push('');
  }
  // A label spanning several columns with one value: keep the value under the last column.
  while (out.length < width) out.splice(out.length - 1, 0, '');
  return out.slice(0, width);
}

function tableSection(table: HTMLTableElement, root: Element): ReportSpec['sections'][number] | null {
  const headRow = table.tHead?.rows[0];
  const bodyRows = Array.from(table.tBodies).flatMap((b) => Array.from(b.rows));
  const first = headRow ?? bodyRows[0];
  if (!first) return null;
  const width = Array.from(first.cells).reduce((n, c) => n + c.colSpan, 0);
  const sample = bodyRows[0];
  const columns = Array.from({ length: width }, (_, j) => {
    const th = headRow?.cells[j];
    const td = sample?.cells[j];
    return { label: th ? textOf(th) : '', align: (td && alignOf(td)) ?? (th && alignOf(th)) };
  });
  const rows = (headRow ? bodyRows : bodyRows.slice(1)).map((r) => rowCells(r, width));
  const totals = table.tFoot ? Array.from(table.tFoot.rows).map((r) => rowCells(r, width)) : undefined;
  // Leave out action columns (no heading, nothing written in them).
  const keep = columns.map((c, j) => Boolean(c.label) || rows.some((r) => r[j]) || Boolean(totals?.some((r) => r[j])));
  const pick = <T,>(xs: T[]) => xs.filter((_, j) => keep[j]);
  return { kind: 'table', title: titleFor(table, root), columns: pick(columns), rows: rows.map(pick), totals: totals?.length ? totals.map(pick) : undefined };
}

export function extractReport(root: HTMLElement, head: { title: string; subtitle?: string; meta?: [string, string][]; orientation?: 'portrait' | 'landscape' }): ReportSpec {
  const sections: ReportSpec['sections'] = [];
  const visit = (el: Element) => {
    if (el.matches(SKIP) || (el as HTMLElement).hidden) return;
    if (el.matches('[data-stat]')) {
      const item = {
        label: textOf(el.querySelector('[data-stat-label]')), value: textOf(el.querySelector('[data-stat-value]')),
        hint: textOf(el.querySelector('[data-stat-hint]')).replace(/\n/g, ' ') || undefined, tone: (el.getAttribute('data-tone') || undefined) as 'red' | undefined,
      };
      const title = titleFor(el, root);
      const last = sections[sections.length - 1];
      if (last?.kind === 'stats' && last.title === title) last.items.push(item);
      else sections.push({ kind: 'stats', title, items: [item] });
      return;
    }
    if (el instanceof HTMLTableElement) {
      const s = tableSection(el, root);
      if (s) sections.push(s);
      return;
    }
    if (el.matches('[data-lines]')) {
      const [a = '', b = ''] = (el.getAttribute('data-lines') || '').split('|');
      const pair = (x: Element) => [textOf(x.firstElementChild), textOf(x.lastElementChild)];
      sections.push({
        kind: 'table', title: el.getAttribute('data-title') || titleFor(el, root), columns: [{ label: a }, { label: b, align: 'right' }],
        rows: Array.from(el.querySelectorAll('[data-line]')).map(pair), totals: Array.from(el.querySelectorAll('[data-line-total]')).map(pair), empty: 'Nothing to show',
      });
      return;
    }
    if (el.matches('[data-report-text], [data-report-empty]')) {
      const line = textOf(el).replace(/\n/g, ' ');
      if (line) {
        const title = titleFor(el, root);
        const last = sections[sections.length - 1];
        if (last?.kind === 'text' && last.title === title) last.lines.push(line);
        else sections.push({ kind: 'text', title, lines: [line] });
      }
      return;
    }
    for (const c of Array.from(el.children)) visit(c);
  };
  for (const c of Array.from(root.children)) visit(c);
  if (!sections.length) sections.push({ kind: 'text', lines: ['Nothing to show for these filters.'] });
  return { title: head.title, subtitle: head.subtitle, meta: head.meta ?? [], orientation: head.orientation, sections };
}

const fileName = (title: string) => `${title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'report'}.pdf`;

export async function downloadReportPdf(spec: ReportSpec) {
  const res = await api<Response>('/render/report', { raw: true, body: spec, query: { format: 'pdf' } });
  if (!res.ok) throw new ApiError(res.status, 'PDF', (await res.json().catch(() => null))?.error?.message ?? 'Could not make the PDF');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName(spec.title);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Prints an HTML page from a hidden frame: the browser's print dialog, no extra window. */
export function printHtml(html: string) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('data-testid', 'print-frame');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(frame);
  const w = frame.contentWindow!;
  w.document.open();
  w.document.write(html);
  w.document.close();
  let printed = false;
  const go = () => {
    if (printed) return;
    printed = true;
    w.focus();
    w.print();
    // Chrome blocks until the dialog closes; others return at once, so keep the frame a while.
    setTimeout(() => frame.remove(), 60_000);
  };
  // Wait for the logo, then print.
  const imgs = Array.from(w.document.images);
  if (imgs.every((i) => i.complete)) setTimeout(go, 50);
  else {
    imgs.forEach((i) => i.addEventListener('load', () => imgs.every((x) => x.complete) && go()));
    setTimeout(go, 1500);
  }
}

export async function printReport(spec: ReportSpec) {
  const res = await api<Response>('/render/report', { raw: true, body: spec, query: { format: 'html' } });
  if (!res.ok) throw new ApiError(res.status, 'PRINT', (await res.json().catch(() => null))?.error?.message ?? 'Could not prepare the printout');
  printHtml(await res.text());
}
