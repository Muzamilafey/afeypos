/**
 * Illustrated checkout buttons: each way to pay (and the customer / hold actions) is a picture card with
 * its own colour, line drawing and display lettering, so cashiers find them at a glance.
 * Bank and card names are drawn as simple coloured marks; official logos can replace them in /brand.
 */
import type { ReactNode } from 'react';
import { cx } from './ui';
import '@fontsource/fraunces/900.css';

export type PosTileKind = 'mpesa' | 'cash' | 'card' | 'loyalty' | 'voucher' | 'customer' | 'hold';

const display = { fontFamily: '"Fraunces", Georgia, serif', fontWeight: 900, letterSpacing: '-0.01em', fontVariationSettings: '"SOFT" 100, "WONK" 1' } as const;

function LoyaltyArt() {
  return (
    <svg viewBox="0 0 120 70" className="h-full w-auto" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M38 20c0-9 6-15 13-15s13 6 13 15-6 16-13 16-13-7-13-16z" />
      <path d="M40 12c4-5 15-6 22 0" />
      <path d="M22 68V54c0-9 6-15 15-17l14 8 14-8c3 1 6 2 8 4" />
      <path d="M32 68V56" />
      <rect x="70" y="36" width="34" height="32" rx="4" />
      <path d="M78 36v-6a9 9 0 0118 0v6" />
    </svg>
  );
}

function VoucherArt() {
  return (
    <svg viewBox="0 0 120 70" className="h-full w-auto" fill="none" stroke="#1c1917" strokeWidth="3.5" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 26l62-22 4 10a6 6 0 004 11l4 11-62 22-4-10a6 6 0 00-4-11z" opacity=".9" />
      <path d="M22 30l70-8 1 11a6 6 0 001 12l1 11-70 8-1-11a6 6 0 00-1-12z" fill="#84603a" />
      <path d="M78 24l3 33" strokeDasharray="0" />
      <path d="M46 49l14-20" /><circle cx="46" cy="33" r="3.5" /><circle cx="60" cy="46" r="3.5" />
      <path d="M86 33h7M86 39h7M86 45h7" />
    </svg>
  );
}

function CustomersArt() {
  return (
    <svg viewBox="0 0 120 70" className="h-full w-auto" aria-hidden="true">
      <g fill="#d4f5cc"><ellipse cx="32" cy="22" rx="12" ry="15" /><path d="M8 66c2-14 10-22 24-22s20 6 24 22z" /><ellipse cx="88" cy="22" rx="12" ry="15" /><path d="M64 66c4-16 10-22 24-22s22 8 24 22z" /></g>
      <g fill="#76d0df" stroke="#fff" strokeWidth="3"><ellipse cx="60" cy="27" rx="13" ry="16" /><path d="M32 70c3-16 13-25 28-25s25 9 28 25z" /></g>
    </svg>
  );
}

function PauseArt() {
  return (
    <svg viewBox="0 0 60 70" className="h-full w-auto" aria-hidden="true"><rect x="10" y="4" width="16" height="62" rx="6" fill="#0a0a0a" /><rect x="34" y="4" width="16" height="62" rx="6" fill="#0a0a0a" /></svg>
  );
}

function CashArt() {
  return (
    <svg viewBox="0 0 120 70" className="h-full w-auto" fill="none" stroke="#fff" strokeWidth="3.5" strokeLinejoin="round" aria-hidden="true">
      <rect x="8" y="14" width="78" height="42" rx="5" transform="rotate(-8 47 35)" opacity=".55" />
      <rect x="22" y="20" width="84" height="44" rx="5" fill="#1f5b40" />
      <circle cx="64" cy="42" r="10" /><path d="M64 36v12M60.5 39.5c0-2 1.6-3 3.5-3s3.5 1 3.5 2.5-1.5 2.4-3.5 3-3.5 1.4-3.5 3 1.6 2.5 3.5 2.5 3.5-1 3.5-3" strokeWidth="2.2" />
      <path d="M32 30h8M88 54h8" />
    </svg>
  );
}

