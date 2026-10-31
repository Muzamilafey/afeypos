import { useState } from 'react';
import { api, newRequestId } from '../lib/api';
import { dateTime, money, mpesaPayer } from '../lib/format';
import { Button, cx, ErrorBox, Field, Input, Select, Spinner } from './ui';
import { Icon } from './icons';

type Mode = 'stk' | 'paybill' | 'code';

/**
 * M-Pesa at the till: a prompt on the customer's phone (STK), the customer paying the Paybill/Till
 * themselves (the till waits for that payment), or entering the code from the customer's M-Pesa SMS.
 * The parent owns the intent so its realtime/polling hooks add the payment once M-Pesa confirms it.
 */
const MODES: { key: Mode; label: string; hint: string; icon: string }[] = [
  { key: 'stk', label: 'Send prompt', hint: 'The customer gets a PIN prompt on their phone', icon: 'phone' },
  { key: 'paybill', label: 'Customer pays Paybill/Till', hint: 'The customer pays from their phone; the sale continues when it arrives', icon: 'store' },
  { key: 'code', label: 'Enter M-Pesa code', hint: 'The customer already paid: type the code from their M-Pesa SMS', icon: 'search' },
];

/**
 * Payments that reached the Paybill/Till without a sale are not listed at the till (anyone could pick a
 * stranger's payment): the cashier finds one only by its M-Pesa code, checks the name and amount, then uses it.
 */
export interface MpesaAccount { id: string; name: string; environment: string; isDefault: boolean; payTo: { type: 'paybill' | 'till'; number: string }; stk: boolean }

