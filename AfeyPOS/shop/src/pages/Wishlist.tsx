import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type StoreProduct } from '../lib/api';
import { useWishlist } from '../lib/wishlist';
import { Container, Crumbs } from '../components/Layout';
import { ProductGrid } from '../components/ProductCard';
import { Icon } from '../components/Icon';

export function WishlistPage() {
  const wish = useWishlist();
  const [rows, setRows] = useState<StoreProduct[] | null>(null);
  const key = wish.ids.join(',');
  useEffect(() => {
    let live = true;
    // Products no longer sold online drop out quietly.
    Promise.all(wish.ids.map((id) => api<{ data: StoreProduct }>(`/products/${id}`).then((r) => r.data).catch(() => null)))
      .then((ps) => live && setRows(ps.filter((p): p is StoreProduct => Boolean(p))));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return (
    <Container>
      <Crumbs items={[{ label: 'Wishlist' }]} />
      <h1 className="section-title mb-8">Your Wishlist</h1>
      {!wish.ids.length ? (
        <div className="rounded-box bg-soft py-16 text-center"><Icon name="heart" className="mx-auto h-10 w-10 text-ink-300" /><p className="mt-3 font-semibold">Nothing saved yet</p><p className="text-sm text-ink-500">Tap the heart on a product to keep it here.</p><Link to="/shop" className="btn-primary mt-5">Browse products</Link></div>
      ) : !rows ? <p className="text-ink-400">Loading…</p> : <ProductGrid products={rows} />}
    </Container>
  );
}
