import { useState } from 'react';
import { api, newRequestId } from '../lib/api';
import { money, mpesaPayer } from '../lib/format';
import { Button, cx, ErrorBox, Input, Spinner } from './ui';

type Mode = 'stk' | 'paybill' | 'code';

/**
 * M-Pesa at the till: a prompt on the customer's phone (STK), the customer paying the Paybill/Till
 * themselves (the till waits for that payment), or entering the code from the customer's M-Pesa SMS.
 * The parent owns the intent so its realtime/polling hooks add the payment once M-Pesa confirms it.
 */
export function MpesaPanel({ amount, tillId, intent, setIntent, unallocated, usedIds, onUse }: {
  amount: number | null;
  tillId: string;
  intent: any;
  setIntent: (i: any) => void;
  unallocated: any[] | undefined;
  usedIds: string[];
  onUse: (i: any) => void;
}) {
  const [mode, setMode] = useState<Mode>('stk');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const mine = intent && (intent.provider ?? 'mpesa') === 'mpesa' ? intent : null;
  const pending = mine?.status === 'pending';
  const whole = amount !== null && amount % 100 === 0;

  const call = async (fn: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const startStk = () => call(async () => setIntent((await api<{ data: any }>('/payments/mpesa/stk', { body: { clientRequestId: newRequestId(), amountCents: amount, phone, tillId } })).data));
  const expect = () => call(async () => setIntent((await api<{ data: any }>('/payments/mpesa/expect', { body: { clientRequestId: newRequestId(), amountCents: amount, tillId } })).data));
  const lookup = () => call(async () => {
    const r = await api<{ data: any; found: boolean }>('/payments/mpesa/lookup', { body: { receipt: code.trim().toUpperCase(), clientRequestId: newRequestId(), tillId } });
    if (r.found) onUse(r.data);
    else setIntent(r.data);
    setCode('');
  });
  const cancel = async () => {
    await api(`/payments/intents/${mine.id}/cancel`, { body: {} }).catch(() => undefined);
    setIntent(null);
  };

  return (
    <div className="space-y-3 rounded-lg border border-ink-200 p-3 dark:border-ink-700">
      {!pending && (
        <div className="inline-flex flex-wrap rounded-lg bg-ink-100 p-1 text-sm dark:bg-ink-800" role="radiogroup" aria-label="How the customer pays with M-Pesa">
          {([['stk', 'Send prompt'], ['paybill', 'Customer pays Paybill/Till'], ['code', 'Enter M-Pesa code']] as const).map(([m, label]) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => { setMode(m); setError(null); }}
              className={cx('rounded-md px-3 py-1 font-medium', mode === m ? 'bg-white shadow-sm dark:bg-ink-900' : 'text-ink-600 dark:text-ink-300')}>{label}</button>
          ))}
        </div>
      )}

      {pending && mine.source === 'stk' && (
        <div className="flex flex-wrap items-center gap-2 text-sm"><Spinner className="h-4 w-4" />Waiting for the customer to enter their M-Pesa PIN…
          <Button size="sm" variant="ghost" onClick={async () => setIntent((await api<{ data: any }>(`/payments/intents/${mine.id}/query`, { body: {} })).data)}>Check status</Button>
          <Button size="sm" variant="ghost" onClick={cancel}>Cancel</Button>
        </div>
      )}
      {pending && mine.awaiting === 'expected' && (
        <div className="space-y-2" data-testid="mpesa-pay-to">
          <div className="grid gap-2 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-950 dark:bg-emerald-900/30 dark:text-emerald-100 sm:grid-cols-3">
            {mine.accountReference ? (
              <>
                <div><div className="text-xs uppercase opacity-70">Paybill</div><div className="text-xl font-semibold tabular-nums">{mine.shortCode}</div></div>
                <div><div className="text-xs uppercase opacity-70">Account</div><div className="text-xl font-semibold tracking-wider">{mine.accountReference}</div></div>
              </>
            ) : (
              <div className="sm:col-span-2"><div className="text-xs uppercase opacity-70">Buy Goods till</div><div className="text-xl font-semibold tabular-nums">{mine.shortCode}</div></div>
            )}
            <div><div className="text-xs uppercase opacity-70">Amount</div><div className="text-xl font-semibold tabular-nums">{money(mine.amountCents)}</div></div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm"><Spinner className="h-4 w-4" />Waiting for the payment to arrive…
            <Button size="sm" variant="ghost" onClick={cancel}>Cancel</Button>
          </div>
        </div>
      )}
      {pending && mine.awaiting === 'verify' && (
        <div className="flex flex-wrap items-center gap-2 text-sm"><Spinner className="h-4 w-4" />Checking {mine.accountReference} with M-Pesa…
          <Button size="sm" variant="ghost" onClick={cancel}>Cancel</Button>
        </div>
      )}

      {!pending && mode === 'stk' && (
        <div className="flex gap-2"><Input placeholder="Customer phone e.g. 0712345678" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" /><Button onClick={startStk} loading={busy} disabled={!phone || !amount || !whole}>Send STK</Button></div>
      )}
      {!pending && mode === 'paybill' && (
        <div className="space-y-2">
          <p className="text-sm text-ink-600 dark:text-ink-300">Show the customer the Paybill and account number (or Buy Goods till) to pay {amount ? money(amount) : ''} from their phone. The sale continues by itself when the money arrives.</p>
          <Button onClick={expect} loading={busy} disabled={!amount || !whole}>Show payment details</Button>
        </div>
      )}
      {!pending && mode === 'code' && (
        <div className="flex gap-2">
          <Input placeholder="M-Pesa code from the SMS, e.g. SJK3AB12CD" value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} maxLength={12} aria-label="M-Pesa code" />
          <Button onClick={lookup} loading={busy} disabled={code.length < 8}>Find payment</Button>
        </div>
      )}

      {mine && mine.status === 'succeeded' && <MpesaPaid intent={mine} />}
      {mine && ['failed', 'cancelled', 'expired'].includes(mine.status) && <ErrorBox error={`M-Pesa ${mine.status}: ${mine.resultDesc ?? ''}. Nothing was taken; try again or use another method.`} />}
      {amount !== null && !whole && <p className="text-xs text-amber-600">M-Pesa accepts whole shillings only.</p>}
      <ErrorBox error={error} />

      {unallocated && unallocated.filter((i) => !usedIds.includes(i.id)).length > 0 && (
        <div>
          <div className="label">Payments received to the Paybill/Till, not yet used</div>
          <ul className="space-y-1">{unallocated.filter((i) => !usedIds.includes(i.id)).map((i) => (
            <li key={i.id}><button type="button" className="flex w-full justify-between rounded border border-ink-200 px-2 py-1.5 text-sm hover:bg-ink-50 dark:border-ink-700 dark:hover:bg-ink-800" onClick={() => onUse(i)}>
              <span>{i.receiptNumber} · {mpesaPayer(i) || 'M-Pesa customer'}{i.accountReference ? ` · ${i.accountReference}` : ''}</span><span className="font-medium">{money(i.paidAmountCents - i.allocatedCents)}</span>
            </button></li>
          ))}</ul>
        </div>
      )}
    </div>
  );
}

/** The confirmation the cashier sees: amount, who paid (name and part of the number, as M-Pesa sent them), receipt. */
export function MpesaPaid({ intent }: { intent: { paidAmountCents?: number; amountCents: number; receiptNumber?: string; payerName?: string; phone?: string } }) {
  const who = mpesaPayer(intent);
  return (
    <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-950 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-100" role="status" data-testid="mpesa-paid">
      <div className="font-semibold">M-Pesa payment received: {money(intent.paidAmountCents ?? intent.amountCents)}</div>
      <div className="mt-0.5">{who ? <>From <b>{who}</b></> : 'From an M-Pesa customer'}{intent.receiptNumber ? <> · Receipt <span className="font-mono">{intent.receiptNumber}</span></> : null}</div>
    </div>
  );
}
