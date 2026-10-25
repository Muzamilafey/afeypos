import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { StoreProduct } from './api';

export interface CartLine { productId: string; name: string; priceCents: number; image?: string; qty: number; max: number | null }
interface CartState {
  lines: CartLine[];
  count: number;
  subtotalCents: number;
  add(p: StoreProduct, qty?: number): void;
  setQty(productId: string, qty: number): void;
  clear(): void;
}

const KEY = 'afey.shop.cart';
const Ctx = createContext<CartState | null>(null);

function load(): CartLine[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]');
  } catch {
    return [];
  }
}

export function CartProvider({ children }: { children: ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>(load);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(lines));
    } catch {
      /* storage unavailable: the basket lasts for this visit */
    }
  }, [lines]);
  const add = useCallback((p: StoreProduct, qty = 1) => {
    setLines((ls) => {
      const found = ls.find((l) => l.productId === p.id);
      const cap = (n: number) => (p.available === null ? n : Math.min(n, p.available));
      if (found) return ls.map((l) => (l.productId === p.id ? { ...l, qty: cap(l.qty + qty), max: p.available } : l));
      return [...ls, { productId: p.id, name: p.name, priceCents: p.priceCents, image: p.images[0], qty: cap(qty), max: p.available }];
    });
  }, []);
  const setQty = useCallback((productId: string, qty: number) => {
    setLines((ls) => (qty <= 0 ? ls.filter((l) => l.productId !== productId) : ls.map((l) => (l.productId === productId ? { ...l, qty: l.max === null ? qty : Math.min(qty, l.max) } : l))));
  }, []);
  const clear = useCallback(() => setLines([]), []);
  const value = useMemo(() => ({ lines, count: lines.reduce((s, l) => s + l.qty, 0), subtotalCents: lines.reduce((s, l) => s + Math.round(l.priceCents * l.qty), 0), add, setQty, clear }), [lines, add, setQty, clear]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCart() {
  const c = useContext(Ctx);
  if (!c) throw new Error('CartProvider missing');
  return c;
}
