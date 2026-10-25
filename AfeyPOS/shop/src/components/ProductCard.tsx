import { Link } from 'react-router-dom';
import { asset, type StoreProduct } from '../lib/api';
import { useCart } from '../lib/cart';
import { money } from '../lib/format';
import { QtyStepper } from './Layout';

export function ProductImage({ p, className = '' }: { p: Pick<StoreProduct, 'images' | 'name'>; className?: string }) {
  return p.images[0]
    ? <img src={asset(p.images[0])} alt={p.name} loading="lazy" className={`object-contain ${className}`} />
    : <div className={`flex items-center justify-center bg-gradient-to-br from-brand-50 to-ink-100 text-3xl font-bold text-brand-700 ${className}`} aria-hidden="true">{p.name.slice(0, 1)}</div>;
}

export function ProductCard({ p }: { p: StoreProduct }) {
  const cart = useCart();
  const inCart = cart.lines.find((l) => l.productId === p.id);
  return (
    <div className="card flex flex-col overflow-hidden" data-testid="product-card">
      <Link to={`/p/${p.id}`} className="block bg-white p-3"><ProductImage p={p} className="h-32 w-full" /></Link>
      <div className="flex flex-1 flex-col gap-2 p-3 pt-0">
        <Link to={`/p/${p.id}`} className="line-clamp-2 text-sm font-medium hover:underline">{p.name}</Link>
        <div className="mt-auto flex items-center justify-between gap-2">
          <span className="font-bold">{money(p.priceCents)}</span>
          {!p.inStock ? <span className="text-xs font-medium text-red-600">Out of stock</span>
            : inCart ? <QtyStepper value={inCart.qty} max={p.available} label={p.name} onChange={(n) => cart.setQty(p.id, n)} />
              : <button className="btn-primary px-3 py-1.5" onClick={() => cart.add(p)} aria-label={`Add ${p.name}`}>Add</button>}
        </div>
      </div>
    </div>
  );
}
