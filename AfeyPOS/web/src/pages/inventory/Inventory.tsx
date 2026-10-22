import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api, newRequestId } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useList, useLocations } from '../../lib/hooks';
import { dateTime, money, qty } from '../../lib/format';
import { DataTable } from '../../components/DataTable';
import { ProductPicker } from '../../components/ProductPicker';
import { Badge, Button, Card, Checkbox, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, StatusBadge, useConfirm, useToast } from '../../components/ui';
import { Icon } from '../../components/icons';
import { code128Svg } from '../../components/barcode';

function useWarehouseSelect() {
  const locs = useLocations();
  const [wh, setWh] = useState('');
  const options = (locs.data?.warehouses ?? []).map((w) => ({ value: w._id, label: w.name }));
  const name = (id: string) => locs.data?.warehouses.find((w) => w._id === id)?.name ?? '—';
  return { wh, setWh, options, name, defaultId: locs.data?.warehouses.find((w) => w.isDefault)?._id ?? options[0]?.value };
}

export function StockLevelsPage() {
  const [params] = useSearchParams();
  const w = useWarehouseSelect();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [below, setBelow] = useState(params.get('belowReorder') === 'true');
  const list = useList(['levels'], '/inventory/levels', { page, q: q || undefined, warehouseId: w.wh || undefined, belowReorder: below ? 'true' : undefined, limit: 50 });
  return (
    <div>
      <PageHeader title="Stock levels" subtitle="Quantities in base units. Value uses weighted average cost." />
      <div className="card">
        <div className="flex flex-wrap items-center gap-2 border-b border-ink-100 p-3 dark:border-ink-800">
          <Input className="max-w-xs" placeholder="Search" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
          <Select className="max-w-[200px]" value={w.wh} onChange={(e) => w.setWh(e.target.value)} placeholder="All locations" options={w.options} />
          <Checkbox label="At or below reorder level" checked={below} onChange={setBelow} />
        </div>
        <DataTable rows={list.data?.data} loading={list.isLoading} error={list.error} page={page} total={list.data?.total} limit={50} onPage={setPage}
          columns={[
            { key: 'p', header: 'Product', render: (r: any) => <Link className="font-medium hover:underline" to={`/products/${r.productId}`}>{r.product.name}</Link> },
            { key: 'w', header: 'Location', render: (r: any) => w.name(r.warehouseId) },
            { key: 'q', header: 'On hand', className: 'num', render: (r: any) => <span className={r.product.reorderLevel && r.qty <= r.product.reorderLevel ? 'font-semibold text-red-600' : ''}>{qty(r.qty)} {r.product.baseUnit}</span> },
            { key: 'r', header: 'Reserved', className: 'num', render: (r: any) => qty(r.reserved) },
            { key: 'a', header: 'Available', className: 'num', render: (r: any) => qty(r.available) },
            { key: 't', header: 'In transit', className: 'num', render: (r: any) => qty(r.inTransit) },
            { key: 'c', header: 'Avg cost', className: 'num', render: (r: any) => money(r.avgCostCents) },
            { key: 'v', header: 'Value', className: 'num', render: (r: any) => money(r.valueCents) },
          ]} />
      </div>
    </div>
  );
}

export function MovementsPage() {
  const w = useWarehouseSelect();
  const [page, setPage] = useState(1);
  const [type, setType] = useState('');
  const list = useList(['movements'], '/inventory/movements', { page, type: type || undefined, warehouseId: w.wh || undefined, limit: 50 });
  return (
    <div>
      <PageHeader title="Stock movements" subtitle="Every stock change, who made it, when and why" />
      <div className="card">
        <div className="flex flex-wrap gap-2 border-b border-ink-100 p-3 dark:border-ink-800">
          <Select className="max-w-[200px]" value={type} onChange={(e) => setType(e.target.value)} placeholder="All types" options={['opening', 'purchase_receipt', 'sale', 'sale_return', 'supplier_return', 'adjustment', 'damage', 'wastage', 'expiry', 'transfer_out', 'transfer_in', 'stocktake', 'sync'].map((t) => ({ value: t, label: t.replace(/_/g, ' ') }))} />
          <Select className="max-w-[200px]" value={w.wh} onChange={(e) => w.setWh(e.target.value)} placeholder="All locations" options={w.options} />
        </div>
        <DataTable rows={list.data?.data} loading={list.isLoading} error={list.error} page={page} total={list.data?.total} limit={50} onPage={setPage}
          columns={[
            { key: 'at', header: 'When', render: (r: any) => dateTime(r.at) },
            { key: 'p', header: 'Product', render: (r: any) => r.productId?.name },
            { key: 'type', header: 'Type', render: (r: any) => <Badge tone={r.qty < 0 ? 'red' : 'green'}>{r.type.replace(/_/g, ' ')}</Badge> },
            { key: 'q', header: 'Qty', className: 'num', render: (r: any) => `${r.qty > 0 ? '+' : ''}${qty(r.qty)}` },
            { key: 'b', header: 'Balance', className: 'num', render: (r: any) => qty(r.balanceAfter) },
            { key: 'ref', header: 'Document', render: (r: any) => r.ref?.number ?? '—' },
            { key: 'u', header: 'By', render: (r: any) => r.userId?.name ?? 'system' },
            { key: 'reason', header: 'Reason', render: (r: any) => r.reason ?? '' },
          ]} />
      </div>
    </div>
  );
}

