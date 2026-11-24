import { useRef } from 'react';
import { denominationTotalCents, denominationsFor, type Denomination } from '@afeypos/shared';
import { useAuth } from '../lib/auth';
import { money } from '../lib/format';
import { cx } from './ui';

export type CashCounts = Record<string, number>;

/** Crops of the 2024 KES note fronts in the CBK guide (source link in public/images/currency/README.md). */
const KES_NOTE_POSITION: Record<number, string> = {
  100000: '48.7% 90.1%', 50000: '50% 74.8%', 20000: '51.8% 59.8%', 10000: '53.3% 45.1%', 5000: '54.7% 30.7%',
};
/** Fronts of the 20, 10, 5 and 1 shilling coins in the CBK coin guide; 50 cents uses the neutral fallback. */
const KES_COIN_POSITION: Record<number, string> = { 2000: '90.8% 70.5%', 1000: '62.7% 70.5%', 500: '34.5% 70.5%', 100: '7% 70.5%' };
const face = (d: Denomination) => (d.valueCents >= 100 ? (d.valueCents / 100).toLocaleString() : `${d.valueCents}¢`);

function NoteChip({ d, currency }: { d: Denomination; currency: string }) {
  const kesPosition = currency === 'KES' ? KES_NOTE_POSITION[d.valueCents] : undefined;
  if (kesPosition) return (
    <span aria-hidden="true" title={`${face(d)} shilling note`} className="inline-flex h-9 w-[4.75rem] shrink-0 overflow-hidden rounded-[5px] bg-[#e4e8e6] shadow-sm ring-1 ring-black/10"
      style={{ backgroundImage: 'url(/images/currency/cbk-kes-2024-notes.jpg)', backgroundSize: '360% auto', backgroundPosition: kesPosition }} />
  );
  return (
    <span aria-hidden="true" className="relative inline-flex h-9 w-[4.75rem] shrink-0 items-center justify-end overflow-hidden rounded-[5px] bg-gradient-to-br from-slate-500 to-slate-800 pr-1.5 text-white shadow-sm ring-1 ring-black/10">
      <span className="text-sm font-black tabular-nums drop-shadow">{face(d)}</span>
    </span>
  );
}

function CoinChip({ d, currency }: { d: Denomination; currency: string }) {
  const kesPosition = currency === 'KES' ? KES_COIN_POSITION[d.valueCents] : undefined;
  if (kesPosition) return (
    <span aria-hidden="true" title={`${face(d)} shilling coin`} className="inline-flex h-9 w-9 shrink-0 rounded-full bg-[#d1d4d2] shadow-sm ring-2 ring-white"
      style={{ backgroundImage: 'url(/images/currency/cbk-kes-coins.jpg)', backgroundSize: '650% auto', backgroundPosition: kesPosition }} />
  );
  // A neutral coin chip keeps unsupported images identifiable by value.
  const gold = d.valueCents >= 500;
  return (
    <span aria-hidden="true" className={cx('inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[11px] font-black shadow-sm ring-2', gold ? 'bg-gradient-to-br from-[#f2d36b] to-[#b8901f] text-[#3b2f0b] ring-[#e7c95a]' : 'bg-gradient-to-br from-[#eef0f3] to-[#a9b0b8] text-[#2b3036] ring-[#cfd4da]')}>
      {face(d)}
    </span>
  );
}

/**
 * Counting the drawer note by note: how many of each note and coin, with − / + for touch screens. Enter moves to
 * the next row, so a cashier can count with the keyboard only. Totals per row, for notes, for coins and overall;
 * with an expected amount, the difference is shown as the cashier counts.
 */
