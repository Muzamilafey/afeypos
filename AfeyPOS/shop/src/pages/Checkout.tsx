import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, newRequestId } from '../lib/api';
import { useCart } from '../lib/cart';
import { money } from '../lib/format';
import { rememberOrder } from '../lib/orders';
import { useStore } from '../lib/store';
import { Container, Crumbs } from '../components/Layout';
import { Icon } from '../components/Icon';

interface Quote { lines: any[]; subtotalCents: number; deliveryFeeCents: number; totalCents: number; problems: string[] }
type Pay = 'mpesa' | 'card' | 'on_delivery';

function Choice({ on, onClick, icon, title, text }: { on: boolean; onClick: () => void; icon: string; title: string; text?: string }) {
  return (
    <button type="button" role="radio" aria-checked={on} aria-label={title} onClick={onClick}
      className={`flex items-center gap-3 rounded-tile border-2 p-4 text-left transition ${on ? 'border-primary bg-soft' : 'border-ink-100 hover:border-ink-300'}`}>
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${on ? 'bg-primary text-white' : 'tint text-primary'}`}><Icon name={icon} className="h-5 w-5" /></span>
      <span className="text-sm"><span className="block font-bold text-ink-800">{title}</span>{text && <span className="text-ink-500">{text}</span>}</span>
    </button>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="rounded-box border border-ink-100 p-6">
      <h2 className="mb-4 flex items-center gap-3 text-lg font-bold"><span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-xs text-white">{n}</span>{title}</h2>
      {children}
    </section>
  );
}

export function CheckoutPage() {
  const store = useStore();
  const cart = useCart();
  const nav = useNavigate();
  const [requestId] = useState(newRequestId);
  const [fulfilment, setFulfilment] = useState<'delivery' | 'pickup'>(store.delivery ? 'delivery' : 'pickup');
  const [area, setArea] = useState(store.deliveryAreas[0]?.name ?? '');
  const [f, setF] = useState({ name: '', phone: '', email: '', address: '', notes: '', mpesaPhone: '', marketingOptIn: false });
  const [payment, setPayment] = useState<Pay>(store.mpesa ? 'mpesa' : store.card ? 'card' : 'on_delivery');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lines = useMemo(() => cart.lines.map((l) => ({ productId: l.productId, qty: l.qty })), [cart.lines]);

  useEffect(() => {
    if (!lines.length) return;
    api<{ data: Quote }>('/cart/quote', { body: { lines, fulfilment, area: fulfilment === 'delivery' ? area : undefined } }).then((r) => setQuote(r.data)).catch((e) => setError(e.message));
  }, [lines, fulfilment, area]);

  if (!cart.lines.length) return <Container><p className="py-16 text-center text-ink-500">Your cart is empty.</p></Container>;
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const place = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ data: any; paymentError?: string }>('/orders', { body: {
        clientRequestId: requestId, customer: { name: f.name, phone: f.phone, email: f.email || undefined }, fulfilment, area: fulfilment === 'delivery' ? area || undefined : undefined,
        address: fulfilment === 'delivery' ? f.address : undefined, notes: f.notes || undefined, payment, mpesaPhone: f.mpesaPhone || undefined, marketingOptIn: f.marketingOptIn, lines,
      } });
      cart.clear();
      rememberOrder({ number: r.data.number, token: r.data.token, totalCents: r.data.totalCents, at: new Date().toISOString() });
      // Card: continue on the payment provider's page, which brings the customer back to the order.
      if (payment === 'card' && r.data.payment?.checkoutUrl && !r.paymentError) {
        window.location.assign(r.data.payment.checkoutUrl);
        return;
      }
      nav(`/order/${r.data.number}?t=${r.data.token}${r.paymentError ? `&e=${encodeURIComponent(r.paymentError)}` : ''}`);
    } catch (e) {
      setError(e instanceof ApiError && e.details?.problems ? e.details.problems.join('. ') : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const needEmail = payment === 'card' && !f.email;
  const ready = f.name.length >= 2 && f.phone.length >= 9 && (fulfilment === 'pickup' || f.address.length >= 3) && quote && !quote.problems.length && !needEmail;
  return (
    <Container>
      <Crumbs items={[{ label: 'Cart', to: '/cart' }, { label: 'Checkout' }]} />
      <h1 className="section-title mb-6">Checkout</h1>
      <div className="grid gap-8 lg:grid-cols-[1fr_380px]">
        <div className="space-y-5">
          <Step n={1} title="How do you want it?">
            <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Delivery or pickup">
              {store.delivery && <Choice on={fulfilment === 'delivery'} onClick={() => setFulfilment('delivery')} icon="truck" title="Delivery" text="To your door" />}
              {store.pickup && <Choice on={fulfilment === 'pickup'} onClick={() => setFulfilment('pickup')} icon="home" title="Pick up" text="Collect at the shop" />}
            </div>
            {fulfilment === 'delivery' ? (
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {store.deliveryAreas.length > 0 && <label><span className="label">Area</span><select className="input" value={area} onChange={(e) => setArea(e.target.value)}>{store.deliveryAreas.map((a) => <option key={a.name} value={a.name}>{a.name} ({a.feeCents ? money(a.feeCents) : 'free'})</option>)}</select></label>}
                <label className={store.deliveryAreas.length ? '' : 'sm:col-span-2'}><span className="label">Delivery address</span><input className="input" value={f.address} onChange={set('address')} placeholder="Building, street, house number" /></label>
              </div>
            ) : (
              <p className="mt-4 flex items-start gap-2 text-sm text-ink-600"><Icon name="pin" className="mt-0.5 h-4 w-4 shrink-0 text-accent" />Collect at {store.branches.map((b) => `${b.name}${b.address ? ` (${b.address})` : ''}`).join(', ') || store.name}. We will SMS you when it is ready.</p>
            )}
          </Step>
          <Step n={2} title="Your details">
            <div className="grid gap-3 sm:grid-cols-2">
              <label><span className="label">Name</span><input className="input" value={f.name} onChange={set('name')} autoComplete="name" /></label>
              <label><span className="label">Phone</span><input className="input" value={f.phone} onChange={set('phone')} inputMode="tel" autoComplete="tel" placeholder="07XX XXX XXX" /></label>
              <label><span className="label">Email {payment === 'card' ? '(for the card receipt)' : '(optional)'}</span><input className="input" value={f.email} onChange={set('email')} type="email" autoComplete="email" /></label>
              <label><span className="label">Notes for us (optional)</span><input className="input" value={f.notes} onChange={set('notes')} placeholder="Gate code, landmark…" /></label>
            </div>
            <label className="mt-4 flex items-center gap-2.5 text-sm"><input type="checkbox" className="h-4 w-4" checked={f.marketingOptIn} onChange={(e) => setF({ ...f, marketingOptIn: e.target.checked })} />Send me offers by SMS (you can stop any time)</label>
          </Step>
          <Step n={3} title="Payment">
            <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Payment">
              {store.mpesa && <Choice on={payment === 'mpesa'} onClick={() => setPayment('mpesa')} icon="phone" title="M-Pesa now" text="Prompt on your phone" />}
              {store.card && <Choice on={payment === 'card'} onClick={() => setPayment('card')} icon="card" title="Card" text="Visa, Mastercard" />}
              {store.payOnDelivery && <Choice on={payment === 'on_delivery'} onClick={() => setPayment('on_delivery')} icon="bag" title={fulfilment === 'pickup' ? 'Pay at the shop' : 'Pay on delivery'} text="Cash or M-Pesa" />}
            </div>
            {payment === 'mpesa' && <label className="mt-4 block"><span className="label">M-Pesa number (if different)</span><input className="input" value={f.mpesaPhone} onChange={set('mpesaPhone')} inputMode="tel" placeholder={f.phone || '07XX XXX XXX'} /><span className="mt-1.5 block text-xs text-ink-500">You will get a prompt on your phone to enter your M-Pesa PIN.</span></label>}
            {payment === 'card' && <p className="mt-4 flex items-center gap-2 text-sm text-ink-600"><Icon name="shield" className="h-4 w-4 text-accent" />You will pay on the card provider’s secure page and come straight back here.</p>}
          </Step>
        </div>
        <aside className="h-fit rounded-box bg-soft p-6 lg:sticky lg:top-40">
          <h2 className="mb-4 text-lg font-bold">Order summary</h2>
          {quote ? <>
            <ul className="space-y-2 text-sm">{quote.lines.map((l) => <li key={l.productId} className="flex justify-between gap-2"><span>{l.qty} × {l.name}</span><span className="tabular-nums">{money(l.totalCents)}</span></li>)}</ul>
            <div className="mt-4 space-y-1.5 border-t border-ink-200 pt-4 text-sm">
              <div className="flex justify-between"><span>Subtotal</span><span>{money(quote.subtotalCents)}</span></div>
              {fulfilment === 'delivery' && <div className="flex justify-between"><span>Delivery</span><span>{quote.deliveryFeeCents ? money(quote.deliveryFeeCents) : 'Free'}</span></div>}
              <div className="flex justify-between pt-2 text-xl font-extrabold text-primary"><span>Total</span><span data-testid="checkout-total">{money(quote.totalCents)}</span></div>
            </div>
            {quote.problems.length > 0 && <ul className="mt-3 list-disc pl-5 text-sm text-red-600">{quote.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
          </> : <p className="text-ink-400">Calculating…</p>}
          {needEmail && <p className="mt-3 text-sm text-ink-600">Enter your email to pay by card.</p>}
          {error && <p className="mt-3 rounded-tile bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</p>}
          <button className="btn-primary mt-5 w-full py-3.5" disabled={!ready || busy} onClick={place}>{busy ? 'Placing order…' : payment === 'on_delivery' ? 'Place order' : 'Place order and pay'}</button>
          <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-ink-500"><Icon name="shield" className="h-3.5 w-3.5" />Secure checkout</p>
        </aside>
      </div>
    </Container>
  );
}
