import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useLocations } from '../../lib/hooks';
import { date, money, qty } from '../../lib/format';
import { DataTable } from '../../components/DataTable';
import { Badge, Button, Checkbox, cx, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Stat, useConfirm, useToast } from '../../components/ui';
import { Icon } from '../../components/icons';
import { code128Svg } from '../../components/barcode';

// ---------------- units ----------------
export function UnitsPage() {
  const toast = useToast();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['units'], queryFn: () => api<{ data: any[] }>('/units').then((r) => r.data) });
  const [edit, setEdit] = useState<any>(null);
  const [error, setError] = useState<unknown>(null);
  const confirm = useConfirm();
  const save = async () => {
    setError(null);
    try {
      if (edit._id) await api(`/units/${edit._id}`, { method: 'PATCH', body: { name: edit.name, allowFractional: edit.allowFractional, active: edit.active } });
      else await api('/units', { body: { code: edit.code, name: edit.name, allowFractional: edit.allowFractional, active: true } });
      setEdit(null); q.refetch(); toast.success('Unit saved');
    } catch (e) { setError(e); }
  };
  return (
    <div className="max-w-4xl">
      <PageHeader title="Units" subtitle="Units of measure for products: pieces, kilograms, litres, cartons… Each product sets its own conversions (e.g. 1 carton = 24 pieces) on the product page."
        actions={can('products.manage') && <Button onClick={() => { setError(null); setEdit({ code: '', name: '', allowFractional: false }); }}><Icon name="plus" className="h-4 w-4" />Add unit</Button>} />
      <div className="card">
        <DataTable rows={q.data} loading={q.isLoading} empty="No units"
          columns={[
            { key: 'c', header: 'Code', render: (r: any) => <span className="font-mono font-semibold">{r.code}</span> },
            { key: 'n', header: 'Name', render: (r: any) => <span>{r.name}{r.unlisted && <Badge tone="amber">used by products, not listed</Badge>}</span> },
            { key: 'f', header: 'Fractions', render: (r: any) => (r.allowFractional ? 'Allowed (e.g. 1.25)' : 'Whole only') },
            { key: 'p', header: 'Products', className: 'num', render: (r: any) => r.productCount },
            { key: 's', header: '', render: (r: any) => (r.active === false ? <Badge>Hidden</Badge> : null) },
            { key: 'a', header: '', render: (r: any) => can('products.manage') && (
              <div className="flex gap-1">
                {r._id ? <Button size="sm" variant="secondary" onClick={() => { setError(null); setEdit({ ...r }); }}>Edit</Button> : <Button size="sm" variant="secondary" onClick={() => { setError(null); setEdit({ code: r.code, name: '', allowFractional: false }); }}>Add to list</Button>}
                {r._id && !r.productCount && <Button size="sm" variant="ghost" aria-label={`Delete ${r.code}`} onClick={async () => { if (await confirm({ title: `Delete unit ${r.code}?`, message: 'It is not used by any product.', danger: true, confirmLabel: 'Delete' })) api(`/units/${r._id}`, { method: 'DELETE' }).then(() => q.refetch()).catch(toast.error); }}><Icon name="trash" className="h-4 w-4" /></Button>}
              </div>
            ) },
          ]} />
      </div>
      {edit && (
        <Modal open onClose={() => setEdit(null)} title={edit._id ? `Unit ${edit.code}` : 'New unit'} icon="layers" size="sm" footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={save}>Save</Button></>}>
          <div className="space-y-3">
            <Field label="Code" hint="Short, shown on receipts: kg, pc, ctn24"><Input value={edit.code} disabled={Boolean(edit._id)} onChange={(e) => setEdit({ ...edit, code: e.target.value.toLowerCase() })} /></Field>
            <Field label="Name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="Carton of 24" /></Field>
            <Checkbox label="Can be sold in fractions (weighed or measured)" checked={Boolean(edit.allowFractional)} onChange={(v) => setEdit({ ...edit, allowFractional: v })} />
            {edit._id && <Checkbox label="Show when setting up products" checked={edit.active !== false} onChange={(v) => setEdit({ ...edit, active: v })} />}
            <ErrorBox error={error} />
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------------- categories & brands ----------------
function NamedList({ kind }: { kind: 'categories' | 'brands' }) {
  const toast = useToast();
  const { can } = useAuth();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: [kind, 'counts'], queryFn: () => api<{ data: any[] }>(`/${kind}`, { query: { withCounts: 'true' } }).then((r) => r.data) });
  const [edit, setEdit] = useState<any>(null);
  const [error, setError] = useState<unknown>(null);
  const isCat = kind === 'categories';
  const parents = (q.data ?? []).filter((c) => !c.parentId);
  const nameOf = (id?: string) => q.data?.find((c) => c._id === id)?.name;
  const save = async () => {
    setError(null);
    try {
      const body = isCat ? { name: edit.name, parentId: edit.parentId || null, color: edit.color || undefined, sortOrder: Number(edit.sortOrder) || 0, ...(edit._id ? { active: edit.active !== false } : {}) } : { name: edit.name };
      if (edit._id) await api(`/${kind}/${edit._id}`, { method: 'PATCH', body });
      else await api(`/${kind}`, { body });
      setEdit(null); q.refetch(); toast.success('Saved');
    } catch (e) { setError(e); }
  };
  const title = isCat ? 'Categories' : 'Brands';
  return (
    <div className="max-w-4xl">
      <PageHeader title={title} subtitle={isCat ? 'Group products for the till (Browse), reports and the online shop. Categories can sit inside others (e.g. Drinks > Sodas).' : 'Manufacturers and brands of your products, for searching and reports.'}
        actions={can('products.manage') && <Button onClick={() => { setError(null); setEdit({ name: '', parentId: '', color: '#2f6b4f', sortOrder: 0 }); }}><Icon name="plus" className="h-4 w-4" />Add {isCat ? 'category' : 'brand'}</Button>} />
      <div className="card">
        <DataTable rows={q.data} loading={q.isLoading} empty={`No ${kind} yet`}
          columns={[
            { key: 'n', header: 'Name', render: (r: any) => <span className="flex items-center gap-2">{isCat && <span className="h-3 w-3 rounded-full" style={{ background: r.color || '#cbd5e1' }} />}<span className="font-semibold">{r.name}</span>{isCat && r.parentId && <span className="text-xs text-ink-500">in {nameOf(r.parentId)}</span>}</span> },
            { key: 'p', header: 'Products', className: 'num', render: (r: any) => r.productCount },
            ...(isCat ? [{ key: 's', header: '', render: (r: any) => (r.active === false ? <Badge>Hidden</Badge> : null) }] : []),
            { key: 'a', header: '', render: (r: any) => can('products.manage') && (
              <div className="flex gap-1">
                <Button size="sm" variant="secondary" onClick={() => { setError(null); setEdit({ ...r, parentId: r.parentId ?? '' }); }}>Edit</Button>
                <Button size="sm" variant="ghost" aria-label={`Delete ${r.name}`} onClick={async () => { if (await confirm({ title: `Delete ${r.name}?`, message: r.productCount ? `${r.productCount} product(s) use it: move them first.` : 'This cannot be undone.', danger: true, confirmLabel: 'Delete' })) api(`/${kind}/${r._id}`, { method: 'DELETE' }).then(() => { q.refetch(); toast.success('Deleted'); }).catch(toast.error); }}><Icon name="trash" className="h-4 w-4" /></Button>
              </div>
            ) },
          ]} />
      </div>
      {edit && (
        <Modal open onClose={() => setEdit(null)} title={edit._id ? `Edit ${edit.name}` : `New ${isCat ? 'category' : 'brand'}`} icon={isCat ? 'grid' : 'tag'} size="sm" footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={save} disabled={!edit.name?.trim()}>Save</Button></>}>
          <div className="space-y-3">
            <Field label="Name"><Input autoFocus value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            {isCat && (
              <>
                <Field label="Inside category"><Select value={edit.parentId} onChange={(e) => setEdit({ ...edit, parentId: e.target.value })} options={[{ value: '', label: 'None (top level)' }, ...parents.filter((p) => p._id !== edit._id).map((p) => ({ value: p._id, label: p.name }))]} /></Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Colour"><input type="color" className="h-10 w-full cursor-pointer rounded-sm border border-[#d5d9de]" value={edit.color || '#2f6b4f'} onChange={(e) => setEdit({ ...edit, color: e.target.value })} /></Field>
                  <Field label="Order" hint="Lower comes first"><Input inputMode="numeric" value={String(edit.sortOrder ?? 0)} onChange={(e) => setEdit({ ...edit, sortOrder: e.target.value.replace(/[^\d-]/g, '') })} /></Field>
                </div>
                {edit._id && <Checkbox label="Show at the till and in the shop" checked={edit.active !== false} onChange={(v) => setEdit({ ...edit, active: v })} />}
              </>
            )}
            <ErrorBox error={error} />
          </div>
        </Modal>
      )}
    </div>
  );
}
export const CategoriesPage = () => <NamedList kind="categories" />;
export const BrandsPage = () => <NamedList kind="brands" />;