export function MpesaPanel({ amount, tillId, accounts = [], intent, setIntent, usedIds, onUse }: {
  amount: number | null;
  tillId: string;
  /** Every M-Pesa account this till may use; the cashier picks one when there is more than one. */
  accounts?: MpesaAccount[];
  intent: any;
  setIntent: (i: any) => void;
  usedIds: string[];
  onUse: (i: any) => void;
}) {
  const [mode, setMode] = useState<Mode>('stk');
  const [accountId, setAccountId] = useState('');
  const account = accounts.find((a) => a.id === accountId) ?? accounts[0];
  const configId = accounts.length > 1 ? account?.id : undefined;
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [found, setFound] = useState<any>(null);
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
  const startStk = () => call(async () => setIntent((await api<{ data: any }>('/payments/mpesa/stk', { body: { clientRequestId: newRequestId(), amountCents: amount, phone, tillId, configId } })).data));
  const expect = () => call(async () => setIntent((await api<{ data: any }>('/payments/mpesa/expect', { body: { clientRequestId: newRequestId(), amountCents: amount, tillId, configId } })).data));
  const lookup = () => call(async () => {
    setFound(null);
    const r = await api<{ data: any; found: boolean }>('/payments/mpesa/lookup', { body: { receipt: code.trim().toUpperCase(), clientRequestId: newRequestId(), tillId } });
    if (r.found) {
      if (usedIds.includes(r.data.id)) throw new Error(`${r.data.receiptNumber} is already on this sale`);
      setFound(r.data);
    } else setIntent(r.data);
  });
  const use = () => {
    onUse(found);
    setFound(null);
    setCode('');
  };
  const cancel = async () => {
    await api(`/payments/intents/${mine.id}/cancel`, { body: {} }).catch(() => undefined);
    setIntent(null);
  };
  const current = MODES.find((m) => m.key === mode)!;
  const field = 'h-12 text-base';

  return (
    <div className="overflow-hidden rounded-xl border border-ink-200 bg-white dark:border-ink-700 dark:bg-ink-900">
      {!pending && (
        <div className="grid grid-cols-3 border-b border-ink-200 bg-ink-50 dark:border-ink-700 dark:bg-ink-800/60" role="radiogroup" aria-label="How the customer pays with M-Pesa">
          {MODES.map((m) => (
            <button key={m.key} type="button" role="radio" aria-checked={mode === m.key} onClick={() => { setMode(m.key); setError(null); setFound(null); }}
              className={cx('flex flex-col items-center gap-1 border-b-2 px-2 py-2.5 text-center text-[13px] font-semibold leading-tight transition-colors',
                mode === m.key ? 'border-emerald-600 bg-white text-emerald-700 dark:bg-ink-900 dark:text-emerald-300' : 'border-transparent text-ink-500 hover:bg-white/60 hover:text-ink-800 dark:text-ink-400 dark:hover:bg-ink-900/50')}>
              <Icon name={m.icon} className="h-5 w-5" />{m.label}
            </button>
          ))}
        </div>
      )}

      <div className="space-y-3 p-4">
        {!pending && accounts.length > 1 && (
          <Field label="M-Pesa account" hint="Which Paybill or Till the money goes to">
            <Select value={account?.id ?? ''} onChange={(e) => setAccountId(e.target.value)}
              options={accounts.map((a) => ({ value: a.id, label: `${a.name} · ${a.payTo.type === 'till' ? 'Till' : 'Paybill'} ${a.payTo.number}${a.environment === 'sandbox' ? ' (test)' : ''}` }))} />
          </Field>
        )}
        {!pending && <p className="text-sm text-ink-500 dark:text-ink-400">{current.hint}</p>}

        {pending && mine.source === 'stk' && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-900/30 dark:text-amber-100"><Spinner className="h-4 w-4" />Waiting for the customer to enter their M-Pesa PIN…
            <span className="ml-auto flex gap-1">
              <Button size="sm" variant="ghost" onClick={async () => setIntent((await api<{ data: any }>(`/payments/intents/${mine.id}/query`, { body: {} })).data)}>Check status</Button>
              <Button size="sm" variant="ghost" onClick={cancel}>Cancel</Button>
            </span>
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

        {!pending && mode === 'stk' && account && !account.stk && (
          <p className="text-xs text-amber-600">{account.name} has no Lipa Na M-Pesa passkey, so it cannot send a prompt. Use “Customer pays Paybill/Till”, or add the passkey in Settings → Integrations.</p>
        )}
        {!pending && mode === 'stk' && (
          <div className="flex gap-2">
            <Input className={field} placeholder="Customer phone, e.g. 0712 345 678" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" aria-label="Customer phone"
              onKeyDown={(e) => { if (e.key === 'Enter' && phone && amount && whole) startStk(); }} />
            <Button className="h-12 shrink-0 px-5" onClick={startStk} loading={busy} disabled={!phone || !amount || !whole}><Icon name="phone" className="h-4 w-4" />Send prompt</Button>
          </div>
        )}
        {!pending && mode === 'paybill' && (
          <Button className="h-12 w-full" onClick={expect} loading={busy} disabled={!amount || !whole}><Icon name="store" className="h-4 w-4" />Show payment details{amount ? ` for ${money(amount)}` : ''}</Button>
        )}
        {!pending && mode === 'code' && (
          <div className="flex gap-2">
            <Input className={cx(field, 'font-mono uppercase tracking-widest')} placeholder="e.g. SJK3AB12CD" value={code} maxLength={12} aria-label="M-Pesa code"
              onChange={(e) => { setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '')); setFound(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && code.length >= 8) lookup(); }} />
            <Button className="h-12 shrink-0 px-5" onClick={lookup} loading={busy} disabled={code.length < 8}><Icon name="search" className="h-4 w-4" />Find payment</Button>
          </div>
        )}

        {found && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-100" data-testid="mpesa-found">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs font-semibold uppercase tracking-wide opacity-70">Payment found</div>
                <div className="break-words text-base font-semibold">{mpesaPayer(found) || 'M-Pesa customer'}</div>
                <div className="font-mono text-xs opacity-80">{found.receiptNumber}{found.completedAt ? ` · ${dateTime(found.completedAt)}` : ''}</div>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-xs opacity-70">Available</div>
                <div className="text-lg font-bold tabular-nums">{money(found.paidAmountCents - (found.allocatedCents ?? 0))}</div>
                {found.allocatedCents ? <div className="text-xs opacity-70">of {money(found.paidAmountCents)}</div> : null}
              </div>
            </div>
            <Button className="mt-3 h-11 w-full" onClick={use}><Icon name="check" className="h-4 w-4" />Use this payment</Button>
          </div>
        )}

        {mine && mine.status === 'succeeded' && <MpesaPaid intent={mine} />}
        {mine && ['failed', 'cancelled', 'expired'].includes(mine.status) && <ErrorBox error={`M-Pesa ${mine.status}: ${mine.resultDesc ?? ''}. Nothing was taken; try again or use another method.`} />}
        {amount !== null && !whole && <p className="text-xs text-amber-600">M-Pesa accepts whole shillings only.</p>}
        <ErrorBox error={error} />
      </div>
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
