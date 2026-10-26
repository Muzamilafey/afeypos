import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { listProducts, type ProductQuery, type StoreProduct } from '../lib/api';
import { useStore } from '../lib/store';
import { Container, Crumbs } from '../components/Layout';
import { ProductGrid } from '../components/ProductCard';
import { Icon } from '../components/Icon';

const SORTS: { value: NonNullable<ProductQuery['sort']>; label: string }[] = [
  { value: 'default', label: 'Recommended' }, { value: 'new', label: 'Newest' }, { value: 'best', label: 'Best selling' },
  { value: 'price_asc', label: 'Price: low to high' }, { value: 'price_desc', label: 'Price: high to low' }, { value: 'name', label: 'Name A–Z' },
];

/** All products, with search, category, deals and sorting kept in the address (shareable links). */
export function ShopPage() {
  const store = useStore();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const categoryId = params.get('c') ?? '';
  const deals = params.get('deals') === '1';
  const sort = (params.get('sort') ?? 'default') as NonNullable<ProductQuery['sort']>;
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ data: StoreProduct[]; total: number } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => setPage(1), [q, categoryId, deals, sort]);
  useEffect(() => {
    let live = true;
    listProducts({ q, categoryId: categoryId || undefined, deals, sort, page, limit: 20 })
      .then((r) => live && setData((d) => (page > 1 && d ? { ...r, data: [...d.data, ...r.data] } : r)))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [q, categoryId, deals, sort, page]);
  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next);
  };
  const category = store.categories.find((c) => c.id === categoryId);
  const title = q ? `Results for “${q}”` : category?.name ?? (deals ? store.studio.sections.deals.title : sort === 'new' ? store.studio.sections.newArrivals.title : sort === 'best' ? store.studio.sections.bestSellers.title : 'All Products');
  return (
    <Container>
      <Crumbs items={[{ label: 'Shop', to: category || q || deals ? '/shop' : undefined }, ...(category || q || deals ? [{ label: title }] : [])]} />
      <div className="grid gap-8 lg:grid-cols-[230px_1fr]">
        <aside className="space-y-6">
          <div>
            <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-ink-500">Categories</h2>
            <ul className="flex gap-2 overflow-x-auto pb-1 text-sm lg:flex-col lg:gap-0.5" role="list">
              <li><button className={`w-full whitespace-nowrap rounded-full px-4 py-2 text-left lg:rounded-lg ${!categoryId ? 'bg-primary font-semibold text-white' : 'hover:bg-soft'}`} onClick={() => update({ c: null })}>All products</button></li>
              {store.categories.map((c) => <li key={c.id}><button className={`w-full whitespace-nowrap rounded-full px-4 py-2 text-left lg:rounded-lg ${categoryId === c.id ? 'bg-primary font-semibold text-white' : 'hover:bg-soft'}`} onClick={() => update({ c: c.id })}>{c.name}</button></li>)}
            </ul>
          </div>
          <label className="flex cursor-pointer items-center gap-2.5 rounded-lg bg-soft px-4 py-3 text-sm font-semibold"><input type="checkbox" className="h-4 w-4 accent-[color:var(--c-primary)]" checked={deals} onChange={(e) => update({ deals: e.target.checked ? '1' : null })} /><Icon name="tag" className="h-4 w-4 text-accent" />On offer only</label>
        </aside>
        <div>
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
            <div><h1 className="section-title">{title}</h1>{data && <p className="mt-1 text-sm text-ink-500">{data.total} {data.total === 1 ? 'product' : 'products'}</p>}</div>
            <label className="flex items-center gap-2 text-sm"><span className="text-ink-500">Sort by</span>
              <select className="rounded-full border border-ink-200 bg-white px-4 py-2 font-semibold focus:border-primary focus:outline-none" value={sort} onChange={(e) => update({ sort: e.target.value === 'default' ? null : e.target.value })}>{SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select>
            </label>
          </div>
          {error && <p className="text-red-600">{error}</p>}
          {!data ? <p className="text-ink-400">Loading…</p> : data.data.length === 0 ? (
            <div className="rounded-box bg-soft py-16 text-center"><Icon name="search" className="mx-auto h-10 w-10 text-ink-300" /><p className="mt-3 font-semibold">Nothing found</p><p className="text-sm text-ink-500">Try another word or category.</p></div>
          ) : (
            <>
              <ProductGrid products={data.data} />
              {data.data.length < data.total && <div className="mt-10 text-center"><button className="btn-light" onClick={() => setPage((n) => n + 1)}>Show more products</button></div>}
            </>
          )}
        </div>
      </div>
    </Container>
  );
}