// ---------------- stock alerts ----------------
export function StockAlertsPage() {
  const locs = useLocations();
  const [warehouseId, setWarehouseId] = useState('');
  const [days, setDays] = useState('30');
  const q = useQuery({ queryKey: ['stock-alerts', warehouseId, days], queryFn: () => api<{ data: any }>('/inventory/alerts', { query: { warehouseId: warehouseId || undefined, expiringWithinDays: days } }).then((r) => r.data), refetchInterval: 60_000 });
  const d = q.data;
  const levelCols = [
    { key: 'p', header: 'Product', render: (r: any) => <Link className="font-semibold text-brand-600 hover:underline" to={`/products/${r.productId}`}>{r.product.name}</Link> },
    { key: 's', header: 'SKU', render: (r: any) => r.product.sku },
    { key: 'w', header: 'Warehouse', render: (r: any) => r.warehouse },
    { key: 'q', header: 'In stock', className: 'num', render: (r: any) => <span className={r.qty <= 0 ? 'font-bold text-red-600' : 'font-semibold text-amber-600'}>{qty(r.qty)} {r.product.baseUnit}</span> },
    { key: 'r', header: 'Reorder at', className: 'num', render: (r: any) => (r.product.reorderLevel ? `${qty(r.product.reorderLevel)}` : '—') },
    { key: 'o', header: 'Suggested order', className: 'num', render: (r: any) => (r.product.reorderQty ? `${qty(r.product.reorderQty)} ${r.product.baseUnit}` : '—') },
  ];
  const batchCols = [
    { key: 'p', header: 'Product', render: (r: any) => r.productId?.name },
    { key: 'b', header: 'Batch', render: (r: any) => r.batchNo },
    { key: 'e', header: 'Expiry', render: (r: any) => date(r.expiryDate) },
    { key: 'q', header: 'Quantity', className: 'num', render: (r: any) => `${qty(r.qty)} ${r.productId?.baseUnit ?? ''}` },
  ];
  return (
    <div className="max-w-6xl">
      <PageHeader title="Stock alerts" subtitle="What to reorder or clear: out of stock, at or below the reorder level, and batches that expired or will expire soon."
        actions={<Link to="/purchasing" className="inline-flex items-center gap-1.5 rounded-sm bg-brand-500 px-3.5 py-2 text-sm font-semibold text-white hover:bg-brand-600"><Icon name="truck" className="h-4 w-4" />Order from suppliers</Link>} />
      <div className="mb-4 flex flex-wrap gap-3">
        <Select className="w-56" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} options={[{ value: '', label: 'All warehouses' }, ...(locs.data?.warehouses ?? []).map((w) => ({ value: w._id, label: w.name }))]} />
        <Select className="w-56" value={days} onChange={(e) => setDays(e.target.value)} options={['7', '14', '30', '60', '90'].map((x) => ({ value: x, label: `Expiring within ${x} days` }))} />
      </div>
      {!d ? <Loading /> : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Out of stock" value={d.counts.outOfStock} icon="alert" color="red" />
            <Stat label="Low stock" value={d.counts.low} icon="layers" color="yellow" />
            <Stat label="Expired batches" value={d.counts.expired} icon="calendar" color="purple" />
            <Stat label={`Expiring in ${d.expiringWithinDays} days`} value={d.counts.expiring} icon="clock" color="blue" />
          </div>
          <Section title="Out of stock" tone="red" rows={d.outOfStock} columns={levelCols} empty="Nothing is out of stock." />
          <Section title="Low stock (at or below reorder level)" tone="amber" rows={d.low} columns={levelCols} empty="Nothing is below its reorder level. Set reorder levels on products to get these alerts." />
          {(d.expired.length > 0 || d.expiring.length > 0) && (
            <>
              <Section title="Expired batches" tone="red" rows={d.expired} columns={batchCols} empty="No expired stock." />
              <Section title="Expiring soon" tone="amber" rows={d.expiring} columns={batchCols} empty="Nothing expires soon." />
            </>
          )}
        </>
      )}
    </div>
  );
}

