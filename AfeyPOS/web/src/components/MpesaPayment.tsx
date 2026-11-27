import { useEffect, useRef, useState } from 'react';
import { api, newRequestId } from '../lib/api';
import { dateTime, money, mpesaPayer } from '../lib/format';
import { Button, cx, ErrorBox, Field, Input, Select } from './ui';
import { Icon } from './icons';
import { MpesaMark, MpesaWaiting, PaySuccess } from './PayVisuals';

/**
 * M-Pesa at the till: a prompt on the customer's phone (STK), the customer paying the Paybill/Till
 * themselves (the till waits for that payment), a dynamic QR, or entering the code from the customer's M-Pesa SMS.
 * The parent owns the intent so its realtime/polling hooks add the payment once M-Pesa confirms it.
 */
/**
 * Payments that reached the Paybill/Till without a sale are not listed at the till (anyone could pick a
 * stranger's payment): the cashier finds one only by its M-Pesa code, checks the name and amount, then uses it.
 */
export interface MpesaAccount { id: string; name: string; environment: string; isDefault: boolean; payTo: { type: 'paybill' | 'till'; number: string }; stk: boolean; c2b?: boolean; qr?: boolean }

/** A payment the till matched by amount only (Buy Goods): the cashier confirms it is this customer's before it counts. */
export const needsConfirm = (i: any) => Boolean(i && (i.provider ?? 'mpesa') === 'mpesa' && i.status === 'succeeded' && i.source === 'c2b' && i.awaiting === 'expected' && (i.requiresConfirmation || !i.accountReference));
const qrDataUri = (value: unknown) => {
  if (!value) return null;
  const image = String(value);
  return image.startsWith('data:') ? image : `data:image/png;base64,${image}`;
};

