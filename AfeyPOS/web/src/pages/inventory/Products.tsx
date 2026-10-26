import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { STANDARD_UNITS, type ProductField } from '@afeypos/shared';
import { api, download } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useList, useLocations } from '../../lib/hooks';
import { money, qty } from '../../lib/format';
import { DataTable } from '../../components/DataTable';
import { Badge, Button, Card, Checkbox, ErrorBox, Field, Input, Loading, Modal, MoneyInput, PageHeader, Select, useToast } from '../../components/ui';
import { Icon } from '../../components/icons';

const FIELD_LABELS: Partial<Record<ProductField, string>> = {
  brand: 'Brand', dimensions: 'Dimensions', grade: 'Grade', specifications: 'Specifications', size: 'Size', color: 'Colour', material: 'Material', model: 'Model',
  genericName: 'Generic name', strength: 'Strength', dosageForm: 'Dosage form', abv: 'Alcohol % (ABV)', volumeMl: 'Volume (ml)', department: 'Department',
};
const FIELD_OPTIONS: Partial<Record<ProductField, string[]>> = {};
const FIELD_HINTS: Partial<Record<ProductField, string>> = {
  department: 'e.g. Fresh produce, Butchery, Dairy. Used for department sales reports.',
};
const ATTRIBUTE_FIELDS = Object.keys(FIELD_LABELS) as ProductField[];

export function ProductsPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [page, setPage] = useState(1);
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  useEffect(() => setQ(params.get('q') ?? ''), [params]);
  const [importing, setImporting] = useState(false);
  const list = useList(['products'], '/products', { page, q: q || undefined, limit: 25 });
  return (
    <div>
      <PageHeader title="Products" actions={<>
        <Button variant="secondary" onClick={() => download('/products-export.csv', 'products.csv')}><Icon name="download" className="h-4 w-4" />Export</Button>
        {can('products.manage') && <Button variant="secondary" onClick={() => setImporting(true)}><Icon name="upload" className="h-4 w-4" />Import CSV</Button>}
        {can('products.manage') && <Button onClick={() => nav('/products/new')}><Icon name="plus" className="h-4 w-4" />New product</Button>}
      </>} />
      <div className="card">
        <div className="border-b border-ink-100 p-3 dark:border-ink-800"><Input className="max-w-sm" placeholder="Search name, SKU, barcode or department" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></div>
        <DataTable rows={list.data?.data} loading={list.isLoading} error={list.error} page={page} total={list.data?.total} limit={25} onPage={setPage} onRowClick={(r: any) => nav(`/products/${r._id}`)} empty="No products yet"
          columns={[
            { key: 'name', header: 'Product', render: (r: any) => <div><div className="font-medium">{r.name}</div><div className="text-xs text-ink-500">{r.attributes?.author ? `${r.attributes.author} · ` : ''}{r.sku}{r.barcodes?.[0] ? ` · ${r.barcodes[0].code}` : ''}</div></div> },
            { key: 'type', header: 'Type', render: (r: any) => (r.type === 'stock' ? (r.trackSerials ? <Badge tone="blue">serialised</Badge> : r.trackBatches ? <Badge tone="blue">batches</Badge> : 'stock') : r.type) },
            { key: 'price', header: 'Retail', className: 'num', render: (r: any) => money(r.prices?.retail) },
            ...(can('products.cost') ? [{ key: 'cost', header: 'Cost', className: 'num', render: (r: any) => money(r.costCents) }] : []),
            { key: 'stock', header: 'In stock', className: 'num', render: (r: any) => (r.trackStock ? <span className={r.stock.qty <= r.reorderLevel ? 'font-medium text-red-600' : ''}>{qty(r.stock.qty)} {r.baseUnit}</span> : '—') },
            { key: 'status', header: '', render: (r: any) => (!r.active ? <Badge>archived</Badge> : null) },
          ]} />
      </div>
      {importing && <ImportModal onClose={() => setImporting(false)} />}
    </div>
  );
}

function ImportModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<unknown>(null);
  const run = async (commit: boolean) => {
    setError(null);
    try {
      const r = await api<{ data: any }>('/products-import', { body: { csv, commit } });
      setResult(r.data);
      if (r.data.committed) qc.invalidateQueries({ queryKey: ['products'] });
    } catch (e) { setError(e); }
  };
  return (
    <Modal open onClose={onClose} title="Import products from CSV" size="lg" footer={<><Button variant="secondary" onClick={() => run(false)} disabled={!csv}>Check file</Button><Button onClick={() => run(true)} disabled={!result || result.errors > 0 || result.committed}>Import</Button></>}>
      <p className="mb-2 text-sm text-ink-500">Columns: sku, name, type, category, baseUnit, barcode, cost, retail, wholesale, contractor, taxRatePercent, reorderLevel, active. Existing SKUs are updated. Export first to get a template.</p>
      <input type="file" accept=".csv,text/csv" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setCsv(await f.text()); setResult(null); } }} />
      <ErrorBox error={error} />
      {result && (
        <div className="mt-3 text-sm">
          <p>{result.committed ? 'Imported.' : `${result.results.length} rows checked, ${result.errors} errors.`}</p>
          <ul className="mt-2 max-h-60 overflow-y-auto">{result.results.filter((r: any) => r.action === 'error').map((r: any) => <li key={r.row} className="text-red-600">Row {r.row} ({r.sku || 'no SKU'}): {r.error}</li>)}</ul>
        </div>
      )}
    </Modal>
  );
}

type ProductForm = Record<string, any>;

const emptyProduct = (baseUnit = 'pc'): ProductForm => ({
  name: '', sku: '', type: 'stock', categoryId: '', description: '', baseUnit, units: [], barcodes: [], costCents: 0, prices: { retail: null, wholesale: null, contractor: null }, priceTiers: [],
  minOrderQty: 0, taxRateBp: null, trackStock: true, trackBatches: false, trackSerials: false, allowFractional: false, reorderLevel: 0, reorderQty: 0, attributes: {},
  warrantyMonths: 0, requiresPrescription: false, ageRestricted: false, minAge: 18, soldByWeight: false, plu: '', active: true,
});