function Section({ title, tone, rows, columns, empty }: { title: string; tone: 'red' | 'amber'; rows: any[]; columns: any[]; empty: string }) {
  return (
    <section className="mb-5">
      <h2 className={cx('mb-2 flex items-center gap-2 text-sm font-bold', tone === 'red' ? 'text-red-700 dark:text-red-300' : 'text-amber-700 dark:text-amber-300')}>{title}<Badge tone={tone}>{rows.length}</Badge></h2>
      <div className="card"><DataTable rows={rows.map((r, i) => ({ ...r, id: r._id ?? String(i) }))} columns={columns} empty={empty} /></div>
    </section>
  );
}

// ---------------- barcode verify ----------------
export function BarcodeVerifyPage() {
  const [code, setCode] = useState('');
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<unknown>(null);
  const [history, setHistory] = useState<{ code: string; ok: boolean; name?: string }[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const verify = async (c = code) => {
    const v = c.trim();
    if (!v) return;
    setError(null);
    try {
      const r = (await api<{ data: any }>('/barcodes/verify', { query: { code: v } })).data;
      setResult(r);
      const ok = r.checkDigitValid !== false && (r.products.length > 0 || Boolean(r.scale?.product));
      setHistory((h) => [{ code: v, ok, name: r.products[0]?.name ?? r.scale?.product?.name }, ...h].slice(0, 15));
    } catch (e) { setError(e); setResult(null); }
    setCode('');
    input.current?.focus();
  };
  const p = result?.products?.[0] ?? result?.scale?.product;
  let svg = '';
  try { if (result && /^[\x20-\x7e]+$/.test(result.code)) svg = code128Svg(result.code, 50, 2); } catch { /* not printable */ }
  return (
    <div className="max-w-5xl">
      <PageHeader title="Barcode verify" subtitle="Scan a barcode to check it before printing labels or receiving stock: is it well formed, and which product (and unit) does it belong to?" />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="space-y-4">
          <div className="card p-4">
            <form onSubmit={(e) => { e.preventDefault(); verify(); }} className="flex gap-2">
              <div className="relative flex-1">
                <Icon name="barcode" className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-ink-400" />
                <input ref={input} autoFocus value={code} onChange={(e) => setCode(e.target.value)} aria-label="Barcode to verify" placeholder="Scan or type a barcode" className="w-full rounded-md border-2 border-ink-800 py-2.5 pl-11 pr-3 text-[15px] focus:border-brand-500 focus:outline-none dark:border-ink-600 dark:bg-ink-900" />
              </div>
              <Button type="submit">Verify</Button>
            </form>
            <div className="mt-3"><ErrorBox error={error} /></div>
          </div>
          {result && (
            <div className="card space-y-4 p-5" data-testid="barcode-result">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-lg font-bold">{result.code}</span>
                <Badge tone="blue">{result.format}</Badge>
                {result.checkDigitValid === true && <Badge tone="green">Check digit correct</Badge>}
                {result.checkDigitValid === false && <Badge tone="red">Check digit wrong: mistyped or damaged</Badge>}
                {result.isbn && <Badge>ISBN {result.isbn}</Badge>}
                {result.duplicate && <Badge tone="red">On more than one product</Badge>}
              </div>
              {svg && <div className="rounded-md border border-ink-100 bg-white p-3 dark:border-ink-800" dangerouslySetInnerHTML={{ __html: svg.replace('<svg ', '<svg style="max-width:100%;height:60px" ') }} />}
              {result.scale && (
                <p className="rounded-md bg-sky-50 px-3 py-2 text-sm text-sky-800 dark:bg-sky-950/40 dark:text-sky-200">Scale barcode: item code <b>{result.scale.itemCode}</b>, {result.scale.weight !== undefined ? <>weight <b>{qty(result.scale.weight)}</b></> : <>price <b>{money(result.scale.priceCents)}</b></>}.</p>
              )}
              {p ? (
                <div className={cx('rounded-lg border p-4', p.active === false ? 'border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30' : 'border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/30')}>
                  <div className="text-xs font-bold uppercase tracking-wide text-ink-500">{p.active === false ? 'Product (inactive)' : 'Belongs to'}</div>
                  <div className="mt-1 text-lg font-bold">{p.name}</div>
                  <div className="text-sm text-ink-600 dark:text-ink-300">SKU {p.sku} · sold as <b>{result.products?.[0]?.unitCode ?? p.baseUnit}</b> · retail {money(p.prices?.retail)}</div>
                  <Link className="mt-2 inline-block text-sm font-semibold text-brand-600 hover:underline" to={`/products/${p._id}`}>Open product →</Link>
                  {result.products.length > 1 && <p className="mt-2 text-sm text-red-700">Also on: {result.products.slice(1).map((x: any) => x.name).join(', ')}</p>}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-ink-300 p-4 text-sm dark:border-ink-700">
                  <b>Not in your products.</b> {result.checkDigitValid === false ? 'Rescan it: the code looks damaged.' : 'Add it to a product (Products → product → Barcodes) or create a new product with it.'}
                  <div className="mt-2"><Link className="font-semibold text-brand-600 hover:underline" to="/products/new">Create a product →</Link></div>
                </div>
              )}
            </div>
          )}
        </div>
        <aside className="card p-4">
          <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-500">Checked this session</h3>
          {!history.length ? <p className="text-sm text-ink-500">Scanned codes appear here.</p> : (
            <ul className="space-y-1.5 text-sm">
              {history.map((h, i) => <li key={i} className="flex items-center gap-2"><span className={cx('h-2 w-2 shrink-0 rounded-full', h.ok ? 'bg-emerald-500' : 'bg-red-500')} /><span className="font-mono text-xs">{h.code}</span><span className="truncate text-ink-500">{h.name ?? 'not found'}</span></li>)}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}
