import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { dateTime, money } from '../lib/format';
import { savedOrders } from '../lib/orders';
import { Container, Crumbs } from '../components/Layout';
import { Icon } from '../components/Icon';

const STEPS = { delivery: ['placed', 'accepted', 'picking', 'out_for_delivery', 'completed'], pickup: ['placed', 'accepted', 'picking', 'ready', 'completed'] } as const;
const LABEL: Record<string, string> = { pending_payment: 'Waiting for payment', placed: 'Received', accepted: 'Accepted', picking: 'Packing', ready: 'Ready for collection', out_for_delivery: 'On the way', completed: 'Done', cancelled: 'Cancelled' };
const STEP_ICON: Record<string, string> = { placed: 'check', accepted: 'smile', picking: 'bag', ready: 'home', out_for_delivery: 'truck', completed: 'star' };

export function OrderPage() {
  const { number } = useParams();
  const [params] = useSearchParams();
  const token = params.get('t') ?? '';
  const simulated = params.get('simulated');
  const [o, setO] = useState<any>(null);
  const [error, setError] = useState(params.get('e') ?? '');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<{ data: any }>(`/orders/${number}`, { query: { token } }).then((r) => setO(r.data)).catch((e) => setError(e.message)), [number, token]);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);
  if (!o) return <Container><p className="py-16 text-center text-ink-400">{error || 'Loading…'}</p></Container>;
  const steps = STEPS[o.fulfilment as 'delivery'];
  const at = steps.indexOf(o.status);
  const card = o.payment.method === 'card';
  const retry = async () => {
    setBusy(true);
    setError('');
    try {
      const r = (await api<{ data: any }>(`/orders/${number}/pay`, { body: {}, query: { token } })).data;
      if (card && r.payment?.checkoutUrl) window.location.assign(r.payment.checkoutUrl);
      else setO(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const simulate = async () => {
    setBusy(true);
    try {
      setO((await api<{ data: any }>(`/orders/${number}/simulate-payment`, { body: {}, query: { token } })).data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Container className="max-w-3xl">
      <Crumbs items={[{ label: 'Account', to: '/account' }, { label: `Order ${o.number}` }]} />
      <div className="space-y-5">
        <div className="rounded-box bg-soft p-8 text-center">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary text-white"><Icon name={o.status === 'cancelled' ? 'close' : o.status === 'pending_payment' ? 'clock' : 'check'} className="h-7 w-7" /></span>
          <p className="mt-4 text-sm text-ink-500">Order</p>
          <h1 className="text-3xl font-extrabold" data-testid="order-number">{o.number}</h1>
          <p className="mt-2 text-lg font-semibold" data-testid="order-status">{LABEL[o.status] ?? o.status}</p>
          {o.status === 'pending_payment' && (
            <div className="mx-auto mt-5 max-w-md rounded-tile bg-white p-5 text-sm">
              {card ? <p>Pay <strong>{money(o.totalCents)}</strong> by card to confirm your order.</p> : <p>Check your phone and enter your M-Pesa PIN to pay <strong>{money(o.totalCents)}</strong>.</p>}
              {o.payment.status === 'failed' && <p className="mt-1 text-red-600">The payment did not go through.</p>}
              {simulated && card && o.payment.status === 'pending' ? (
                <div className="mt-4 rounded-tile border border-dashed border-ink-300 p-3">
                  <p className="text-xs text-ink-500">Payment simulator (test mode): no real card is charged.</p>
                  <button className="btn-primary btn-sm mt-2" disabled={busy} onClick={simulate}>Simulate card payment</button>
                </div>
              ) : card && o.payment.status === 'pending' && o.payment.checkoutUrl ? (
                <a className="btn-primary mt-4" href={o.payment.checkoutUrl}>Pay by card</a>
              ) : (
                <button className="btn-primary mt-4" disabled={busy} onClick={retry}>{busy ? 'Sending…' : card ? 'Try the card payment again' : 'Send the M-Pesa prompt again'}</button>
              )}
            </div>
          )}
          {o.payment.status === 'paid' && <p className="mt-2 text-sm font-semibold text-primary">{o.payment.method === 'on_delivery' ? 'Paid' : `Paid by ${card ? 'card' : 'M-Pesa'}`}{o.payment.receiptNumber ? ` (${o.payment.receiptNumber})` : ''}</p>}
          {error && <p className="mt-3 text-sm text-red-600" role="alert">{error}</p>}
        </div>
        {o.status !== 'cancelled' && o.status !== 'pending_payment' && (
          <ol className="grid grid-cols-5 gap-1 rounded-box border border-ink-100 p-5 text-center text-xs">
            {steps.map((s, i) => (
              <li key={s} className={i <= at ? 'font-bold text-primary' : 'text-ink-400'}>
                <span className={`mx-auto mb-2 flex h-9 w-9 items-center justify-center rounded-full ${i <= at ? 'bg-primary text-white' : 'bg-ink-100'}`}><Icon name={STEP_ICON[s] ?? 'check'} className="h-4 w-4" /></span>{LABEL[s]}
              </li>
            ))}
          </ol>
        )}
        <div className="rounded-box border border-ink-100 p-6">
          <ul className="space-y-2 text-sm">{o.lines.map((l: any) => <li key={l.productId} className="flex justify-between"><span>{l.qty} × {l.name}</span><span>{money(l.totalCents)}</span></li>)}</ul>
          <div className="mt-4 space-y-1 border-t border-ink-100 pt-4 text-sm">
            {o.deliveryFeeCents > 0 && <div className="flex justify-between"><span>Delivery</span><span>{money(o.deliveryFeeCents)}</span></div>}
            <div className="flex justify-between text-lg font-extrabold text-primary"><span>Total</span><span>{money(o.totalCents)}</span></div>
          </div>
          <p className="mt-4 text-sm text-ink-500">{o.fulfilment === 'delivery' ? `Delivery to ${o.address ?? ''}${o.area ? `, ${o.area}` : ''}` : 'Pick up at the shop'} · placed {dateTime(o.createdAt)}</p>
        </div>
        <p className="text-center text-sm text-ink-500">Keep this page to follow your order. <Link className="font-semibold text-primary underline" to="/shop">Continue shopping</Link></p>
      </div>
    </Container>
  );
}

function TrackForm() {
  const nav = useNavigate();
  const [number, setNumber] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState('');
  return (
    <form className="space-y-4 rounded-box border border-ink-100 p-6" onSubmit={async (e) => {
      e.preventDefault();
      try {
        const r = await api<{ data: any }>(`/orders/${number.trim().toUpperCase()}`, { query: { phone } });
        nav(`/order/${r.data.number}?t=${r.data.token}`);
      } catch {
        setError('No order found with that number and phone');
      }
    }}>
      <h2 className="text-xl font-bold">Track your order</h2>
      <label className="block"><span className="label">Order number</span><input className="input" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="WEB-000123" /></label>
      <label className="block"><span className="label">Phone used for the order</span><input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" /></label>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button className="btn-primary w-full">Find order</button>
    </form>
  );
}

export function TrackPage() {
  return <Container className="max-w-md"><Crumbs items={[{ label: 'Track order' }]} /><TrackForm /></Container>;
}

/** No sign-in: orders placed from this browser, plus tracking by number and phone. */
export function AccountPage() {
  const orders = savedOrders();
  return (
    <Container className="max-w-4xl">
      <Crumbs items={[{ label: 'Account' }]} />
      <h1 className="section-title mb-6">Your Account</h1>
      <div className="grid gap-6 md:grid-cols-2">
        <section className="rounded-box bg-soft p-6">
          <h2 className="mb-4 text-xl font-bold">Orders on this device</h2>
          {orders.length ? (
            <ul className="divide-y divide-ink-200">
              {orders.map((o) => (
                <li key={o.number}><Link to={`/order/${o.number}?t=${o.token}`} className="flex items-center justify-between py-3 text-sm hover:text-primary"><span><span className="block font-bold">{o.number}</span><span className="text-ink-500">{dateTime(o.at)}</span></span><span className="flex items-center gap-2 font-semibold">{money(o.totalCents)}<Icon name="chevron" className="h-4 w-4" /></span></Link></li>
              ))}
            </ul>
          ) : <p className="text-sm text-ink-500">Orders you place from this browser appear here.</p>}
        </section>
        <TrackForm />
      </div>
    </Container>
  );
}