interface DraftLine { productId: string; name: string; qty: number; batchNo?: string; serials?: string; trackSerials?: boolean; trackBatches?: boolean }

function LinesEditor({ lines, setLines, signed }: { lines: DraftLine[]; setLines: (l: DraftLine[]) => void; signed?: boolean }) {
  return (
    <div className="space-y-2">
      <ProductPicker onPick={(p) => setLines([...lines, { productId: p._id, name: p.name, qty: signed ? -1 : 1, trackSerials: p.trackSerials, trackBatches: p.trackBatches }])} />
      {lines.map((l, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <span className="min-w-[160px] flex-1 text-sm">{l.name}</span>
          <Input className="w-28" type="number" step="any" value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: Number(e.target.value) } : x)))} aria-label="Quantity" />
          {l.trackBatches && <Input className="w-28" placeholder="Batch" value={l.batchNo ?? ''} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, batchNo: e.target.value } : x)))} />}
          {l.trackSerials && <Input className="w-48" placeholder="Serials" value={l.serials ?? ''} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, serials: e.target.value } : x)))} />}
          <Button variant="ghost" onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="Remove"><Icon name="x" className="h-4 w-4" /></Button>
        </div>
      ))}
      {signed && <p className="text-xs text-ink-500">Use negative quantities to remove stock and positive to add.</p>}
    </div>
  );
}

const toPayload = (lines: DraftLine[]) => lines.map((l) => ({ productId: l.productId, qty: l.qty, batchNo: l.batchNo || undefined, serials: l.serials ? l.serials.split(/[,\s]+/).filter(Boolean) : undefined }));

export function AdjustmentsPage() {
  const { can } = useAuth();
  const w = useWarehouseSelect();
  const qc = useQueryClient();
  const toast = useToast();
  const list = useList(['adjustments'], '/inventory/adjustments', { limit: 50 });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ reason: 'damage', notes: '', approveNow: false });
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [error, setError] = useState<unknown>(null);
  const act = async (id: string, action: 'approve' | 'reject') => {
    try { await api(`/inventory/adjustments/${id}/${action}`, { body: {} }); qc.invalidateQueries({ queryKey: ['adjustments'] }); toast.success(`Adjustment ${action}d`); } catch (e) { toast.error(e); }
  };
  return (
    <div>
      <PageHeader title="Stock adjustments" subtitle="Damage, wastage, expiry and corrections require approval" actions={<Button onClick={() => setOpen(true)}><Icon name="plus" className="h-4 w-4" />New adjustment</Button>} />
      <div className="card">
        <DataTable rows={list.data?.data} loading={list.isLoading} error={list.error}
          columns={[
            { key: 'n', header: 'Number', render: (r: any) => r.number },
            { key: 'd', header: 'Date', render: (r: any) => dateTime(r.createdAt) },
            { key: 'w', header: 'Location', render: (r: any) => w.name(r.warehouseId) },
            { key: 'r', header: 'Reason', render: (r: any) => r.reason },
            { key: 'l', header: 'Lines', render: (r: any) => r.lines.length },
            { key: 's', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
            { key: 'a', header: '', render: (r: any) => r.status === 'pending' && can('inventory.adjust.approve') ? <div className="flex gap-1"><Button size="sm" onClick={() => act(r._id, 'approve')}>Approve</Button><Button size="sm" variant="secondary" onClick={() => act(r._id, 'reject')}>Reject</Button></div> : null },
          ]} />
      </div>
      <Modal open={open} onClose={() => setOpen(false)} title="New stock adjustment" size="lg" footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={!lines.length} onClick={async () => {
        try { await api('/inventory/adjustments', { body: { warehouseId: w.wh || w.defaultId, ...form, lines: toPayload(lines) }, idempotencyKey: newRequestId() }); setOpen(false); setLines([]); qc.invalidateQueries({ queryKey: ['adjustments'] }); toast.success('Adjustment saved'); } catch (e) { setError(e); }
      }}>Save</Button></>}>
        <div className="mb-3 grid gap-3 sm:grid-cols-3">
          <Field label="Location"><Select value={w.wh || w.defaultId} onChange={(e) => w.setWh(e.target.value)} options={w.options} /></Field>
          <Field label="Reason"><Select value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} options={['correction', 'damage', 'wastage', 'expiry', 'theft', 'other'].map((x) => ({ value: x, label: x }))} /></Field>
          <Field label="Notes"><Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
        </div>
        <LinesEditor lines={lines} setLines={setLines} signed />
        {can('inventory.adjust.approve') && <div className="mt-3"><Checkbox label="Approve and post now" checked={form.approveNow} onChange={(v) => setForm({ ...form, approveNow: v })} /></div>}
        <div className="mt-3"><ErrorBox error={error} /></div>
      </Modal>
    </div>
  );
}

