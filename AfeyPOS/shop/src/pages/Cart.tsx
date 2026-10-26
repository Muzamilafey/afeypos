import { Link } from 'react-router-dom';
import { asset } from '../lib/api';
import { useCart } from '../lib/cart';
import { money } from '../lib/format';
import { useStore } from '../lib/store';
import { Container, Crumbs, QtyStepper } from '../components/Layout';
import { Icon } from '../components/Icon';

export function CartPage() {
  const cart = useCart();
  const store = useStore();
  if (!cart.lines.length) return (
    <Container>
      <Crumbs items={[{ label: 'Cart' }]} />
      <div className="rounded-box bg-soft py-16 text-center"><Icon name="bag" className="mx-auto h-10 w-10 text-ink-300" /><h1 className="mt-3 text-xl font-bold">Your cart is empty</h1><Link to="/shop" className="btn-primary mt-5">Start shopping</Link></div>
    </Container>
  );
  const short = store.minOrderCents > 0 && cart.subtotalCents < store.minOrderCents;
  const toFree = store.delivery && store.freeDeliveryAboveCents > 0 ? store.freeDeliveryAboveCents - cart.subtotalCents : 0;
  return (
    <Container>
      <Crumbs items={[{ label: 'Cart' }]} />
      <h1 className="section-title mb-6">Your Cart</h1>
      <div className="grid gap-8 lg:grid-cols-[1fr_360px]">
        <div className="divide-y divide-ink-100 rounded-box border border-ink-100">
          {cart.lines.map((l) => (
            <div key={l.productId} className="flex flex-wrap items-center gap-4 p-4 sm:flex-nowrap">
              <Link to={`/p/${l.productId}`} className="flex h-20 w-20 shrink-0 items-center justify-center rounded-tile bg-soft p-2">{l.image ? <img src={asset(l.image)} alt="" className="h-full w-full object-contain mix-blend-multiply" /> : <Icon name="basket" className="h-8 w-8 text-ink-300" />}</Link>
              <div className="min-w-0 flex-1"><Link to={`/p/${l.productId}`} className="font-semibold hover:text-primary">{l.name}</Link><div className="text-sm text-ink-500">{money(l.priceCents)} each</div></div>
              <QtyStepper value={l.qty} max={l.max} label={l.name} onChange={(n) => cart.setQty(l.productId, n)} />
              <div className="w-24 text-right font-bold tabular-nums text-primary">{money(Math.round(l.priceCents * l.qty))}</div>
              <button className="text-ink-400 hover:text-red-600" aria-label={`Remove ${l.name}`} onClick={() => cart.setQty(l.productId, 0)}><Icon name="trash" className="h-5 w-5" /></button>
            </div>
          ))}
        </div>
        <aside className="h-fit rounded-box bg-soft p-6">
          <h2 className="mb-4 text-lg font-bold">Order summary</h2>
          <div className="flex justify-between text-lg font-extrabold text-primary"><span>Subtotal</span><span data-testid="cart-subtotal">{money(cart.subtotalCents)}</span></div>
          <p className="mt-1 text-sm text-ink-500">Delivery is added at checkout.</p>
          {toFree > 0 && <p className="mt-4 flex items-center gap-2 rounded-tile bg-white px-3 py-2.5 text-sm"><Icon name="truck" className="h-4 w-4 text-accent" />Add {money(toFree)} more for free delivery</p>}
          {short && <p className="mt-3 text-sm font-semibold text-amber-700">The minimum order is {money(store.minOrderCents)}.</p>}
          <Link to="/checkout" className={`btn-primary mt-5 w-full ${short ? 'pointer-events-none opacity-50' : ''}`}>Checkout<Icon name="arrow" className="h-4 w-4" /></Link>
          <Link to="/shop" className="mt-3 block text-center text-sm font-semibold text-primary hover:underline">Continue shopping</Link>
        </aside>
      </div>
    </Container>
  );
}
