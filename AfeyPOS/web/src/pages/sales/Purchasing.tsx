import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, newRequestId } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useList, useLocations } from '../../lib/hooks';
import { date, dateTime, money } from '../../lib/format';
import { DataTable } from '../../components/DataTable';
import { ProductPicker } from '../../components/ProductPicker';
import { EmailDocButton, PdfButton } from '../../components/DocumentActions';
import { Badge, Button, Checkbox, cx, ErrorBox, Field, Input, Loading, Modal, MoneyInput, PageHeader, Select, StatusBadge, Tabs, useConfirm, useToast } from '../../components/ui';
import { Icon } from '../../components/icons';

/**
 * Suppliers & purchasing: ask suppliers for quotations, compare them, order (purchase orders) and receive the
 * goods (goods received notes). Every document has a PDF and can be emailed with it attached.
 */

interface Line {
  productId: string; name: string; unitCode: string; units: { code: string; name: string }[]; qty: number; unitCostCents: number;
  batchNo?: string; expiryDate?: string; serials?: string; trackBatches?: boolean; trackSerials?: boolean; poLineId?: string; ordered?: number; received?: number;
}

type Tab = 'quotations' | 'orders' | 'receiving';
const PATHS: Record<Tab, string> = { quotations: '/purchasing/quotations', orders: '/purchasing', receiving: '/purchasing/receiving' };
const TITLES: Record<Tab, [string, string]> = {
  quotations: ['Supplier quotations', 'Ask suppliers for prices, compare their quotes and order from the best one'],
  orders: ['Purchase orders', 'Orders sent to suppliers and what has arrived'],
  receiving: ['Goods received', 'Deliveries received into stock (GRN) with the supplier invoice'],
};

function useSuppliers() {
  return useQuery({ queryKey: ['suppliers-all'], queryFn: () => api<{ data: any[] }>('/suppliers', { query: { limit: 200 } }).then((r) => r.data) });
}

const toLine = (p: any): Line => ({ productId: p._id, name: p.name, unitCode: p.units?.find((u: any) => u.isDefaultPurchase)?.code ?? p.baseUnit, units: p.units?.length ? p.units : [{ code: p.baseUnit, name: p.baseUnit }], qty: 1, unitCostCents: p.costCents ?? 0, trackBatches: p.trackBatches, trackSerials: p.trackSerials });

function LineGrid({ lines, setLines, mode }: { lines: Line[]; setLines: (l: Line[]) => void; mode: 'po' | 'grn' | 'rfq' }) {
  const upd = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const priced = mode !== 'rfq';
  return (
    <div className="space-y-2">
      <ProductPicker onPick={(p) => setLines([...lines, toLine(p)])} />
      {lines.length > 0 && (
        <div className={cx('hidden gap-2 px-2 text-[11px] font-semibold uppercase text-ink-500 sm:grid', priced ? 'grid-cols-6' : 'grid-cols-4')}>
          <span className="col-span-2">Item</span><span>Unit</span><span>Quantity</span>{priced && <><span>Unit cost</span><span className="text-right">Amount</span></>}
        </div>
      )}
      {lines.map((l, i) => (
        <div key={i} className={cx('grid grid-cols-2 gap-2 rounded-sm border border-ink-100 p-2 dark:border-ink-800', priced ? 'sm:grid-cols-6' : 'sm:grid-cols-4')}>
          <div className="col-span-2 text-sm font-medium">
            {l.name}
            {l.ordered !== undefined && <div className="text-xs font-normal text-ink-500">Ordered {l.ordered} · received {l.received ?? 0} · outstanding {Math.max(0, l.ordered - (l.received ?? 0))}</div>}
          </div>
          <Select aria-label="Unit" value={l.unitCode} onChange={(e) => upd(i, { unitCode: e.target.value })} options={l.units.map((u) => ({ value: u.code, label: u.name }))} />
          <div className="flex items-center gap-1">
            <Input type="number" step="any" min="0" value={l.qty} onChange={(e) => upd(i, { qty: Number(e.target.value) })} aria-label={`Quantity of ${l.name}`} />
            {!priced && <Button variant="ghost" aria-label={`Remove ${l.name}`} onClick={() => setLines(lines.filter((_, j) => j !== i))}><Icon name="x" className="h-4 w-4" /></Button>}
          </div>
          {priced && <>
            <MoneyInput value={l.unitCostCents} onChange={(v) => upd(i, { unitCostCents: v ?? 0 })} aria-label={`Unit cost of ${l.name}`} />
            <div className="flex items-center justify-end gap-2 text-sm tabular-nums">{money(Math.round(l.qty * l.unitCostCents))}<Button variant="ghost" aria-label={`Remove ${l.name}`} onClick={() => setLines(lines.filter((_, j) => j !== i))}><Icon name="x" className="h-4 w-4" /></Button></div>
          </>}
          {mode === 'grn' && l.trackBatches && <><Input placeholder="Batch no." value={l.batchNo ?? ''} onChange={(e) => upd(i, { batchNo: e.target.value })} /><Input type="date" value={l.expiryDate ?? ''} onChange={(e) => upd(i, { expiryDate: e.target.value })} aria-label="Expiry" /></>}
          {mode === 'grn' && l.trackSerials && <Input className="col-span-2" placeholder="Serial numbers (comma separated)" value={l.serials ?? ''} onChange={(e) => upd(i, { serials: e.target.value })} />}
        </div>
      ))}
      {priced && <div className="text-right font-semibold">Total {money(lines.reduce((a, l) => a + Math.round(l.qty * l.unitCostCents), 0))}</div>}
    </div>
  );
}

