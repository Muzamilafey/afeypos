/**
 * Graph view for any report: finds the report's tables (arrays of rows) and figures, and draws them.
 *  - rows over time (days, weeks, months, hours) → line / column chart;
 *  - a few categories (≤ 8, e.g. payment methods) → pie and ranked bars;
 *  - many rows (products, customers…) → the top 15 as ranked bars;
 *  - a single set of figures (e.g. profit summary) → bars of each figure.
 * The measure (sales, profit, quantity…) can be changed; money and quantities are formatted as such.
 */
import { useMemo, useState } from 'react';
import { money, qty as fmtQty } from '../lib/format';
import { CHART_COLORS, GroupedBars, Legend, LineChart, Pie } from './Chart';
import { Select } from './ui';

type Row = Record<string, any>;
interface Dataset { key: string; title: string; rows: Row[]; labelOf: (r: Row) => string; measures: string[] }

const LABEL_KEYS = ['name', 'label', 'product', 'customer', 'supplier', 'cashier', 'branch', 'category', 'method', 'status', 'type', 'reason', 'day', 'date', 'month', 'week', 'hour', 'weekday', 'number', 'code', 'section', 'bucket', 'period', '_id'];
const SKIP = /(^_id$|Id$|^id$|Bp$|^rateBp$|^seq$|^attempts?$|^__v$)/;
const TIMELIKE = /^\d{4}-\d{2}(-\d{2})?([ T].*)?$|^\d{4}-W\d+$|^\d{1,2}$/;

/** Readable name for a field: grossCents → Gross, grossProfitCents → Gross profit. */
export function measureLabel(k: string) {
  const s = k.replace(/Cents$/, '').replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').trim().toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
const isMoney = (k: string) => /Cents$/.test(k);
const fmt = (k: string, v: number) => (isMoney(k) ? money(v) : fmtQty(Math.round(v * 100) / 100));

function textOf(v: any): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object' && !Array.isArray(v)) return v.name ?? v.label ?? v.number ?? (Object.values(v).every((x) => typeof x !== 'object') ? Object.values(v).join(' ') : null);
  return null;
}

function toDataset(key: string, rows: Row[]): Dataset | null {
  const sample = rows.slice(0, 20).filter((r) => r && typeof r === 'object' && !Array.isArray(r));
  if (!sample.length) return null;
  const measures = [...new Set(sample.flatMap((r) => Object.keys(r).filter((k) => typeof r[k] === 'number' && !SKIP.test(k))))];
  if (!measures.length) return null;
  // Money first, then counts and quantities.
  measures.sort((a, b) => Number(isMoney(b)) - Number(isMoney(a)));
  const labelKey = LABEL_KEYS.find((k) => sample.some((r) => textOf(r[k]) != null)) ?? Object.keys(sample[0]!).find((k) => typeof sample[0]![k] === 'string');
  return { key, title: measureLabel(key.split('.').pop() || 'rows'), rows, measures, labelOf: (r) => (labelKey ? textOf(r[labelKey]) ?? '—' : '—') };
}

/** Every chartable table in a report response, largest first, plus its headline figures. */
export function findDatasets(data: unknown): { sets: Dataset[]; figures: { key: string; value: number }[] } {
  const sets: Dataset[] = [];
  const figures: { key: string; value: number }[] = [];
  const walk = (v: any, path: string, depth: number) => {
    if (depth > 3 || v == null) return;
    if (Array.isArray(v)) {
      // One row (e.g. a profit summary): its figures, not a table.
      const unlabelled = (r: any) => !LABEL_KEYS.some((k) => textOf(r?.[k]) != null);
      if (v.length === 1 && v[0] && typeof v[0] === 'object' && unlabelled(v[0])) return walk(v[0], path, depth + 1);
      const d = toDataset(path || 'rows', v);
      if (d) sets.push(d);
      return;
    }
    if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (typeof x === 'number' && isMoney(k) && depth <= 2) figures.push({ key: k, value: x });
        else if (x && typeof x === 'object') walk(x, path ? `${path}.${k}` : k, depth + 1);
      }
    }
  };
  walk(data, '', 0);
  sets.sort((a, b) => b.rows.length - a.rows.length);
  return { sets, figures };
}

