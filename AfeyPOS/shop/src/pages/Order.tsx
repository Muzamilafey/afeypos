import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { dateTime, money } from '../lib/format';

const STEPS = { delivery: ['placed', 'accepted', 'picking', 'out_for_delivery', 'completed'], pickup: ['placed', 'accepted', 'picking', 'ready', 'completed'] } as const;
const LABEL: Record<string, string> = { pending_payment: 'Waiting for payment', placed: 'Received', accepted: 'Accepted', picking: 'Packing', ready: 'Ready for collection', out_for_delivery: 'On the way', completed: 'Done', cancelled: 'Cancelled' };

export function OrderPage() {
  const { number } = useParams();
  const [params] = useSearchParams();
  const token = params.get('t') ?? '';
  const [o, setO] = useState<any>(null);
  const [error, setError] = useState(params.get('e') ?? '');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<{ data: any }>(`/orders/${number}`, { query: { token } }).then((r) => setO(r.data)).catch((e) => setError(e.message)), [number, token]);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);
  if (!o) return <p className="text-ink-400">{error || 'Loading…'}</p>;
  const steps = STEPS[o.fulfilment as 'delivery'];
  const at = steps.indexOf(o.status);
  const retry = async () => {
    setBusy(true);
    setError('');
    try {
      setO((await api<{ data: any }>(`/orders/${number}/pay`, { body: {}, query: { token } })).data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="card p-6 text-center">
        <p className="text-sm text-ink-500">Order</p>
        <h1 className="text-2xl font-bold" data-testid="order-number">{o.number}</h1>
        <p className="mt-2 text-lg" data-testid="order-status">{LABEL[o.status] ?? o.status}</p>
        {o.status === 'pending_payment' && (
          <div className="mt-4 rounded-xl bg-amber-50 p-4 text-sm text-amber-900">
            <p>Check your phone and enter your M-Pesa PIN to pay <strong>{money(o.totalCents)}</strong>.</p>
            {o.payment.status === 'failed' && <p className="mt-1">The payment did not go through.</p>}
            <button className="btn-primary mt-3" disabled={busy} onClick={retry}>{busy ? 'Sending…' : 'Send the M-Pesa prompt again'}</button>
          </div>
        )}
        {o.payment.status === 'paid' && <p className="mt-2 text-sm text-brand-700">Paid by M-Pesa{o.payment.receiptNumber ? ` (${o.payment.receiptNumber})` : ''}</p>}
        {error && <p className="mt-3 text-sm text-red-600" role="alert">{error}</p>}
      </div>
      {o.status !== 'cancelled' && o.status !== 'pending_payment' && (
        <ol className="card grid grid-cols-5 gap-1 p-4 text-center text-xs">
          {steps.map((s, i) => <li key={s} className={i <= at ? 'font-semibold text-brand-700' : 'text-ink-400'}><div className={`mx-auto mb-1 h-2 rounded-full ${i <= at ? 'bg-brand-600' : 'bg-ink-200'}`} />{LABEL[s]}</li>)}
        </ol>
      )}
      <div className="card p-5">
        <ul className="space-y-1 text-sm">{o.lines.map((l: any) => <li key={l.productId} className="flex justify-between"><span>{l.qty} × {l.name}</span><span>{money(l.totalCents)}</span></li>)}</ul>
        <div className="mt-3 space-y-1 border-t border-ink-100 pt-3 text-sm">
          {o.deliveryFeeCents > 0 && <div className="flex justify-between"><span>Delivery</span><span>{money(o.deliveryFeeCents)}</span></div>}
          <div className="flex justify-between text-base font-bold"><span>Total</span><span>{money(o.totalCents)}</span></div>
        </div>
        <p className="mt-3 text-sm text-ink-500">{o.fulfilment === 'delivery' ? `Delivery to ${o.address ?? ''}${o.area ? `, ${o.area}` : ''}` : 'Pick up at the shop'} · placed {dateTime(o.createdAt)}</p>
      </div>
      <p className="text-center text-sm text-ink-500">Keep this page to follow your order. <Link className="underline" to="/">Continue shopping</Link></p>
    </div>
  );
}

export function TrackPage() {
  const nav = useNavigate();
  const [number, setNumber] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState('');
  return (
    <form className="card mx-auto max-w-md space-y-3 p-6" onSubmit={async (e) => {
      e.preventDefault();
      try {
        const r = await api<{ data: any }>(`/orders/${number.trim().toUpperCase()}`, { query: { phone } });
        nav(`/order/${r.data.number}?t=${r.data.token}`);
      } catch {
        setError('No order found with that number and phone');
      }
    }}>
      <h1 className="text-xl font-semibold">Track your order</h1>
      <label className="block"><span className="label">Order number</span><input className="input" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="WEB-000123" /></label>
      <label className="block"><span className="label">Phone used for the order</span><input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" /></label>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button className="btn-primary w-full">Find order</button>
    </form>
  );
}
