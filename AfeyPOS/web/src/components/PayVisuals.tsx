import type { ReactNode } from 'react';
import { money } from '../lib/format';
import { cx } from './ui';

/** The M-Pesa badge: green, with the M-PESA word and a phone. */
export function MpesaMark({ className = 'h-14' }: { className?: string }) {
  return (
    <svg viewBox="0 0 150 56" className={className} role="img" aria-label="M-Pesa">
      <rect width="150" height="56" rx="14" fill="#4CAF50" />
      <rect x="2" y="2" width="146" height="52" rx="12" fill="url(#mp-g)" />
      <defs>
        <linearGradient id="mp-g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#5BC236" /><stop offset="1" stopColor="#3E9B2A" /></linearGradient>
      </defs>
      <g transform="translate(14 11)">
        <rect width="20" height="34" rx="4" fill="#fff" />
        <rect x="3" y="4" width="14" height="22" rx="1.5" fill="#3E9B2A" />
        <circle cx="10" cy="30" r="1.8" fill="#3E9B2A" />
      </g>
      <text x="44" y="37" fill="#fff" fontFamily="Arial Black, Arial, sans-serif" fontWeight="900" fontSize="23" letterSpacing="0.5">M-PESA</text>
    </svg>
  );
}

const Dots = () => <span className="pay-dots ml-1 inline-flex gap-0.5 align-middle" aria-hidden><span className="h-1.5 w-1.5 rounded-full bg-current" /><span className="h-1.5 w-1.5 rounded-full bg-current" /><span className="h-1.5 w-1.5 rounded-full bg-current" /></span>;

/** Waiting for an M-Pesa payment: the badge with ripples. Only a short line of text. */
export function MpesaWaiting({ title, children, compact }: { title: ReactNode; children?: ReactNode; compact?: boolean }) {
  return (
    <div className={cx('relative flex flex-col items-center overflow-hidden rounded-xl bg-gradient-to-b from-emerald-50 to-white text-center dark:from-emerald-950/40 dark:to-ink-900', compact ? 'py-4' : 'py-7')} aria-live="polite">
      <div className="relative flex items-center justify-center">
        <span className="pay-ripple absolute h-20 w-20 rounded-full bg-emerald-400/40" />
        <span className="pay-ripple absolute h-20 w-20 rounded-full bg-emerald-400/40" style={{ animationDelay: '0.7s' }} />
        <span className="pay-ripple absolute h-20 w-20 rounded-full bg-emerald-400/40" style={{ animationDelay: '1.4s' }} />
        <div className="pay-bob relative"><MpesaMark className={compact ? 'h-11' : 'h-14'} /></div>
      </div>
      <div className={cx('font-semibold text-emerald-900 dark:text-emerald-100', compact ? 'mt-3 text-sm' : 'mt-5 text-base')}>{title}<Dots /></div>
      {children && <div className="mt-1 text-sm text-emerald-900/80 dark:text-emerald-100/80">{children}</div>}
    </div>
  );
}

const BURST = [0, 45, 90, 135, 180, 225, 270, 315];

/** Payment done: a drawn check with a small burst, the amount, and one line underneath. */
export function PaySuccess({ amountCents, title, children, tone = 'emerald', logo, testId, label }: {
  amountCents?: number; title: ReactNode; children?: ReactNode; tone?: 'emerald' | 'sky'; logo?: ReactNode; testId?: string; label?: string;
}) {
  const c = tone === 'sky' ? { ring: '#0EA5E9', bg: 'from-sky-50 dark:from-sky-950/40', text: 'text-sky-900 dark:text-sky-100', dot: 'bg-sky-400' } : { ring: '#16A34A', bg: 'from-emerald-50 dark:from-emerald-950/40', text: 'text-emerald-900 dark:text-emerald-100', dot: 'bg-emerald-400' };
  return (
    <div className={cx('relative flex flex-col items-center overflow-hidden rounded-xl bg-gradient-to-b to-white px-4 py-6 text-center dark:to-ink-900', c.bg)} role="status" data-testid={testId} aria-label={label}>
      <div className="relative h-20 w-20">
        {BURST.map((a, i) => <span key={a} className={cx('pay-burst absolute left-1/2 top-1/2 -ml-1 -mt-1 h-2 w-2 rounded-full', i % 2 ? 'bg-amber-400' : c.dot)} style={{ ['--a' as string]: `${a}deg` }} />)}
        <svg viewBox="0 0 64 64" className="pay-pop relative h-20 w-20">
          <circle cx="32" cy="32" r="30" fill={c.ring} opacity="0.12" />
          <circle cx="32" cy="32" r="30" fill="none" stroke={c.ring} strokeWidth="3" className="pay-ring" transform="rotate(-90 32 32)" />
          <path d="M19 33 l9 9 l17 -19" fill="none" stroke={c.ring} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" className="pay-draw" />
        </svg>
      </div>
      {logo && <div className="pay-pop mt-3" style={{ animationDelay: '0.25s' }}>{logo}</div>}
      <div className={cx('mt-3 text-sm font-semibold uppercase tracking-wide', c.text)}>{title}</div>
      {amountCents !== undefined && <div className={cx('pay-pop text-3xl font-bold tabular-nums', c.text)} style={{ animationDelay: '0.2s' }}>{money(amountCents)}</div>}
      {children && <div className="mt-1 text-sm text-ink-600 dark:text-ink-300">{children}</div>}
    </div>
  );
}

