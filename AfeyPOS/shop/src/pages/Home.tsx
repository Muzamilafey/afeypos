import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, type StoreProduct } from '../lib/api';
import { useStore } from '../lib/store';
import { money } from '../lib/format';
import { ProductCard } from '../components/ProductCard';

export function HomePage() {
  const store = useStore();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const categoryId = params.get('c') ?? '';
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ data: StoreProduct[]; total: number } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => setPage(1), [q, categoryId]);
  useEffect(() => {
    let live = true;
    api<{ data: StoreProduct[]; total: number }>('/products', { query: { q, categoryId, page, limit: 24 } })
      .then((r) => live && setData((d) => (page > 1 && d ? { ...r, data: [...d.data, ...r.data] } : r)))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [q, categoryId, page]);
  const choose = (c: string) => setParams(c ? { c } : {});
  return (
    <div>
      {!q && !categoryId && (
        <section className="mb-6 overflow-hidden rounded-3xl bg-gradient-to-r from-brand-700 to-brand-500 p-6 text-white sm:p-10">
          <h1 className="text-2xl font-bold sm:text-4xl">Your groceries, delivered</h1>
          <p className="mt-2 max-w-xl text-brand-50">Order from {store.name} and {store.delivery && store.pickup ? 'get it delivered or pick it up' : store.delivery ? 'get it delivered' : 'pick it up at the shop'}.{store.mpesa ? ' Pay with M-Pesa' : ''}{store.mpesa && store.payOnDelivery ? ' or on delivery.' : store.payOnDelivery ? ' Pay on delivery.' : '.'}</p>
          {store.freeDeliveryAboveCents > 0 && store.delivery && <p className="mt-3 inline-block rounded-full bg-white/15 px-3 py-1 text-sm">Free delivery on orders over {money(store.freeDeliveryAboveCents)}</p>}
        </section>
      )}
      <div className="mb-4 flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Categories">
        <button role="tab" aria-selected={!categoryId} className={!categoryId ? 'btn-primary py-1.5' : 'btn-light py-1.5'} onClick={() => choose('')}>All</button>
        {store.categories.map((c) => <button key={c.id} role="tab" aria-selected={categoryId === c.id} className={categoryId === c.id ? 'btn-primary whitespace-nowrap py-1.5' : 'btn-light whitespace-nowrap py-1.5'} onClick={() => choose(c.id)}>{c.name}</button>)}
      </div>
      {q && <p className="mb-3 text-sm text-ink-500">Results for “{q}”</p>}
      {error && <p className="text-red-600">{error}</p>}
      {!data ? <p className="text-ink-400">Loading…</p> : data.data.length === 0 ? <p className="text-ink-500">Nothing found.</p> : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">{data.data.map((p) => <ProductCard key={p.id} p={p} />)}</div>
          {data.data.length < data.total && <div className="mt-6 text-center"><button className="btn-light" onClick={() => setPage((n) => n + 1)}>Show more</button></div>}
        </>
      )}
    </div>
  );
}
