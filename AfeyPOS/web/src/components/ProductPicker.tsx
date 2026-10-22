import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Input } from './ui';

/** Type-ahead product search; Enter on an exact barcode/SKU picks it immediately. */
export function ProductPicker({ onPick, placeholder = 'Search or scan product' }: { onPick: (p: any) => void; placeholder?: string }) {
  const [q, setQ] = useState('');
  const r = useQuery({ queryKey: ['picker', q], queryFn: () => api<{ data: any[] }>('/products', { query: { q, limit: 8, active: 'true' } }).then((x) => x.data), enabled: q.length >= 2 });
  const pick = (p: any) => {
    onPick(p);
    setQ('');
  };
  return (
    <div className="relative">
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} aria-label={placeholder}
        onKeyDown={async (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          try {
            pick((await api<{ data: { product: any } }>('/products/lookup', { query: { code: q } })).data.product);
          } catch {
            if (r.data?.length === 1) pick(r.data[0]);
          }
        }} />
      {q.length >= 2 && r.data && r.data.length > 0 && (
        <ul className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-ink-200 bg-white shadow-lg dark:border-ink-700 dark:bg-ink-900">
          {r.data.map((p) => <li key={p._id}><button type="button" className="flex w-full justify-between px-3 py-2 text-left text-sm hover:bg-ink-50 dark:hover:bg-ink-800" onClick={() => pick(p)}><span>{p.name}</span><span className="text-ink-500">{p.sku}</span></button></li>)}
        </ul>
      )}
    </div>
  );
}