export function ProductEditPage() {
  const { id } = useParams();
  const isNew = id === 'new';
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const { me, can } = useAuth();
  const caps = me!.capabilities;
  const has = (f: ProductField) => caps.productFields.includes(f);
  const locs = useLocations();
  const cats = useQuery({ queryKey: ['categories'], queryFn: () => api<{ data: any[] }>('/categories').then((r) => r.data) });
  const brands = useQuery({ queryKey: ['brands'], queryFn: () => api<{ data: any[] }>('/brands').then((r) => r.data) });
  // Units from Inventory > Units, plus the standard ones.
  const unitList = useQuery({ queryKey: ['units'], queryFn: () => api<{ data: any[] }>('/units').then((r) => r.data) });
  const unitOptions = [...new Map([...STANDARD_UNITS.map((u) => [u.code, `${u.name} (${u.code})`] as const), ...(unitList.data ?? []).filter((u) => u.active !== false && !u.unlisted).map((u) => [u.code, `${u.name} (${u.code})`] as const)]).entries()].map(([value, label]) => ({ value, label }));
  const existing = useQuery({ queryKey: ['product', id], queryFn: () => api<{ data: any }>(`/products/${id}`).then((r) => r.data), enabled: !isNew });
  const [p, setP] = useState<ProductForm>(emptyProduct(caps.units[0]));
  const [opening, setOpening] = useState<{ qty: string; costCents: number | null; batchNo: string; expiryDate: string; serials: string }>({ qty: '', costCents: null, batchNo: '', expiryDate: '', serials: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (existing.data) setP({ ...emptyProduct(), ...existing.data, categoryId: existing.data.categoryId ?? '', plu: existing.data.plu ?? '' });
  }, [existing.data]);

  if (!isNew && existing.isLoading) return <Loading />;
  const set = (k: string, v: any) => setP((x) => ({ ...x, [k]: v }));
  const setAttr = (k: string, v: any) => setP((x) => ({ ...x, attributes: { ...x.attributes, [k]: v } }));
  const units = p.units.filter((u: any) => u.code !== p.baseUnit);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: ProductForm = { ...p, categoryId: p.categoryId || null, brandId: p.brandId || null, plu: p.plu || null, prices: Object.fromEntries(Object.entries(p.prices).filter(([, v]) => v !== null && v !== undefined)) };
      for (const k of ['_id', 'tenantId', 'createdAt', 'updatedAt', '__v', 'levels', 'variants', 'stock', 'parentId'] as const) delete body[k];
      if (isNew && opening.qty && Number(opening.qty) > 0) {
        const wh = locs.data?.warehouses.find((w) => w.isDefault) ?? locs.data?.warehouses[0];
        body.openingStock = [{ warehouseId: wh?._id, qty: Number(opening.qty), unitCostCents: opening.costCents ?? p.costCents, batchNo: opening.batchNo || undefined, expiryDate: opening.expiryDate || undefined, serials: opening.serials ? opening.serials.split(/[,\s]+/).filter(Boolean) : undefined }];
      }
      const r = isNew ? await api<{ data: any }>('/products', { body }) : await api<{ data: any }>(`/products/${id}`, { method: 'PUT', body });
      toast.success('Product saved');
      qc.invalidateQueries({ queryKey: ['products'] });
      nav(`/products/${r.data._id}`, { replace: true });
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  const editable = can('products.manage');
  return (
    <div className="max-w-5xl">
      <PageHeader title={isNew ? 'New product' : p.name} subtitle={!isNew ? p.sku : undefined} actions={editable && <><Button variant="secondary" onClick={() => nav('/products')}>Cancel</Button><Button loading={busy} onClick={save}>Save</Button></>} />
      <ErrorBox error={error} />
      <div className="mt-3 grid gap-4 lg:grid-cols-3">
        <Card title="Details" className="lg:col-span-2">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" className="sm:col-span-2"><Input value={p.name} onChange={(e) => set('name', e.target.value)} /></Field>
            <Field label="SKU / code"><Input value={p.sku} onChange={(e) => set('sku', e.target.value)} /></Field>
            <Field label="Category"><Select value={p.categoryId} onChange={(e) => set('categoryId', e.target.value)} placeholder="None" options={(cats.data ?? []).map((c) => ({ value: c._id, label: c.name }))} /></Field>
            <Field label="Brand"><Select value={p.brandId ?? ''} onChange={(e) => set('brandId', e.target.value)} placeholder="None" options={(brands.data ?? []).map((b) => ({ value: b._id, label: b.name }))} /></Field>
            <Field label="Type"><Select value={p.type} onChange={(e) => set('type', e.target.value)} options={[{ value: 'stock', label: 'Stocked item' }, { value: 'service', label: 'Service' }, { value: 'non_stock', label: 'Non-stock item' }]} /></Field>
            <Field label="Base unit (stock is counted in this unit)"><Select value={p.baseUnit} onChange={(e) => set('baseUnit', e.target.value)} options={unitOptions.some((u) => u.value === p.baseUnit) ? unitOptions : [{ value: p.baseUnit, label: p.baseUnit }, ...unitOptions]} /></Field>
            {ATTRIBUTE_FIELDS.filter(has).map((f) => (
              <Field key={f} label={FIELD_LABELS[f]!} hint={FIELD_HINTS[f]}>
                {FIELD_OPTIONS[f] ? (
                  <Select value={p.attributes?.[f] ?? ''} onChange={(e) => setAttr(f, e.target.value)} placeholder="Not set" options={FIELD_OPTIONS[f]!.map((o) => ({ value: o, label: o }))} />
                ) : (
                  <Input value={p.attributes?.[f] ?? ''} onChange={(e) => setAttr(f, e.target.value)} />
                )}
              </Field>
            ))}
            <Field label="Description" className="sm:col-span-2"><Input value={p.description ?? ''} onChange={(e) => set('description', e.target.value)} /></Field>
          </div>
        </Card>
        <Card title="Stock control">
          <div className="space-y-3">
            <Checkbox label="Track stock" checked={p.trackStock} onChange={(v) => set('trackStock', v)} />
            {caps.modules.includes('fractionalQuantities') && <Checkbox label="Allow fractional quantities (e.g. 2.5 m)" checked={p.allowFractional} onChange={(v) => set('allowFractional', v)} />}
            {caps.modules.includes('batchExpiry') && <Checkbox label="Track batches & expiry dates" checked={p.trackBatches} onChange={(v) => set('trackBatches', v)} />}
            {caps.modules.includes('serialNumbers') && <Checkbox label="Track serial numbers / IMEI" checked={p.trackSerials} onChange={(v) => set('trackSerials', v)} />}
            {has('warrantyMonths') && <Field label="Warranty (months)"><Input type="number" min={0} value={p.warrantyMonths} onChange={(e) => set('warrantyMonths', Number(e.target.value))} /></Field>}
            {has('requiresPrescription') && <Checkbox label="Prescription only (POM)" checked={p.requiresPrescription} onChange={(v) => set('requiresPrescription', v)} />}
            {has('ageRestricted') && <><Checkbox label="Age restricted" checked={p.ageRestricted} onChange={(v) => set('ageRestricted', v)} />{p.ageRestricted && <Field label="Minimum age"><Input type="number" value={p.minAge} onChange={(e) => set('minAge', Number(e.target.value))} /></Field>}</>}
            {has('plu') && <Field label="Scale PLU code" hint="Used for variable-weight barcodes"><Input value={p.plu} onChange={(e) => set('plu', e.target.value)} /></Field>}
            <div className="grid grid-cols-2 gap-2">
              <Field label="Reorder level"><Input type="number" min={0} value={p.reorderLevel} onChange={(e) => set('reorderLevel', Number(e.target.value))} /></Field>
              <Field label="Reorder qty"><Input type="number" min={0} value={p.reorderQty} onChange={(e) => set('reorderQty', Number(e.target.value))} /></Field>
            </div>
            {caps.modules.includes('bulkDiscounts') && <Field label="Minimum order (base units)"><Input type="number" min={0} value={p.minOrderQty} onChange={(e) => set('minOrderQty', Number(e.target.value))} /></Field>}
          </div>
        </Card>
        {caps.modules.includes('etims') && (
          <Card title="KRA eTIMS">
            <div className="space-y-3">
              <Field label="Item classification code" hint="KRA's code for this kind of item (from the eTIMS code list)"><Input inputMode="numeric" value={p.etims?.itemClsCd ?? ''} onChange={(e) => set('etims', { ...p.etims, itemClsCd: e.target.value.replace(/\D/g, '') })} /></Field>
              <Field label="Tax type" hint="Leave as automatic to follow the VAT rate">
                <Select value={p.etims?.taxTyCd ?? ''} onChange={(e) => set('etims', { ...p.etims, taxTyCd: e.target.value })} placeholder="Automatic (from VAT rate)"
                  options={[{ value: 'B', label: 'B: VAT 16%' }, { value: 'E', label: 'E: VAT 8%' }, { value: 'C', label: 'C: zero-rated' }, { value: 'A', label: 'A: exempt' }, { value: 'D', label: 'D: non-VAT' }]} />
              </Field>
              {p.etims?.itemCd && <div className="text-xs text-ink-500">Item code {p.etims.itemCd}{p.etims.registeredAt ? ' · registered with KRA' : ' · not registered yet'}</div>}
              {p.etims?.error && <div className="text-xs text-red-600">{p.etims.error}</div>}
            </div>
          </Card>
        )}
        {caps.modules.includes('onlineStore') && (
          <Card title="Online shop">
            <div className="space-y-3">
              <Checkbox label="Sell on the online shop" checked={Boolean(p.online?.enabled)} onChange={(v) => set('online', { ...p.online, enabled: v })} />
              {p.online?.enabled && <>
                <Checkbox label="Feature on the home page" checked={Boolean(p.online?.featured)} onChange={(v) => set('online', { ...p.online, featured: v })} />
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Was price (shows as a deal)" hint="Leave empty unless it is on offer"><MoneyInput value={p.online?.compareAtCents ?? null} onChange={(v) => set('online', { ...p.online, compareAtCents: v ?? null })} /></Field>
                  <Field label="Badge on the shop" hint="e.g. New, Organic, Bestseller"><Input maxLength={20} value={p.online?.badge ?? ''} onChange={(e) => set('online', { ...p.online, badge: e.target.value })} /></Field>
                </div>
                <Field label="Description for shoppers"><textarea className="input min-h-20" maxLength={2000} value={p.online?.description ?? ''} onChange={(e) => set('online', { ...p.online, description: e.target.value })} /></Field>
                <p className="text-xs text-ink-500">Shown with the retail price, the photos below and the stock of the shop warehouse.</p>
              </>}
            </div>
          </Card>
        )}
        <Card title="Prices" className="lg:col-span-2">
          <div className="grid gap-3 sm:grid-cols-4">
            {can('products.cost') && <Field label="Cost (per base unit)"><MoneyInput value={p.costCents} onChange={(v) => set('costCents', v ?? 0)} /></Field>}
            {caps.priceLists.map((pl) => <Field key={pl} label={`${pl} price`}><MoneyInput value={p.prices?.[pl]} onChange={(v) => set('prices', { ...p.prices, [pl]: v })} /></Field>)}
            <Field label="Tax rate %" hint="Blank = business default"><Input inputMode="decimal" value={p.taxRateBp === null || p.taxRateBp === undefined ? '' : p.taxRateBp / 100} onChange={(e) => set('taxRateBp', e.target.value === '' ? null : Math.round(Number(e.target.value) * 100))} /></Field>
          </div>
          {can('products.cost') && p.prices?.retail && p.costCents ? <p className="mt-2 text-xs text-ink-500">Retail margin {Math.round(((p.prices.retail - p.costCents) / p.prices.retail) * 100)}% (before tax)</p> : null}
          {caps.modules.includes('bulkDiscounts') && (
            <div className="mt-4">
              <div className="label">Quantity price tiers (price per base unit)</div>
              {p.priceTiers.map((t: any, i: number) => (
                <div key={i} className="mb-2 flex gap-2">
                  <Select value={t.priceList} onChange={(e) => set('priceTiers', p.priceTiers.map((x: any, j: number) => (j === i ? { ...x, priceList: e.target.value } : x)))} options={caps.priceLists.map((x) => ({ value: x, label: x }))} />
                  <Input type="number" placeholder="Min qty" value={t.minQty} onChange={(e) => set('priceTiers', p.priceTiers.map((x: any, j: number) => (j === i ? { ...x, minQty: Number(e.target.value) } : x)))} />
                  <MoneyInput value={t.priceCents} onChange={(v) => set('priceTiers', p.priceTiers.map((x: any, j: number) => (j === i ? { ...x, priceCents: v ?? 0 } : x)))} />
                  <Button variant="ghost" onClick={() => set('priceTiers', p.priceTiers.filter((_: any, j: number) => j !== i))}><Icon name="x" className="h-4 w-4" /></Button>
                </div>
              ))}
              <Button size="sm" variant="secondary" onClick={() => set('priceTiers', [...p.priceTiers, { priceList: caps.priceLists[0], minQty: 10, priceCents: p.prices?.retail ?? 0 }])}>Add tier</Button>
            </div>
          )}
        </Card>
        <Card title="Barcodes">
          {p.barcodes.map((b: any, i: number) => (
            <div key={i} className="mb-2 flex gap-2">
              <Input value={b.code} onChange={(e) => set('barcodes', p.barcodes.map((x: any, j: number) => (j === i ? { ...x, code: e.target.value } : x)))} placeholder="Scan barcode" />
              <Select className="w-28" value={b.unitCode} onChange={(e) => set('barcodes', p.barcodes.map((x: any, j: number) => (j === i ? { ...x, unitCode: e.target.value } : x)))} options={[p.baseUnit, ...units.map((u: any) => u.code)].map((c) => ({ value: c, label: c }))} />
              <Button variant="ghost" onClick={() => set('barcodes', p.barcodes.filter((_: any, j: number) => j !== i))}><Icon name="x" className="h-4 w-4" /></Button>
            </div>
          ))}
          <Button size="sm" variant="secondary" onClick={() => set('barcodes', [...p.barcodes, { code: '', unitCode: p.baseUnit }])}>Add barcode</Button>
        </Card>
        {(caps.modules.includes('unitConversions') || units.length > 0) && (
          <Card title="Selling & purchase units" className="lg:col-span-3">
            <p className="mb-2 text-xs text-ink-500">e.g. Carton = 24 pieces, Bag = 50 kg, Foot = 0.3048 m. Leave unit prices blank to use base price × factor.</p>
            {units.map((u: any, i: number) => {
              const upd = (patch: any) => set('units', [p.units.find((x: any) => x.code === p.baseUnit), ...units.map((x: any, j: number) => (j === i ? { ...x, ...patch } : x))].filter(Boolean));
              return (
                <div key={i} className="mb-2 grid gap-2 sm:grid-cols-6">
                  <Input placeholder="Code" list="afey-units" value={u.code} onChange={(e) => { const known = unitList.data?.find((x) => x.code === e.target.value); upd({ code: e.target.value, ...(known && !u.name ? { name: known.name } : {}) }); }} />
                  <Input placeholder="Name" value={u.name} onChange={(e) => upd({ name: e.target.value })} />
                  <Input placeholder={`Factor (${p.baseUnit})`} type="number" step="any" value={u.factor} onChange={(e) => upd({ factor: Number(e.target.value) })} />
                  {caps.priceLists.slice(0, 2).map((pl) => <MoneyInput key={pl} placeholder={`${pl} price`} value={u.prices?.[pl]} onChange={(v) => upd({ prices: { ...u.prices, [pl]: v } })} />)}
                  <Button variant="ghost" onClick={() => set('units', p.units.filter((x: any) => x !== u))}><Icon name="x" className="h-4 w-4" /></Button>
                </div>
              );
            })}
            <datalist id="afey-units">{unitOptions.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}</datalist>
            <Button size="sm" variant="secondary" onClick={() => set('units', [...(p.units.length ? p.units : [{ code: p.baseUnit, name: p.baseUnit, factor: 1, prices: {} }]), { code: '', name: '', factor: 1, prices: {} }])}>Add unit</Button>
          </Card>
        )}
        {isNew && p.type === 'stock' && (
          <Card title="Opening stock" className="lg:col-span-3">
            <div className="grid gap-3 sm:grid-cols-5">
              <Field label={`Quantity (${p.baseUnit})`}><Input type="number" step="any" value={opening.qty} onChange={(e) => setOpening({ ...opening, qty: e.target.value })} /></Field>
              {can('products.cost') && <Field label="Unit cost"><MoneyInput value={opening.costCents} onChange={(v) => setOpening({ ...opening, costCents: v })} /></Field>}
              {p.trackBatches && <><Field label="Batch no."><Input value={opening.batchNo} onChange={(e) => setOpening({ ...opening, batchNo: e.target.value })} /></Field><Field label="Expiry"><Input type="date" value={opening.expiryDate} onChange={(e) => setOpening({ ...opening, expiryDate: e.target.value })} /></Field></>}
              {p.trackSerials && <Field label="Serial numbers" className="sm:col-span-2"><Input value={opening.serials} onChange={(e) => setOpening({ ...opening, serials: e.target.value })} placeholder="Comma separated" /></Field>}
            </div>
          </Card>
        )}
        {editable && <ImagesCard images={p.images ?? []} onChange={(images) => set('images', images)} />}
        {!isNew && existing.data?.levels && (
          <Card title="Stock by location" className="lg:col-span-3">
            <ul className="text-sm">{existing.data.levels.map((l: any) => <li key={l._id} className="flex justify-between py-1"><span>{locs.data?.warehouses.find((w) => w._id === l.warehouseId)?.name}</span><span className="tabular-nums">{qty(l.qty)} {p.baseUnit} · reserved {qty(l.reserved)} · in transit {qty(l.inTransit)} · avg cost {money(l.avgCostCents)}</span></li>)}</ul>
          </Card>
        )}
      </div>
    </div>
  );
}

