/** Minimal accessible bar chart (SVG) for dashboards and reports. */
export function BarChart({ data, height = 160, format }: { data: { label: string; value: number }[]; height?: number; format: (v: number) => string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  if (!data.length) return <p className="text-sm text-ink-500">No data for this period.</p>;
  return (
    <div className="flex items-end gap-1" style={{ height }} role="img" aria-label="Bar chart">
      {data.map((d) => (
        <div key={d.label} className="group flex min-w-0 flex-1 flex-col items-center justify-end" title={`${d.label}: ${format(d.value)}`}>
          <div className="w-full rounded-t bg-brand-500/80 transition group-hover:bg-brand-600" style={{ height: `${Math.max(2, (d.value / max) * (height - 24))}px` }} />
          <div className="mt-1 w-full truncate text-center text-[10px] text-ink-500">{d.label}</div>
        </div>
      ))}
    </div>
  );
}
