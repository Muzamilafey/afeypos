import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { asset } from '../lib/api';
import { useCart } from '../lib/cart';
import { money } from '../lib/format';
import { useStore } from '../lib/store';

export function Layout({ children }: { children: ReactNode }) {
  const store = useStore();
  const cart = useCart();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  return (
    <div className="flex min-h-screen flex-col">
      {store.announcement && <div className="bg-brand-700 px-4 py-1.5 text-center text-xs font-medium text-white">{store.announcement}</div>}
      <header className="sticky top-0 z-20 border-b border-ink-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
          <Link to="/" className="flex shrink-0 items-center gap-2">
            {store.logoUrl ? <img src={asset(store.logoUrl)} alt="" className="h-9 w-9 rounded-full object-cover" /> : <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-600 font-bold text-white">{store.name.slice(0, 1)}</span>}
            <span className="hidden text-lg font-bold sm:block">{store.name}</span>
          </Link>
          <form className="flex-1" onSubmit={(e) => { e.preventDefault(); nav(`/?q=${encodeURIComponent(q)}`); }}>
            <input className="input rounded-full" type="search" placeholder="Search milk, bread, sugar…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search products" />
          </form>
          <Link to="/cart" className="btn-primary shrink-0 px-4" aria-label="Basket">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M3 4h2l2.4 11.2a2 2 0 002 1.6h7.7a2 2 0 002-1.5L21 8H6" /><circle cx="10" cy="20" r="1.4" /><circle cx="17" cy="20" r="1.4" /></svg>
            <span data-testid="cart-count">{cart.count}</span>
            {cart.count > 0 && <span className="hidden sm:inline">· {money(cart.subtotalCents)}</span>}
          </Link>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">{children}</main>
      <footer className="border-t border-ink-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-6 text-sm text-ink-500 sm:flex-row sm:justify-between">
          <span>{store.name}{store.tagline ? ` · ${store.tagline}` : ''}</span>
          <span>{[store.contactPhone && `Call ${store.contactPhone}`, store.hours].filter(Boolean).join(' · ')}{(store.contactPhone || store.hours) && ' · '}<Link className="underline" to="/track">Track an order</Link></span>
        </div>
      </footer>
    </div>
  );
}

export function QtyStepper({ value, onChange, max, label }: { value: number; onChange: (n: number) => void; max: number | null; label: string }) {
  return (
    <div className="inline-flex items-center rounded-full border border-ink-200 bg-white">
      <button type="button" className="h-9 w-9 rounded-full text-lg hover:bg-ink-50" aria-label={`Fewer ${label}`} onClick={() => onChange(value - 1)}>−</button>
      <span className="w-8 text-center text-sm font-semibold tabular-nums">{value}</span>
      <button type="button" className="h-9 w-9 rounded-full text-lg hover:bg-ink-50 disabled:opacity-40" aria-label={`More ${label}`} disabled={max !== null && value >= max} onClick={() => onChange(value + 1)}>+</button>
    </div>
  );
}
