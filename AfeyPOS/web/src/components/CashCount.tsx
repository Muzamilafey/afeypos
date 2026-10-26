import { useRef } from 'react';
import { denominationTotalCents, denominationsFor } from '@afeypos/shared';
import { useAuth } from '../lib/auth';
import { money } from '../lib/format';
import { cx } from './ui';

export type CashCounts = Record<string, number>;

/**
 * Counting the drawer note by note: how many of each note and coin. Enter moves to the next row, so a
 * cashier can count with the keyboard only. Totals per row, for notes, for coins and overall.
 */
export function CashCount({ counts, onChange, autoFocus, label = 'Cash in the drawer' }: { counts: CashCounts; onChange: (c: CashCounts) => void; autoFocus?: boolean; label?: string }) {
  const { me } = useAuth();
  const list = denominationsFor(me?.tenant.settings?.currency) ?? [];
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const total = denominationTotalCents(counts, list);
  const sub = (kind: 'note' | 'coin') => denominationTotalCents(counts, list.filter((d) => d.kind === kind));
  const pieces = (kind: 'note' | 'coin') => list.filter((d) => d.kind === kind).reduce((a, d) => a + (counts[d.key] ?? 0), 0);
  const row = (i: number) => {
    const d = list[i]!;
    const n = counts[d.key] ?? 0;
    return (
      <div key={d.key} className={cx('grid grid-cols-[minmax(0,1fr)_96px_minmax(0,1fr)] items-center gap-3 rounded-md px-2 py-1.5', n > 0 ? 'bg-emerald-50/70 dark:bg-emerald-950/30' : '')}>
        <span className="flex items-center gap-2 text-sm">
          <span className={cx('inline-flex items-center justify-center font-bold', d.kind === 'note' ? 'h-6 w-11 rounded-sm bg-[#2f6b4f] text-[10px] text-white' : 'h-7 w-7 rounded-full bg-[#c9a227] text-[9px] text-[#3b2f0b] ring-2 ring-[#e7c95a]')} aria-hidden="true">{d.valueCents >= 100 ? d.valueCents / 100 : `${d.valueCents}¢`}</span>
          <span>{money(d.valueCents)} {d.kind === 'note' ? 'note' : 'coin'}</span>
        </span>
        <input ref={(el) => { refs.current[i] = el; }} autoFocus={autoFocus && i === 0} inputMode="numeric" aria-label={`Number of ${money(d.valueCents)} ${d.kind}s`}
          className="input py-1.5 text-center font-mono" value={n ? String(n) : ''} placeholder="0"
          onChange={(e) => { const v = Math.max(0, Math.min(100000, Math.floor(Number(e.target.value.replace(/\D/g, '')) || 0))); onChange({ ...counts, [d.key]: v }); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && i < list.length - 1) { e.preventDefault(); refs.current[i + 1]?.focus(); refs.current[i + 1]?.select(); } }} />
        <span className="text-right font-mono text-sm tabular-nums">{n ? money(n * d.valueCents) : '—'}</span>
      </div>
    );
  };
  if (!list.length) return <p className="text-sm text-ink-500">Note and coin counting is not set up for this currency: enter the total instead.</p>;
  const notes = list.map((d, i) => ({ d, i })).filter((x) => x.d.kind === 'note');
  const coins = list.map((d, i) => ({ d, i })).filter((x) => x.d.kind === 'coin');
  return (
    <fieldset className="space-y-3" aria-label={label}>
      <div>
        <div className="mb-1 flex justify-between px-2 text-[11px] font-bold uppercase tracking-wide text-ink-500"><span>Notes</span><span>{pieces('note')} notes · {money(sub('note'))}</span></div>
        <div className="space-y-0.5">{notes.map((x) => row(x.i))}</div>
      </div>
      <div>
        <div className="mb-1 flex justify-between px-2 text-[11px] font-bold uppercase tracking-wide text-ink-500"><span>Coins</span><span>{pieces('coin')} coins · {money(sub('coin'))}</span></div>
        <div className="space-y-0.5">{coins.map((x) => row(x.i))}</div>
      </div>
      <div className="flex items-center justify-between rounded-lg bg-[#2f6b4f] px-4 py-3 text-white" data-testid="cash-count-total">
        <span className="text-sm font-semibold uppercase tracking-wide">{label}</span>
        <span className="text-2xl font-black tabular-nums">{money(total)}</span>
      </div>
    </fieldset>
  );
}

export const cashCountTotal = (counts: CashCounts, currency?: string | null) => denominationTotalCents(counts, denominationsFor(currency) ?? []);
