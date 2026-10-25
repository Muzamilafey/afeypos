import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useLocations } from '../lib/hooks';
import { dateTime, money } from '../lib/format';
import { getWorkstation } from '../lib/workstation';
import { useRealtime } from '../lib/realtime';
import { DataTable } from '../components/DataTable';
import { Badge, Button, Card, Checkbox, ErrorBox, Field, Input, Loading, Modal, MoneyInput, PageHeader, Select, Stat, Tabs, useConfirm, useToast } from '../components/ui';
import { Icon } from '../components/icons';

const LABEL: Record<string, string> = { pending_payment: 'Awaiting M-Pesa', placed: 'New', accepted: 'Accepted', picking: 'Packing', ready: 'Ready for pickup', out_for_delivery: 'Out for delivery', completed: 'Completed', cancelled: 'Cancelled' };
const TONE: Record<string, 'blue' | 'amber' | 'green' | 'red' | 'gray'> = { pending_payment: 'amber', placed: 'blue', accepted: 'blue', picking: 'amber', ready: 'green', out_for_delivery: 'green', completed: 'gray', cancelled: 'red' };
const PAY: Record<string, string> = { unpaid: 'to collect', pending: 'M-Pesa pending', paid: 'paid', failed: 'payment failed', refund_due: 'refund due', refunded: 'refunded' };

export function OrderStatus({ status }: { status: string }) {
  return <Badge tone={TONE[status] ?? 'gray'}>{LABEL[status] ?? status}</Badge>;
}