/** Small coloured marks of the cards and banks taken at the till. */
function CardMarks() {
  return (
    <div className="grid grid-cols-3 items-center gap-x-2 gap-y-1" aria-hidden="true">
      <span className="text-[13px] font-black italic tracking-tight text-[#1a1f71]">VISA</span>
      <svg viewBox="0 0 38 24" className="h-4 w-auto"><circle cx="13" cy="12" r="11" fill="#eb001b" /><circle cx="25" cy="12" r="11" fill="#f79e1b" /><path d="M19 3a11 11 0 010 18 11 11 0 010-18z" fill="#ff5f00" /></svg>
      <span className="rounded-[3px] bg-[#8dc63f] px-1 text-[10px] font-bold leading-4 text-white">KCB</span>
      <span className="text-[10px] font-black leading-none text-[#006a3a]">CO-OP<br />BANK</span>
      <span className="flex flex-col items-center text-[9px] font-black leading-none text-[#3b3b3b]"><svg viewBox="0 0 30 10" className="h-2 w-auto"><path d="M2 9l13-7 13 7" fill="none" stroke="#a6192e" strokeWidth="3" /></svg>EQUITY</span>
      <span className="text-[10px] font-bold leading-none text-ink-600">+ all<br />banks</span>
    </div>
  );
}

const THEMES: Record<PosTileKind, { bg: string; text: string; title: ReactNode; art?: ReactNode; artClass?: string }> = {
  mpesa: { bg: 'bg-white ring-1 ring-inset ring-emerald-200', text: 'text-[#2e7d32]', title: <>Pay with<br /><span className="text-[1.35em]">M-Pesa</span></>, art: <img src="/brand/mpesa.svg" alt="" className="h-full w-auto" draggable={false} /> },
  cash: { bg: 'bg-[#2f6b4f]', text: 'text-white', title: <>Pay with<br /><span className="text-[1.35em]">Cash</span></>, art: <CashArt /> },
  card: { bg: 'bg-[#d6cdc2]', text: 'text-[#0a0a0a]', title: <span className="text-[1.15em]">Pay with Card</span> },
  loyalty: { bg: 'bg-[#556b47]', text: 'text-white', title: <span className="text-[1.2em]">Loyalty Card</span>, art: <span className="h-full text-white"><LoyaltyArt /></span> },
  voucher: { bg: 'bg-[#84603a]', text: 'text-white', title: <>pay with<br /><span className="text-[1.35em]">Voucher</span></>, art: <VoucherArt /> },
  customer: { bg: 'bg-white', text: 'text-[#0a0a0a]', title: <span className="text-[1.2em]">Customers</span>, art: <CustomersArt /> },
  hold: { bg: 'bg-white', text: 'text-[#0a0a0a]', title: <span className="text-[1.2em]">Hold sale</span>, art: <PauseArt /> },
};

export function PosTile({ kind, label, onClick, disabled, hint, title, badge, big }: { kind: PosTileKind; label: string; onClick: () => void; disabled?: boolean; hint?: string; title?: string; badge?: string; big?: boolean }) {
  const t = THEMES[kind];
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title} aria-label={label}
      className={cx('group relative flex min-h-[84px] flex-col items-center justify-center overflow-hidden rounded-lg px-2 shadow-sm transition hover:-translate-y-px hover:shadow-md focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-500/40 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:translate-y-0 disabled:hover:shadow-sm', t.bg, t.text, big ? 'py-5' : 'py-2')}>
      {hint && <kbd className="absolute right-1.5 top-1.5 rounded bg-black/10 px-1 font-sans text-[10px] font-semibold not-italic opacity-70">{hint}</kbd>}
      {kind === 'voucher' && <span className="absolute -right-6 top-2 rotate-[35deg] bg-[#f39a32] px-6 py-0.5 font-sans text-[8px] font-bold tracking-[0.2em] text-white" aria-hidden="true">VOUCHER</span>}
      {badge && <span className="absolute left-1.5 top-1.5 rounded-full bg-white/90 px-1.5 font-sans text-[10px] font-bold text-ink-800">{badge}</span>}
      {kind === 'card' ? (
        <>
          <span className="text-center leading-none" style={display}>{t.title}</span>
          <span className="mt-1.5"><CardMarks /></span>
        </>
      ) : (
        <>
          <span className={cx('flex h-9 items-center justify-center', kind === 'mpesa' && 'h-7')}>{t.art}</span>
          <span className="mt-1 text-center text-[15px] leading-[0.95]" style={display}>{t.title}</span>
        </>
      )}
    </button>
  );
}