function RankedBars({ rows, measure }: { rows: { label: string; value: number }[]; measure: string }) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  return (
    <ul className="space-y-1.5">
      {rows.map((r, i) => (
        <li key={`${r.label}-${i}`} className="grid grid-cols-[minmax(6rem,14rem)_1fr_auto] items-center gap-2 text-[12px]">
          <span className="truncate" title={r.label}>{r.label}</span>
          <div className="h-3 rounded-sm bg-ink-50 dark:bg-ink-800"><div className="h-3 rounded-sm" style={{ width: `${Math.max(1, (Math.abs(r.value) / max) * 100)}%`, background: r.value < 0 ? CHART_COLORS[3] : CHART_COLORS[i % CHART_COLORS.length] }} /></div>
          <span className="tabular-nums text-ink-600 dark:text-ink-300">{fmt(measure, r.value)}</span>
        </li>
      ))}
    </ul>
  );
}

export function AutoChart({ data }: { data: unknown }) {
  const { sets, figures } = useMemo(() => findDatasets(data), [data]);
  const [setKey, setSetKey] = useState<string | null>(null);
  const [measureState, setMeasure] = useState<string | null>(null);
  const set = sets.find((s) => s.key === setKey) ?? sets[0];
  const measure = set && measureState && set.measures.includes(measureState) ? measureState : set?.measures[0];

  if (!set) {
    if (!figures.length) return <p className="p-4 text-sm text-ink-500" data-testid="report-graph">This report has no figures to draw for this period.</p>;
    return (
      <div className="card p-4" data-testid="report-graph">
        <RankedBars rows={figures.map((f) => ({ label: measureLabel(f.key), value: f.value }))} measure="xCents" />
      </div>
    );
  }
  const labels = set.rows.map(set.labelOf);
  const values = set.rows.map((r) => Number(r[measure!] ?? 0));
  const timeline = labels.length > 0 && labels.every((l) => TIMELIKE.test(l));
  // The small charts read their axis in cents; quantities are scaled so the axis reads in units.
  const scale = isMoney(measure!) ? 1 : 100;
  const second = set.measures.find((m) => m !== measure && isMoney(m) === isMoney(measure!) && /profit|tax|discount|cost|refund/i.test(m));
  const ranked = labels.map((label, i) => ({ label, value: values[i]! })).sort((a, b) => b.value - a.value);
  return (
    <div className="card space-y-4 p-4" data-testid="report-graph">
      <div className="flex flex-wrap gap-2">
        {sets.length > 1 && <Select aria-label="Table to draw" className="max-w-xs" value={set.key} onChange={(e) => { setSetKey(e.target.value); setMeasure(null); }} options={sets.map((s) => ({ value: s.key, label: `${s.title} (${s.rows.length})` }))} />}
        <Select aria-label="Measure" className="max-w-xs" value={measure} onChange={(e) => setMeasure(e.target.value)} options={set.measures.map((m) => ({ value: m, label: measureLabel(m) }))} />
      </div>
      {timeline ? (
        <div>
          {labels.length > 20
            ? <LineChart labels={labels.map((l) => l.slice(-5))} series={[{ name: measureLabel(measure!), values: values.map((v) => v * scale) }, ...(second ? [{ name: measureLabel(second), values: set.rows.map((r) => Number(r[second] ?? 0) * scale), color: CHART_COLORS[2] }] : [])]} every={Math.ceil(labels.length / 10)} height={200} fill />
            : <GroupedBars labels={labels.map((l) => (l.length > 7 ? l.slice(-5) : l))} series={[{ name: measureLabel(measure!), values: values.map((v) => v * scale) }, ...(second ? [{ name: measureLabel(second), values: set.rows.map((r) => Number(r[second] ?? 0) * scale), color: CHART_COLORS[2] }] : [])]} height={200} />}
          <div className="mt-2"><Legend items={[{ name: measureLabel(measure!) }, ...(second ? [{ name: measureLabel(second), color: CHART_COLORS[2] }] : [])]} /></div>
        </div>
      ) : (
        <div className={ranked.length <= 8 ? 'grid gap-6 md:grid-cols-2' : ''}>
          {ranked.length <= 8 && ranked.every((r) => r.value >= 0) && <Pie rows={ranked.map((r) => ({ name: r.label, value: r.value }))} size={160} />}
          <div>
            {ranked.length > 15 && <p className="mb-2 text-[12px] text-ink-500">Top 15 of {ranked.length} by {measureLabel(measure!).toLowerCase()}</p>}
            <RankedBars rows={ranked.slice(0, 15)} measure={measure!} />
          </div>
        </div>
      )}
    </div>
  );
}