// ---------------- quotations ----------------

function RequestQuoteModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (groupId: string) => void }) {
  const toast = useToast();
  const locs = useLocations();
  const suppliers = useSuppliers();
  const [picked, setPicked] = useState<string[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [respondBy, setRespondBy] = useState('');
  const [notes, setNotes] = useState('');
  const [message, setMessage] = useState('');
  const [send, setSend] = useState(true);
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const wh = warehouseId || locs.data?.warehouses.find((w) => w.isDefault)?._id || locs.data?.warehouses[0]?._id;
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ data: any[]; groupId: string; emails: Record<string, any> }>('/supplier-quotations', { body: { supplierIds: picked, warehouseId: wh, respondBy: respondBy || undefined, notes: notes || undefined, message: message || undefined, send, lines: lines.map((l) => ({ productId: l.productId, unitCode: l.unitCode, qty: l.qty })) } });
      const failed = Object.values(r.emails ?? {}).filter((e: any) => e && !e.queued);
      if (failed.length) toast.info(`Saved. Not emailed to ${failed.length} supplier(s): ${failed.map((f: any) => f.reason).join('; ')}`);
      else toast.success(send ? `Request emailed to ${picked.length} supplier(s)` : 'Request saved');
      setPicked([]); setLines([]); setNotes(''); setMessage('');
      onDone(r.groupId);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const list = suppliers.data ?? [];
  return (
    <Modal open={open} onClose={onClose} title="Request quotation" size="xl" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!picked.length || !lines.length} onClick={submit}>{send ? 'Save and email' : 'Save request'}</Button></>}>
      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        <div>
          <div className="label">Suppliers to ask ({picked.length})</div>
          <div className="max-h-72 space-y-1 overflow-y-auto rounded-sm border border-ink-100 p-2 dark:border-ink-800">
            {list.map((s) => (
              <label key={s._id} className="flex cursor-pointer items-start gap-2 rounded-sm px-1.5 py-1 text-sm hover:bg-ink-50 dark:hover:bg-ink-800">
                <input type="checkbox" className="mt-0.5" checked={picked.includes(s._id)} onChange={(e) => setPicked(e.target.checked ? [...picked, s._id] : picked.filter((x) => x !== s._id))} />
                <span>{s.name}<span className="block text-xs text-ink-500">{s.email || 'no email: print or send yourself'}</span></span>
              </label>
            ))}
            {!list.length && <p className="text-sm text-ink-500">Add suppliers first.</p>}
          </div>
          <div className="mt-3 space-y-3">
            <Field label="Deliver to"><Select value={wh ?? ''} onChange={(e) => setWarehouseId(e.target.value)} options={(locs.data?.warehouses ?? []).map((w) => ({ value: w._id, label: w.name }))} /></Field>
            <Field label="Reply by"><Input type="date" value={respondBy} onChange={(e) => setRespondBy(e.target.value)} /></Field>
          </div>
        </div>
        <div className="space-y-3">
          <LineGrid lines={lines} setLines={setLines} mode="rfq" />
          <Field label="Notes on the request (printed)"><textarea className="input" rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Delivery in the morning, pallets welcome" /></Field>
          <Checkbox label="Email the request (PDF) to each supplier now" checked={send} onChange={setSend} />
          {send && <Field label="Email message (optional)"><textarea className="input" rows={2} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} /></Field>}
          <ErrorBox error={error} />
        </div>
      </div>
    </Modal>
  );
}

