/** Small SVG charts in the admin template palette (blue, yellow, purple, red, teal, green). */
export const CHART_COLORS = ['#4a9be3', '#f3c24c', '#9b7fd6', '#e8625b', '#3fb8b0', '#62b86f'];

/** 874000 cents → "8.7k", for axis and compact figures (shillings). */
export function compact(cents: number) {
  const v = (cents ?? 0) / 100;
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(v >= 100_000 ? 0 : 1)}k`;
  return String(Math.round(v));
}

/** Single-series bar chart (reports). */
export function BarChart({ data, height = 160, format }: { data: { label: string; value: number }[]; height?: number; format: (v: number) => string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  if (!data.length) return <p className="text-sm text-ink-500">No data for this period.</p>;
  return (
    <div className="flex items-end gap-1" style={{ height }} role="img" aria-label="Bar chart">
      {data.map((d) => (
        <div key={d.label} className="group flex min-w-0 flex-1 flex-col items-center justify-end" title={`${d.label}: ${format(d.value)}`}>
          <div className="w-full max-w-[18px] rounded-t-sm bg-[#4a9be3] transition group-hover:bg-[#3a86cf]" style={{ height: `${Math.max(2, (d.value / max) * (height - 24))}px` }} />
          <div className="mt-1 w-full truncate text-center text-[10px] text-ink-500">{d.label}</div>
        </div>
      ))}
    </div>
  );
}

/** Two series side by side per label (e.g. sales and profit per day). */
export function GroupedBars({ labels, series, height = 170, every = 1 }: { labels: string[]; series: { name: string; values: number[]; color?: string }[]; height?: number; every?: number }) {
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const W = 600;
  const H = height;
  const B = 18;
  const n = labels.length;
  const slot = W / Math.max(1, n);
  const bw = Math.max(2, Math.min(9, (slot * 0.7) / series.length));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={series.map((s) => s.name).join(' and ')}>
      {[0.25, 0.5, 0.75, 1].map((f) => <line key={f} x1="0" x2={W} y1={(H - B) * (1 - f)} y2={(H - B) * (1 - f)} stroke="#eef0f3" />)}
      {labels.map((l, i) => (
        <g key={`${l}-${i}`}>
          {series.map((s, k) => {
            const v = s.values[i] ?? 0;
            const h = Math.max(v > 0 ? 2 : 0, (v / max) * (H - B - 4));
            return <rect key={s.name} x={i * slot + (slot - bw * series.length) / 2 + k * bw} y={H - B - h} width={bw - 1} height={h} fill={s.color ?? CHART_COLORS[k]}><title>{`${l} · ${s.name}: ${compact(v)}`}</title></rect>;
          })}
          {i % every === 0 && <text x={i * slot + slot / 2} y={H - 4} textAnchor="middle" fontSize="10" fill="#8b929b">{l}</text>}
        </g>
      ))}
    </svg>
  );
}

/** Multi-series line chart with dots (area graph style in the template). */
export function LineChart({ labels, series, height = 150, fill = false, every = 1 }: { labels: string[]; series: { name: string; values: number[]; color?: string }[]; height?: number; fill?: boolean; every?: number }) {
  const W = 600;
  const H = height;
  const L = 34;
  const B = 18;
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const x = (i: number) => L + (labels.length <= 1 ? 0 : (i * (W - L - 8)) / (labels.length - 1));
  const y = (v: number) => 6 + (H - B - 6) * (1 - v / max);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={series.map((s) => s.name).join(' and ')}>
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={L} x2={W - 8} y1={y(max * f)} y2={y(max * f)} stroke="#eef0f3" />
          <text x={L - 6} y={y(max * f) + 3} textAnchor="end" fontSize="9" fill="#8b929b">{compact(max * f)}</text>
        </g>
      ))}
      {series.map((s, k) => {
        const c = s.color ?? CHART_COLORS[k];
        const pts = s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
        return (
          <g key={s.name}>
            {fill && <polygon points={`${x(0)},${H - B} ${pts} ${x(s.values.length - 1)},${H - B}`} fill={c} fillOpacity="0.35" />}
            <polyline points={pts} fill="none" stroke={c} strokeWidth="2" />
            {!fill && s.values.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r="2.6" fill="#fff" stroke={c} strokeWidth="1.6"><title>{`${labels[i]} · ${s.name}: ${compact(v)}`}</title></circle>)}
          </g>
        );
      })}
      {labels.map((l, i) => (i % every === 0 ? <text key={`${l}-${i}`} x={x(i)} y={H - 4} textAnchor="middle" fontSize="9.5" fill="#8b929b">{l}</text> : null))}
    </svg>
  );
}

/** Pie chart with legend (shares of a whole). */
export function Pie({ rows, size = 130 }: { rows: { name: string; value: number }[]; size?: number }) {
  const total = rows.reduce((s, r) => s + r.value, 0);
  const r = 50;
  let a = 0;
  const slices = rows.map((row, i) => {
    const ang = total ? (row.value / total) * Math.PI * 2 : 0;
    const [x1, y1] = [60 + r * Math.sin(a), 60 - r * Math.cos(a)];
    a += ang;
    const [x2, y2] = [60 + r * Math.sin(a), 60 - r * Math.cos(a)];
    const d = ang >= Math.PI * 2 - 1e-6 ? `M60,10 A50,50 0 1 1 59.99,10 Z` : `M60,60 L${x1},${y1} A${r},${r} 0 ${ang > Math.PI ? 1 : 0} 1 ${x2},${y2} Z`;
    return <path key={row.name} d={d} fill={CHART_COLORS[i % CHART_COLORS.length]} stroke="#fff" strokeWidth="1"><title>{`${row.name}: ${total ? Math.round((row.value / total) * 100) : 0}%`}</title></path>;
  });
  if (!total) return <p className="text-sm text-ink-500">No data yet.</p>;
  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 120 120" style={{ width: size, height: size }} role="img" aria-label="Pie chart">{slices}</svg>
      <ul className="space-y-1.5 text-[12px]">{rows.map((row, i) => <li key={row.name} className="flex items-center gap-2"><span className="h-3 w-3 rounded-sm" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} /><span className="truncate">{row.name}</span><span className="ml-auto pl-2 text-ink-500">{Math.round((row.value / total) * 100)}%</span></li>)}</ul>
    </div>
  );
}

/** Circular progress figure (0-100). */
export function Ring({ value, label, color = CHART_COLORS[0] }: { value: number; label: string; color?: string }) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  const c = 2 * Math.PI * 26;
  return (
    <div className="flex flex-col items-center gap-1">
      <svg viewBox="0 0 64 64" className="h-[70px] w-[70px]" role="img" aria-label={`${label} ${v}%`}>
        <circle cx="32" cy="32" r="26" fill="none" stroke="#eef0f3" strokeWidth="6" />
        <circle cx="32" cy="32" r="26" fill="none" stroke={color} strokeWidth="6" strokeDasharray={`${(v / 100) * c} ${c}`} transform="rotate(-90 32 32)" strokeLinecap="round" />
        <text x="32" y="36" textAnchor="middle" fontSize="15" fontWeight="700" fill="currentColor">{v}</text>
      </svg>
      <span className="text-center text-[11px] text-ink-500">{label}</span>
    </div>
  );
}

/** Tiny area sparkline. */
export function Sparkline({ values, color = CHART_COLORS[2] }: { values: number[]; color?: string }) {
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${(i * 60) / Math.max(1, values.length - 1)},${20 - (v / max) * 18}`).join(' ');
  return (
    <svg viewBox="0 0 60 20" className="h-5 w-16" aria-hidden="true">
      <polygon points={`0,20 ${pts} 60,20`} fill={color} fillOpacity="0.45" />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.2" />
    </svg>
  );
}

/** Grouped horizontal bars (bar graph in the template). */
export function HBars({ labels, series }: { labels: string[]; series: { name: string; values: number[]; color?: string }[] }) {
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  return (
    <div className="space-y-2.5">
      {labels.map((l, i) => (
        <div key={l} className="grid grid-cols-[3rem_1fr] items-center gap-2">
          <span className="text-[11px] text-ink-500">{l}</span>
          <div className="space-y-1">{series.map((s, k) => <div key={s.name} className="h-2.5 rounded-sm" title={`${s.name}: ${compact(s.values[i] ?? 0)}`} style={{ width: `${Math.max(1, ((s.values[i] ?? 0) / max) * 100)}%`, background: s.color ?? CHART_COLORS[k] }} />)}</div>
        </div>
      ))}
    </div>
  );
}

export function Legend({ items }: { items: { name: string; color?: string }[] }) {
  return <div className="flex flex-wrap gap-1.5">{items.map((it, i) => <span key={it.name} className="rounded-sm px-2 py-0.5 text-[11px] font-semibold text-white" style={{ background: it.color ?? CHART_COLORS[i] }}>{it.name}</span>)}</div>;
}
