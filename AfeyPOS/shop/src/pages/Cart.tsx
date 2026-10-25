import { Link } from 'react-router-dom';
import { asset } from '../lib/api';
import { useCart } from '../lib/cart';
import { money } from '../lib/format';
import { useStore } from '../lib/store';
import { QtyStepper } from '../components/Layout';

export function CartPage() {
  const cart = useCart();
  const store = useStore();
  if (!cart.lines.length) return <div className="py-16 text-center"><h1 className="text-xl font-semibold">Your basket is empty</h1><Link to="/" className="btn-primary mt-4">Start shopping</Link></div>;
  const short = store.minOrderCents > 0 && cart.subtotalCents < store.minOrderCents;
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="card divide-y divide-ink-100 lg:col-span-2">
        {cart.lines.map((l) => (
          <div key={l.productId} className="flex items-center gap-3 p-4">
            {l.image ? <img src={asset(l.image)} alt="" className="h-14 w-14 rounded-lg object-contain" /> : <div className="h-14 w-14 rounded-lg bg-brand-50" />}
            <div className="flex-1"><div className="font-medium">{l.name}</div><div className="text-sm text-ink-500">{money(l.priceCents)} each</div></div>
            <QtyStepper value={l.qty} max={l.max} label={l.name} onChange={(n) => cart.setQty(l.productId, n)} />
            <div className="w-24 text-right font-semibold tabular-nums">{money(Math.round(l.priceCents * l.qty))}</div>
          </div>
        ))}
      </div>
      <div className="card h-fit p-5">
        <div className="flex justify-between text-lg font-bold"><span>Subtotal</span><span data-testid="cart-subtotal">{money(cart.subtotalCents)}</span></div>
        <p className="mt-1 text-sm text-ink-500">Delivery is added at checkout.</p>
        {short && <p className="mt-3 text-sm text-amber-700">The minimum order is {money(store.minOrderCents)}.</p>}
        <Link to="/checkout" className={`btn-primary mt-4 w-full ${short ? 'pointer-events-none opacity-50' : ''}`}>Checkout</Link>
      </div>
    </div>
  );
}
