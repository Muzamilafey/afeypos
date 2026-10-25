import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, type StoreConfig } from './api';
import { setCurrency } from './format';

const Ctx = createContext<StoreConfig | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [cfg, setCfg] = useState<StoreConfig | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: StoreConfig }>('/config')
      .then((r) => {
        setCurrency(r.data.currency);
        document.title = `${r.data.name}: shop online`;
        setCfg(r.data);
      })
      .catch((e) => setError(e.message));
  }, []);
  if (error) return <div className="mx-auto max-w-md p-10 text-center"><h1 className="text-xl font-semibold">The shop is closed</h1><p className="mt-2 text-ink-500">{error}</p></div>;
  if (!cfg) return <div className="flex h-screen items-center justify-center text-ink-400">Loading…</div>;
  return <Ctx.Provider value={cfg}>{children}</Ctx.Provider>;
}

export function useStore() {
  const c = useContext(Ctx);
  if (!c) throw new Error('StoreProvider missing');
  return c;
}
