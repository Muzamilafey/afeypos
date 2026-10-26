import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, listProducts, type StoreProduct } from '../lib/api';
import { useCart } from '../lib/cart';
import { useStore } from '../lib/store';
import { Container, Crumbs, QtyStepper } from '../components/Layout';
import { PriceTag, ProductBadge, ProductCard, ProductImage, WishButton } from '../components/ProductCard';
import { Icon } from '../components/Icon';

export function ProductPage() {
  const { id } = useParams();
  const cart = useCart();
  const store = useStore();
  const [p, setP] = useState<StoreProduct | null>(null);
  const [related, setRelated] = useState<StoreProduct[]>([]);
  const [error, setError] = useState('');
  const [qty, setQty] = useState(1);
  const [added, setAdded] = useState(false);
  useEffect(() => {
    setP(null);
    api<{ data: StoreProduct }>(`/products/${id}`).then((r) => {
      setP(r.data);
      if (r.data.categoryId) listProducts({ categoryId: r.data.categoryId, limit: 6 }).then((x) => setRelated(x.data.filter((o) => o.id !== r.data.id).slice(0, 5))).catch(() => undefined);
    }).catch((e) => setError(e.message));
  }, [id]);
  if (error) return <Container><p className="py-16 text-center text-red-600">{error}</p></Container>;
  if (!p) return <Container><p className="py-16 text-center text-ink-400">Loading…</p></Container>;
  const category = store.categories.find((c) => c.id === p.categoryId);
  const perks = store.studio.topBar.items.length ? store.studio.topBar.items : store.studio.why.items.slice(0, 3);
  return (
    <Container>
      <Crumbs items={[{ label: 'Shop', to: '/shop' }, ...(category ? [{ label: category.name, to: `/shop?c=${category.id}` }] : []), { label: p.name }]} />
      <div className="grid gap-10 md:grid-cols-2">
        <div className="relative rounded-box bg-soft p-10"><ProductImage p={p} className="h-80 w-full" /><div className="absolute left-5 top-5"><ProductBadge p={p} /></div></div>
        <div className="py-2">
          {category && <p className="text-xs font-bold uppercase tracking-wide text-accent">{category.name}</p>}
          <h1 className="mt-2 text-3xl font-extrabold leading-tight sm:text-4xl">{p.name}</h1>
          <div className="mt-4 flex items-baseline gap-3"><PriceTag p={p} big /><span className="text-sm text-ink-500">per {p.unit}</span></div>
          {p.description && <p className="mt-5 whitespace-pre-line leading-relaxed text-ink-600">{p.description}</p>}
          {p.ageRestricted && <p className="mt-4 rounded-tile bg-amber-50 px-4 py-3 text-sm text-amber-800">Age-restricted: you will be asked for ID at delivery or pickup.</p>}
          <div className="mt-8 flex flex-wrap items-center gap-3">
            {p.inStock ? <>
              <QtyStepper value={qty} max={p.available} label={p.name} onChange={(n) => setQty(Math.max(1, n))} />
              <button className="btn-primary px-8" onClick={() => { cart.add(p, qty); setQty(1); setAdded(true); }}><Icon name="bag" className="h-4 w-4" />Add to Cart</button>
              <WishButton p={p} className="h-11 w-11 border border-ink-200 shadow-none" />
            </> : <span className="font-semibold text-red-600">Out of stock</span>}
          </div>
          {added && <p className="mt-3 flex items-center gap-1.5 text-sm font-semibold text-primary" role="status"><Icon name="check" className="h-4 w-4" />Added to your cart</p>}
          {p.available !== null && p.available <= 5 && p.inStock && <p className="mt-3 text-sm font-semibold text-amber-700">Only {p.available} left</p>}
          {perks.length > 0 && <ul className="mt-8 space-y-3 border-t border-ink-100 pt-6 text-sm">{perks.map((it, i) => <li key={i} className="flex items-center gap-3"><span className="tint flex h-9 w-9 items-center justify-center rounded-full text-primary"><Icon name={it.icon} className="h-4 w-4" /></span><span><strong className="text-primary">{it.title}</strong>{it.text ? <span className="text-ink-500"> · {it.text}</span> : null}</span></li>)}</ul>}
        </div>
      </div>
      {related.length > 0 && (
        <section className="pt-16">
          <h2 className="section-title mb-6">You may also like</h2>
          <div className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-5">{related.map((r) => <ProductCard key={r.id} p={r} />)}</div>
        </section>
      )}
    </Container>
  );
}