function QuoteModal({ id, onClose, onCompare, onOrdered }: { id: string; onClose: () => void; onCompare: (groupId: string) => void; onOrdered: (poId: string) => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['supplier-quotation', id], queryFn: () => api<{ data: any }>(`/supplier-quotations/${id}`).then((r) => r.data) });
  const [prices, setPrices] = useState<Record<string, { unitCostCents: number | null; available: boolean; notes?: string }>>({});
  const [meta, setMeta] = useState<{ supplierRef?: string; deliveryDays?: string; validUntil?: string; supplierNotes?: string }>({});
  const [error, setError] = useState<unknown>(null);
  if (!q.data) return <Modal open onClose={onClose} title="Quotation">{q.error ? <ErrorBox error={q.error} /> : <Loading />}</Modal>;
  const d = q.data;
  const open = ['draft', 'sent', 'quoted'].includes(d.status);
  const editable = open && can('purchasing.manage');
  const price = (l: any) => prices[l._id] ?? { unitCostCents: l.unitCostCents ?? null, available: l.available !== false, notes: l.notes };
  const refresh = () => { qc.invalidateQueries({ queryKey: ['supplier-quotation', id] }); qc.invalidateQueries({ queryKey: ['supplier-quotations'] }); qc.invalidateQueries({ queryKey: ['pos'] }); };
  const act = async (fn: () => Promise<unknown>, ok: string) => { setError(null); try { await fn(); toast.success(ok); refresh(); setPrices({}); } catch (e) { setError(e); } };
  const total = d.lines.reduce((a: number, l: any) => { const p = price(l); return a + (p.available && p.unitCostCents != null ? Math.round(l.qty * p.unitCostCents) : 0); }, 0);
  const saveQuote = () => act(() => api(`/supplier-quotations/${id}/quote`, { method: 'PUT', body: {
    lines: d.lines.map((l: any) => ({ lineId: l._id, ...price(l) })), supplierRef: meta.supplierRef ?? d.supplierRef, deliveryDays: meta.deliveryDays !== undefined ? (meta.deliveryDays === '' ? undefined : Number(meta.deliveryDays)) : d.deliveryDays,
    validUntil: (meta.validUntil ?? d.validUntil?.slice(0, 10)) || undefined, supplierNotes: meta.supplierNotes ?? d.supplierNotes,
  } }), 'Prices saved');
  const accept = async () => {
    const sendOrder = await confirm({ title: 'Order from this supplier?', message: `A purchase order is created at the quoted prices (${money(d.totalCents)}). Other suppliers' quotes for this request are closed. Email the order to ${d.supplierId?.name} now?`, confirmLabel: 'Create and email order' });
    if (!sendOrder) return;
    await act(async () => {
      const r = await api<{ purchaseOrder: any; emailed: any }>(`/supplier-quotations/${id}/accept`, { body: { sendOrder: true } });
      if (r.emailed && !r.emailed.queued) toast.info(`Order ${r.purchaseOrder.number} created, not emailed: ${r.emailed.reason}`);
      onOrdered(r.purchaseOrder._id);
    }, 'Purchase order created');
  };
  return (
    <Modal open onClose={onClose} size="xl" title={`${d.status === 'quoted' || d.status === 'accepted' ? 'Quotation' : 'Request for quotation'} ${d.number}`} footer={<div className="flex w-full flex-wrap items-center gap-2">
      <PdfButton kind="supplier_quotation" id={id} size="md" />
      {can('purchasing.manage') && open && <EmailDocButton kind="supplier_quotation" id={id} defaultTo={d.supplierId?.email} what="Request for quotation" label={d.sentAt ? 'Email again' : 'Email'} size="md" onSent={refresh}
        send={(body) => api(`/supplier-quotations/${id}/send`, { body })} />}
      {d.groupSize !== 1 && <Button variant="secondary" onClick={() => onCompare(d.groupId)}><Icon name="layersStack" className="h-4 w-4" />Compare suppliers</Button>}
      <span className="flex-1" />
      {editable && <Button variant="ghost" onClick={async () => { if (await confirm({ title: 'Cancel this request?', message: 'It is closed and cannot be ordered from.', confirmLabel: 'Cancel request', danger: true })) act(() => api(`/supplier-quotations/${id}/cancel`, { body: {} }), 'Request cancelled'); }}>Cancel request</Button>}
      {editable && d.status === 'quoted' && <Button variant="secondary" onClick={() => act(() => api(`/supplier-quotations/${id}/reject`, { body: {} }), 'Quote rejected')}>Reject</Button>}
      {editable && <Button variant="secondary" onClick={saveQuote}>Save prices</Button>}
      {editable && d.status === 'quoted' && Object.keys(prices).length === 0 && <Button onClick={accept}><Icon name="check" className="h-4 w-4" />Accept and order</Button>}
      {d.purchaseOrder && <Button onClick={() => onOrdered(d.purchaseOrder._id)}>Purchase order {d.purchaseOrder.number}</Button>}
    </div>}>
      <div className="mb-3 grid gap-3 text-sm sm:grid-cols-4">
        <div><div className="label">Supplier</div>{d.supplierId?.name}<div className="text-xs text-ink-500">{d.supplierId?.email ?? 'no email'}{d.supplierId?.phone ? ` · ${d.supplierId.phone}` : ''}</div></div>
        <div><div className="label">Status</div><StatusBadge status={d.status} />{d.decisionNote && <div className="mt-1 text-xs text-ink-500">{d.decisionNote}</div>}</div>
        <div><div className="label">Requested</div>{date(d.createdAt)}{d.sentAt && <div className="text-xs text-ink-500">Sent {dateTime(d.sentAt)}</div>}</div>
        <div><div className="label">Reply by</div>{date(d.respondBy)}</div>
      </div>
      <p className="mb-2 text-xs text-ink-500">{editable ? 'Enter the prices from the supplier’s reply (email, phone or their quote). Untick “available” for items they cannot supply.' : 'Prices quoted by the supplier.'}</p>
      <table className="min-w-full text-sm">
        <thead><tr><th className="th">Item</th><th className="th num">Quantity</th><th className="th">Available</th><th className="th num">Unit price</th><th className="th num">Amount</th><th className="th">Supplier note</th></tr></thead>
        <tbody>
          {d.lines.map((l: any) => {
            const p = price(l);
            const set = (patch: Partial<typeof p>) => setPrices({ ...prices, [l._id]: { ...p, ...patch } });
            return (
              <tr key={l._id}>
                <td className="td">{l.name}</td>
                <td className="td num">{l.qty} {l.unitCode}</td>
                <td className="td">{editable ? <input type="checkbox" aria-label={`${l.name} available`} checked={p.available} onChange={(e) => set({ available: e.target.checked })} /> : p.available ? 'Yes' : 'No'}</td>
                <td className="td num">{editable ? <MoneyInput className="w-32" aria-label={`Quoted price for ${l.name}`} disabled={!p.available} value={p.unitCostCents} onChange={(v) => set({ unitCostCents: v })} /> : p.unitCostCents != null ? money(p.unitCostCents) : '—'}</td>
                <td className="td num">{p.available && p.unitCostCents != null ? money(Math.round(l.qty * p.unitCostCents)) : '—'}</td>
                <td className="td">{editable ? <Input aria-label={`Note for ${l.name}`} value={p.notes ?? ''} maxLength={300} onChange={(e) => set({ notes: e.target.value })} /> : l.notes}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot><tr><td className="td font-semibold" colSpan={4}>Total quoted</td><td className="td num font-semibold">{money(total)}</td><td /></tr></tfoot>
      </table>
      <div className="mt-3 grid gap-3 sm:grid-cols-4">
        <Field label="Supplier's quote ref"><Input disabled={!editable} value={meta.supplierRef ?? d.supplierRef ?? ''} onChange={(e) => setMeta({ ...meta, supplierRef: e.target.value })} /></Field>
        <Field label="Delivery (days)"><Input disabled={!editable} type="number" min="0" value={meta.deliveryDays ?? d.deliveryDays ?? ''} onChange={(e) => setMeta({ ...meta, deliveryDays: e.target.value })} /></Field>
        <Field label="Quote valid until"><Input disabled={!editable} type="date" value={meta.validUntil ?? d.validUntil?.slice(0, 10) ?? ''} onChange={(e) => setMeta({ ...meta, validUntil: e.target.value })} /></Field>
        <Field label="Supplier's terms / notes"><Input disabled={!editable} value={meta.supplierNotes ?? d.supplierNotes ?? ''} onChange={(e) => setMeta({ ...meta, supplierNotes: e.target.value })} /></Field>
      </div>
      {d.notes && <p className="mt-2 text-sm text-ink-600">Our notes: {d.notes}</p>}
      <div className="mt-3"><ErrorBox error={error} /></div>
    </Modal>
  );
}

function CompareModal({ groupId, onClose, onOpen }: { groupId: string; onClose: () => void; onOpen: (id: string) => void }) {
  const q = useQuery({ queryKey: ['supplier-compare', groupId], queryFn: () => api<{ data: any }>(`/supplier-quotations/compare/${groupId}`).then((r) => r.data) });
  const d = q.data;
  const best = d ? [...d.quotes].filter((x: any) => x.status === 'quoted' || x.status === 'accepted').sort((a: any, b: any) => Number(b.complete) - Number(a.complete) || a.totalCents - b.totalCents)[0] : null;
  return (
    <Modal open onClose={onClose} size="xl" title="Compare supplier quotes">
      {!d ? (q.error ? <ErrorBox error={q.error} /> : <Loading />) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr><th className="th">Item</th><th className="th num">Quantity</th>{d.quotes.map((x: any) => <th key={x.id} className="th num"><button type="button" className="font-semibold text-brand-600 hover:underline" onClick={() => onOpen(x.id)}>{x.supplier?.name}</button><div className="font-normal normal-case"><StatusBadge status={x.status} /></div></th>)}</tr>
            </thead>
            <tbody>
              {d.rows.map((r: any) => (
                <tr key={r.productId}>
                  <td className="td">{r.name}</td>
                  <td className="td num">{r.qty} {r.unitCode}</td>
                  {r.prices.map((p: any) => (
                    <td key={p.quotationId} className={cx('td num', p.quotationId === r.bestQuotationId && 'bg-green-50 font-semibold text-green-700 dark:bg-green-950/40')}>
                      {!p.available ? <span className="text-xs text-ink-400">not available</span> : p.unitCostCents != null ? money(p.unitCostCents) : <span className="text-ink-400">—</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr><td className="td font-semibold" colSpan={2}>Total quoted</td>{d.quotes.map((x: any) => <td key={x.id} className="td num font-semibold">{x.totalCents ? money(x.totalCents) : '—'}{!x.complete && x.totalCents ? <div className="text-[11px] font-normal text-amber-600">not every item</div> : null}</td>)}</tr>
              <tr><td className="td" colSpan={2}>Delivery</td>{d.quotes.map((x: any) => <td key={x.id} className="td num">{x.deliveryDays != null ? `${x.deliveryDays} days` : '—'}</td>)}</tr>
            </tfoot>
          </table>
          {best && <p className="mt-3 text-sm">Cheapest complete quote: <strong>{best.supplier?.name}</strong> ({money(best.totalCents)}). Open a supplier to accept their quote.</p>}
          <p className="mt-1 text-xs text-ink-500">Green marks the lowest price for each item.</p>
        </div>
      )}
    </Modal>
  );
}

function QuotationsTab({ onOpen }: { onOpen: (id: string) => void }) {
  const [status, setStatus] = useState('open');
  const list = useList(['supplier-quotations'], '/supplier-quotations', { limit: 100, ...(status === 'open' ? { open: true } : status ? { status } : {}) });
  return (
    <div className="card">
      <div className="panel-head">
        <Tabs value={status} onChange={setStatus} tabs={[{ key: 'open', label: 'Open' }, { key: 'accepted', label: 'Accepted' }, { key: 'rejected', label: 'Rejected' }, { key: '', label: 'All' }]} />
      </div>
      <DataTable rows={list.data?.data} loading={list.isLoading} error={list.error} onRowClick={(r: any) => onOpen(r._id)} empty="No quotation requests yet. Use “Request quotation” to ask suppliers for prices." columns={[
        { key: 'n', header: 'Number', render: (r: any) => r.number },
        { key: 's', header: 'Supplier', render: (r: any) => <>{r.supplierId?.name}{r.groupSize > 1 && <span className="ml-2"><Badge tone="blue">{r.groupSize} suppliers</Badge></span>}</> },
        { key: 'i', header: 'Items', className: 'num', render: (r: any) => r.lines.length },
        { key: 'd', header: 'Requested', render: (r: any) => date(r.createdAt) },
        { key: 'b', header: 'Reply by', render: (r: any) => date(r.respondBy) },
        { key: 't', header: 'Quoted', className: 'num', render: (r: any) => (r.totalCents ? money(r.totalCents) : '—') },
        { key: 'st', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
      ]} />
    </div>
  );
}

// ---------------- orders and receiving ----------------

function PoModal({ id, onClose, onReceive }: { id: string; onClose: () => void; onReceive: (po: any) => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['po', id], queryFn: () => api<{ data: any }>(`/purchase-orders/${id}`).then((r) => r.data) });
  if (!q.data) return <Modal open onClose={onClose} title="Purchase order">{q.error ? <ErrorBox error={q.error} /> : <Loading />}</Modal>;
  const po = q.data;
  const refresh = () => { qc.invalidateQueries({ queryKey: ['po', id] }); qc.invalidateQueries({ queryKey: ['pos'] }); };
  const openToReceive = ['draft', 'sent', 'partially_received'].includes(po.status);
  return (
    <Modal open onClose={onClose} size="xl" title={`Purchase order ${po.number}`} footer={<div className="flex w-full flex-wrap gap-2">
      <PdfButton kind="purchase_order" id={id} size="md" />
      {can('purchasing.manage') && po.status !== 'cancelled' && <EmailDocButton kind="purchase_order" id={id} defaultTo={po.supplierId?.email} what="Purchase order" label={po.sentAt ? 'Email again' : 'Email to supplier'} size="md" onSent={refresh} send={(body) => api(`/purchase-orders/${id}/send`, { body })} />}
      <span className="flex-1" />
      {can('purchasing.manage') && ['draft', 'sent'].includes(po.status) && <Button variant="ghost" onClick={async () => { if (await confirm({ title: `Cancel ${po.number}?`, message: 'The supplier should be told separately.', confirmLabel: 'Cancel order', danger: true })) api(`/purchase-orders/${id}/cancel`, { body: {} }).then(() => { toast.success('Order cancelled'); refresh(); }).catch(toast.error); }}>Cancel order</Button>}
      {openToReceive && can('inventory.receive') && <Button onClick={() => onReceive(po)}><Icon name="package" className="h-4 w-4" />Receive goods</Button>}
    </div>}>
      <div className="mb-3 grid gap-3 text-sm sm:grid-cols-4">
        <div><div className="label">Supplier</div>{po.supplierId?.name}<div className="text-xs text-ink-500">{po.supplierId?.email ?? 'no email'}</div></div>
        <div><div className="label">Status</div><StatusBadge status={po.status} /></div>
        <div><div className="label">Created</div>{date(po.createdAt)}{po.sentAt && <div className="text-xs text-ink-500">Sent {dateTime(po.sentAt)}</div>}</div>
        <div><div className="label">Deliver by</div>{date(po.expectedAt)}</div>
      </div>
      <table className="min-w-full text-sm">
        <thead><tr><th className="th">Item</th><th className="th num">Ordered</th><th className="th num">Received</th><th className="th num">Outstanding</th><th className="th num">Unit cost</th><th className="th num">Amount</th></tr></thead>
        <tbody>{po.lines.map((l: any) => <tr key={l._id}><td className="td">{l.name}</td><td className="td num">{l.qty} {l.unitCode}</td><td className="td num">{l.receivedQty ?? 0}</td><td className={cx('td num', l.qty - (l.receivedQty ?? 0) > 0 && 'font-semibold text-amber-600')}>{Math.max(0, l.qty - (l.receivedQty ?? 0))}</td><td className="td num">{money(l.unitCostCents)}</td><td className="td num">{money(Math.round(l.qty * l.unitCostCents))}</td></tr>)}</tbody>
        <tfoot><tr><td className="td font-semibold" colSpan={5}>Total</td><td className="td num font-semibold">{money(po.totalCents)}</td></tr></tfoot>
      </table>
      {po.notes && <p className="mt-2 text-sm text-ink-600">{po.notes}</p>}
      {po.receipts?.length > 0 && <p className="mt-3 text-sm">Deliveries: {po.receipts.map((g: any) => `${g.number} (${date(g.createdAt)}, ${money(g.totalCents)})`).join(', ')}</p>}
    </Modal>
  );
}

function GrnModal({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['grn', id], queryFn: () => api<{ data: any }>(`/goods-receipts/${id}`).then((r) => r.data) });
  const suppliers = useSuppliers();
  if (!q.data) return <Modal open onClose={onClose} title="Goods received">{q.error ? <ErrorBox error={q.error} /> : <Loading />}</Modal>;
  const g = q.data;
  const email = suppliers.data?.find((s) => s._id === (g.supplierId?._id ?? g.supplierId))?.email;
  return (
    <Modal open onClose={onClose} size="xl" title={`Goods received note ${g.number}`} footer={<div className="flex gap-2"><PdfButton kind="goods_receipt" id={id} size="md" /><EmailDocButton kind="goods_receipt" id={id} defaultTo={email} what="Goods received note" size="md" /></div>}>
      <div className="mb-3 grid gap-3 text-sm sm:grid-cols-4">
        <div><div className="label">Supplier</div>{g.supplierId?.name ?? 'None (stock received)'}</div>
        <div><div className="label">Supplier invoice</div>{g.supplierInvoiceNo ?? '—'}</div>
        <div><div className="label">Received</div>{dateTime(g.createdAt)}</div>
        <div><div className="label">Payment due</div>{date(g.dueDate)}</div>
      </div>
      <table className="min-w-full text-sm">
        <thead><tr><th className="th">Item</th><th className="th">Batch / expiry</th><th className="th num">Quantity</th><th className="th num">Unit cost</th><th className="th num">Amount</th></tr></thead>
        <tbody>{g.lines.map((l: any, i: number) => <tr key={i}><td className="td">{l.name}</td><td className="td">{[l.batchNo, l.expiryDate && date(l.expiryDate)].filter(Boolean).join(' · ') || '—'}</td><td className="td num">{l.qty} {l.unitCode}</td><td className="td num">{money(l.unitCostCents)}</td><td className="td num">{money(Math.round(l.qty * l.unitCostCents))}</td></tr>)}</tbody>
        <tfoot>
          <tr><td className="td" colSpan={4}>Subtotal</td><td className="td num">{money(g.subtotalCents)}</td></tr>
          <tr><td className="td" colSpan={4}>VAT</td><td className="td num">{money(g.taxCents)}</td></tr>
          <tr><td className="td font-semibold" colSpan={4}>Total</td><td className="td num font-semibold">{money(g.totalCents)}</td></tr>
        </tfoot>
      </table>
    </Modal>
  );
}

export function PurchasingPage({ tab }: { tab: Tab }) {
  const { can } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const locs = useLocations();
  const suppliers = useSuppliers();
  const pos = useList(['pos'], '/purchase-orders', { limit: 50 }, tab === 'orders');
  const grns = useList(['grns'], '/goods-receipts', { limit: 50 }, tab === 'receiving');
  const [mode, setMode] = useState<null | 'po' | 'grn'>(null);
  const [rfqOpen, setRfqOpen] = useState(false);
  const [quoteId, setQuoteId] = useState<string | null>(null);
  const [compareId, setCompareId] = useState<string | null>(null);
  const [poId, setPoId] = useState<string | null>(null);
  const [grnId, setGrnId] = useState<string | null>(null);
  // Another tab can ask to open a document here (e.g. the order just created from a quotation).
  const loc = useLocation();
  useEffect(() => {
    const st = loc.state as { openPo?: string; openGrn?: string } | null;
    if (st?.openPo) setPoId(st.openPo);
    if (st?.openGrn) setGrnId(st.openGrn);
  }, [loc.state]);
  const [form, setForm] = useState<any>({ supplierId: '', warehouseId: '', supplierInvoiceNo: '', taxCents: 0, purchaseOrderId: '' });
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [requestId, setRequestId] = useState(newRequestId);
  const whId = form.warehouseId || locs.data?.warehouses.find((w) => w.isDefault)?._id;

  const receiveFromPo = (po: any) => {
    setPoId(null);
    setForm({ supplierId: po.supplierId?._id ?? po.supplierId, warehouseId: po.warehouseId, purchaseOrderId: po._id, poNumber: po.number, supplierInvoiceNo: '', invoiceDate: '', taxCents: 0 });
    setLines(po.lines.filter((l: any) => (l.receivedQty ?? 0) < l.qty).map((l: any) => ({ productId: l.productId, poLineId: l._id, name: l.name, unitCode: l.unitCode, units: [{ code: l.unitCode, name: l.unitCode }], qty: l.qty - (l.receivedQty ?? 0), ordered: l.qty, received: l.receivedQty ?? 0, unitCostCents: l.unitCostCents })));
    setMode('grn');
  };

  const submit = async () => {
    setError(null);
    try {
      const payload = lines.filter((l) => l.qty > 0).map((l) => ({ productId: l.productId, poLineId: l.poLineId, unitCode: l.unitCode, qty: l.qty, unitCostCents: l.unitCostCents, batchNo: l.batchNo || undefined, expiryDate: l.expiryDate || undefined, serials: l.serials ? l.serials.split(/[,\s]+/).filter(Boolean) : undefined }));
      if (mode === 'po') {
        const r = await api<{ data: any }>('/purchase-orders', { body: { supplierId: form.supplierId, warehouseId: whId, expectedAt: form.expectedAt || undefined, notes: form.notes || undefined, lines: payload } });
        toast.success(`Purchase order ${r.data.number} created`);
        setPoId(r.data._id);
      } else {
        const r = await api<{ data: any }>('/goods-receipts', { body: { clientRequestId: requestId, supplierId: form.supplierId, warehouseId: whId, purchaseOrderId: form.purchaseOrderId || undefined, supplierInvoiceNo: form.supplierInvoiceNo || undefined, invoiceDate: form.invoiceDate || undefined, taxCents: form.taxCents, notes: form.notes || undefined, lines: payload }, idempotencyKey: requestId });
        toast.success(`Goods received (${r.data.number}) and stock updated`);
        if (tab !== 'receiving') nav(PATHS.receiving, { state: { openGrn: r.data._id } });
        else setGrnId(r.data._id);
      }
      setMode(null); setLines([]); setRequestId(newRequestId());
      qc.invalidateQueries({ queryKey: ['pos'] }); qc.invalidateQueries({ queryKey: ['grns'] }); qc.invalidateQueries({ queryKey: ['po'] });
    } catch (e) { setError(e); }
  };

  const [title, subtitle] = TITLES[tab];
  return (
    <div>
      <PageHeader title={title} subtitle={subtitle} actions={<>
        {can('purchasing.manage') && <Button variant={tab === 'quotations' ? 'primary' : 'secondary'} onClick={() => setRfqOpen(true)}><Icon name="doc" className="h-4 w-4" />Request quotation</Button>}
        {can('purchasing.manage') && <Button variant={tab === 'orders' ? 'primary' : 'secondary'} onClick={() => { setForm({ supplierId: '', warehouseId: '' }); setLines([]); setError(null); setMode('po'); }}><Icon name="plus" className="h-4 w-4" />New purchase order</Button>}
        {can('inventory.receive') && <Button variant={tab === 'receiving' ? 'primary' : 'secondary'} onClick={() => { setForm({ supplierId: '', warehouseId: '', supplierInvoiceNo: '', taxCents: 0 }); setLines([]); setError(null); setMode('grn'); }}><Icon name="package" className="h-4 w-4" />Receive goods</Button>}
      </>} />
      <Tabs value={tab} onChange={(k) => nav(PATHS[k as Tab])} tabs={[{ key: 'quotations', label: 'Quotations' }, { key: 'orders', label: 'Purchase orders' }, { key: 'receiving', label: 'Goods received' }]} />
      {tab === 'quotations' && <QuotationsTab onOpen={setQuoteId} />}
      {tab === 'orders' && (
        <div className="card">
          <DataTable rows={pos.data?.data} loading={pos.isLoading} error={pos.error} onRowClick={(r: any) => setPoId(r._id)} columns={[
            { key: 'n', header: 'PO', render: (r: any) => r.number },
            { key: 's', header: 'Supplier', render: (r: any) => r.supplierId?.name },
            { key: 'd', header: 'Created', render: (r: any) => date(r.createdAt) },
            { key: 'e', header: 'Deliver by', render: (r: any) => date(r.expectedAt) },
            { key: 't', header: 'Total', className: 'num', render: (r: any) => money(r.totalCents) },
            { key: 'st', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
            { key: 'a', header: '', render: (r: any) => <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
              <PdfButton kind="purchase_order" id={r._id} />
              {['draft', 'sent', 'partially_received'].includes(r.status) && can('inventory.receive') && <Button size="sm" onClick={async () => receiveFromPo((await api<{ data: any }>(`/purchase-orders/${r._id}`)).data)}>Receive</Button>}
            </div> },
          ]} />
        </div>
      )}
      {tab === 'receiving' && (
        <div className="card">
          <DataTable rows={grns.data?.data} loading={grns.isLoading} error={grns.error} onRowClick={(r: any) => setGrnId(r._id)} columns={[
            { key: 'n', header: 'GRN', render: (r: any) => r.number },
            { key: 's', header: 'Supplier', render: (r: any) => r.supplierId?.name ?? 'None (stock received)' },
            { key: 'i', header: 'Invoice', render: (r: any) => r.supplierInvoiceNo ?? '—' },
            { key: 'd', header: 'Received', render: (r: any) => dateTime(r.createdAt) },
            { key: 'du', header: 'Due', render: (r: any) => date(r.dueDate) },
            { key: 't', header: 'Total', className: 'num', render: (r: any) => money(r.totalCents) },
            { key: 'p', header: 'Paid', className: 'num', render: (r: any) => money(r.paidCents) },
            { key: 'a', header: '', render: (r: any) => <div onClick={(e) => e.stopPropagation()}><PdfButton kind="goods_receipt" id={r._id} /></div> },
          ]} />
        </div>
      )}

      <RequestQuoteModal open={rfqOpen} onClose={() => setRfqOpen(false)} onDone={() => { setRfqOpen(false); qc.invalidateQueries({ queryKey: ['supplier-quotations'] }); if (tab !== 'quotations') nav(PATHS.quotations); }} />
      {quoteId && <QuoteModal id={quoteId} onClose={() => setQuoteId(null)} onCompare={(g) => { setQuoteId(null); setCompareId(g); }} onOrdered={(po) => { setQuoteId(null); nav(PATHS.orders, { state: { openPo: po } }); }} />}
      {compareId && <CompareModal groupId={compareId} onClose={() => setCompareId(null)} onOpen={(id) => { setCompareId(null); setQuoteId(id); }} />}
      {poId && <PoModal id={poId} onClose={() => setPoId(null)} onReceive={receiveFromPo} />}
      {grnId && <GrnModal id={grnId} onClose={() => setGrnId(null)} />}

      <Modal open={Boolean(mode)} onClose={() => setMode(null)} title={mode === 'po' ? 'New purchase order' : form.poNumber ? `Receive goods for ${form.poNumber}` : 'Receive goods (GRN)'} size="xl" footer={<><Button variant="secondary" onClick={() => setMode(null)}>Cancel</Button><Button disabled={!form.supplierId || !lines.length} onClick={submit}>{mode === 'po' ? 'Create order' : 'Post receipt'}</Button></>}>
        <div className="mb-3 grid gap-3 sm:grid-cols-4">
          <Field label="Supplier"><Select disabled={Boolean(form.purchaseOrderId)} value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })} placeholder="Select supplier" options={(suppliers.data ?? []).map((s) => ({ value: s._id, label: s.name }))} /></Field>
          <Field label={mode === 'po' ? 'Deliver to' : 'Receive into'}><Select value={whId ?? ''} onChange={(e) => setForm({ ...form, warehouseId: e.target.value })} options={(locs.data?.warehouses ?? []).map((w) => ({ value: w._id, label: w.name }))} /></Field>
          {mode === 'po' && <Field label="Deliver by"><Input type="date" value={form.expectedAt ?? ''} onChange={(e) => setForm({ ...form, expectedAt: e.target.value })} /></Field>}
          {mode === 'grn' && <>
            <Field label="Supplier invoice no."><Input value={form.supplierInvoiceNo} onChange={(e) => setForm({ ...form, supplierInvoiceNo: e.target.value })} /></Field>
            <Field label="Invoice date"><Input type="date" value={form.invoiceDate ?? ''} onChange={(e) => setForm({ ...form, invoiceDate: e.target.value })} /></Field>
            <Field label="Input tax (VAT) on invoice"><MoneyInput value={form.taxCents} onChange={(v) => setForm({ ...form, taxCents: v ?? 0 })} /></Field>
          </>}
        </div>
        {form.purchaseOrderId && <p className="mb-2 text-xs text-ink-500">Quantities are what is still outstanding. Change them to what actually arrived; set 0 for items that did not come. The order stays open until everything is received.</p>}
        <LineGrid lines={lines} setLines={setLines} mode={mode === 'grn' ? 'grn' : 'po'} />
        <Field label="Notes" className="mt-3"><Input value={form.notes ?? ''} maxLength={1000} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder={mode === 'grn' ? 'e.g. 2 cartons damaged, returned to driver' : 'Printed on the order'} /></Field>
        <div className="mt-3"><ErrorBox error={error} /></div>
      </Modal>
    </div>
  );
}
