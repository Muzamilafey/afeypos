import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, newRequestId } from '../lib/api';
import { useCart } from '../lib/cart';
import { money } from '../lib/format';
import { useStore } from '../lib/store';

interface Quote { lines: any[]; subtotalCents: number; deliveryFeeCents: number; totalCents: number; problems: string[] }

export function CheckoutPage() {
  const store = useStore();
  const cart = useCart();
  const nav = useNavigate();
  const [requestId] = useState(newRequestId);
  const [fulfilment, setFulfilment] = useState<'delivery' | 'pickup'>(store.delivery ? 'delivery' : 'pickup');
  const [area, setArea] = useState(store.deliveryAreas[0]?.name ?? '');
  const [f, setF] = useState({ name: '', phone: '', email: '', address: '', notes: '', mpesaPhone: '', marketingOptIn: false });
  const [payment, setPayment] = useState<'mpesa' | 'on_delivery'>(store.mpesa ? 'mpesa' : 'on_delivery');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lines = useMemo(() => cart.lines.map((l) => ({ productId: l.productId, qty: l.qty })), [cart.lines]);

  useEffect(() => {
    if (!lines.length) return;
    api<{ data: Quote }>('/cart/quote', { body: { lines, fulfilment, area: fulfilment === 'delivery' ? area : undefined } }).then((r) => setQuote(r.data)).catch((e) => setError(e.message));
  }, [lines, fulfilment, area]);

  if (!cart.lines.length) return <p className="py-10 text-center text-ink-500">Your basket is empty.</p>;
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
      nav(`/order/${r.data.number}?t=${r.data.token}${r.paymentError ? `&e=${encodeURIComponent(r.paymentError)}` : ''}`);
    } catch (e) {
      setError(e instanceof ApiError && e.details?.problems ? e.details.problems.join('. ') : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const ready = f.name.length >= 2 && f.phone.length >= 9 && (fulfilment === 'pickup' || f.address.length >= 3) && quote && !quote.problems.length;
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <section className="card p-5">
          <h2 className="mb-3 text-lg font-semibold">How do you want it?</h2>
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Delivery or pickup">
            {store.delivery && <button type="button" role="radio" aria-checked={fulfilment === 'delivery'} className={fulfilment === 'delivery' ? 'btn-primary' : 'btn-light'} onClick={() => setFulfilment('delivery')}>Delivery</button>}
            {store.pickup && <button type="button" role="radio" aria-checked={fulfilment === 'pickup'} className={fulfilment === 'pickup' ? 'btn-primary' : 'btn-light'} onClick={() => setFulfilment('pickup')}>Pick up</button>}
          </div>
          {fulfilment === 'delivery' ? (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {store.deliveryAreas.length > 0 && <label><span className="label">Area</span><select className="input" value={area} onChange={(e) => setArea(e.target.value)}>{store.deliveryAreas.map((a) => <option key={a.name} value={a.name}>{a.name} ({a.feeCents ? money(a.feeCents) : 'free'})</option>)}</select></label>}
              <label className={store.deliveryAreas.length ? '' : 'sm:col-span-2'}><span className="label">Delivery address</span><input className="input" value={f.address} onChange={set('address')} placeholder="Building, street, house number" /></label>
            </div>
          ) : (
            <p className="mt-3 text-sm text-ink-600">Collect at {store.branches.map((b) => `${b.name}${b.address ? ` (${b.address})` : ''}`).join(', ') || store.name}. We will SMS you when it is ready.</p>
          )}
        </section>
        <section className="card p-5">
          <h2 className="mb-3 text-lg font-semibold">Your details</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <label><span className="label">Name</span><input className="input" value={f.name} onChange={set('name')} autoComplete="name" /></label>
            <label><span className="label">Phone</span><input className="input" value={f.phone} onChange={set('phone')} inputMode="tel" autoComplete="tel" placeholder="07XX XXX XXX" /></label>
            <label><span className="label">Email (optional)</span><input className="input" value={f.email} onChange={set('email')} type="email" autoComplete="email" /></label>
            <label><span className="label">Notes for us (optional)</span><input className="input" value={f.notes} onChange={set('notes')} placeholder="Gate code, landmark…" /></label>
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.marketingOptIn} onChange={(e) => setF({ ...f, marketingOptIn: e.target.checked })} />Send me offers by SMS (you can stop any time)</label>
        </section>
        <section className="card p-5">
          <h2 className="mb-3 text-lg font-semibold">Payment</h2>
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Payment">
            {store.mpesa && <button type="button" role="radio" aria-checked={payment === 'mpesa'} className={payment === 'mpesa' ? 'btn-primary' : 'btn-light'} onClick={() => setPayment('mpesa')}>M-Pesa now</button>}
            {store.payOnDelivery && <button type="button" role="radio" aria-checked={payment === 'on_delivery'} className={payment === 'on_delivery' ? 'btn-primary' : 'btn-light'} onClick={() => setPayment('on_delivery')}>{fulfilment === 'pickup' ? 'Pay at the shop' : 'Pay on delivery'}</button>}
          </div>
          {payment === 'mpesa' && <label className="mt-3 block"><span className="label">M-Pesa number (if different)</span><input className="input" value={f.mpesaPhone} onChange={set('mpesaPhone')} inputMode="tel" placeholder={f.phone || '07XX XXX XXX'} /><span className="mt-1 block text-xs text-ink-500">You will get a prompt on your phone to enter your M-Pesa PIN.</span></label>}
        </section>
      </div>
      <aside className="card h-fit p-5">
        <h2 className="mb-3 text-lg font-semibold">Order summary</h2>
        {quote ? <>
          <ul className="space-y-1 text-sm">{quote.lines.map((l) => <li key={l.productId} className="flex justify-between gap-2"><span>{l.qty} × {l.name}</span><span className="tabular-nums">{money(l.totalCents)}</span></li>)}</ul>
          <div className="mt-3 space-y-1 border-t border-ink-100 pt-3 text-sm">
            <div className="flex justify-between"><span>Subtotal</span><span>{money(quote.subtotalCents)}</span></div>
            {fulfilment === 'delivery' && <div className="flex justify-between"><span>Delivery</span><span>{quote.deliveryFeeCents ? money(quote.deliveryFeeCents) : 'Free'}</span></div>}
            <div className="flex justify-between pt-1 text-lg font-bold"><span>Total</span><span data-testid="checkout-total">{money(quote.totalCents)}</span></div>
          </div>
          {quote.problems.length > 0 && <ul className="mt-3 list-disc pl-5 text-sm text-red-600">{quote.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
        </> : <p className="text-ink-400">Calculating…</p>}
        {error && <p className="mt-3 rounded-lg bg-red-50 p-2 text-sm text-red-700" role="alert">{error}</p>}
        <button className="btn-primary mt-4 w-full" disabled={!ready || busy} onClick={place}>{busy ? 'Placing order…' : payment === 'mpesa' ? 'Place order and pay' : 'Place order'}</button>
      </aside>
    </div>
  );
}
