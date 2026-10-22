import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, newRequestId } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useList, useLocations } from '../../lib/hooks';
import { dateTime, money } from '../../lib/format';
import { DataTable } from '../../components/DataTable';
import { ProductPicker } from '../../components/ProductPicker';
import { Button, ErrorBox, Field, Input, Modal, MoneyInput, PageHeader, Select, StatusBadge, Tabs, useToast } from '../../components/ui';
import { Icon } from '../../components/icons';

interface Line { productId: string; name: string; unitCode: string; units: { code: string; name: string }[]; qty: number; unitCostCents: number; batchNo?: string; expiryDate?: string; serials?: string; trackBatches?: boolean; trackSerials?: boolean }

function useSuppliers() {
  return useQuery({ queryKey: ['suppliers-all'], queryFn: () => api<{ data: any[] }>('/suppliers', { query: { limit: 200 } }).then((r) => r.data) });
}

function LineGrid({ lines, setLines, receiving }: { lines: Line[]; setLines: (l: Line[]) => void; receiving?: boolean }) {
  const upd = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <div className="space-y-2">
      <ProductPicker onPick={(p) => setLines([...lines, { productId: p._id, name: p.name, unitCode: p.units?.find((u: any) => u.isDefaultPurchase)?.code ?? p.baseUnit, units: p.units?.length ? p.units : [{ code: p.baseUnit, name: p.baseUnit }], qty: 1, unitCostCents: p.costCents ?? 0, trackBatches: p.trackBatches, trackSerials: p.trackSerials }])} />
      {lines.map((l, i) => (
        <div key={i} className="grid grid-cols-2 gap-2 rounded-lg border border-ink-100 p-2 sm:grid-cols-6 dark:border-ink-800">
          <div className="col-span-2 text-sm font-medium">{l.name}</div>
          <Select value={l.unitCode} onChange={(e) => upd(i, { unitCode: e.target.value })} options={l.units.map((u) => ({ value: u.code, label: u.name }))} />
          <Input type="number" step="any" value={l.qty} onChange={(e) => upd(i, { qty: Number(e.target.value) })} aria-label="Quantity" />
          <MoneyInput value={l.unitCostCents} onChange={(v) => upd(i, { unitCostCents: v ?? 0 })} aria-label="Unit cost" />
          <div className="flex items-center justify-end gap-2 text-sm tabular-nums">{money(Math.round(l.qty * l.unitCostCents))}<Button variant="ghost" onClick={() => setLines(lines.filter((_, j) => j !== i))}><Icon name="x" className="h-4 w-4" /></Button></div>
          {receiving && l.trackBatches && <><Input placeholder="Batch no." value={l.batchNo ?? ''} onChange={(e) => upd(i, { batchNo: e.target.value })} /><Input type="date" value={l.expiryDate ?? ''} onChange={(e) => upd(i, { expiryDate: e.target.value })} aria-label="Expiry" /></>}
          {receiving && l.trackSerials && <Input className="col-span-2" placeholder="Serial numbers (comma separated)" value={l.serials ?? ''} onChange={(e) => upd(i, { serials: e.target.value })} />}
        </div>
      ))}
      <div className="text-right font-semibold">Total {money(lines.reduce((a, l) => a + Math.round(l.qty * l.unitCostCents), 0))}</div>
    </div>
  );
}