export function CashCount({ counts, onChange, autoFocus, label = 'Cash in the drawer', expectedCents, columns = 2 }: { counts: CashCounts; onChange: (c: CashCounts) => void; autoFocus?: boolean; label?: string; expectedCents?: number | null; columns?: 1 | 2 }) {
  const { me } = useAuth();
  const currency = (me?.tenant.settings?.currency ?? 'KES').toUpperCase();
  const list = denominationsFor(currency) ?? [];
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const total = denominationTotalCents(counts, list);
  const sub = (kind: 'note' | 'coin') => denominationTotalCents(counts, list.filter((d) => d.kind === kind));
  const pieces = (kind: 'note' | 'coin') => list.filter((d) => d.kind === kind).reduce((a, d) => a + (counts[d.key] ?? 0), 0);
  const set = (d: Denomination, v: number) => onChange({ ...counts, [d.key]: Math.max(0, Math.min(100000, Math.floor(v) || 0)) });
  const tile = (i: number) => {
    const d = list[i]!;
    const n = counts[d.key] ?? 0;
    return (
      <div key={d.key} className={cx('flex items-center gap-2 rounded-lg border px-2.5 py-2 transition', n > 0 ? 'border-emerald-300 bg-emerald-50/70 dark:border-emerald-800 dark:bg-emerald-950/30' : 'border-ink-100 bg-white dark:border-ink-800 dark:bg-ink-900')}>
        {d.kind === 'note' ? <NoteChip d={d} currency={currency} /> : <CoinChip d={d} currency={currency} />}
        <div className="flex items-center">
          <button type="button" tabIndex={-1} aria-label={`One ${money(d.valueCents)} ${d.kind} less`} disabled={!n} onClick={() => set(d, n - 1)}
            className="flex h-9 w-8 items-center justify-center rounded-l-md border border-r-0 border-ink-200 text-lg font-bold text-ink-500 hover:bg-ink-50 disabled:opacity-40 dark:border-ink-700 dark:hover:bg-ink-800">−</button>
          <input ref={(el) => { refs.current[i] = el; }} autoFocus={autoFocus && i === 0} inputMode="numeric" aria-label={`Number of ${money(d.valueCents)} ${d.kind}s`}
            className="h-9 w-14 border border-ink-200 bg-white text-center font-mono text-base font-semibold focus:z-10 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:border-ink-700 dark:bg-ink-950"
            value={n ? String(n) : ''} placeholder="0"
            onFocus={(e) => e.target.select()}
            onChange={(e) => set(d, Number(e.target.value.replace(/\D/g, '')))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && i < list.length - 1) { e.preventDefault(); refs.current[i + 1]?.focus(); }
              if (e.key === 'ArrowUp') { e.preventDefault(); set(d, n + 1); }
              if (e.key === 'ArrowDown') { e.preventDefault(); set(d, n - 1); }
            }} />
          <button type="button" tabIndex={-1} aria-label={`One ${money(d.valueCents)} ${d.kind} more`} onClick={() => set(d, n + 1)}
            className="flex h-9 w-8 items-center justify-center rounded-r-md border border-l-0 border-ink-200 text-lg font-bold text-ink-500 hover:bg-ink-50 dark:border-ink-700 dark:hover:bg-ink-800">+</button>
        </div>
        <span className={cx('ml-auto min-w-[5.5rem] text-right font-mono text-sm tabular-nums', n ? 'font-semibold text-ink-900 dark:text-white' : 'text-ink-300')}>{n ? money(n * d.valueCents) : '—'}</span>
      </div>
    );
  };
  if (!list.length) return <p className="text-sm text-ink-500">Note and coin counting is not set up for this currency: enter the total instead.</p>;
  const notes = list.map((d, i) => ({ d, i })).filter((x) => x.d.kind === 'note');
  const coins = list.map((d, i) => ({ d, i })).filter((x) => x.d.kind === 'coin');
  const diff = expectedCents == null ? null : total - expectedCents;
  return (
    <fieldset className="space-y-4" aria-label={label}>
      <section>
        <div className="mb-1.5 flex items-baseline justify-between px-0.5 text-[11px] font-bold uppercase tracking-wide text-ink-500"><span>Notes</span><span className="normal-case tracking-normal">{pieces('note')} notes · <b className="text-ink-700 dark:text-ink-200">{money(sub('note'))}</b></span></div>
        <div className={cx('grid gap-1.5', columns === 2 && 'xl:grid-cols-2')}>{notes.map((x) => tile(x.i))}</div>
      </section>
      <section>
        <div className="mb-1.5 flex items-baseline justify-between px-0.5 text-[11px] font-bold uppercase tracking-wide text-ink-500"><span>Coins</span><span className="normal-case tracking-normal">{pieces('coin')} coins · <b className="text-ink-700 dark:text-ink-200">{money(sub('coin'))}</b></span></div>
        <div className={cx('grid gap-1.5', columns === 2 && 'xl:grid-cols-2')}>{coins.map((x) => tile(x.i))}</div>
      </section>
      <div className="overflow-hidden rounded-xl bg-gradient-to-r from-[#1f5a40] to-[#2f7d57] text-white shadow-sm">
        <div className="flex items-center justify-between px-4 py-3" data-testid="cash-count-total">
          <span className="text-sm font-semibold uppercase tracking-wide opacity-90">{label}</span>
          <span className="text-3xl font-black tabular-nums">{money(total)}</span>
        </div>
        {diff !== null && total > 0 && (
          <div className={cx('flex items-center justify-between px-4 py-1.5 text-sm font-semibold', diff === 0 ? 'bg-emerald-900/40' : diff < 0 ? 'bg-red-600/80' : 'bg-amber-500/80')} data-testid="cash-count-diff">
            <span>{diff === 0 ? 'Matches the expected cash' : diff < 0 ? 'Short' : 'Over'}</span>
            <span className="tabular-nums">{diff === 0 ? '✓' : money(Math.abs(diff))}</span>
          </div>
        )}
      </div>
    </fieldset>
  );
}

export const cashCountTotal = (counts: CashCounts, currency?: string | null) => denominationTotalCents(counts, denominationsFor(currency) ?? []);
