import { Link } from 'react-router-dom';
import { asset, type StoreProduct } from '../lib/api';
import { useCart } from '../lib/cart';
import { money } from '../lib/format';
import { useStore } from '../lib/store';
import { useWishlist } from '../lib/wishlist';
import { Icon } from './Icon';
import { QtyStepper } from './Layout';

export function ProductImage({ p, className = '' }: { p: Pick<StoreProduct, 'images' | 'name'>; className?: string }) {
  return p.images[0]
    ? <img src={asset(p.images[0])} alt={p.name} loading="lazy" className={`object-contain mix-blend-multiply ${className}`} />
    : <div className={`flex items-center justify-center text-5xl font-extrabold ${className}`} aria-hidden="true"><Icon name="basket" className="h-16 w-16 text-primary opacity-30" /></div>;
}

export function WishButton({ p, className = '' }: { p: StoreProduct; className?: string }) {
  const wish = useWishlist();
  const on = wish.has(p.id);
  return (
    <button type="button" onClick={() => wish.toggle(p)} aria-pressed={on} aria-label={on ? `Remove ${p.name} from wishlist` : `Save ${p.name} to wishlist`}
      className={`flex h-9 w-9 items-center justify-center rounded-full bg-white shadow-sm transition hover:scale-105 ${on ? 'text-red-500' : 'text-ink-500'} ${className}`}>
      <Icon name="heart" className="h-[18px] w-[18px]" filled={on} />
    </button>
  );
}

export function PriceTag({ p, big = false }: { p: StoreProduct; big?: boolean }) {
  return (
    <span className="flex items-baseline gap-2">
      <span className={`font-extrabold text-primary ${big ? 'text-3xl' : 'text-base'}`}>{money(p.priceCents)}</span>
      {p.compareAtCents && <span className={`text-ink-400 line-through ${big ? 'text-base' : 'text-xs'}`}>{money(p.compareAtCents)}</span>}
    </span>
  );
}

export function ProductBadge({ p }: { p: StoreProduct }) {
  const off = p.compareAtCents ? Math.round((1 - p.priceCents / p.compareAtCents) * 100) : 0;
  const text = off >= 1 ? `-${off}%` : p.badge || (p.isNew ? 'New' : '');
  if (!text) return null;
  return <span className={`chip ${off >= 1 ? 'bg-red-500 text-white' : 'bg-accent text-primary'}`}>{text}</span>;
}

export function ProductCard({ p }: { p: StoreProduct }) {
  const cart = useCart();
  const { categories } = useStore();
  const inCart = cart.lines.find((l) => l.productId === p.id);
  const category = categories.find((c) => c.id === p.categoryId)?.name;
  return (
    <div className="group flex flex-col" data-testid="product-card">
      <div className="relative overflow-hidden rounded-box bg-soft">
        <Link to={`/p/${p.id}`} className="block p-5" tabIndex={-1} aria-hidden="true"><ProductImage p={p} className="h-40 w-full transition duration-300 group-hover:scale-105" /></Link>
        <div className="absolute left-3 top-3"><ProductBadge p={p} /></div>
        <WishButton p={p} className="absolute right-3 top-3" />
      </div>
      <div className="flex flex-1 flex-col px-1 pt-3">
        {category && <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">{category}</span>}
        <Link to={`/p/${p.id}`} className="mt-0.5 line-clamp-2 text-sm font-semibold text-ink-800 hover:text-primary">{p.name}</Link>
        <div className="mt-auto flex items-center justify-between gap-2 pt-2">
          <PriceTag p={p} />
          {!p.inStock ? <span className="text-xs font-semibold text-red-600">Out of stock</span>
            : inCart ? <QtyStepper small value={inCart.qty} max={p.available} label={p.name} onChange={(n) => cart.setQty(p.id, n)} />
              : <button className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-white transition hover:scale-105" onClick={() => cart.add(p)} aria-label={`Add ${p.name}`}><Icon name="bag" className="h-[18px] w-[18px]" /></button>}
        </div>
      </div>
    </div>
  );
}

export function ProductGrid({ products }: { products: StoreProduct[] }) {
  return <div className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">{products.map((p) => <ProductCard key={p.id} p={p} />)}</div>;
}
