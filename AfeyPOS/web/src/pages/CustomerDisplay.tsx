import { useEffect, useRef, useState } from 'react';
import { usePublicConfig } from './Auth';
import { money } from '../lib/format';

/**
 * What the till shows the customer. The till posts its basket on a same-origin BroadcastChannel, so the display
 * works on a second monitor of the same PC, offline too, with nothing sent over the network.
 */
export interface DisplayState {
  status: 'idle' | 'basket' | 'paying' | 'paid';
  lines: { name: string; qty: number; unit: string; unitPriceCents: number; totalCents: number; discountCents: number }[];
  discountCents: number;
  taxCents: number;
  totalCents: number;
  paidCents?: number;
  changeCents?: number;
  payment?: string;
  message?: string;
  at: number;
}

const CHANNEL = 'afey-customer-display';

/** The till's side: publishes the basket whenever it changes (and answers a display that just opened). */
export function useCustomerDisplayFeed(state: DisplayState | null) {
  const ch = useRef<BroadcastChannel | null>(null);
  const last = useRef<DisplayState | null>(null);
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    ch.current = new BroadcastChannel(CHANNEL);
    ch.current.onmessage = (e) => { if (e.data?.type === 'hello' && last.current) ch.current?.postMessage({ type: 'state', state: last.current }); };
    return () => { ch.current?.close(); ch.current = null; };
  }, []);
  useEffect(() => {
    if (!state) return;
    last.current = state;
    ch.current?.postMessage({ type: 'state', state });
  }, [state]);
}

export function openCustomerDisplay() {
  // A separate window the cashier drags to the customer's screen (or starts full screen there).
  window.open('/customer-display', 'afey-customer-display', 'popup,width=1024,height=640');
}

export function CustomerDisplayPage() {
  const cfg = usePublicConfig().data;
  const [state, setState] = useState<DisplayState | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(CHANNEL);
    ch.onmessage = (e) => { if (e.data?.type === 'state') setState(e.data.state); };
    ch.postMessage({ type: 'hello' });
    return () => ch.close();
  }, []);
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }); }, [state?.lines.length]);
  const name = cfg?.tenant?.name ?? 'Welcome';
  const logo = cfg?.tenant?.logoUrl;
  const s = state ?? { status: 'idle', lines: [], discountCents: 0, taxCents: 0, totalCents: 0, at: 0 } as DisplayState;
  const lastLine = s.lines.at(-1);
  return (
    <div className="flex h-screen flex-col bg-ink-950 text-white" data-testid="customer-display">
      <header className="flex items-center gap-4 border-b border-white/10 px-8 py-5">
        {logo ? <img src={logo} alt="" className="h-12 w-12 rounded-lg bg-white object-contain p-1" /> : null}
        <div className="text-2xl font-bold">{name}</div>
        <div className="ml-auto text-sm text-white/50">{new Date().toLocaleDateString()}</div>
      </header>
      {s.status === 'idle' || (!s.lines.length && s.status !== 'paid') ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <div className="text-5xl font-extrabold">Karibu!</div>
          <div className="text-xl text-white/60">{cfg?.tenant?.tagline || 'Welcome. Your items will show here.'}</div>
        </div>
      ) : s.status === 'paid' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
          <div className="flex h-24 w-24 items-center justify-center rounded-full bg-emerald-500 text-5xl">✓</div>
          <div className="text-4xl font-extrabold">Asante! Thank you</div>
          <div className="text-2xl">Paid {money(s.paidCents ?? s.totalCents)}{s.payment ? ` by ${s.payment}` : ''}</div>
          {s.changeCents ? <div className="text-3xl font-bold text-emerald-400">Change {money(s.changeCents)}</div> : null}
          <div className="text-lg text-white/60">{s.message ?? 'Karibu tena. Come again!'}</div>
        </div>
      ) : (
        <div className="grid flex-1 grid-cols-[1fr_380px] overflow-hidden">
          <div ref={listRef} className="overflow-y-auto px-8 py-4">
            <table className="w-full text-lg">
              <thead><tr className="text-left text-sm uppercase tracking-wide text-white/40"><th className="py-2">Item</th><th className="text-right">Qty</th><th className="text-right">Price</th><th className="text-right">Total</th></tr></thead>
              <tbody>
                {s.lines.map((l, i) => (
                  <tr key={i} className={`border-t border-white/10 ${i === s.lines.length - 1 ? 'bg-white/5' : ''}`}>
                    <td className="py-2 font-semibold">{l.name}{l.discountCents ? <div className="text-sm text-emerald-400">− {money(l.discountCents)} off</div> : null}</td>
                    <td className="text-right tabular-nums">{l.qty} {l.unit}</td>
                    <td className="text-right tabular-nums">{money(l.unitPriceCents)}</td>
                    <td className="text-right font-semibold tabular-nums">{money(l.totalCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <aside className="flex flex-col justify-end gap-3 bg-white/5 p-8">
            {lastLine && <div className="mb-auto rounded-xl bg-white/10 p-4"><div className="text-sm text-white/50">Just added</div><div className="text-xl font-bold">{lastLine.name}</div><div className="text-lg">{lastLine.qty} {lastLine.unit} × {money(lastLine.unitPriceCents)}</div></div>}
            {s.discountCents > 0 && <div className="flex justify-between text-lg text-emerald-400"><span>Discount</span><span>− {money(s.discountCents)}</span></div>}
            <div className="flex justify-between text-lg text-white/60"><span>Tax</span><span>{money(s.taxCents)}</span></div>
            <div className="border-t border-white/10 pt-3 text-sm uppercase tracking-wide text-white/50">Total to pay</div>
            <div className="break-words text-5xl font-extrabold leading-tight tabular-nums" data-testid="display-total">{money(s.totalCents)}</div>
            {s.status === 'paying' && <div className="rounded-lg bg-amber-500/20 px-3 py-2 text-center text-lg text-amber-200">{s.message ?? 'Waiting for payment…'}</div>}
          </aside>
        </div>
      )}
    </div>
  );
}