/** Cash at the till: notes fanned out, the amount due, and the change popping in once enough is given. */
export function CashVisual({ dueCents, tenderedCents }: { dueCents: number; tenderedCents?: number | null }) {
  const given = tenderedCents ?? 0;
  const enough = given >= dueCents && given > 0;
  const change = Math.max(0, given - dueCents);
  return (
    <div className="relative flex items-center gap-4 overflow-hidden rounded-xl bg-gradient-to-br from-amber-50 via-white to-emerald-50 p-4 dark:from-amber-950/30 dark:via-ink-900 dark:to-emerald-950/30" data-testid="cash-visual">
      <div className="relative h-16 w-24 shrink-0" aria-hidden>
        {[-12, -3, 6].map((r, i) => (
          <div key={r} className="pay-note absolute inset-x-0 top-2 mx-auto h-11 w-20 overflow-hidden rounded-md border border-emerald-700/30 bg-gradient-to-br from-emerald-300 to-emerald-500 shadow-sm" style={{ ['--r' as string]: `${r}deg`, animationDelay: `${i * 0.08}s` }}>
            <div className="absolute inset-1 rounded-sm border border-white/40" />
            <div className="absolute left-1/2 top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white/60" />
            {i === 2 && <div className="pay-shine absolute inset-y-0 w-6 bg-white/40 blur-sm" />}
          </div>
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">{enough ? 'Change to give' : 'Cash due'}</div>
        {enough
          ? <div key={change} className="pay-pop text-3xl font-bold tabular-nums text-emerald-700 dark:text-emerald-300">{money(change)}</div>
          : <div className="text-3xl font-bold tabular-nums text-ink-900 dark:text-white">{money(Math.max(0, dueCents - given))}</div>}
        {given > 0 && <div className="text-xs text-ink-500">Received {money(given)}</div>}
      </div>
    </div>
  );
}

/** A receipt printer pushing out a receipt: busy while printing, then the receipt stays out with a check. */
export function PrintingVisual({ state, message }: { state: 'printing' | 'done' | 'browser' | 'failed'; message?: string }) {
  const busy = state === 'printing';
  return (
    <div className="flex items-center justify-center gap-4 rounded-xl bg-gradient-to-b from-ink-50 to-white px-4 py-3 dark:from-ink-800/60 dark:to-ink-900" role="status" data-testid="printing" aria-label={message}>
      <div className="relative h-20 w-24" aria-hidden>
        {/* the receipt coming out of the slot */}
        <div className="absolute left-1/2 top-[30px] h-12 w-14 -translate-x-1/2 overflow-hidden">
          <div className={cx('mx-auto h-12 w-12 rounded-b-sm border border-ink-200 bg-white shadow-sm dark:border-ink-600', busy ? 'pay-paper' : 'pay-paper-once')}>
            <div className="mx-1.5 mt-2 space-y-1">
              {[0.9, 0.6, 0.8, 0.5].map((w, i) => <div key={i} className="pay-line h-1 rounded bg-ink-300 dark:bg-ink-500" style={{ width: `${w * 100}%`, animationDelay: `${0.2 + i * 0.12}s` }} />)}
            </div>
          </div>
        </div>
        {/* the printer */}
        <div className={cx('absolute inset-x-1 top-2 h-8 rounded-lg bg-gradient-to-b from-ink-600 to-ink-800 shadow-md dark:from-ink-500 dark:to-ink-700', busy && 'pay-shake')}>
          <div className="absolute inset-x-3 bottom-1 h-1 rounded bg-black/50" />
          <span className={cx('absolute right-2 top-2 h-1.5 w-1.5 rounded-full', state === 'failed' ? 'bg-red-400' : busy ? 'animate-pulse bg-amber-300' : 'bg-emerald-400')} />
        </div>
      </div>
      <div className="text-sm">
        <div className="font-semibold">{state === 'printing' ? <>Printing receipt<Dots /></> : state === 'done' ? 'Receipt printed' : state === 'browser' ? 'Receipt sent to the print window' : 'Printer not reached'}</div>
        {message && <div className="text-xs text-ink-500">{message}</div>}
      </div>
      {state === 'done' && <svg viewBox="0 0 24 24" className="pay-pop h-7 w-7 text-emerald-600" aria-hidden><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className="pay-draw" /></svg>}
    </div>
  );
}