export function TransfersPage() {
  const w = useWarehouseSelect();
  const qc = useQueryClient();
  const toast = useToast();
  const list = useList(['transfers'], '/inventory/transfers', { limit: 50 });
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [error, setError] = useState<unknown>(null);
  const act = async (id: string, action: string) => {
    try { await api(`/inventory/transfers/${id}/${action}`, { body: {} }); qc.invalidateQueries({ queryKey: ['transfers'] }); toast.success('Updated'); } catch (e) { toast.error(e); }
  };
  return (
    <div>
      <PageHeader title="Stock transfers" actions={<Button onClick={() => setOpen(true)}><Icon name="plus" className="h-4 w-4" />New transfer</Button>} />
      <div className="card">
        <DataTable rows={list.data?.data} loading={list.isLoading} error={list.error}
          columns={[
            { key: 'n', header: 'Number', render: (r: any) => r.number },
            { key: 'f', header: 'From', render: (r: any) => w.name(r.fromWarehouseId) },
            { key: 't', header: 'To', render: (r: any) => w.name(r.toWarehouseId) },
            { key: 'l', header: 'Lines', render: (r: any) => r.lines.length },
            { key: 's', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
            { key: 'a', header: '', render: (r: any) => r.status === 'draft' ? <Button size="sm" onClick={() => act(r._id, 'dispatch')}>Dispatch</Button> : r.status === 'in_transit' ? <Button size="sm" onClick={() => act(r._id, 'receive')}>Receive all</Button> : null },
          ]} />
      </div>
      <Modal open={open} onClose={() => setOpen(false)} title="New transfer" size="lg" footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={!from || !to || !lines.length} onClick={async () => {
        try { await api('/inventory/transfers', { body: { fromWarehouseId: from, toWarehouseId: to, lines: lines.map((l) => ({ productId: l.productId, qty: l.qty })), dispatchNow: true } }); setOpen(false); setLines([]); qc.invalidateQueries({ queryKey: ['transfers'] }); } catch (e) { setError(e); }
      }}>Dispatch</Button></>}>
        <div className="mb-3 grid gap-3 sm:grid-cols-2">
          <Field label="From"><Select value={from} onChange={(e) => setFrom(e.target.value)} placeholder="Select" options={w.options} /></Field>
          <Field label="To"><Select value={to} onChange={(e) => setTo(e.target.value)} placeholder="Select" options={w.options} /></Field>
        </div>
        <LinesEditor lines={lines} setLines={setLines} />
        <div className="mt-3"><ErrorBox error={error} /></div>
      </Modal>
    </div>
  );
}

export function StocktakesPage() {
  const w = useWarehouseSelect();
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ['stocktakes'], queryFn: () => api<{ data: any[] }>('/inventory/stocktakes').then((r) => r.data) });
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div>
      <PageHeader title="Stocktaking" subtitle="Counts are compared to a snapshot taken when the count starts" actions={<div className="flex gap-2"><Select value={w.wh || w.defaultId} onChange={(e) => w.setWh(e.target.value)} options={w.options} /><Button onClick={async () => { try { const r = await api<{ data: any }>('/inventory/stocktakes', { body: { warehouseId: w.wh || w.defaultId } }); qc.invalidateQueries({ queryKey: ['stocktakes'] }); setSelected(r.data._id); } catch (e) { toast.error(e); } }}>Start count</Button></div>} />
      <div className="card">
        <DataTable rows={list.data} loading={list.isLoading} error={list.error} onRowClick={(r: any) => setSelected(r._id)}
          columns={[
            { key: 'n', header: 'Number', render: (r: any) => r.number },
            { key: 'w', header: 'Location', render: (r: any) => w.name(r.warehouseId) },
            { key: 'd', header: 'Started', render: (r: any) => dateTime(r.createdAt) },
            { key: 's', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
          ]} />
      </div>
      {selected && <StocktakeModal id={selected} onClose={() => { setSelected(null); qc.invalidateQueries({ queryKey: ['stocktakes'] }); }} />}
    </div>
  );
}