export function PurchasingPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState('po');
  const qc = useQueryClient();
  const toast = useToast();
  const locs = useLocations();
  const suppliers = useSuppliers();
  const pos = useList(['pos'], '/purchase-orders', { limit: 50 }, tab === 'po');
  const grns = useList(['grns'], '/goods-receipts', { limit: 50 }, tab === 'grn');
  const [mode, setMode] = useState<null | 'po' | 'grn'>(null);
  const [form, setForm] = useState<any>({ supplierId: '', warehouseId: '', supplierInvoiceNo: '', taxCents: 0, purchaseOrderId: '' });
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [requestId, setRequestId] = useState(newRequestId);
  const whId = form.warehouseId || locs.data?.warehouses.find((w) => w.isDefault)?._id;

  const receiveFromPo = (po: any) => {
    setForm({ supplierId: po.supplierId?._id ?? po.supplierId, warehouseId: po.warehouseId, purchaseOrderId: po._id, supplierInvoiceNo: '', taxCents: 0 });
    setLines(po.lines.filter((l: any) => l.receivedQty < l.qty).map((l: any) => ({ productId: l.productId, name: l.name, unitCode: l.unitCode, units: [{ code: l.unitCode, name: l.unitCode }], qty: l.qty - l.receivedQty, unitCostCents: l.unitCostCents })));
    setMode('grn');
  };

  const submit = async () => {
    setError(null);
    try {
      const payload = lines.map((l) => ({ productId: l.productId, unitCode: l.unitCode, qty: l.qty, unitCostCents: l.unitCostCents, batchNo: l.batchNo || undefined, expiryDate: l.expiryDate || undefined, serials: l.serials ? l.serials.split(/[,\s]+/).filter(Boolean) : undefined }));
      if (mode === 'po') await api('/purchase-orders', { body: { supplierId: form.supplierId, warehouseId: whId, lines: payload } });
      else await api('/goods-receipts', { body: { clientRequestId: requestId, supplierId: form.supplierId, warehouseId: whId, purchaseOrderId: form.purchaseOrderId || undefined, supplierInvoiceNo: form.supplierInvoiceNo || undefined, taxCents: form.taxCents, lines: payload }, idempotencyKey: requestId });
      toast.success(mode === 'po' ? 'Purchase order created' : 'Goods received and stock updated');
      setMode(null); setLines([]); setRequestId(newRequestId());
      qc.invalidateQueries({ queryKey: ['pos'] }); qc.invalidateQueries({ queryKey: ['grns'] });
    } catch (e) { setError(e); }
  };

  return (
    <div>
      <PageHeader title="Purchasing" actions={<>
        {can('purchasing.manage') && <Button variant="secondary" onClick={() => { setForm({ supplierId: '', warehouseId: '' }); setLines([]); setMode('po'); }}>New purchase order</Button>}
        {can('inventory.receive') && <Button onClick={() => { setForm({ supplierId: '', warehouseId: '', supplierInvoiceNo: '', taxCents: 0 }); setLines([]); setMode('grn'); }}>Receive goods</Button>}
      </>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'po', label: 'Purchase orders' }, { key: 'grn', label: 'Goods received' }]} />
      <div className="card">
        {tab === 'po' ? (
          <DataTable rows={pos.data?.data} loading={pos.isLoading} error={pos.error} columns={[
            { key: 'n', header: 'PO', render: (r: any) => r.number },
            { key: 's', header: 'Supplier', render: (r: any) => r.supplierId?.name },
            { key: 'd', header: 'Created', render: (r: any) => dateTime(r.createdAt) },
            { key: 't', header: 'Total', className: 'num', render: (r: any) => money(r.totalCents) },
            { key: 'st', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
            { key: 'a', header: '', render: (r: any) => <div className="flex gap-1">
              {r.status === 'draft' && <Button size="sm" variant="secondary" onClick={() => api(`/purchase-orders/${r._id}/send`, { body: {} }).then(() => { toast.success('Marked sent'); qc.invalidateQueries({ queryKey: ['pos'] }); }).catch(toast.error)}>Send</Button>}
              {['draft', 'sent', 'partially_received'].includes(r.status) && can('inventory.receive') && <Button size="sm" onClick={async () => receiveFromPo((await api<{ data: any }>(`/purchase-orders/${r._id}`)).data)}>Receive</Button>}
            </div> },
          ]} />
        ) : (
          <DataTable rows={grns.data?.data} loading={grns.isLoading} error={grns.error} columns={[
            { key: 'n', header: 'GRN', render: (r: any) => r.number },
            { key: 's', header: 'Supplier', render: (r: any) => r.supplierId?.name },
            { key: 'i', header: 'Invoice', render: (r: any) => r.supplierInvoiceNo ?? '—' },
            { key: 'd', header: 'Received', render: (r: any) => dateTime(r.createdAt) },
            { key: 't', header: 'Total', className: 'num', render: (r: any) => money(r.totalCents) },
            { key: 'p', header: 'Paid', className: 'num', render: (r: any) => money(r.paidCents) },
          ]} />
        )}
      </div>
      <Modal open={Boolean(mode)} onClose={() => setMode(null)} title={mode === 'po' ? 'New purchase order' : 'Receive goods (GRN)'} size="xl" footer={<><Button variant="secondary" onClick={() => setMode(null)}>Cancel</Button><Button disabled={!form.supplierId || !lines.length} onClick={submit}>{mode === 'po' ? 'Create order' : 'Post receipt'}</Button></>}>
        <div className="mb-3 grid gap-3 sm:grid-cols-4">
          <Field label="Supplier"><Select value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })} placeholder="Select supplier" options={(suppliers.data ?? []).map((s) => ({ value: s._id, label: s.name }))} /></Field>
          <Field label="Receive into"><Select value={whId ?? ''} onChange={(e) => setForm({ ...form, warehouseId: e.target.value })} options={(locs.data?.warehouses ?? []).map((w) => ({ value: w._id, label: w.name }))} /></Field>
          {mode === 'grn' && <><Field label="Supplier invoice no."><Input value={form.supplierInvoiceNo} onChange={(e) => setForm({ ...form, supplierInvoiceNo: e.target.value })} /></Field><Field label="Input tax (VAT) on invoice"><MoneyInput value={form.taxCents} onChange={(v) => setForm({ ...form, taxCents: v ?? 0 })} /></Field></>}
        </div>
        <LineGrid lines={lines} setLines={setLines} receiving={mode === 'grn'} />
        <div className="mt-3"><ErrorBox error={error} /></div>
      </Modal>
    </div>
  );
}
