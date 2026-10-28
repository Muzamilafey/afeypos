import { useEffect, useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import type { PaymentChannel } from '@afeypos/shared';
import { api, newRequestId } from '../lib/api';
import { money } from '../lib/format';
import { Button, cx, ErrorBox, Field, Input, Select, Spinner, useToast } from './ui';

export interface GatewayOption {
  id: string;
  provider: string;
  name: string;
  label: string;
  flows: ('push' | 'link')[];
  channels: PaymentChannel[];
  currency: string;
  environment: 'sandbox' | 'production';
  devOnly: boolean;
}

export function QrCode({ text, size = 176 }: { text: string; size?: number }) {
  const src = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createDataURL(4, 8);
  }, [text]);
  return <img src={src} width={size} height={size} alt="Payment link QR code" className="rounded bg-white p-1" style={{ imageRendering: 'pixelated' }} />;
}

/**
 * Starts a gateway charge (phone prompt or hosted payment link) and shows its live status.
 * The parent owns the intent so the realtime/polling hooks can add the confirmed payment.
 */
export function GatewayPanel({ gateways, amount, tillId, customer, intent, setIntent }: {
  gateways: GatewayOption[];
  amount: number | null;
  tillId: string;
  customer?: { name?: string; phone?: string; email?: string; kind?: string } | null;
  intent: any;
  setIntent: (i: any) => void;
}) {
  const toast = useToast();
  const [gwId, setGwId] = useState(gateways[0]?.id);
  const gw = gateways.find((g) => g.id === gwId) ?? gateways[0];
  const [flow, setFlow] = useState<'push' | 'link'>(gw?.flows[0] ?? 'push');
  const [channel, setChannel] = useState('');
  const walkIn = !customer || customer.kind === 'walk_in';
  const [phone, setPhone] = useState(walkIn ? '' : (customer?.phone ?? ''));
  const [email, setEmail] = useState(walkIn ? '' : (customer?.email ?? ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (gw && !gw.flows.includes(flow)) setFlow(gw.flows[0]);
    setChannel((c) => (gw?.channels.some((x) => x.value === c) ? c : (gw?.channels[0]?.value ?? '')));
  }, [gw, flow]);

  if (!gw) return null;
  const currency = flow === 'push' ? (gw.channels.find((c) => c.value === channel)?.currency ?? gw.currency) : gw.currency;
  const wholeOnly = flow === 'push' && amount !== null && amount % 100 !== 0;
  const pending = intent?.status === 'pending' && intent.provider === gw.provider;

  const sendLink = async (id: string, to: string) => {
    setSending(true);
    try {
      await api(`/payments/intents/${id}/send-link`, { body: { phone: to } });
      toast.success(`Payment link sent to ${to}: the customer opens it and pays (M-Pesa prompt, Airtel Money or card)`);
    } catch (e) {
      setError(e);
    } finally {
      setSending(false);
    }
  };

  const start = async () => {
    setError(null);
    setBusy(true);
    try {
      const r = await api<{ data: any }>(`/payments/gateways/${gw.id}/charge`, {
        body: { clientRequestId: newRequestId(), amountCents: amount, flow, phone: phone || undefined, email: email || undefined, channel: flow === 'push' ? channel || undefined : undefined, tillId, customerName: walkIn ? undefined : customer?.name },
      });
      setIntent(r.data);
      // A payment link goes straight to the customer's phone when a number was entered.
      if (flow === 'link' && phone && r.data.checkoutUrl) await sendLink(r.data.id, phone);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-ink-200 p-3 dark:border-ink-700" data-testid="gateway-panel">
      {gateways.length > 1 && (
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Payment provider">
          {gateways.map((g) => (
            <Button key={g.id} size="sm" role="radio" aria-checked={g.id === gw.id} variant={g.id === gw.id ? 'primary' : 'secondary'} disabled={pending} onClick={() => setGwId(g.id)}>
              {g.label}{g.environment === 'sandbox' && <span className="ml-1 text-[10px] uppercase opacity-70">test</span>}
            </Button>
          ))}
        </div>
      )}
      {!pending ? (
        <>
          {gw.flows.length > 1 && (
            <div className="inline-flex rounded-lg bg-ink-100 p-1 text-sm dark:bg-ink-800" role="radiogroup" aria-label="How the customer pays">
              {gw.flows.map((f) => (
                <button key={f} type="button" role="radio" aria-checked={flow === f} onClick={() => setFlow(f)}
                  className={cx('rounded-md px-3 py-1 font-medium', flow === f ? 'bg-white shadow-sm dark:bg-ink-900' : 'text-ink-600 dark:text-ink-300')}>
                  {f === 'push' ? 'Prompt on phone' : 'Payment link / QR'}
                </button>
              ))}
            </div>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            {flow === 'push' && gw.channels.length > 0 && (
              <Field label="Network"><Select value={channel} onChange={(e) => setChannel(e.target.value)} options={gw.channels.map((c) => ({ value: c.value, label: c.label }))} /></Field>
            )}
            {flow === 'push' && <Field label="Customer phone"><Input placeholder="e.g. 0712345678" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" /></Field>}
            {flow === 'link' && <Field label="Customer phone (optional)" hint="The payment link is sent to this phone by SMS"><Input placeholder="e.g. 0712345678" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" /></Field>}
            {flow === 'link' && <Field label="Customer email (optional)"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>}
          </div>
          <Button onClick={start} loading={busy} disabled={!amount || (flow === 'push' && !phone) || wholeOnly}>
            {flow === 'push' ? `Send ${money(amount ?? 0)} request` : phone ? `Send payment link to ${phone}` : 'Create payment link'} · {gw.label}
          </Button>
          {wholeOnly && <p className="text-xs text-amber-600">Mobile money accepts whole amounts only.</p>}
          {currency !== gw.currency && <p className="text-xs text-ink-500">Charged in {currency}.</p>}
        </>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Spinner className="h-4 w-4" />
            {intent.checkoutUrl ? `Ask the customer to scan and pay ${money(intent.amountCents)}…` : `Waiting for the customer to approve on their phone…`}
            <Button size="sm" variant="ghost" onClick={async () => setIntent((await api<{ data: any }>(`/payments/intents/${intent.id}/query`, { body: {} })).data)}>Check status</Button>
            <Button size="sm" variant="ghost" onClick={async () => { await api(`/payments/intents/${intent.id}/cancel`, { body: {} }); setIntent(null); }}>Cancel</Button>
          </div>
          {intent.resultDesc && !intent.checkoutUrl && <p className="text-xs text-ink-500">{intent.resultDesc}</p>}
          {intent.checkoutUrl && (
            <div className="flex items-center gap-3">
              <QrCode text={intent.checkoutUrl} />
              <div className="min-w-0 space-y-2 text-xs">
                <a href={intent.checkoutUrl} target="_blank" rel="noreferrer" className="block break-all text-brand-700 underline dark:text-brand-200">{intent.checkoutUrl}</a>
                <Button size="sm" variant="secondary" onClick={() => navigator.clipboard?.writeText(intent.checkoutUrl).then(() => toast.success('Link copied'), () => toast.error('Copy failed'))}>Copy link</Button>
                <div className="flex gap-1">
                  <Input aria-label="Send the link to phone" className="py-1" placeholder="Customer phone" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" />
                  <Button size="sm" loading={sending} disabled={!phone} onClick={() => sendLink(intent.id, phone)}>Send to phone</Button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
      {intent && intent.provider === gw.provider && ['failed', 'cancelled', 'expired'].includes(intent.status) && (
        <ErrorBox error={`${gw.label} ${intent.status}: ${intent.resultDesc ?? ''}. Nothing was charged; try again or use another method.`} />
      )}
      <ErrorBox error={error} />
    </div>
  );
}
