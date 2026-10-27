import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, newRequestId } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useLocations } from '../../lib/hooks';
import { money, qty as fmtQty } from '../../lib/format';
import { usePublicConfig } from '../Auth';
import { ProductPicker } from '../../components/ProductPicker';
import { Button, Card, EmptyState, ErrorBox, Field, Input, MoneyInput, PageHeader, Select, useToast } from '../../components/ui';
import { Icon } from '../../components/icons';

interface Line { key: string; productId: string; name: string; sku?: string; unitCode: string; inStock: number; qty: number; unitCostCents?: number; at: number }

const DRAFT = 'afey.receive-stock.draft';
const readDraft = (): { warehouseId?: string; lines: Line[] } => {
  try {
    return JSON.parse(localStorage.getItem(DRAFT) ?? '') ?? { lines: [] };
  } catch {
    return { lines: [] };
  }
};

/**
 * Inventory → Receive stock: scan each item as it is unpacked (every scan adds 1), correct any quantity or the new
 * total, then save once. Saved as a goods received note (GRN); with a supplier it is also added to what is owed.
 * The list is kept on this computer until it is saved, so a refresh loses nothing.
 */
export function ReceiveStockPage() {
  const { me, can, has } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const locs = useLocations();
  const serverBranch = usePublicConfig().data?.branchCode?.toUpperCase();
  const draft = useMemo(readDraft, []);
  const [warehouseId, setWarehouseId] = useState(draft.warehouseId ?? '');
  const [branchId, setBranchId] = useState('');
  const [lines, setLines] = useState<Line[]>(draft.lines ?? []);
  const [supplierId, setSupplierId] = useState('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [code, setCode] = useState('');
  const [flash, setFlash] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [requestId, setRequestId] = useState(newRequestId);
  const scanRef = useRef<HTMLInputElement>(null);
  const showCost = can('products.cost');

  // Stores this server may receive into: a branch server only its own branch; head office not the branches
  // that run their own server (their stock is received there); users limited to some branches only those.
  const branches = useMemo(() => (locs.data?.branches ?? []).filter((b) => b.active
    && (!serverBranch || b.code?.toUpperCase() === serverBranch)
    && (me?.deploymentMode !== 'hq' || !b.hasServer)
    && (!me?.user.branchIds.length || me.user.branchIds.includes(b._id))), [locs.data, serverBranch, me]);
  const elsewhere = (locs.data?.branches ?? []).filter((b) => me?.deploymentMode === 'hq' && b.hasServer);
  const stores = (locs.data?.warehouses ?? []).filter((w) => w.branchId === branchId);
  useEffect(() => {
    if (!locs.data || !branches.length) return;
    const fromDraft = locs.data.warehouses.find((w) => w._id === warehouseId);
    const b = fromDraft && branches.some((x) => x._id === fromDraft.branchId) ? fromDraft.branchId : branches[0]._id;
    setBranchId((cur) => cur || b);
  }, [locs.data, branches, warehouseId]);
  useEffect(() => {
    if (!branchId || stores.some((w) => w._id === warehouseId)) return;
    setWarehouseId((stores.find((w) => w.isDefault) ?? stores[0])?._id ?? '');
  }, [branchId, stores, warehouseId]);
  useEffect(() => {
    try { localStorage.setItem(DRAFT, JSON.stringify({ warehouseId, lines })); } catch { /* private mode */ }
  }, [warehouseId, lines]);

  const suppliers = useQuery({ queryKey: ['suppliers-pick'], queryFn: () => api<{ data: { _id: string; name: string }[] }>('/suppliers', { query: { limit: 200 } }).then((r) => r.data), enabled: can('suppliers.read') && has('suppliers') });

  const add = (p: { _id: string; name: string; sku?: string; costCents?: number; baseUnit?: string; units?: { code: string; factor: number }[] }, unitCode: string, inStock: number) => {
    const key = `${p._id}:${unitCode}`;
    const factor = p.units?.find((u) => u.code === unitCode)?.factor ?? 1;
    setLines((ls) => {
      const found = ls.find((l) => l.key === key);
      if (found) return [{ ...found, qty: found.qty + 1, at: Date.now() }, ...ls.filter((l) => l.key !== key)];
      return [{ key, productId: p._id, name: p.name, sku: p.sku, unitCode, inStock, qty: 1, unitCostCents: p.costCents !== undefined ? Math.round(p.costCents * factor) : undefined, at: Date.now() }, ...ls];
    });
    setFlash(key);
    setTimeout(() => setFlash((f) => (f === key ? '' : f)), 700);
  };
  const scan = async (raw: string) => {
    const c = raw.trim();
    setCode('');
    if (!c) return;
    setError(null);
    try {
      const r = (await api<{ data: { product: any; unitCode: string; stock: { qty: number } | null } }>('/products/lookup', { query: { code: c, warehouseId } })).data;
      add(r.product, r.unitCode, r.stock?.qty ?? 0);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? new Error(`No product with barcode ${c}`) : e);
    } finally {
      scanRef.current?.focus();
    }
  };
  const pick = async (p: any) => {
    const lookup = await api<{ data: { stock: { qty: number } | null } }>('/products/lookup', { query: { code: p.sku, warehouseId } }).catch(() => null);
    add(p, p.baseUnit ?? 'pc', lookup?.data.stock?.qty ?? 0);
    scanRef.current?.focus();
  };
  // A scanner types fast and presses Enter: keep listening even when the cursor is elsewhere on the page.
  useEffect(() => {
    let buf = '';
    let last = 0;
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      const now = Date.now();
      if (now - last > 80) buf = '';
      last = now;
      if (e.key === 'Enter' && buf.length >= 3) { e.preventDefault(); const c = buf; buf = ''; void scan(c); return; }
      if (e.key.length === 1) buf += e.key;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const setQty = (key: string, q: number) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, qty: Math.max(0, q) } : l)));
  const total = lines.reduce((a, l) => a + l.qty, 0);
  const value = lines.reduce((a, l) => a + Math.round(l.qty * (l.unitCostCents ?? 0)), 0);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const toSave = lines.filter((l) => l.qty > 0);
      const r = await api<{ data: { number: string } }>('/inventory/receive', {
        body: {
          clientRequestId: requestId, warehouseId, supplierId: supplierId || undefined, supplierInvoiceNo: reference.trim() || undefined, notes: notes.trim() || undefined,
          lines: toSave.map((l) => ({ productId: l.productId, unitCode: l.unitCode, qty: l.qty, ...(showCost && l.unitCostCents !== undefined ? { unitCostCents: l.unitCostCents } : {}) })),
        },
        idempotencyKey: requestId,
      });
      toast.success(`Saved ${r.data.number}: ${fmtQty(toSave.reduce((a, l) => a + l.qty, 0))} received into ${stores.find((w) => w._id === warehouseId)?.name ?? 'the store'}`);
      setLines([]);
      setReference('');
      setNotes('');
      setRequestId(newRequestId());
      qc.invalidateQueries({ queryKey: ['stock'] });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      scanRef.current?.focus();
    }
  };

  return (
    <div className="max-w-6xl">
      <PageHeader title="Receive stock" subtitle="Scan every item as it is unpacked: each scan adds 1. Correct any quantity, then save once." />
      <Card className="mb-4">
        <div className="grid gap-3 md:grid-cols-4">
          {branches.length > 1 && <Field label="Branch"><Select value={branchId} onChange={(e) => { setBranchId(e.target.value); setWarehouseId(''); }} options={branches.map((b) => ({ value: b._id, label: b.name }))} /></Field>}
          <Field label="Receive into"><Select aria-label="Receive into" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} options={stores.map((w) => ({ value: w._id, label: w.name }))} /></Field>
          {can('suppliers.read') && has('suppliers') && <Field label="Supplier (optional)" hint="With a supplier it is also added to what you owe them"><Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} options={[{ value: '', label: 'No supplier (stock only)' }, ...(suppliers.data ?? []).map((s) => ({ value: s._id, label: s.name }))]} /></Field>}
          <Field label="Delivery note / invoice no."><Input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
        </div>
        {elsewhere.length > 0 && <p className="mt-2 text-xs text-ink-500">Not listed: {elsewhere.map((b) => b.name).join(', ')}: they run their own server, so their stock is received there.</p>}
      </Card>

      <div className="mb-4 grid gap-3 md:grid-cols-[1fr_320px]">
        <form onSubmit={(e) => { e.preventDefault(); void scan(code); }} className="relative">
          <Icon name="barcode" className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-brand-600" />
          <input ref={scanRef} autoFocus aria-label="Scan barcode" value={code} onChange={(e) => setCode(e.target.value)} disabled={!warehouseId}
            placeholder={warehouseId ? 'Scan a barcode (each scan adds 1) or type it and press Enter' : 'Choose where to receive first'}
            className="h-14 w-full rounded-xl border-2 border-brand-500 bg-white pl-11 pr-28 text-lg shadow-sm outline-none ring-brand-200 focus:ring-4 dark:bg-ink-900" />
          <span className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-1.5 text-xs font-semibold text-emerald-700"><span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />Listening</span>
        </form>
        <ProductPicker placeholder="No barcode? Search by name" onPick={pick} />
      </div>
      <ErrorBox error={error} />

      <Card className="mt-3" bodyClassName="p-0">
        {!lines.length ? (
          <EmptyState title="Nothing scanned yet" icon="barcode">Scan the first item. The same item scanned again adds 1 to its line.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="receive-lines">
              <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500 dark:bg-ink-800/60">
                <tr><th className="px-3 py-2">Product</th><th className="px-3 py-2">Unit</th><th className="px-3 py-2 text-right">In stock</th><th className="px-3 py-2 text-right">Received</th><th className="px-3 py-2 text-right">New total</th>{showCost && <th className="px-3 py-2 text-right">Unit cost</th>}<th /></tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.key} className={`border-t border-ink-100 transition-colors dark:border-ink-800 ${flash === l.key ? 'bg-emerald-100 dark:bg-emerald-900/40' : ''}`}>
                    <td className="px-3 py-2"><div className="font-medium">{l.name}</div><div className="text-xs text-ink-500">{l.sku}</div></td>
                    <td className="px-3 py-2">{l.unitCode}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtQty(l.inStock)}</td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button size="sm" variant="ghost" aria-label={`One less ${l.name}`} onClick={() => setQty(l.key, l.qty - 1)}>−</Button>
                        <input aria-label={`Received ${l.name}`} inputMode="decimal" className="input w-20 py-1 text-right" value={l.qty} onChange={(e) => setQty(l.key, Number(e.target.value.replace(/[^\d.]/g, '')) || 0)} onKeyDown={(e) => { if (e.key === 'Enter') scanRef.current?.focus(); }} />
                        <Button size="sm" variant="ghost" aria-label={`One more ${l.name}`} onClick={() => setQty(l.key, l.qty + 1)}>+</Button>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <input aria-label={`New total ${l.name}`} inputMode="decimal" className="input w-24 py-1 text-right font-semibold" value={l.inStock + l.qty}
                        onChange={(e) => setQty(l.key, (Number(e.target.value.replace(/[^\d.]/g, '')) || 0) - l.inStock)} onKeyDown={(e) => { if (e.key === 'Enter') scanRef.current?.focus(); }} />
                    </td>
                    {showCost && <td className="px-3 py-2 text-right"><div className="ml-auto w-28"><MoneyInput aria-label={`Unit cost ${l.name}`} value={l.unitCostCents ?? null} onChange={(v) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, unitCostCents: v ?? undefined } : x)))} /></div></td>}
                    <td className="px-3 py-2 text-right"><Button size="sm" variant="ghost" aria-label={`Remove ${l.name}`} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}><Icon name="trash" className="h-4 w-4" /></Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="sticky bottom-0 mt-4 flex flex-wrap items-end gap-3 rounded-xl border border-ink-200 bg-white p-3 shadow-lg dark:border-ink-700 dark:bg-ink-900">
        <Field label="Notes" className="min-w-[200px] flex-1"><Input value={notes} placeholder="e.g. 2 cartons damaged, returned to driver" onChange={(e) => setNotes(e.target.value)} /></Field>
        <div className="text-sm"><div className="text-ink-500">{lines.length} {lines.length === 1 ? 'product' : 'products'}</div><div className="text-lg font-bold tabular-nums" data-testid="receive-total">{fmtQty(total)} received{showCost && value ? ` · ${money(value)}` : ''}</div></div>
        <Button variant="secondary" disabled={!lines.length || busy} onClick={() => { if (window.confirm('Clear the scanned list?')) setLines([]); }}>Clear</Button>
        <Button size="lg" loading={busy} disabled={!warehouseId || !lines.some((l) => l.qty > 0)} onClick={save}>Save received stock</Button>
      </div>
    </div>
  );
}
