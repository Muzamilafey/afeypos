import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { StoreProduct } from './api';

/** Saved products, kept in this browser only. */
interface WishState { ids: string[]; has(id: string): boolean; toggle(p: Pick<StoreProduct, 'id'>): void }
const KEY = 'afey.shop.wishlist';
const Ctx = createContext<WishState | null>(null);

export function WishlistProvider({ children }: { children: ReactNode }) {
  const [ids, setIds] = useState<string[]>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
      return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(ids));
    } catch {
      /* storage unavailable */
    }
  }, [ids]);
  const toggle = useCallback((p: Pick<StoreProduct, 'id'>) => setIds((xs) => (xs.includes(p.id) ? xs.filter((x) => x !== p.id) : [p.id, ...xs].slice(0, 100))), []);
  const value = useMemo(() => ({ ids, has: (id: string) => ids.includes(id), toggle }), [ids, toggle]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWishlist() {
  const c = useContext(Ctx);
  if (!c) throw new Error('WishlistProvider missing');
  return c;
}