export function OnlineOrdersPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState('open');
  const [q, setQ] = useState('');
  const list = useQuery({ queryKey: ['online-orders', tab, q], queryFn: () => api<{ data: any[] }>('/online-orders', { query: { open: tab === 'open' ? true : undefined, status: tab !== 'open' && tab !== 'all' ? tab : undefined, q: q || undefined, limit: 100 } }).then((r) => r.data), refetchInterval: 30_000 });
  const [open, setOpen] = useState<string | null>(null);
  useRealtime('online-order.placed', (o) => { toast.success(`New online order ${o.number}: ${money(o.totalCents)}`); qc.invalidateQueries({ queryKey: ['online-orders'] }); }, []);
  const rows = list.data ?? [];
  return (
    <div>
      <PageHeader title="Online orders" subtitle="Orders from the shop website: accept, pack, hand over and complete them as sales" />
      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="New" value={String(rows.filter((r) => r.status === 'placed').length)} tone={rows.some((r) => r.status === 'placed') ? 'red' : undefined} />
        <Stat label="Being packed" value={String(rows.filter((r) => ['accepted', 'picking'].includes(r.status)).length)} />
        <Stat label="Ready / on the way" value={String(rows.filter((r) => ['ready', 'out_for_delivery'].includes(r.status)).length)} />
        <Stat label="Value" value={money(rows.reduce((s, r) => s + (r.totalCents ?? 0), 0))} />
      </div>
      <Tabs tabs={[{ key: 'open', label: 'Open' }, { key: 'completed', label: 'Completed' }, { key: 'cancelled', label: 'Cancelled' }, { key: 'all', label: 'All' }]} value={tab} onChange={setTab} />
      <Input className="mb-3 max-w-xs" placeholder="Order number, name or phone" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="card"><DataTable rows={rows} loading={list.isLoading} empty="No orders" onRowClick={(r: any) => setOpen(r._id)} columns={[
        { key: 'n', header: 'Order', render: (r: any) => <div><div className="font-medium">{r.number}</div><div className="text-xs text-ink-500">{dateTime(r.createdAt)}</div></div> },
        { key: 'c', header: 'Customer', render: (r: any) => <div><div>{r.customer?.name}</div><div className="text-xs text-ink-500">{r.customer?.phone}</div></div> },
        { key: 'f', header: 'How', render: (r: any) => (r.fulfilment === 'delivery' ? `Delivery${r.area ? ` · ${r.area}` : ''}` : 'Pickup') },
        { key: 'i', header: 'Items', className: 'num', render: (r: any) => r.lines.reduce((s: number, l: any) => s + l.qty, 0) },
        { key: 't', header: 'Total', className: 'num', render: (r: any) => money(r.totalCents) },
        { key: 'p', header: 'Payment', render: (r: any) => <Badge tone={r.payment?.status === 'paid' ? 'green' : r.payment?.status === 'refund_due' ? 'red' : 'gray'}>{r.payment?.method === 'mpesa' ? 'M-Pesa' : 'On delivery'} · {PAY[r.payment?.status] ?? r.payment?.status}</Badge> },
        { key: 's', header: 'Status', render: (r: any) => <OrderStatus status={r.status} /> },
      ]} /></div>
      {open && <OrderModal id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function printPickList(o: any) {
  const w = window.open('', '_blank', 'width=420,height=640');
  if (!w) return;
  const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(o.number)}</title><style>body{font:13px/1.4 system-ui;margin:12px}h1{font-size:18px;margin:0}td{padding:4px 2px;border-bottom:1px solid #ddd}.box{width:14px;height:14px;border:1.5px solid #000;display:inline-block}</style></head><body>
  <h1>${esc(o.number)} · ${o.fulfilment === 'delivery' ? 'DELIVERY' : 'PICKUP'}</h1><p>${esc(o.customer?.name)} · ${esc(o.customer?.phone)}<br>${esc(o.address ?? '')}${o.area ? `, ${esc(o.area)}` : ''}${o.notes ? `<br><em>${esc(o.notes)}</em>` : ''}</p>
  <table style="width:100%;border-collapse:collapse">${o.lines.map((l: any) => `<tr><td><span class="box"></span></td><td><strong>${esc(l.qty)}</strong> × ${esc(l.name)}</td><td style="text-align:right">${esc(l.sku)}</td></tr>`).join('')}</table>
  <p>Total ${esc((o.totalCents / 100).toFixed(2))} · ${o.payment?.status === 'paid' ? 'PAID' : 'COLLECT ON ' + (o.fulfilment === 'delivery' ? 'DELIVERY' : 'PICKUP')}</p><script>window.onload=()=>window.print()</script></body></html>`);
  w.document.close();
}

function OrderModal({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const locs = useLocations();
  const q = useQuery({ queryKey: ['online-order', id], queryFn: () => api<{ data: any }>(`/online-orders/${id}`).then((r) => r.data) });
  const [completing, setCompleting] = useState(false);
  const [tillId, setTillId] = useState(getWorkstation().tillId ?? '');
  const [pay, setPay] = useState<{ method: string; amountCents: number | null; reference: string }>({ method: 'cash', amountCents: null, reference: '' });
  const [error, setError] = useState<unknown>(null);
  useEffect(() => setPay((p) => ({ ...p, amountCents: q.data?.totalCents ?? null })), [q.data?.totalCents]);
  if (!q.data) return <Modal open onClose={onClose} title="Order"><Loading /></Modal>;
  const o = q.data;
  const refresh = () => { qc.invalidateQueries({ queryKey: ['online-orders'] }); qc.invalidateQueries({ queryKey: ['online-order', id] }); };
  const move = (status: string, note?: string) => api(`/online-orders/${id}/status`, { body: { status, note } }).then(() => { toast.success(LABEL[status]); refresh(); }).catch(toast.error);
  const cancel = async () => {
    const reason = window.prompt('Why is the order cancelled? (sent to the customer)');
    if (reason === null) return;
    if (await confirm({ title: `Cancel ${o.number}?`, message: o.payment?.status === 'paid' ? 'The stock is released and an M-Pesa refund is prepared for approval.' : 'The stock is released.', confirmLabel: 'Cancel order', danger: true })) move('cancelled', reason || undefined);
  };
  const complete = () => api<{ data: any; sale: any }>(`/online-orders/${id}/complete`, { body: { tillId, payments: o.payment?.status === 'paid' ? [] : [{ method: pay.method, amountCents: pay.amountCents ?? 0, reference: pay.reference || undefined }] } })
    .then((r) => { toast.success(`Completed: sale ${r.sale.number}`); setCompleting(false); refresh(); })
    .catch(setError);
  const actions: { label: string; status: string; show: boolean }[] = [
    { label: 'Accept', status: 'accepted', show: o.status === 'placed' },
    { label: 'Start packing', status: 'picking', show: o.status === 'accepted' },
    { label: 'Ready for pickup', status: 'ready', show: ['accepted', 'picking'].includes(o.status) && o.fulfilment === 'pickup' },
    { label: 'Out for delivery', status: 'out_for_delivery', show: ['accepted', 'picking'].includes(o.status) && o.fulfilment === 'delivery' },
  ];
  return (
    <Modal open onClose={onClose} title={`${o.number} · ${LABEL[o.status]}`} size="lg" footer={<>
      <Button variant="secondary" onClick={() => printPickList(o)}><Icon name="printer" className="h-4 w-4" />Pick list</Button>
      {!['completed', 'cancelled'].includes(o.status) && <Button variant="ghost" onClick={cancel}>Cancel order</Button>}
      {actions.filter((a) => a.show).map((a) => <Button key={a.status} variant="secondary" onClick={() => move(a.status)}>{a.label}</Button>)}
      {['placed', 'accepted', 'picking', 'ready', 'out_for_delivery'].includes(o.status) && <Button onClick={() => setCompleting(true)}>Complete</Button>}
    </>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Card title="Customer">
          <p className="font-medium">{o.customer?.name}</p>
          <p className="text-sm"><a className="underline" href={`tel:${o.customer?.phone}`}>{o.customer?.phone}</a>{o.customer?.email ? ` · ${o.customer.email}` : ''}</p>
          <p className="mt-2 text-sm">{o.fulfilment === 'delivery' ? <>Deliver to <strong>{o.address}</strong>{o.area ? `, ${o.area}` : ''}</> : 'Customer collects at the shop'}</p>
          {o.notes && <p className="mt-1 text-sm italic text-ink-600">“{o.notes}”</p>}
        </Card>
        <Card title="Payment">
          <p className="text-sm">{o.payment?.method === 'mpesa' ? 'M-Pesa' : o.fulfilment === 'delivery' ? 'Pay on delivery' : 'Pay at pickup'}: <strong>{PAY[o.payment?.status] ?? o.payment?.status}</strong></p>
          {o.payment?.receiptNumber && <p className="text-sm">Receipt {o.payment.receiptNumber}</p>}
          {o.saleNumber && <p className="mt-2 text-sm">Sale {o.saleNumber}</p>}
          {o.payment?.status === 'refund_due' && <p className="mt-2 text-sm text-red-600">Refund prepared under M-Pesa payouts; approve and send it.</p>}
        </Card>
      </div>
      <table className="mt-4 min-w-full text-sm"><thead><tr><th className="th">Item</th><th className="th num">Qty</th><th className="th num">Price</th><th className="th num">Total</th></tr></thead>
        <tbody>{o.lines.map((l: any) => <tr key={String(l.productId)}><td className="td">{l.name}<div className="text-xs text-ink-500">{l.sku}</div></td><td className="td num">{l.qty}</td><td className="td num">{money(l.unitPriceCents)}</td><td className="td num">{money(l.totalCents)}</td></tr>)}
          {o.deliveryFeeCents > 0 && <tr><td className="td" colSpan={3}>Delivery</td><td className="td num">{money(o.deliveryFeeCents)}</td></tr>}
          <tr><td className="td font-semibold" colSpan={3}>Total</td><td className="td num font-semibold">{money(o.totalCents)}</td></tr></tbody></table>
      <ul className="mt-3 text-xs text-ink-500">{o.history.map((h: any, i: number) => <li key={i}>{dateTime(h.at)} · {LABEL[h.status] ?? h.status}{h.note ? `: ${h.note}` : ''}</li>)}</ul>
      {completing && (
        <Modal open onClose={() => setCompleting(false)} title="Complete order" size="sm" footer={<Button disabled={!tillId} onClick={complete}>Complete sale</Button>}>
          <div className="space-y-3">
            <Field label="Till"><Select value={tillId} onChange={(e) => setTillId(e.target.value)} placeholder="Select till" options={(locs.data?.tills ?? []).map((t) => ({ value: t._id, label: t.name }))} /></Field>
            {o.payment?.status === 'paid' ? <p className="text-sm text-emerald-700">Paid by M-Pesa: the payment is used for the sale.</p> : <>
              <Field label="Collected by"><Select value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })} options={[{ value: 'cash', label: 'Cash' }, { value: 'mpesa', label: 'M-Pesa (code)' }, { value: 'card', label: 'Card' }, { value: 'bank', label: 'Bank' }]} /></Field>
              <Field label="Amount"><MoneyInput value={pay.amountCents} onChange={(v) => setPay({ ...pay, amountCents: v })} /></Field>
              {pay.method !== 'cash' && <Field label="Reference"><Input value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value.toUpperCase() })} /></Field>}
            </>}
            <p className="text-xs text-ink-500">The order becomes a sale on this till: stock, receipt, eTIMS and accounts follow as for any sale. Prices are those the customer was given.</p>
            <ErrorBox error={error} />
          </div>
        </Modal>
      )}
    </Modal>
  );
}

/** Settings → Online shop */
export function StoreSettingsPage() {
  const toast = useToast();
  const locs = useLocations();
  const q = useQuery({ queryKey: ['business'], queryFn: () => api<{ data: any }>('/settings/business').then((r) => r.data) });
  const [s, setS] = useState<any>(null);
  useEffect(() => { if (q.data && !s) setS({ deliveryAreas: [], pickup: true, delivery: true, payOnDelivery: true, mpesa: true, ...(q.data.settings?.store ?? {}) }); }, [q.data, s]);
  if (!s) return <Loading />;
  const set = (k: string, v: unknown) => setS({ ...s, [k]: v });
  const save = () => api('/settings/business', { method: 'PATCH', body: { settings: { store: {
    enabled: Boolean(s.enabled), branchId: s.branchId || null, warehouseId: s.warehouseId || null, pickup: s.pickup !== false, delivery: s.delivery !== false,
    deliveryAreas: (s.deliveryAreas ?? []).filter((a: any) => a.name), deliveryFeeCents: s.deliveryFeeCents ?? 0, freeDeliveryAboveCents: s.freeDeliveryAboveCents ?? 0, minOrderCents: s.minOrderCents ?? 0,
    payOnDelivery: s.payOnDelivery !== false, mpesa: s.mpesa !== false, notifyPhone: s.notifyPhone ?? '', contactPhone: s.contactPhone ?? '', announcement: s.announcement ?? '', hours: s.hours ?? '',
  } } } }).then(() => toast.success('Online shop saved')).catch(toast.error);
  return (
    <div className="max-w-4xl space-y-4">
      <PageHeader title="Online shop" subtitle="The separate shopping website for your customers" actions={<Button onClick={save}>Save</Button>} />
      <Card>
        <Checkbox label="The online shop is open" checked={Boolean(s.enabled)} onChange={(v) => set('enabled', v)} />
        <p className="mt-2 text-sm text-ink-500">Tick <strong>Sell on the online shop</strong> on each product to list it. Publish the shop website (see docs/ONLINE-SHOP.md) on its own address, for example <code>shop.yoursupermarket.co.ke</code>.</p>
      </Card>
      <Card title="Fulfilment">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Branch that fulfils orders"><Select value={s.branchId ?? ''} onChange={(e) => set('branchId', e.target.value)} placeholder="Main branch" options={(locs.data?.branches ?? []).map((b) => ({ value: b._id, label: b.name }))} /></Field>
          <Field label="Stock taken from"><Select value={s.warehouseId ?? ''} onChange={(e) => set('warehouseId', e.target.value)} placeholder="The branch's main warehouse" options={(locs.data?.warehouses ?? []).filter((w) => !s.branchId || w.branchId === s.branchId).map((w) => ({ value: w._id, label: w.name }))} /></Field>
          <Checkbox label="Customers can pick up" checked={s.pickup !== false} onChange={(v) => set('pickup', v)} />
          <Checkbox label="We deliver" checked={s.delivery !== false} onChange={(v) => set('delivery', v)} />
          <Field label="Delivery fee (when no areas are listed)"><MoneyInput value={s.deliveryFeeCents ?? 0} onChange={(v) => set('deliveryFeeCents', v ?? 0)} /></Field>
          <Field label="Free delivery above" hint="0 = never free"><MoneyInput value={s.freeDeliveryAboveCents ?? 0} onChange={(v) => set('freeDeliveryAboveCents', v ?? 0)} /></Field>
          <Field label="Minimum order"><MoneyInput value={s.minOrderCents ?? 0} onChange={(v) => set('minOrderCents', v ?? 0)} /></Field>
        </div>
        <div className="mt-4"><div className="label">Delivery areas and fees</div>
          {(s.deliveryAreas ?? []).map((a: any, i: number) => (
            <div key={i} className="mb-2 flex gap-2">
              <Input className="w-56" placeholder="Area (e.g. Kilimani)" value={a.name} onChange={(e) => set('deliveryAreas', s.deliveryAreas.map((x: any, j: number) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <MoneyInput className="w-36" value={a.feeCents} onChange={(v) => set('deliveryAreas', s.deliveryAreas.map((x: any, j: number) => (j === i ? { ...x, feeCents: v ?? 0 } : x)))} />
              <Button size="sm" variant="ghost" aria-label="Remove area" onClick={() => set('deliveryAreas', s.deliveryAreas.filter((_: any, j: number) => j !== i))}><Icon name="x" className="h-4 w-4" /></Button>
            </div>
          ))}
          <Button size="sm" variant="secondary" onClick={() => set('deliveryAreas', [...(s.deliveryAreas ?? []), { name: '', feeCents: 0 }])}><Icon name="plus" className="h-4 w-4" />Add area</Button>
        </div>
      </Card>
      <Card title="Payment and contact">
        <div className="grid gap-3 sm:grid-cols-2">
          <Checkbox label="M-Pesa at checkout (STK prompt)" checked={s.mpesa !== false} onChange={(v) => set('mpesa', v)} />
          <Checkbox label="Pay on delivery / at pickup" checked={s.payOnDelivery !== false} onChange={(v) => set('payOnDelivery', v)} />
          <Field label="SMS new orders to"><Input value={s.notifyPhone ?? ''} placeholder="07XX XXX XXX" onChange={(e) => set('notifyPhone', e.target.value)} /></Field>
          <Field label="Customer care number"><Input value={s.contactPhone ?? ''} onChange={(e) => set('contactPhone', e.target.value)} /></Field>
          <Field label="Opening hours"><Input value={s.hours ?? ''} placeholder="Mon-Sun 7am-10pm" onChange={(e) => set('hours', e.target.value)} /></Field>
          <Field label="Banner message"><Input value={s.announcement ?? ''} placeholder="Free delivery this weekend!" onChange={(e) => set('announcement', e.target.value)} /></Field>
        </div>
      </Card>
    </div>
  );
}