export function MpesaPanel({ amount, tillId, accounts = [], watchTill = false, intent, setIntent, usedIds, onUse, confirmedIds = [], onConfirm }: {
  amount: number | null;
  tillId: string;
  /** Every M-Pesa account this till may use; the cashier picks one when there is more than one. */
  accounts?: MpesaAccount[];
  /** Start looking for a payment to the Paybill/Till as soon as M-Pesa is chosen (Checkout rules). */
  watchTill?: boolean;
  intent: any;
  setIntent: (i: any) => void;
  usedIds: string[];
  onUse: (i: any) => void;
  /** Payments matched by amount that the cashier already confirmed ("Continue"). */
  confirmedIds?: string[];
  onConfirm?: (i: any) => void;
}) {
  const [accountId, setAccountId] = useState('');
  const account = accounts.find((a) => a.id === accountId) ?? accounts[0];
  // Prompts and payments to the Paybill/Till are set up separately: offer only what this account does.
  const c2bOn = account?.c2b !== false;
  const qrEnabled = account?.qr === true;
  const configId = accounts.length > 1 ? account?.id : undefined;
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [found, setFound] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const mine = intent && (intent.provider ?? 'mpesa') === 'mpesa' ? intent : null;
  // The background watch runs quietly beside the normal choices; only a payment the cashier started takes over.
  const watching = useRef<{ amount: number; id: string; configId?: string; qr: boolean } | null>(null);
  const watchGeneration = useRef(0);
  // Payments the cashier said are not this customer's: the next wait skips them.
  const skipped = useRef<string[]>([]);
  const askConfirm = needsConfirm(mine) && !confirmedIds.includes(mine.id);
  const notMine = () => call(async () => {
    const receipt = mine.receiptNumber;
    await api(`/payments/intents/${mine.id}/not-mine`, { body: {} });
    if (receipt) skipped.current = [...skipped.current, receipt];
    // Wait again: the watch restarts by itself; a manual wait is started again here.
    const manual = !watching.current?.id || watching.current.id !== mine.id;
    watching.current = null;
    setIntent(null);
    if (manual && !watchTill && !qrEnabled) {
      const data = (await api<{ data: any }>('/payments/mpesa/expect', { body: { clientRequestId: newRequestId(), amountCents: amount, tillId, configId, qr: qrEnabled, skipReceipts: skipped.current } })).data;
      setIntent(data);
      setQrCode(qrDataUri(data.qrCode));
    }
  });
  // Enter = Continue, wherever the focus is.
  useEffect(() => {
    if (!askConfirm) return;
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.repeat) return;
      e.preventDefault();
      e.stopPropagation();
      onConfirm?.(mine);
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [askConfirm, mine?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const autoWatch = Boolean(mine && mine.status === 'pending' && watching.current?.id && watching.current.id === mine.id);
  const pending = mine?.status === 'pending' && !autoWatch;
  const pendingAny = mine?.status === 'pending';
  const pendingExpected = pendingAny && mine.awaiting === 'expected';
  const pendingStk = pendingAny && mine.source === 'stk';
  const pendingVerify = pendingAny && mine.awaiting === 'verify';
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
  const startStk = () => call(async () => {
    await stopWatch();
    setFound(null);
    setQrCode(null);
    setIntent((await api<{ data: any }>('/payments/mpesa/stk', { body: { clientRequestId: newRequestId(), amountCents: amount, phone, tillId, configId } })).data);
  });
  const expect = (qr = qrEnabled) => call(async () => {
    await stopWatch();
    setFound(null);
    setQrCode(null);
    const data = (await api<{ data: any }>('/payments/mpesa/expect', { body: { clientRequestId: newRequestId(), amountCents: amount, tillId, configId, qr, skipReceipts: skipped.current.length ? skipped.current : undefined } })).data;
    setIntent(data);
    setQrCode(qrDataUri(data.qrCode));
  });
  const lookup = () => call(async () => {
    setFound(null);
    await stopWatch();
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
    watching.current = { amount: amount ?? 0, id: '', configId, qr: qrEnabled };
    setQrCode(null);
    setIntent(null);
  };
  /** Stops the background watch before the cashier takes another route (a prompt, or a code). */
  const stopWatch = async () => {
    watchGeneration.current += 1;
    const w = watching.current;
    // Keep the amount so the watch does not start itself again behind the route the cashier chose.
    watching.current = { amount: amount ?? 0, id: '', configId, qr: qrEnabled };
    const id = w?.id || (mine?.status === 'pending' ? mine.id : '');
    if (id) {
      await api(`/payments/intents/${id}/cancel`, { body: {} }).catch(() => undefined);
      setIntent(null);
    }
  };

  const selectAccount = async (nextId: string) => {
    watchGeneration.current += 1;
    const activeId = watching.current?.id;
    watching.current = null;
    if (activeId) await api(`/payments/intents/${activeId}/cancel`, { body: {} }).catch(() => undefined);
    setIntent(null);
    setQrCode(null);
    setError(null);
    setAccountId(nextId);
  };

  /**
   * Watching the till: as soon as M-Pesa is chosen the server starts waiting for a payment of this amount,
   * so the customer can simply pay the Till and the sale finishes by itself. Changing the amount starts again.
   */
  useEffect(() => {
    const shouldAutoWait = watchTill || qrEnabled;
    if (!shouldAutoWait || !account || !c2bOn || pending || mine?.status === 'succeeded' || !amount || amount % 100 !== 0) return;
    if (watching.current?.amount === amount && watching.current.configId === configId && watching.current.qr === qrEnabled) return;
    const started = watching.current;
    const generation = ++watchGeneration.current;
    watching.current = { amount, id: '', configId, qr: qrEnabled };
    void (async () => {
      // Drop the previous wait (the cart changed), then wait for the new amount.
      if (started?.id) await api(`/payments/intents/${started.id}/cancel`, { body: {} }).catch(() => undefined);
      try {
        const r = await api<{ data: any }>('/payments/mpesa/expect', { body: { clientRequestId: newRequestId(), amountCents: amount, tillId, configId, qr: qrEnabled, skipReceipts: skipped.current.length ? skipped.current : undefined } });
        if (generation !== watchGeneration.current) {
          await api(`/payments/intents/${r.data.id}/cancel`, { body: {} }).catch(() => undefined);
          return;
        }
        watching.current = { amount, id: r.data.id, configId, qr: qrEnabled };
        setIntent(r.data);
        setQrCode(qrDataUri(r.data.qrCode));
      } catch {
        // No M-Pesa for this till, or it is offline: the cashier can still prompt or type the code.
        if (generation === watchGeneration.current) watching.current = null;
      }
    })();
  }, [watchTill, c2bOn, qrEnabled, account?.id, accounts.length, amount, tillId, configId, pending, mine?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const field = 'h-12 text-base';

  useEffect(() => { setQrCode(null); }, [amount, account?.id]);

  return (
    <div className="mpesa-panel-container overflow-hidden rounded-xl border border-ink-200 bg-white dark:border-ink-700 dark:bg-ink-900">
      <div className="space-y-4 p-4">
        {!found && !askConfirm && mine?.status !== 'succeeded' && <>
        {accounts.length > 1 && (!pendingAny || autoWatch) && (
          <Field label="M-Pesa account" hint="Which Paybill or Till the money goes to">
            <Select value={account?.id ?? ''} onChange={(e) => { void selectAccount(e.target.value); }}
              options={accounts.map((a) => ({ value: a.id, label: `${a.name} - ${a.payTo.type === 'till' ? 'Till' : 'Paybill'} ${a.payTo.number}${a.environment === 'sandbox' ? ' (test)' : ''}` }))} />
          </Field>
        )}

        <div className="mpesa-options-grid">
        <div className="mpesa-options-primary">
        <section className="mpesa-prompt space-y-3 rounded-lg border border-ink-200 p-3 dark:border-ink-700" aria-label="Send M-Pesa prompt">
          <div>
            <h3 className="font-semibold text-ink-900 dark:text-white">Send prompt</h3>
            <p className="text-xs text-ink-500">Ask the customer to approve the payment on their phone.</p>
          </div>
          {pendingStk && (
            <div>
              <MpesaWaiting title="Waiting for the customer's PIN"><b className="tabular-nums">{money(mine.amountCents)}</b>{mine.phone ? <> - {String(mine.phone).replace(/^254/, '0').replace(/(\d{4})\d{3}(\d{3})/, '$1***$2')}</> : null}</MpesaWaiting>
              <div className="mt-2 flex justify-center gap-1">
                <Button size="sm" variant="ghost" onClick={async () => setIntent((await api<{ data: any }>(`/payments/intents/${mine.id}/query`, { body: {} })).data)}>Check status</Button>
                <Button size="sm" variant="ghost" onClick={cancel}>Cancel prompt</Button>
              </div>
            </div>
          )}
          {!pendingStk && account && !account.stk && (
            <p className="text-xs text-ink-500">Phone prompts are not configured for {account.name}. You can still use Paybill/Till or search by M-Pesa code.</p>
          )}
          {!pendingStk && (
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              <Input className={cx(field, 'min-w-0 w-full')} placeholder="Customer phone, e.g. 0712 345 678" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" aria-label="Customer phone"
                onKeyDown={(e) => { if (e.key === 'Enter' && phone && amount && whole && account?.stk) startStk(); }} />
              <Button className="h-12 px-3 sm:px-4" onClick={startStk} loading={busy} disabled={!account?.stk || !phone || !amount || !whole}><Icon name="phone" className="h-4 w-4" />Send prompt</Button>
            </div>
          )}
        </section>

        <section className="mpesa-paybill space-y-3 rounded-lg border border-ink-200 p-3 dark:border-ink-700" aria-label="Customer pays Paybill or Till">
          <div>
            <h3 className="font-semibold text-ink-900 dark:text-white">Customer pays Paybill/Till</h3>
            <p className="text-xs text-ink-500">Show the payment details or a dynamic QR code. The sale updates when M-Pesa confirms payment.</p>
          </div>
          {pendingExpected ? (
            <div className="space-y-3" data-testid="mpesa-pay-to">
              <div className="grid min-w-0 grid-cols-2 gap-2 rounded-lg bg-emerald-50 p-3 text-emerald-950 dark:bg-emerald-900/30 dark:text-emerald-100">
                <div className="min-w-0 rounded-md bg-white/60 p-2 dark:bg-black/10"><div className="text-[11px] uppercase leading-tight opacity-70">{mine.payToType === 'till' ? 'Buy Goods till' : 'Paybill'}</div><div className="break-words text-lg font-semibold tabular-nums">{mine.shortCode}</div></div>
                {mine.accountReference ? <div className="min-w-0 rounded-md bg-white/60 p-2 dark:bg-black/10"><div className="text-[11px] uppercase leading-tight opacity-70">{mine.payToType === 'till' ? 'Reference' : 'Account'}</div><div className="break-words text-lg font-semibold tracking-wide">{mine.accountReference}</div></div> : null}
                <div className="min-w-0 rounded-md bg-white/60 p-2 dark:bg-black/10"><div className="text-[11px] uppercase leading-tight opacity-70">Amount</div><div className="break-words text-lg font-semibold tabular-nums">{money(mine.amountCents)}</div></div>
              </div>
              <div className="mpesa-payment-status">
                <div className="space-y-2">
                  <MpesaWaiting compact title="Waiting for payment" />
                  <div className="flex justify-center"><Button size="sm" variant="ghost" onClick={cancel}>Cancel Paybill/Till wait</Button></div>
                </div>
                {qrCode && <div className="flex flex-col items-center justify-center gap-1 rounded-lg border border-ink-200 p-2 text-center dark:border-ink-700">
                  <img src={qrCode} alt="Dynamic M-Pesa payment QR code" className="h-36 w-36 max-w-full object-contain" />
                  <span className="text-[11px] leading-tight text-ink-600 dark:text-ink-300">Scan with M-Pesa or My Safaricom</span>
                </div>}
              </div>
              {!qrCode && account?.qr && <Button className="w-full" variant="secondary" onClick={() => expect(true)} loading={busy}><Icon name="barcode" className="h-4 w-4" />Generate QR for this payment</Button>}
            </div>
          ) : (
            <Button className="h-12 w-full" variant="secondary" onClick={() => expect()} loading={busy} disabled={!c2bOn || !amount || !whole}><Icon name="store" className="h-4 w-4" />Show payment details{qrEnabled ? ' and QR' : ''}{amount ? ` for ${money(amount)}` : ''}</Button>
          )}
          {!c2bOn && <p className="text-xs text-ink-500">Paybill/Till payments are not configured for this account.</p>}
          {pendingAny && !pendingExpected && <p className="text-xs text-ink-500">Starting Paybill/Till details here will replace the active M-Pesa request.</p>}
        </section>

        <section className="mpesa-code-search space-y-3 rounded-lg border border-ink-200 p-3 dark:border-ink-700" aria-label="Search M-Pesa code">
          <div>
            <h3 className="font-semibold text-ink-900 dark:text-white">Search M-Pesa code</h3>
            <p className="text-xs text-ink-500">Enter the receipt code from the customer's M-Pesa message to find the payment.</p>
          </div>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
            <Input className={cx(field, 'min-w-0 w-full font-mono uppercase tracking-widest')} placeholder="e.g. SJK3AB12CD" value={code} maxLength={12} aria-label="M-Pesa code"
              onChange={(e) => { setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '')); setFound(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && code.length >= 8) lookup(); }} />
            <Button className="h-12 px-3 sm:px-4" onClick={lookup} loading={busy} disabled={code.length < 8}><Icon name="search" className="h-4 w-4" />Find payment</Button>
          </div>
          {pendingVerify && <div><MpesaWaiting compact title={<>Checking <span className="font-mono">{mine.accountReference}</span></>} /><div className="flex justify-center"><Button size="sm" variant="ghost" onClick={cancel}>Cancel code search</Button></div></div>}
          {pendingAny && !pendingVerify && <p className="text-xs text-ink-500">Searching by code will replace the active M-Pesa request.</p>}
        </section>
        </div>
        </div>
        </>}

        {found && (
          <div className="mx-auto w-full max-w-2xl rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-100" data-testid="mpesa-found">
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

        {askConfirm && (
          <div className="mx-auto w-full max-w-2xl space-y-3" data-testid="mpesa-confirm">
            <PaySuccess title="M-Pesa payment found" amountCents={mine.paidAmountCents ?? mine.amountCents} logo={<MpesaMark className="h-8" />}>
              {mpesaPayer(mine) ? <b>{mpesaPayer(mine)}</b> : 'M-Pesa customer'}{mine.receiptNumber ? <> · <span className="font-mono">{mine.receiptNumber}</span></> : null}
              {mine.transactionDate || mine.completedAt ? <div className="text-xs">Paid {dateTime(mine.transactionDate ?? mine.completedAt)}</div> : null}
            </PaySuccess>
            <p className="text-center text-sm text-ink-600 dark:text-ink-300">Is this the customer’s payment?</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <Button variant="secondary" className="h-12" loading={busy} onClick={notMine}>Not this payment</Button>
              <Button className="h-12" autoFocus onClick={() => onConfirm?.(mine)}><Icon name="check" className="h-4 w-4" />Continue<kbd className="ml-2 rounded border border-white/40 px-1.5 py-0.5 text-[10px] font-semibold">Enter</kbd></Button>
            </div>
          </div>
        )}
        {mine && mine.status === 'succeeded' && !askConfirm && <MpesaPaid intent={mine} />}
        {mine && ['failed', 'cancelled', 'expired'].includes(mine.status) && <ErrorBox error={`M-Pesa ${mine.status}: ${mine.resultDesc ?? ''}. Nothing was taken; try again or use another method.`} />}
        {!found && !askConfirm && mine?.status !== 'succeeded' && amount !== null && !whole && <p className="text-xs text-amber-600">M-Pesa accepts whole shillings only.</p>}
        <ErrorBox error={error} />
      </div>
    </div>
  );
}

/** The confirmation the cashier sees: amount, who paid (name and part of the number, as M-Pesa sent them), receipt. */
export function MpesaPaid({ intent }: { intent: { paidAmountCents?: number; amountCents: number; receiptNumber?: string; payerName?: string; phone?: string } }) {
  const who = mpesaPayer(intent);
  return (
    <PaySuccess testId="mpesa-paid" title="Paid with M-Pesa" amountCents={intent.paidAmountCents ?? intent.amountCents} logo={<MpesaMark className="h-8" />}
      label={`M-Pesa payment received: ${money(intent.paidAmountCents ?? intent.amountCents)}`}>
      {who ? <b>{who}</b> : 'M-Pesa customer'}{intent.receiptNumber ? <> · <span className="font-mono">{intent.receiptNumber}</span></> : null}
    </PaySuccess>
  );
}
