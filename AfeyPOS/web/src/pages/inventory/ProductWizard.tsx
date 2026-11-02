import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import {
  SELLING_METHODS, STANDARD_UNITS, UNIT_PRESETS, addTax, detectBarcode, marginBp, markupBp, priceForMargin, priceForMarkup, pricingWarnings, removeTax, unitProblems,
  type SellingMethod,
} from '@afeypos/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useLocations } from '../../lib/hooks';
import { money } from '../../lib/format';
import { Badge, Button, Card, Checkbox, ErrorBox, Field, Input, MoneyInput, PageHeader, Select, useToast } from '../../components/ui';
import { Icon } from '../../components/icons';

const STEPS = ['Identify', 'Selling method', 'Units', 'Pricing', 'Barcodes & SKU', 'Inventory', 'Hardware & labels', 'Review'] as const;

type Unit = { code: string; name: string; factor: number; retail: number | null };
type Variant = { name: string; values: string };

function useDebounced<T>(v: T, ms = 350) {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

const pct = (bp: number | null) => (bp === null ? '—' : `${(bp / 100).toFixed(1)}%`);

/** Product creation wizard: eight short steps from name to review. Suggestions only, never automatic price changes. */
export function ProductWizardPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { me, can } = useAuth();
  const caps = me!.capabilities;
  const settings = me!.tenant.settings ?? {};
  const bizIncl: boolean = settings.pricesIncludeTax ?? true;
  const locs = useLocations();
  const cats = useQuery({ queryKey: ['categories'], queryFn: () => api<{ data: any[] }>('/categories').then((r) => r.data) });
  const brands = useQuery({ queryKey: ['brands'], queryFn: () => api<{ data: any[] }>('/brands').then((r) => r.data) });
  const suppliers = useQuery({ queryKey: ['suppliers', 'all'], queryFn: () => api<{ data: any[] }>('/suppliers', { query: { limit: 200 } }).then((r) => r.data), enabled: can('suppliers.read') });

  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [brandId, setBrandId] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<'stock' | 'service' | 'non_stock'>('stock');
  const [method, setMethod] = useState<SellingMethod>('unit');
  const [baseUnit, setBaseUnit] = useState('pc');
  const [units, setUnits] = useState<Unit[]>([]);
  const [variants, setVariants] = useState<Variant[]>([{ name: 'Size', values: '' }]);
  const [costCents, setCostCents] = useState<number | null>(null);
  const [retail, setRetail] = useState<number | null>(null);
  const [wholesale, setWholesale] = useState<number | null>(null);
  const [minPrice, setMinPrice] = useState<number | null>(null);
  const [entryIncl, setEntryIncl] = useState(bizIncl);
  const [taxPct, setTaxPct] = useState('');
  const [branchPrices, setBranchPrices] = useState<Record<string, number | null>>({});
  const [targetMargin, setTargetMargin] = useState('');
  const [targetMarkup, setTargetMarkup] = useState('');
  const [sku, setSku] = useState('');
  const [barcodes, setBarcodes] = useState<{ code: string; unitCode: string }[]>([]);
  const [scan, setScan] = useState('');
  const [trackStock, setTrackStock] = useState(true);
  const [trackBatches, setTrackBatches] = useState(false);
  const [trackSerials, setTrackSerials] = useState(false);
  const [warehouseId, setWarehouseId] = useState('');
  const [openingQty, setOpeningQty] = useState('');
  const [batchNo, setBatchNo] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [serials, setSerials] = useState('');
  const [reorderLevel, setReorderLevel] = useState('0');
  const [reorderQty, setReorderQty] = useState('0');
  const [maxStock, setMaxStock] = useState('0');
  const [binLocation, setBinLocation] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [plu, setPlu] = useState('');
  const [labelCopies, setLabelCopies] = useState('1');
  const [labelPrice, setLabelPrice] = useState(true);
  const [online, setOnline] = useState(false);
  const [acceptWarnings, setAcceptWarnings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const rateBp = taxPct === '' ? (settings.defaultTaxRateBp ?? 1600) : Math.round(Number(taxPct) * 100);
  /** Prices are stored the way the business keeps them (with or without VAT); convert what was typed. */
  const toStored = (c: number | null) => (c === null ? null : entryIncl === bizIncl ? c : entryIncl ? removeTax(c, rateBp) : addTax(c, rateBp));
  const netOf = (c: number) => (entryIncl ? removeTax(c, rateBp) : c);
  const cost = costCents ?? 0;
  const defaultWh = locs.data?.warehouses.find((w) => w.isDefault) ?? locs.data?.warehouses[0];
  const branches = (locs.data?.branches ?? []) as any[];
  const multiBranch = caps.modules.includes('multiBranch') && branches.length > 1;
  const methodInfo = SELLING_METHODS.find((m) => m.key === method)!;
  const weighed = method === 'weight';
  const showPlu = weighed || caps.productFields.includes('plu');

  // Step 1: duplicates and category suggestions from this business's own catalogue.
  const dName = useDebounced(name);
  const dScan = useDebounced(barcodes.map((b) => b.code).join(','));
  const similar = useQuery({
    queryKey: ['similar', dName, dScan],
    queryFn: () => api<{ data: { exact: any[]; similar: any[]; categories: any[] } }>('/catalog/similar', { query: { name: dName || undefined, barcode: barcodes[0]?.code || undefined } }).then((r) => r.data),
    enabled: dName.length >= 3 || Boolean(barcodes[0]?.code),
  });

  const pickMethod = (m: SellingMethod) => {
    const info = SELLING_METHODS.find((x) => x.key === m)!;
    setMethod(m);
    if (!(info.baseUnits as readonly string[]).includes(baseUnit)) setBaseUnit(info.baseUnits[0]);
    if (m === 'pack' && !units.length) setUnits([{ code: 'ctn', name: 'Carton (24)', factor: 24, retail: null }]);
  };

  const unitIssues = unitProblems(baseUnit, units);
  const storedUnits = units.map((u) => ({ code: u.code.trim(), name: u.name.trim() || u.code.trim(), factor: Number(u.factor), prices: u.retail !== null ? { retail: toStored(u.retail) } : {} }));
  const variantCombos = useMemo(() => {
    if (method !== 'variants') return [];
    const axes = variants.map((v) => ({ name: v.name.trim(), values: v.values.split(',').map((x) => x.trim()).filter(Boolean) })).filter((a) => a.name && a.values.length);
    if (!axes.length) return [];
    let combos: Record<string, string>[] = [{}];
    for (const a of axes) combos = combos.flatMap((c) => a.values.map((v) => ({ ...c, [a.name]: v })));
    return combos.slice(0, 100);
  }, [method, variants]);

  const warnings = pricingWarnings({
    costCents: cost, retailCents: toStored(retail), wholesaleCents: toStored(wholesale),
    minPriceCents: toStored(minPrice), pricesIncludeTax: bizIncl, taxRateBp: rateBp,
    units: units.filter((u) => u.retail !== null).map((u) => ({ code: u.code, factor: Number(u.factor), retailCents: toStored(u.retail) })),
    branchPrices: branches.filter((b) => branchPrices[b._id] != null).map((b) => ({ name: b.name, retailCents: toStored(branchPrices[b._id]) })),
  });
  const blocking = warnings.filter((w) => w.level === 'error');
  const barcodeInfo = barcodes.map((b) => ({ ...b, info: b.code ? detectBarcode(b.code) : null }));

  const suggestSku = async () => {
    const r = await api<{ data: { sku: string } }>('/catalog/next-sku', { query: { categoryId: categoryId || undefined, name: categoryId ? undefined : name } });
    setSku(r.data.sku);
  };
  const generateBarcode = async () => {
    try {
      const r = await api<{ data: { codes: string[] } }>('/barcodes/generate', { body: { count: 1 } });
      setBarcodes((b) => [...b, { code: r.data.codes[0], unitCode: baseUnit }]);
    } catch (e) { setError(e); }
  };
  const nextPlu = async () => {
    const r = await api<{ data: { plu: string | null } }>('/catalog/next-plu');
    if (r.data.plu) setPlu(r.data.plu);
  };
  const pluCheck = useQuery({
    queryKey: ['plu-check', plu],
    queryFn: () => api<{ data: { check?: { free: boolean; product?: { name: string } } } }>('/catalog/next-plu', { query: { check: plu } }).then((r) => r.data.check),
    enabled: /^\d{1,6}$/.test(plu),
  });
  const addScan = () => {
    const code = scan.trim();
    if (!code) return;
    if (barcodes.some((b) => b.code === code)) { toast.error('That barcode is already in the list'); return; }
    setBarcodes((b) => [...b, { code, unitCode: baseUnit }]);
    setScan('');
  };

  const stepProblem = (i: number): string | null => {
    if (i === 0 && !name.trim()) return 'Enter the product name';
    if (i === 2 && unitIssues.length) return unitIssues[0];
    if (i === 2 && method === 'variants' && !variantCombos.length) return 'Add at least one variant value (e.g. Size: S, M, L)';
    if (i === 4 && !sku.trim()) return 'Enter or suggest a SKU';
    if (i === 4 && barcodeInfo.some((b) => !b.code.trim())) return 'Remove the empty barcode row';
    if (i === 6 && plu && pluCheck.data && !pluCheck.data.free) return `PLU ${plu} is already used by ${pluCheck.data.product?.name}`;
    return null;
  };
  const firstProblem = STEPS.map((_, i) => stepProblem(i)).find(Boolean) ?? null;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const fractional = methodInfo.fractional || storedUnits.some((u) => u.factor % 1 !== 0);
      const body: Record<string, unknown> = {
        name: name.trim(), sku: sku.trim(), type, categoryId: categoryId || null, brandId: brandId || null, description: description || undefined,
        sellingMethod: method, baseUnit, units: storedUnits, barcodes,
        costCents: cost, prices: { ...(retail !== null ? { retail: toStored(retail) } : {}), ...(wholesale !== null ? { wholesale: toStored(wholesale) } : {}) },
        minPriceCents: toStored(minPrice), taxRateBp: taxPct === '' ? null : rateBp,
        branchPrices: Object.entries(branchPrices).filter(([, v]) => v != null).map(([branchId, v]) => ({ branchId, retail: toStored(v) })),
        trackStock: type === 'stock' && trackStock, trackBatches, trackSerials, allowFractional: fractional && !trackSerials, soldByWeight: weighed,
        reorderLevel: Number(reorderLevel) || 0, reorderQty: Number(reorderQty) || 0, maxStock: Number(maxStock) || 0, binLocation: binLocation || undefined,
        supplierId: supplierId || null, plu: plu || null, label: { copies: Number(labelCopies) || 1, showPrice: labelPrice }, online: online ? { enabled: true } : undefined,
      };
      const wh = warehouseId || defaultWh?._id;
      if (type === 'stock' && Number(openingQty) > 0 && wh) {
        body.openingStock = [{ warehouseId: wh, qty: Number(openingQty), unitCostCents: cost, batchNo: batchNo || undefined, expiryDate: expiryDate || undefined, serials: serials ? serials.split(/[,\s]+/).filter(Boolean) : undefined }];
      }
      const r = await api<{ data: any }>('/products', { body });
      for (const combo of variantCombos) {
        const suffix = Object.values(combo).join(' ');
        await api('/products', { body: { ...body, openingStock: undefined, barcodes: [], plu: null, name: `${body.name} ${suffix}`, sku: `${body.sku}-${Object.values(combo).map((v) => v.toUpperCase().replace(/[^A-Z0-9]/g, '')).join('-')}`, parentId: r.data._id, variantAttributes: combo } });
      }
      toast.success(variantCombos.length ? `Product saved with ${variantCombos.length} variants` : 'Product saved');
      qc.invalidateQueries({ queryKey: ['products'] });
      nav(`/products/${r.data._id}`, { replace: true });
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  const problem = stepProblem(step);
  const unitChoices = [...new Set([...(methodInfo.baseUnits as readonly string[]), ...STANDARD_UNITS.map((u) => u.code), baseUnit])];

  return (
    <div className="max-w-5xl">
      <PageHeader title="New product" subtitle={<span>Step {step + 1} of {STEPS.length}: {STEPS[step]} · <Link className="text-brand-600 hover:underline" to="/products/new/classic">Use the one-page form</Link></span>}
        actions={<Button variant="secondary" onClick={() => nav('/products')}>Cancel</Button>} />
      <ol className="mb-4 flex flex-wrap gap-1" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s}>
            <button type="button" onClick={() => setStep(i)} aria-current={i === step ? 'step' : undefined}
              className={`rounded-full px-3 py-1 text-xs font-medium ${i === step ? 'bg-brand-600 text-white' : stepProblem(i) && i < step ? 'bg-amber-100 text-amber-800' : 'bg-ink-100 text-ink-700 dark:bg-ink-800 dark:text-ink-200'}`}>
              {i + 1}. {s}
            </button>
          </li>
        ))}
      </ol>
      <ErrorBox error={error} />

      {step === 0 && (
        <Card title="What is it?">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" className="sm:col-span-2"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Brookside Fresh Milk 500ml" /></Field>
            <Field label="Category"><Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} placeholder="None" options={(cats.data ?? []).map((c) => ({ value: c._id, label: c.name }))} /></Field>
            <Field label="Brand"><Select value={brandId} onChange={(e) => setBrandId(e.target.value)} placeholder="None" options={(brands.data ?? []).map((b) => ({ value: b._id, label: b.name }))} /></Field>
            <Field label="Type"><Select value={type} onChange={(e) => setType(e.target.value as any)} options={[{ value: 'stock', label: 'Stocked item' }, { value: 'service', label: 'Service' }, { value: 'non_stock', label: 'Non-stock item' }]} /></Field>
            <Field label="Description"><Input value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
          </div>
          {similar.data && (similar.data.exact.length > 0 || similar.data.similar.length > 0 || similar.data.categories.length > 0) && (
            <div className="mt-4 space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/30" data-testid="similar-products">
              {similar.data.exact.map((p) => <div key={p._id} className="font-medium text-red-700">Same {p.matched} as <Link className="underline" to={`/products/${p._id}`}>{p.name}</Link> ({p.sku})</div>)}
              {similar.data.similar.length > 0 && <div><span className="font-medium">Already in your products?</span> {similar.data.similar.map((p, i) => <span key={p._id}>{i ? ', ' : ' '}<Link className="text-brand-700 underline" to={`/products/${p._id}`}>{p.name}</Link>{p.retailCents ? ` (${money(p.retailCents)})` : ''}</span>)}</div>}
              {!categoryId && similar.data.categories.length > 0 && (
                <div className="flex flex-wrap items-center gap-2"><span className="text-ink-600">Similar products are in:</span>
                  {similar.data.categories.map((c) => <Button key={c._id} size="sm" variant="secondary" onClick={() => setCategoryId(c._id)}>{c.name}</Button>)}
                </div>
              )}
              <p className="text-xs text-ink-500">Suggestions come from your own products. Nothing is filled in unless you choose it.</p>
            </div>
          )}
        </Card>
      )}

      {step === 1 && (
        <Card title="How is it sold?">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {SELLING_METHODS.map((m) => (
              <button key={m.key} type="button" onClick={() => pickMethod(m.key)} aria-pressed={method === m.key}
                className={`rounded-xl border p-3 text-left transition ${method === m.key ? 'border-brand-500 bg-brand-50 ring-2 ring-brand-500 dark:bg-brand-950/30' : 'border-ink-200 hover:border-ink-300 dark:border-ink-700'}`}>
                <div className="font-medium">{m.label}</div>
                <div className="mt-1 text-xs text-ink-500">{m.hint}</div>
              </button>
            ))}
          </div>
        </Card>
      )}

      {step === 2 && (
        <Card title="Units and conversions">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Base unit (stock is counted in this)" hint={methodInfo.fractional ? 'Quantities like 0.75 are allowed' : 'Whole quantities'}>
              <Select value={baseUnit} onChange={(e) => setBaseUnit(e.target.value)} options={unitChoices.map((c) => ({ value: c, label: STANDARD_UNITS.find((u) => u.code === c)?.name ? `${STANDARD_UNITS.find((u) => u.code === c)!.name} (${c})` : c === 'm2' ? 'Square metre (m2)' : c }))} />
            </Field>
          </div>
          <div className="mt-4">
            <div className="label">Other units it is bought or sold in</div>
            {units.map((u, i) => {
              const upd = (patch: Partial<Unit>) => setUnits((all) => all.map((x, j) => (j === i ? { ...x, ...patch } : x)));
              return (
                <div key={i} className="mb-2 grid items-center gap-2 sm:grid-cols-[7rem_1fr_8rem_auto_auto]">
                  <Input aria-label={`Unit ${i + 1} code`} placeholder="Code" value={u.code} onChange={(e) => upd({ code: e.target.value })} />
                  <Input aria-label={`Unit ${i + 1} name`} placeholder="Name" value={u.name} onChange={(e) => upd({ name: e.target.value })} />
                  <Input aria-label={`Unit ${i + 1} factor`} type="number" step="any" min={0} value={u.factor} onChange={(e) => upd({ factor: Number(e.target.value) })} />
                  <span className="text-xs text-ink-500">1 {u.code || 'unit'} = {u.factor} {baseUnit}</span>
                  <Button variant="ghost" aria-label="Remove unit" onClick={() => setUnits((all) => all.filter((_, j) => j !== i))}><Icon name="x" className="h-4 w-4" /></Button>
                </div>
              );
            })}
            <div className="flex flex-wrap gap-2">
              {(UNIT_PRESETS[baseUnit] ?? []).filter((p) => !units.some((u) => u.code === p.code)).map((p) => (
                <Button key={p.code} size="sm" variant="secondary" onClick={() => setUnits((all) => [...all, { ...p, retail: null }])}>+ {p.name}</Button>
              ))}
              <Button size="sm" variant="secondary" onClick={() => setUnits((all) => [...all, { code: '', name: '', factor: 1, retail: null }])}>+ Other unit</Button>
            </div>
            <p className="mt-2 text-xs text-ink-500">Every unit is set against the base unit, so conversions can never go round in circles. Selling 1 {units[0]?.code || 'carton'} takes {units[0]?.factor ?? 24} {baseUnit} off stock.</p>
            {unitIssues.map((m) => <div key={m} className="mt-1 text-sm text-red-600">{m}</div>)}
          </div>
          {method === 'variants' && (
            <div className="mt-5">
              <div className="label">Variants (each gets its own SKU and stock)</div>
              {variants.map((v, i) => (
                <div key={i} className="mb-2 grid gap-2 sm:grid-cols-[10rem_1fr_auto]">
                  <Input aria-label={`Variant ${i + 1} name`} placeholder="Size, Colour…" value={v.name} onChange={(e) => setVariants((all) => all.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                  <Input aria-label={`Variant ${i + 1} values`} placeholder="Comma separated: S, M, L" value={v.values} onChange={(e) => setVariants((all) => all.map((x, j) => (j === i ? { ...x, values: e.target.value } : x)))} />
                  <Button variant="ghost" aria-label="Remove variant" onClick={() => setVariants((all) => all.filter((_, j) => j !== i))}><Icon name="x" className="h-4 w-4" /></Button>
                </div>
              ))}
              <Button size="sm" variant="secondary" onClick={() => setVariants((all) => [...all, { name: '', values: '' }])}>+ Another option</Button>
              {variantCombos.length > 0 && <p className="mt-2 text-xs text-ink-500">{variantCombos.length} variants: {variantCombos.slice(0, 6).map((c) => Object.values(c).join(' ')).join(', ')}{variantCombos.length > 6 ? '…' : ''}</p>}
            </div>
          )}
        </Card>
      )}

      {step === 3 && (
        <Card title="Pricing">
          <div className="mb-3 flex flex-wrap gap-4">
            <Checkbox label={`Prices I type include VAT (${rateBp / 100}%)`} checked={entryIncl} onChange={setEntryIncl} />
            {entryIncl !== bizIncl && <span className="text-xs text-amber-700">Your business keeps prices {bizIncl ? 'with' : 'without'} VAT: they will be converted when saved.</span>}
          </div>
          <div className="grid gap-3 sm:grid-cols-4">
            {can('products.cost') && <Field label="Cost (per base unit)" hint={`Per ${baseUnit}, before VAT`}><MoneyInput value={costCents} onChange={setCostCents} /></Field>}
            <Field label="Selling price" hint={`Per ${baseUnit}`}><MoneyInput value={retail} onChange={setRetail} /></Field>
            <Field label="Wholesale price"><MoneyInput value={wholesale} onChange={setWholesale} /></Field>
            <Field label="Minimum price" hint="The till cannot go lower without a manager"><MoneyInput value={minPrice} onChange={setMinPrice} /></Field>
            <Field label="VAT %" hint="Blank = business default"><Input inputMode="decimal" value={taxPct} onChange={(e) => setTaxPct(e.target.value)} placeholder={String((settings.defaultTaxRateBp ?? 1600) / 100)} /></Field>
          </div>
          {can('products.cost') && (
            <div className="mt-4 grid gap-3 rounded-lg bg-ink-50 p-3 text-sm sm:grid-cols-5 dark:bg-ink-900" data-testid="price-calculator">
              <div><div className="text-xs text-ink-500">Margin</div><div className="font-semibold">{pct(retail ? marginBp(cost, netOf(retail)) : null)}</div></div>
              <div><div className="text-xs text-ink-500">Markup</div><div className="font-semibold">{pct(retail ? markupBp(cost, netOf(retail)) : null)}</div></div>
              <div><div className="text-xs text-ink-500">Profit per {baseUnit}</div><div className="font-semibold">{retail ? money(netOf(retail) - cost) : '—'}</div></div>
              <Field label="Target margin %">
                <div className="flex gap-1"><Input inputMode="decimal" value={targetMargin} onChange={(e) => setTargetMargin(e.target.value)} />
                  <Button size="sm" variant="secondary" disabled={!cost || !targetMargin} onClick={() => { const net = priceForMargin(cost, Math.round(Number(targetMargin) * 100)); if (net !== null) setRetail(entryIncl ? addTax(net, rateBp) : net); }}>Use</Button></div>
              </Field>
              <Field label="Target markup %">
                <div className="flex gap-1"><Input inputMode="decimal" value={targetMarkup} onChange={(e) => setTargetMarkup(e.target.value)} />
                  <Button size="sm" variant="secondary" disabled={!cost || !targetMarkup} onClick={() => { const net = priceForMarkup(cost, Math.round(Number(targetMarkup) * 100)); if (net !== null) setRetail(entryIncl ? addTax(net, rateBp) : net); }}>Use</Button></div>
              </Field>
            </div>
          )}
          {units.length > 0 && (
            <div className="mt-4">
              <div className="label">Unit prices (blank = base price × factor)</div>
              <div className="grid gap-2 sm:grid-cols-3">
                {units.map((u, i) => (
                  <Field key={i} label={`${u.name || u.code} (${u.factor} ${baseUnit})`} hint={retail ? `Default ${money(Math.round(retail * u.factor))}` : undefined}>
                    <MoneyInput value={u.retail} onChange={(v) => setUnits((all) => all.map((x, j) => (j === i ? { ...x, retail: v } : x)))} />
                  </Field>
                ))}
              </div>
            </div>
          )}
          {multiBranch && can('prices.manage') && (
            <div className="mt-4">
              <div className="label">Branch prices (blank = same everywhere)</div>
              <div className="grid gap-2 sm:grid-cols-3">
                {branches.map((b) => <Field key={b._id} label={b.name}><MoneyInput value={branchPrices[b._id] ?? null} onChange={(v) => setBranchPrices((x) => ({ ...x, [b._id]: v }))} /></Field>)}
              </div>
            </div>
          )}
          <Warnings warnings={warnings} />
        </Card>
      )}

      {step === 4 && (
        <Card title="Barcodes and SKU">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="SKU / code"><div className="flex gap-2"><Input value={sku} onChange={(e) => setSku(e.target.value.toUpperCase())} /><Button variant="secondary" onClick={suggestSku}>Suggest</Button></div></Field>
            <Field label="Scan or type a barcode" hint="Press Enter after each one; a product can have several (e.g. a piece and a carton)">
              <Input value={scan} onChange={(e) => setScan(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addScan(); } }} placeholder="Scan the manufacturer barcode" />
            </Field>
          </div>
          <div className="mt-3 space-y-2" data-testid="wizard-barcodes">
            {barcodeInfo.map((b, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-ink-100 p-2 dark:border-ink-800">
                <span className="font-mono">{b.code}</span>
                {b.info && <Badge tone="blue">{b.info.format}</Badge>}
                {b.info?.checkDigitValid === true && <Badge tone="green">Check digit OK</Badge>}
                {b.info?.checkDigitValid === false && <Badge tone="red">Check digit wrong</Badge>}
                {b.info?.restricted && <Badge tone="amber">In-store code, not a GTIN</Badge>}
                <Select aria-label="Barcode unit" className="w-28" value={b.unitCode} onChange={(e) => setBarcodes((all) => all.map((x, j) => (j === i ? { ...x, unitCode: e.target.value } : x)))} options={[baseUnit, ...units.map((u) => u.code)].map((c) => ({ value: c, label: c }))} />
                <Button variant="ghost" aria-label="Remove barcode" onClick={() => setBarcodes((all) => all.filter((_, j) => j !== i))}><Icon name="x" className="h-4 w-4" /></Button>
              </div>
            ))}
            {similar.data?.exact.filter((p) => p.matched === 'barcode').map((p) => <div key={p._id} className="text-sm text-red-600">That barcode is already on {p.name}.</div>)}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={generateBarcode}><Icon name="plus" className="h-4 w-4" />Make an in-store barcode</Button>
            <span className="text-xs text-ink-500">For items with no manufacturer barcode. In-store codes work only in your shops; they are not registered GS1 barcodes.</span>
          </div>
        </Card>
      )}

      {step === 5 && (
        <Card title="Inventory">
          {type !== 'stock' ? <p className="text-sm text-ink-500">Services and non-stock items have no stock to count.</p> : (
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-2 sm:col-span-3">
                <Checkbox label="Track stock" checked={trackStock} onChange={setTrackStock} />
                {caps.modules.includes('batchExpiry') && <Checkbox label="Track batches & expiry dates" checked={trackBatches} onChange={setTrackBatches} />}
                {caps.modules.includes('serialNumbers') && <Checkbox label="Track serial numbers / IMEI" checked={trackSerials} onChange={setTrackSerials} />}
              </div>
              <Field label="Store"><Select value={warehouseId || defaultWh?._id || ''} onChange={(e) => setWarehouseId(e.target.value)} options={(locs.data?.warehouses ?? []).map((w: any) => ({ value: w._id, label: w.name }))} /></Field>
              <Field label={`Quantity (${baseUnit})`} hint="Opening stock"><Input type="number" step="any" min={0} value={openingQty} onChange={(e) => setOpeningQty(e.target.value)} /></Field>
              <Field label="Shelf / bin location"><Input value={binLocation} onChange={(e) => setBinLocation(e.target.value)} placeholder="e.g. A3-2" /></Field>
              <Field label="Reorder level"><Input type="number" min={0} value={reorderLevel} onChange={(e) => setReorderLevel(e.target.value)} /></Field>
              <Field label="Reorder qty"><Input type="number" min={0} value={reorderQty} onChange={(e) => setReorderQty(e.target.value)} /></Field>
              <Field label="Maximum stock" hint="0 = no limit"><Input type="number" min={0} value={maxStock} onChange={(e) => setMaxStock(e.target.value)} /></Field>
              {can('suppliers.read') && <Field label="Main supplier"><Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} placeholder="None" options={(suppliers.data ?? []).map((s) => ({ value: s._id, label: s.name }))} /></Field>}
              {trackBatches && <><Field label="Batch no."><Input value={batchNo} onChange={(e) => setBatchNo(e.target.value)} /></Field><Field label="Expiry"><Input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} /></Field></>}
              {trackSerials && <Field label="Serial numbers" className="sm:col-span-3"><Input value={serials} onChange={(e) => setSerials(e.target.value)} placeholder="Comma separated" /></Field>}
            </div>
          )}
        </Card>
      )}

      {step === 6 && (
        <Card title="Hardware and labels">
          <div className="grid gap-3 sm:grid-cols-3">
            {showPlu && (
              <Field label="Scale PLU" hint={weighed ? 'The item number on the scale; the label barcode carries it' : 'Only for items weighed or priced on a scale'}>
                <div className="flex gap-2"><Input inputMode="numeric" value={plu} onChange={(e) => setPlu(e.target.value.replace(/\D/g, '').slice(0, 6))} /><Button variant="secondary" onClick={nextPlu}>Next free</Button></div>
                {plu && pluCheck.data && <div className={`mt-1 text-xs ${pluCheck.data.free ? 'text-emerald-700' : 'text-red-600'}`}>{pluCheck.data.free ? 'Free' : `Used by ${pluCheck.data.product?.name}`}</div>}
              </Field>
            )}
            <Field label="Shelf labels to print"><Input type="number" min={1} max={50} value={labelCopies} onChange={(e) => setLabelCopies(e.target.value)} /></Field>
            <div className="pt-6"><Checkbox label="Show the price on labels" checked={labelPrice} onChange={setLabelPrice} /></div>
            {caps.modules.includes('onlineStore') && <div className="pt-6"><Checkbox label="Sell on the online shop" checked={online} onChange={setOnline} /></div>}
          </div>
          {weighed && <p className="mt-3 text-xs text-ink-500">After saving, send the PLU and price to your scales from Hardware → Weighing scales. Scales that cannot be programmed from here get a file for the scale's own software.</p>}
        </Card>
      )}

      {step === 7 && (
        <Card title="Review">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2" data-testid="wizard-review">
            <Row k="Name" v={name || '—'} />
            <Row k="SKU" v={sku || '—'} />
            <Row k="Category" v={cats.data?.find((c) => c._id === categoryId)?.name ?? '—'} />
            <Row k="Sold" v={`${methodInfo.label} · base unit ${baseUnit}`} />
            <Row k="Units" v={units.length ? units.map((u) => `${u.code} = ${u.factor} ${baseUnit}`).join(', ') : 'Base unit only'} />
            <Row k="Selling price" v={retail !== null ? `${money(retail)} ${entryIncl ? 'incl.' : 'excl.'} VAT` : '—'} />
            {can('products.cost') && <Row k="Cost" v={money(cost)} />}
            <Row k="Minimum price" v={minPrice !== null ? money(minPrice) : 'None'} />
            <Row k="Barcodes" v={barcodes.length ? barcodes.map((b) => `${b.code} (${b.unitCode})`).join(', ') : 'None'} />
            <Row k="Opening stock" v={Number(openingQty) > 0 ? `${openingQty} ${baseUnit}` : 'None'} />
            {plu && <Row k="PLU" v={plu} />}
            {variantCombos.length > 0 && <Row k="Variants" v={`${variantCombos.length} (${variantCombos.slice(0, 4).map((c) => Object.values(c).join(' ')).join(', ')}${variantCombos.length > 4 ? '…' : ''})`} />}
          </dl>
          <Warnings warnings={warnings} />
          {firstProblem && <div className="mt-3 text-sm text-red-600">{firstProblem}</div>}
          {blocking.length > 0 && <div className="mt-3"><Checkbox label="I have checked these prices and want to save anyway" checked={acceptWarnings} onChange={setAcceptWarnings} /></div>}
        </Card>
      )}

      <div className="mt-4 flex items-center justify-between">
        <Button variant="secondary" disabled={step === 0} onClick={() => setStep((s) => s - 1)}>Back</Button>
        <div className="flex items-center gap-3">
          {problem && step < STEPS.length - 1 && <span className="text-sm text-amber-700">{problem}</span>}
          {step < STEPS.length - 1
            ? <Button disabled={Boolean(problem)} onClick={() => setStep((s) => s + 1)}>Next</Button>
            : <Button loading={busy} disabled={Boolean(firstProblem) || (blocking.length > 0 && !acceptWarnings)} onClick={save}>Save</Button>}
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between gap-3 border-b border-ink-100 py-1 dark:border-ink-800"><dt className="text-ink-500">{k}</dt><dd className="text-right font-medium">{v}</dd></div>;
}

function Warnings({ warnings }: { warnings: { level: string; message: string }[] }) {
  if (!warnings.length) return null;
  return (
    <ul className="mt-3 space-y-1 text-sm" data-testid="price-warnings">
      {warnings.map((w, i) => <li key={i} className={w.level === 'error' ? 'text-red-600' : 'text-amber-700'}>{w.level === 'error' ? '⚠ ' : ''}{w.message}</li>)}
    </ul>
  );
}