/** Product images are uploaded to tenant-scoped storage and fetched with the user's session. */
function ImagesCard({ images, onChange }: { images: string[]; onChange: (v: string[]) => void }) {
  const toast = useToast();
  const [urls, setUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    (async () => {
      const next: Record<string, string> = {};
      for (const src of images) {
        try {
          const res = await api<Response>(src.replace(/^\/api\/v1/, ''), { raw: true });
          if (res.ok) next[src] = URL.createObjectURL(await res.blob());
        } catch { /* missing file */ }
      }
      if (alive) setUrls(next);
    })();
    return () => { alive = false; };
  }, [images]);
  const upload = async (file: File) => {
    if (file.size > 3 * 1024 * 1024) return toast.error('Images must be smaller than 3 MB');
    const base64 = await new Promise<string>((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]); r.readAsDataURL(file); });
    try {
      const r = await api<{ data: { url: string } }>('/files', { body: { base64 } });
      onChange([...images, r.data.url]);
    } catch (e) { toast.error(e); }
  };
  return (
    <Card title="Images" className="lg:col-span-3">
      <div className="flex flex-wrap gap-3">
        {images.map((src) => (
          <div key={src} className="relative h-24 w-24 overflow-hidden rounded-lg border border-ink-200 dark:border-ink-700">
            {urls[src] ? <img src={urls[src]} alt="" className="h-full w-full object-cover" /> : <div className="p-2 text-xs text-ink-400">loading</div>}
            <button type="button" aria-label="Remove image" className="absolute right-1 top-1 rounded bg-white/80 p-0.5" onClick={() => onChange(images.filter((x) => x !== src))}><Icon name="x" className="h-3.5 w-3.5" /></button>
          </div>
        ))}
        <label className="flex h-24 w-24 cursor-pointer items-center justify-center rounded-lg border border-dashed border-ink-300 text-xs text-ink-500 hover:bg-ink-50 dark:border-ink-700">
          <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          Add image
        </label>
      </div>
      <p className="mt-2 text-xs text-ink-500">Save the product to keep image changes.</p>
    </Card>
  );
}