function StocktakeModal({ id, onClose }: { id: string; onClose: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['stocktake', id], queryFn: () => api<{ data: any }>(`/inventory/stocktakes/${id}`).then((r) => r.data) });
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState('');
  if (!q.data) return <Modal open onClose={onClose} title="Stocktake"><Loading /></Modal>;
  const st = q.data;
  const save = async () => {
    const entries = Object.entries(counts).filter(([, v]) => v !== '').map(([productId, v]) => ({ productId, countedQty: Number(v) }));
    if (entries.length) await api(`/inventory/stocktakes/${id}/counts`, { method: 'PATCH', body: { counts: entries } });
    await q.refetch();
    setCounts({});
  };
  return (
    <Modal open onClose={onClose} title={`Stocktake ${st.number}`} size="xl" footer={st.status === 'counting' ? <><Button variant="secondary" onClick={() => save().then(() => toast.success('Counts saved')).catch(toast.error)}>Save counts</Button><Button onClick={async () => {
      if (!(await confirm({ title: 'Post stocktake?', message: 'Variances will be posted as stock adjustments. Uncounted items are left unchanged.', confirmLabel: 'Post' }))) return;
      try { await save(); const r = await api<{ data: any }>(`/inventory/stocktakes/${id}/post`, { body: {} }); toast.success(`Posted ${r.data.variances.length} variances`); onClose(); } catch (e) { toast.error(e); }
    }}>Post variances</Button></> : undefined}>
      <Input className="mb-2 max-w-xs" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <table className="min-w-full text-sm"><thead><tr><th className="th">Product</th><th className="th num">Expected</th><th className="th num">Counted</th><th className="th num">Variance</th></tr></thead>
        <tbody>{st.lines.filter((l: any) => !filter || l.productId?.name?.toLowerCase().includes(filter.toLowerCase()) || l.productId?.sku === filter).map((l: any) => {
          const pid = l.productId?._id;
          const counted = counts[pid] ?? (l.countedQty ?? '');
          const v = counted === '' ? null : Number(counted) - l.expectedQty;
          return <tr key={pid}><td className="td">{l.productId?.name} <span className="text-ink-500">{l.productId?.sku}</span></td><td className="td num">{qty(l.expectedQty)}</td>
            <td className="td num">{st.status === 'counting' ? <Input className="ml-auto w-24 text-right" inputMode="decimal" value={counted} onChange={(e) => setCounts({ ...counts, [pid]: e.target.value })} /> : qty(l.countedQty)}</td>
            <td className={`td num ${v && v < 0 ? 'text-red-600' : v ? 'text-amber-600' : ''}`}>{v === null ? '' : qty(v)}</td></tr>;
        })}</tbody></table>
    </Modal>
  );
}

export function LabelsPage() {
  const [items, setItems] = useState<{ p: any; copies: number }[]>([]);
  const [error, setError] = useState<unknown>(null);
  const print = () => {
    try {
      const html = items.flatMap(({ p, copies }) => {
        const code = p.barcodes?.[0]?.code ?? p.sku;
        const svg = code128Svg(code, 40, 1.5);
        return Array.from({ length: copies }, () => `<div class="l"><div class="n">${p.name.replace(/</g, '&lt;')}</div><div class="p">KES ${((p.prices?.retail ?? 0) / 100).toFixed(2)}</div>${svg}<div class="c">${code}</div></div>`);
      }).join('');
      const w = window.open('', '_blank');
      w!.document.write(`<!doctype html><html><head><title>Labels</title><style>@page{size:50mm 30mm;margin:0}body{margin:0;font:10px sans-serif}.l{width:50mm;height:30mm;padding:2mm;box-sizing:border-box;page-break-after:always;text-align:center;overflow:hidden}.n{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.p{font-size:14px;font-weight:700}svg{max-width:100%;height:10mm}.c{font-size:8px}</style></head><body>${html}<script>onload=()=>print()</script></body></html>`);
      w!.document.close();
    } catch (e) { setError(e); }
  };
  return (
    <div className="max-w-3xl">
      <PageHeader title="Shelf labels & barcodes" subtitle="Prints 50 × 30 mm Code 128 labels from the browser. ZPL/TSPL output is available through the hardware API." actions={<Button onClick={print} disabled={!items.length}><Icon name="printer" className="h-4 w-4" />Print labels</Button>} />
      <Card>
        <ProductPicker onPick={(p) => setItems([...items, { p, copies: 1 }])} />
        <ul className="mt-3 divide-y divide-ink-100 dark:divide-ink-800">{items.map((it, i) => <li key={i} className="flex items-center gap-2 py-2 text-sm"><span className="flex-1">{it.p.name}</span><Input className="w-20" type="number" min={1} value={it.copies} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, copies: Number(e.target.value) } : x)))} aria-label="Copies" /><Button variant="ghost" onClick={() => setItems(items.filter((_, j) => j !== i))}><Icon name="x" className="h-4 w-4" /></Button></li>)}</ul>
        <ErrorBox error={error} />
      </Card>
    </div>
  );
}
