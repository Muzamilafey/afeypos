import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type StoreProduct } from '../lib/api';
import { useCart } from '../lib/cart';
import { money } from '../lib/format';
import { ProductImage } from '../components/ProductCard';
import { QtyStepper } from '../components/Layout';

export function ProductPage() {
  const { id } = useParams();
  const cart = useCart();
  const [p, setP] = useState<StoreProduct | null>(null);
  const [error, setError] = useState('');
  const [qty, setQty] = useState(1);
  useEffect(() => {
    api<{ data: StoreProduct }>(`/products/${id}`).then((r) => setP(r.data)).catch((e) => setError(e.message));
  }, [id]);
  if (error) return <p className="text-red-600">{error}</p>;
  if (!p) return <p className="text-ink-400">Loading…</p>;
  return (
    <div className="grid gap-8 md:grid-cols-2">
      <div className="card p-6"><ProductImage p={p} className="h-72 w-full" /></div>
      <div>
        <Link to="/" className="text-sm text-brand-700 hover:underline">← Back to shop</Link>
        <h1 className="mt-2 text-2xl font-bold">{p.name}</h1>
        <p className="mt-2 text-2xl font-bold text-brand-700">{money(p.priceCents)} <span className="text-sm font-normal text-ink-500">per {p.unit}</span></p>
        {p.description && <p className="mt-4 whitespace-pre-line text-ink-600">{p.description}</p>}
        {p.ageRestricted && <p className="mt-3 text-sm text-amber-700">Age-restricted: you will be asked for ID at delivery or pickup.</p>}
        <div className="mt-6 flex items-center gap-3">
          {p.inStock ? <>
            <QtyStepper value={qty} max={p.available} label={p.name} onChange={(n) => setQty(Math.max(1, n))} />
            <button className="btn-primary" onClick={() => { cart.add(p, qty); setQty(1); }}>Add to basket</button>
          </> : <span className="font-medium text-red-600">Out of stock</span>}
        </div>
        {p.available !== null && p.available <= 5 && p.inStock && <p className="mt-2 text-sm text-amber-700">Only {p.available} left</p>}
      </div>
    </div>
  );
}
