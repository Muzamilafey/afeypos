import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { allocateProportionally, calculateTax, lineAmount, roundQty, type PriceListKey } from '@afeypos/shared';
import { api, ApiError, newRequestId, openPrintable } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLocations } from '../lib/hooks';
import { getWorkstation, setWorkstation } from '../lib/workstation';
import { bridgeConfigured, fingerprint } from '../lib/bridge';
import { money, paymentLabel, qty as fmtQty, toCentsInput } from '../lib/format';
import { useRealtime } from '../lib/realtime';
import { Badge, Button, Checkbox, cx, ErrorBox, Field, Input, Modal, MoneyInput, Select, Spinner, useToast } from '../components/ui';
import { Icon } from '../components/icons';
import { GatewayPanel, type GatewayOption } from '../components/GatewayPayment';
import { MpesaPanel } from '../components/MpesaPayment';

interface Product {
  _id: string; name: string; sku: string; baseUnit: string; units: { code: string; name: string; factor: number }[]; prices: Record<string, number | undefined>;
  taxRateBp: number | null; trackSerials: boolean; trackBatches: boolean; allowFractional: boolean; requiresPrescription: boolean; ageRestricted: boolean; minAge?: number; categoryId?: string; stock?: { qty: number }; attributes?: Record<string, string | undefined>;
}
interface Line { key: string; product: Product; unitCode: string; qty: number; unitPriceCents: number; quotedCents: number; discountCents: number; serials: string[]; prescriptionRef?: string; promotion?: boolean }
interface Cart { id: string; label: string; lines: Line[]; customer: { _id: string; name: string; priceList?: string; balanceCents?: number; creditLimitCents?: number; loyaltyPoints?: number; kind?: string } | null; priceList: PriceListKey; cartDiscountCents: number; couponCode: string; ageVerified: boolean; salesDocumentId?: string }
interface Payment { method: string; amountCents: number; tenderedCents?: number; reference?: string; paymentIntentId?: string; label?: string }

const newCart = (n: number, priceList: PriceListKey): Cart => ({ id: newRequestId(), label: `Sale ${n}`, lines: [], customer: null, priceList, cartDiscountCents: 0, couponCode: '', ageVerified: false });

export function POSPage() {
  const { me } = useAuth();
  const locs = useLocations();
  const [tillId, setTillId] = useState(getWorkstation().tillId ?? '');
  const tills = (locs.data?.tills ?? []).filter((t) => t.active && (!me?.user.branchIds.length || me.user.branchIds.includes(t.branchId)));
  useEffect(() => {
    if (!tillId && tills.length === 1) setTillId(tills[0]._id);
  }, [tills, tillId]);
  const till = tills.find((t) => t._id === tillId);
  const shift = useQuery({ queryKey: ['shift', tillId], queryFn: () => api<{ data: any }>('/shifts/current', { query: { tillId } }).then((r) => r.data), enabled: Boolean(tillId) });

  if (!locs.data) return <div className="p-10"><Spinner /></div>;
  if (!till) {
    return (
      <div className="mx-auto max-w-md card p-6">
        <h2 className="mb-3 font-semibold">Which till is this computer?</h2>
        <div className="space-y-2">{tills.map((t) => <Button key={t._id} variant="secondary" className="w-full" onClick={() => { setWorkstation({ tillId: t._id }); setTillId(t._id); }}>{t.name} ({t.code})</Button>)}</div>
        {!tills.length && <p className="text-sm text-ink-500">No tills are available to you. Ask a manager to add one under Branches & tills.</p>}
      </div>
    );
  }
  if (shift.isLoading) return <div className="p-10"><Spinner /></div>;
  const requireShift = me?.tenant.settings?.requireOpenShift !== false;
  if (requireShift && !shift.data) return <OpenShift tillId={tillId} tillName={till.name} onOpened={() => shift.refetch()} onChangeTill={() => { setWorkstation({ tillId: undefined }); setTillId(''); }} />;
  return <Checkout till={till} shift={shift.data} />;
}

function OpenShift({ tillId, tillName, onOpened, onChangeTill }: { tillId: string; tillName: string; onOpened: () => void; onChangeTill: () => void }) {
  const [floatCents, setFloat] = useState<number | null>(0);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="mx-auto max-w-md card p-6">
      <h2 className="font-semibold">Open shift on {tillName}</h2>
      <p className="mb-4 text-sm text-ink-500">Count the cash in the drawer before you start selling.</p>
      <Field label="Opening float"><MoneyInput value={floatCents} onChange={setFloat} autoFocus /></Field>
      <div className="mt-4"><ErrorBox error={error} /></div>
      <div className="mt-4 flex gap-2">
        <Button className="flex-1" size="lg" loading={busy} onClick={async () => { setBusy(true); try { await api('/shifts', { body: { tillId, openingFloatCents: floatCents ?? 0 } }); onOpened(); } catch (e) { setError(e); } finally { setBusy(false); } }}>Open shift</Button>
        <Button variant="secondary" size="lg" onClick={onChangeTill}>Change till</Button>
      </div>
    </div>
  );
}

function Checkout({ till, shift }: { till: { _id: string; name: string; warehouseId: string; branchId: string }; shift: any }) {
  const { me, can, has } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const caps = me!.capabilities;
  const settings = me!.tenant.settings ?? {};
  const storeKey = `afey.carts.${till._id}`;
  const [carts, setCartsState] = useState<Cart[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storeKey) ?? 'null');
      if (Array.isArray(saved) && saved.length) return saved;
    } catch { /* ignore */ }
    return [newCart(1, caps.checkout.defaultPriceList)];
  });
  const [active, setActiveState] = useState(0);
  // Refs mirror state synchronously so rapid barcode scans always see the latest cart.
  const cartsRef = useRef(carts);
  const activeRef = useRef(active);
  const setCarts = useCallback((fn: (cs: Cart[]) => Cart[]) => {
    cartsRef.current = fn(cartsRef.current);
    setCartsState(cartsRef.current);
  }, []);
  const setActive = (i: number) => {
    activeRef.current = i;
    setActiveState(i);
  };
  const currentCart = () => cartsRef.current[Math.min(activeRef.current, cartsRef.current.length - 1)];
  const cart = carts[Math.min(active, carts.length - 1)];
  const scanChain = useRef<Promise<void>>(Promise.resolve());
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [customerOpen, setCustomerOpen] = useState(false);
  const [lastSale, setLastSale] = useState<any>(null);
  const [error, setError] = useState<unknown>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [panel, setPanel] = useState<null | { kind: 'line'; focus: 'qty' | 'discount' } | { kind: 'cart' } | { kind: 'resume' } | { kind: 'browse' }>(null);

  useEffect(() => {
    try { localStorage.setItem(storeKey, JSON.stringify(carts)); } catch { /* ignore */ }
  }, [carts, storeKey]);

  const update = useCallback((fn: (c: Cart) => Cart) => setCarts((cs) => cs.map((c, i) => (i === Math.min(activeRef.current, cs.length - 1) ? fn(c) : c))), [setCarts]);

  const categories = useQuery({ queryKey: ['categories'], queryFn: () => api<{ data: any[] }>('/categories').then((r) => r.data) });
  const results = useQuery({
    queryKey: ['pos-search', search, category],
    queryFn: () => api<{ data: Product[] }>('/products', { query: { q: search || undefined, categoryId: category ?? undefined, active: 'true', limit: caps.checkout.touchMode ? 40 : 12, warehouseId: till.warehouseId } }).then((r) => r.data),
    enabled: search.length >= 2 || Boolean(category),
  });

  const quote = useCallback(async (product: Product, unitCode: string, q: number, c: Cart) => {
    const r = await api<{ data: { unitPriceCents: number; source: string } }>(`/products/${product._id}/quote`, { body: { unitCode, qty: q, priceList: c.priceList, customerId: c.customer?._id, branchId: till.branchId, couponCode: c.couponCode || undefined } });
    return r.data;
  }, [till.branchId]);

  const addProduct = useCallback(async (product: Product, opts: { unitCode?: string; qty?: number; priceCents?: number } = {}) => {
    setError(null);
    const c0 = currentCart();
    const unitCode = opts.unitCode ?? product.baseUnit;
    const existing = c0.lines.find((l) => l.product._id === product._id && l.unitCode === unitCode && !product.trackSerials && opts.qty === undefined && opts.priceCents === undefined);
    const q = roundQty(existing ? existing.qty + 1 : opts.qty ?? 1);
    try {
      const qt = await quote(product, unitCode, q, c0);
      let lineQty = q;
      if (opts.priceCents !== undefined && qt.unitPriceCents > 0) lineQty = roundQty(opts.priceCents / qt.unitPriceCents);
      update((c) => {
        const ex = existing && c.lines.find((l) => l.key === existing.key);
        if (ex) return { ...c, lines: c.lines.map((l) => (l.key === ex.key ? { ...l, qty: lineQty, unitPriceCents: l.unitPriceCents === l.quotedCents ? qt.unitPriceCents : l.unitPriceCents, quotedCents: qt.unitPriceCents, promotion: qt.source === 'promotion' } : l)) };
        const key = newRequestId();
        setSelectedKey(key);
        return { ...c, lines: [...c.lines, { key, product, unitCode, qty: lineQty, unitPriceCents: qt.unitPriceCents, quotedCents: qt.unitPriceCents, discountCents: 0, serials: [], promotion: qt.source === 'promotion' }] };
      });
      if (existing) setSelectedKey(existing.key);
    } catch (e) {
      setError(e);
    }
     
  }, [quote, update]);

  const lookupAndAdd = async (code: string) => {
    try {
      const r = await api<{ data: { product: Product; unitCode: string; weighed?: { qty?: number; priceCents?: number } } }>('/products/lookup', { query: { code, warehouseId: till.warehouseId } });
      await addProduct(r.data.product, { unitCode: r.data.unitCode, qty: r.data.weighed?.qty, priceCents: r.data.weighed?.priceCents });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        const found = await api<{ data: Product[] }>('/products', { query: { q: code, active: 'true', limit: 2 } }).then((x) => x.data).catch(() => []);
        if (found.length === 1) await addProduct(found[0]);
        else {
          setSearch(code);
          toast.info(found.length ? `Several products match "${code}"; pick one` : `No product with code "${code}"`);
        }
      } else setError(e);
    }
  };
  // Scans are queued so a fast scanner never loses or double-counts an item.
  const onScan = (code: string) => {
    const c = code.trim();
    if (!c) return;
    setSearch('');
    scanChain.current = scanChain.current.then(() => lookupAndAdd(c));
    searchRef.current?.focus();
  };

  const setLine = async (key: string, patch: Partial<Line>) => {
    const line = cart.lines.find((l) => l.key === key);
    if (!line) return;
    const next = { ...line, ...patch };
    if (patch.qty !== undefined || patch.unitCode !== undefined) {
      try {
        const qt = await quote(next.product, next.unitCode, next.qty, cart);
        if (line.unitPriceCents === line.quotedCents || patch.unitCode) next.unitPriceCents = qt.unitPriceCents;
        next.quotedCents = qt.unitPriceCents;
      } catch (e) {
        setError(e);
      }
    }
    update((c) => ({ ...c, lines: c.lines.map((l) => (l.key === key ? next : l)) }));
  };

  // Re-quote every line when customer/price list changes.
  const requoteAll = async (c: Cart) => {
    const lines = await Promise.all(c.lines.map(async (l) => {
      const qt = await quote(l.product, l.unitCode, l.qty, c).catch(() => null);
      return qt ? { ...l, unitPriceCents: qt.unitPriceCents, quotedCents: qt.unitPriceCents, promotion: qt.source === 'promotion' } : l;
    }));
    update(() => ({ ...c, lines }));
  };

  // Totals computed with the same shared functions the server uses.
  const totals = useMemo(() => {
    const gross = cart.lines.map((l) => lineAmount(l.qty, l.unitPriceCents));
    const disc = cart.lines.map((l, i) => Math.min(l.discountCents, gross[i]));
    const linesGross = gross.reduce((a, b) => a + b, 0);
    const cartDiscount = Math.min(cart.cartDiscountCents, linesGross - disc.reduce((a, b) => a + b, 0));
    const shares = allocateProportionally(cartDiscount, gross.map((g, i) => g - disc[i]));
    let total = 0;
    let tax = 0;
    cart.lines.forEach((l, i) => {
      const t = calculateTax(gross[i] - disc[i] - shares[i], l.product.taxRateBp ?? settings.defaultTaxRateBp ?? 0, settings.pricesIncludeTax ?? true);
      total += t.gross;
      tax += t.tax;
    });
    const discount = disc.reduce((a, b) => a + b, 0) + cartDiscount;
    return { linesGross, discount, tax, total, items: cart.lines.reduce((a, l) => a + l.qty, 0) };
  }, [cart, settings.defaultTaxRateBp, settings.pricesIncludeTax]);

  const suspend = () => {
    if (!cart.lines.length) return;
    setCarts((cs) => [...cs, newCart(cs.length + 1, caps.checkout.defaultPriceList)]);
    setActive(carts.length);
    toast.info(`${cart.label} suspended`);
  };
  const removeCart = (i: number) => {
    setCarts((cs) => (cs.length === 1 ? [newCart(1, caps.checkout.defaultPriceList)] : cs.filter((_, j) => j !== i)));
    setActive(0);
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'F2') { e.preventDefault(); searchRef.current?.focus(); }
      if (e.key === 'F4') { e.preventDefault(); setCustomerOpen(true); }
      if (e.key === 'F8') { e.preventDefault(); suspend(); }
      if (e.key === 'F9' || e.key === 'F12') { e.preventDefault(); if (cart.lines.length) setPaying(true); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  const needsAge = has('ageVerification') && cart.lines.some((l) => l.product.ageRestricted);
  const big = caps.checkout.touchMode;
  const selected = cart.lines.find((l) => l.key === selectedKey) ?? cart.lines[cart.lines.length - 1];
  const held = carts.map((c, i) => ({ c, i })).filter(({ i }) => i !== active);
  const removeLine = (key: string) => update((c) => ({ ...c, lines: c.lines.filter((x) => x.key !== key) }));
  const taxLabel = settings.pricesIncludeTax === false ? 'Tax' : `Tax${settings.defaultTaxRateBp ? ` (${settings.defaultTaxRateBp / 100}%)` : ''}`;
  const tiles: { key: string; label: string; icon: string; tone: string; onClick: () => void; disabled?: boolean; hint?: string; count?: number }[] = [
    { key: 'qty', label: 'Quantity', icon: 'plus', tone: 'text-emerald-600 bg-emerald-50', onClick: () => setPanel({ kind: 'line', focus: 'qty' }), disabled: !selected },
    { key: 'ldisc', label: 'Line disc', icon: 'percent', tone: 'text-sky-600 bg-sky-50', onClick: () => setPanel({ kind: 'line', focus: 'discount' }), disabled: !selected || !can('sales.discount') },
    { key: 'del', label: 'Delete', icon: 'trash', tone: 'text-red-600 bg-red-50', onClick: () => selected && removeLine(selected.key), disabled: !selected },
    { key: 'hold', label: 'Hold', icon: 'pause', tone: 'text-amber-600 bg-amber-50', onClick: suspend, disabled: !cart.lines.length, hint: 'F8' },
    { key: 'gdisc', label: 'Global disc', icon: 'tag', tone: 'text-violet-600 bg-violet-50', onClick: () => setPanel({ kind: 'cart' }), disabled: !cart.lines.length || !can('sales.discount') },
    { key: 'resume', label: 'Resume', icon: 'play', tone: 'text-orange-600 bg-orange-50', onClick: () => setPanel({ kind: 'resume' }), disabled: !held.length, count: held.length },
    { key: 'cust', label: cart.customer ? 'Customer ✓' : 'Customer', icon: 'user', tone: 'text-indigo-600 bg-indigo-50', onClick: () => setCustomerOpen(true), hint: 'F4' },
    { key: 'clear', label: 'Clear', icon: 'x', tone: 'text-ink-600 bg-ink-100', onClick: () => removeCart(active), disabled: !cart.lines.length },
  ];

  return (
    // Fills the window under the shell's header (48px) and breadcrumb (42px), inside the page padding; the footer is hidden here.
    <div className="flex flex-col gap-3 lg:h-[calc(100vh-122px)] lg:min-h-[520px] lg:flex-row">
      {/* main: search, transaction lines, totals */}
      <section className="card flex min-w-0 flex-1 flex-col overflow-hidden" aria-label="Current sale">
        <div className="flex flex-wrap items-center gap-2 border-b border-ink-100 px-4 py-3 dark:border-ink-800">
          <div className="relative min-w-[240px] flex-1">
            <Icon name="search" className="absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-ink-400" />
            <input ref={searchRef} autoFocus value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onScan(e.currentTarget.value); } if (e.key === 'Escape') setSearch(''); }}
              placeholder="Scan barcode or search name / SKU" aria-label="Scan or search products"
              className={cx('w-full rounded-md border-2 border-ink-800 bg-white py-2.5 pl-11 pr-14 text-[15px] font-medium shadow-sm placeholder:font-normal placeholder:text-ink-400 focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-brand-500/15 dark:border-ink-600 dark:bg-ink-900', big && 'py-3.5 text-base')} />
            <kbd className="absolute right-3 top-1/2 -translate-y-1/2 rounded border border-ink-200 bg-ink-50 px-1.5 py-0.5 text-[11px] font-semibold text-ink-500 dark:border-ink-700 dark:bg-ink-800">F2</kbd>
            {search.length >= 2 && (
              <div className="absolute inset-x-0 top-full z-30 mt-1 max-h-[55vh] overflow-y-auto rounded-md border border-ink-100 bg-white shadow-xl dark:border-ink-700 dark:bg-ink-900" role="listbox" aria-label="Matching products">
                {results.isFetching && <div className="p-3"><Spinner className="h-4 w-4" /></div>}
                {results.data?.map((p) => (
                  <button key={p._id} role="option" aria-selected="false" onClick={() => { addProduct(p); setSearch(''); searchRef.current?.focus(); }}
                    className="flex w-full items-center gap-3 border-b border-ink-50 px-4 py-2.5 text-left last:border-0 hover:bg-brand-50 dark:border-ink-800 dark:hover:bg-ink-800">
                    <span className="min-w-0 flex-1"><span className="block truncate font-semibold">{p.name}</span><span className="text-xs text-ink-500">{p.sku} · <span className={(p.stock?.qty ?? 0) <= 0 ? 'text-red-600' : ''}>In stock: {fmtQty(p.stock?.qty)} {p.baseUnit}</span></span></span>
                    <span className="font-mono text-sm font-semibold">{money(p.prices?.[cart.priceList] ?? p.prices?.retail)}</span>
                  </button>
                ))}
                {results.data && !results.data.length && <p className="px-4 py-3 text-sm text-ink-500">No products found. Press Enter to look the code up.</p>}
              </div>
            )}
          </div>
          <Button variant="secondary" onClick={() => setPanel({ kind: 'browse' })}><Icon name="grid" className="h-4 w-4" />Browse</Button>
          {caps.checkout.showPriceListSelector && caps.priceLists.length > 1 && (
            <select aria-label="Price list" className="input w-auto py-2" value={cart.priceList} onChange={(e) => { const c = { ...cart, priceList: e.target.value as PriceListKey }; requoteAll(c); }}>
              {caps.priceLists.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          )}
          <Badge tone="green">{till.name}</Badge>
        </div>

        <div className="flex items-center gap-3 px-5 pb-2 pt-4">
          <Icon name="cart" className="h-5 w-5 text-brand-500" />
          <h2 className="text-[15px] font-extrabold uppercase tracking-wide text-ink-800 dark:text-white">Transaction lines</h2>
          <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-bold text-brand-600 dark:bg-brand-500/15 dark:text-brand-200">{fmtQty(totals.items)} {totals.items === 1 ? 'ITEM' : 'ITEMS'}</span>
          <button type="button" onClick={() => setCustomerOpen(true)} className="ml-auto flex max-w-[45%] items-center gap-1.5 truncate rounded-full bg-ink-50 px-3 py-1 text-xs font-semibold text-ink-600 hover:bg-ink-100 dark:bg-ink-800 dark:text-ink-300"><Icon name="user" className="h-3.5 w-3.5" /><span className="truncate">{cart.customer ? cart.customer.name : 'Walk-in customer (F4)'}</span></button>
          <span className="text-xs font-semibold text-ink-400">{cart.label}</span>
        </div>
        {error ? <div className="px-5 pb-2"><ErrorBox error={error} /></div> : null}

        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full min-w-[600px] text-sm">
            <thead className="sticky top-0 z-10 bg-[#f7f8fa] dark:bg-ink-950">
              <tr className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink-500">
                <th className="px-5 py-3 text-left">Item description</th>
                <th className="px-3 py-3 text-center">Unit</th>
                <th className="px-3 py-3 text-right">Price</th>
                <th className="px-3 py-3 text-center">Quantity</th>
                <th className="px-3 py-3 text-right">Discount</th>
                <th className="px-5 py-3 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {cart.lines.map((l) => (
                <SaleRow key={l.key} line={l} selected={selected?.key === l.key} allowFraction={caps.checkout.allowFractionalQty && l.product.allowFractional} big={big}
                  onSelect={() => setSelectedKey(l.key)} onChange={(patch) => setLine(l.key, patch)} onRemove={() => removeLine(l.key)} onEdit={() => { setSelectedKey(l.key); setPanel({ kind: 'line', focus: 'qty' }); }} />
              ))}
            </tbody>
          </table>
          {!cart.lines.length && (
            <div className="flex h-[60%] flex-col items-center justify-center px-6 text-center text-ink-400">
              <Icon name="barcode" className="mb-3 h-14 w-14" />
              <p className="font-semibold text-ink-500">Scan an item to start the sale</p>
              <p className="mt-1 text-xs">F2 search · F4 customer · F8 hold · F9 pay</p>
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 border-t border-ink-100 dark:border-ink-800 md:grid-cols-[repeat(4,minmax(0,1fr))_minmax(0,1.6fr)]">
          {[
            { k: 'Gross', v: money(totals.linesGross), c: '' },
            { k: 'Discount', v: money(totals.discount), c: 'text-red-600' },
            { k: taxLabel, v: money(totals.tax), c: '' },
            { k: 'Payable', v: money(totals.total), c: 'text-brand-600', strong: true },
          ].map((x) => (
            <div key={x.k} className="min-w-0 border-r border-ink-100 px-4 py-3 dark:border-ink-800">
              <div className={cx('text-[11px] font-bold uppercase tracking-[0.12em]', x.strong ? 'text-brand-600' : 'text-ink-500')}>{x.k}</div>
              <div className={cx('mt-1 truncate font-mono text-[15px] font-semibold tabular-nums', x.c)}>{x.v}</div>
            </div>
          ))}
          <div className="col-span-2 flex min-w-0 flex-col items-end justify-center bg-[#f7f8fa] px-5 py-3 dark:bg-ink-950/60 md:col-span-1">
            <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-ink-500">Total payable</div>
            <div className="font-black leading-none tracking-tight text-ink-900 dark:text-white" data-testid="cart-total"><span className="whitespace-nowrap text-3xl tabular-nums 2xl:text-4xl">{money(totals.total)}</span></div>
          </div>
        </div>
      </section>

      {/* actions */}
      <aside className="flex w-full flex-col gap-3 lg:w-[320px] 2xl:w-[400px]" aria-label="Sale actions">
        <div className="grid min-h-0 flex-1 auto-rows-fr grid-cols-2 gap-2.5 overflow-y-auto">
          {tiles.map((t) => (
            <button key={t.key} type="button" onClick={t.onClick} disabled={t.disabled}
              className={cx('card relative flex min-h-[76px] flex-col items-center justify-center gap-1.5 transition hover:-translate-y-px hover:shadow-md disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:translate-y-0 disabled:hover:shadow-none', big ? 'py-6' : 'py-3')}>
              {t.hint && <kbd className="absolute right-2 top-2 rounded border border-ink-200 bg-ink-50 px-1 text-[10px] font-semibold text-ink-400 dark:border-ink-700 dark:bg-ink-800">{t.hint}</kbd>}
              <span className={cx('flex h-9 w-9 items-center justify-center rounded-full', t.tone)}><Icon name={t.icon} className="h-[18px] w-[18px]" /></span>
              <span className="text-[13px] font-extrabold uppercase tracking-wide text-ink-800 dark:text-ink-100">{t.label}</span>
              {t.count !== undefined && <span className="-mt-2 text-[11px] font-semibold text-ink-400">({t.count})</span>}
            </button>
          ))}
        </div>
        {needsAge && <div className="card p-3 text-sm"><Checkbox label={`Customer is ${Math.max(...cart.lines.map((l) => l.product.minAge ?? 18))}+ (ID checked)`} checked={cart.ageVerified} onChange={(v) => update((c) => ({ ...c, ageVerified: v }))} /></div>}
        <button type="button" aria-label={`Pay ${money(totals.total)}`} disabled={!cart.lines.length || (needsAge && !cart.ageVerified)} onClick={() => setPaying(true)}
          className="group flex shrink-0 flex-col items-center justify-center gap-1.5 rounded-lg bg-brand-500 px-6 py-5 text-white shadow-lg shadow-brand-500/25 ring-4 ring-brand-500/20 transition hover:bg-brand-600 disabled:cursor-not-allowed disabled:bg-brand-300 disabled:shadow-none disabled:ring-0 dark:disabled:bg-brand-800">
          <span className="text-2xl font-black uppercase tracking-wide 2xl:text-3xl">Finalize &amp; Pay</span>
          <span className="rounded-full bg-white/20 px-3 py-1 text-sm font-bold">F9 · {money(totals.total)}</span>
        </button>
      </aside>

      {panel?.kind === 'line' && selected && (
        <LineModal line={selected} focus={panel.focus} allowFraction={caps.checkout.allowFractionalQty && selected.product.allowFractional} canDiscount={can('sales.discount')}
          onClose={() => { setPanel(null); searchRef.current?.focus(); }} onSave={(patch) => { setLine(selected.key, patch); setPanel(null); searchRef.current?.focus(); }} onRemove={() => { removeLine(selected.key); setPanel(null); }} />
      )}
      {panel?.kind === 'cart' && (
        <Modal open onClose={() => setPanel(null)} title="Global discount" icon="tag" subtitle="Taken off the whole sale and shared across the items." size="sm" footer={<Button onClick={() => { setPanel(null); requoteAll(cart); searchRef.current?.focus(); }}>Done</Button>}>
          <div className="space-y-3">
            <Field label="Discount on the sale"><MoneyInput value={cart.cartDiscountCents} onChange={(v) => update((c) => ({ ...c, cartDiscountCents: v ?? 0 }))} aria-label="Cart discount" autoFocus /></Field>
            {has('promotions') && <Field label="Coupon code"><Input value={cart.couponCode} onChange={(e) => update((c) => ({ ...c, couponCode: e.target.value.toUpperCase() }))} aria-label="Coupon code" /></Field>}
          </div>
        </Modal>
      )}
      {panel?.kind === 'resume' && (
        <Modal open onClose={() => setPanel(null)} title="Held sales" icon="play" subtitle="Pick a sale to continue it. The current sale stays on hold." size="sm">
          <ul className="divide-y divide-ink-100 dark:divide-ink-800">
            {held.map(({ c, i }) => (
              <li key={c.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1"><div className="font-semibold">{c.label}</div><div className="text-xs text-ink-500">{c.lines.length} line(s){c.customer ? ` · ${c.customer.name}` : ''}</div></div>
                <Button size="sm" onClick={() => { setActive(i); setPanel(null); searchRef.current?.focus(); }}>Resume</Button>
                <Button size="sm" variant="ghost" aria-label={`Discard ${c.label}`} onClick={() => removeCart(i)}><Icon name="trash" className="h-4 w-4" /></Button>
              </li>
            ))}
          </ul>
        </Modal>
      )}
      {panel?.kind === 'browse' && (
        <Modal open onClose={() => { setPanel(null); setCategory(null); }} title="Browse products" icon="grid" size="xl">
          {categories.data && categories.data.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {categories.data.filter((c) => c.active !== false).map((c) => <button key={c._id} onClick={() => setCategory(c._id === category ? null : c._id)} className={cx('rounded-full px-3.5 py-1.5 text-sm font-semibold', category === c._id ? 'bg-brand-500 text-white' : 'bg-ink-100 hover:bg-ink-200 dark:bg-ink-800')}>{c.name}</button>)}
            </div>
          )}
          {!category ? <p className="text-sm text-ink-500">Choose a category.</p> : results.isFetching ? <Spinner /> : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {results.data?.map((p) => (
                <button key={p._id} onClick={() => addProduct(p)} className="card p-3 text-left transition hover:border-brand-500">
                  <div className="line-clamp-2 font-semibold">{p.name}</div>
                  <div className="mt-1 flex items-center justify-between text-sm"><span className="text-ink-500">{p.sku}</span><span className="font-semibold">{money(p.prices?.[cart.priceList] ?? p.prices?.retail)}</span></div>
                  <div className={cx('mt-1 text-xs', (p.stock?.qty ?? 0) <= 0 ? 'text-red-600' : 'text-ink-500')}>In stock: {fmtQty(p.stock?.qty)} {p.baseUnit}</div>
                </button>
              ))}
              {results.data && !results.data.length && <p className="text-sm text-ink-500">No products in this category.</p>}
            </div>
          )}
        </Modal>
      )}

      {customerOpen && <CustomerPicker onClose={() => setCustomerOpen(false)} onPick={(c) => { setCustomerOpen(false); const next = { ...cart, customer: c, priceList: (c?.priceList as PriceListKey) && caps.priceLists.includes(c?.priceList as PriceListKey) ? (c!.priceList as PriceListKey) : cart.priceList }; requoteAll(next); }} />}
      {paying && (
        <PaymentModal cart={cart} total={totals.total} till={till} shift={shift} onClose={() => setPaying(false)}
          onDone={(sale) => { setPaying(false); setLastSale(sale); removeCart(active); qc.invalidateQueries({ queryKey: ['pos-search'] }); searchRef.current?.focus(); }} />
      )}
      {lastSale && <ReceiptModal sale={lastSale} tillId={till._id} onClose={() => { setLastSale(null); searchRef.current?.focus(); }} />}
    </div>
  );
}

/** One row of the transaction lines table: click to select it, quantity stepper inline. */
function SaleRow({ line, selected, allowFraction, big, onSelect, onChange, onRemove, onEdit }: { line: Line; selected: boolean; allowFraction: boolean; big: boolean; onSelect: () => void; onChange: (p: Partial<Line>) => void; onRemove: () => void; onEdit: () => void }) {
  const step = allowFraction ? 0.5 : 1;
  const total = lineAmount(line.qty, line.unitPriceCents) - line.discountCents;
  return (
    <tr onClick={onSelect} onDoubleClick={onEdit} aria-selected={selected}
      className={cx('cursor-pointer border-b border-ink-50 transition dark:border-ink-800', selected ? 'bg-brand-50/70 shadow-[inset_3px_0_0_theme(colors.brand.500)] dark:bg-brand-500/10' : 'hover:bg-[#f7f8fa] dark:hover:bg-ink-800/40')}>
      <td className={cx('px-5', big ? 'py-4' : 'py-3')}>
        <div className="text-[15px] font-extrabold uppercase text-ink-900 dark:text-white">{line.product.name}</div>
        <div className="mt-0.5 text-xs font-medium uppercase tracking-wide text-ink-400">SKU: {line.product.sku}{line.promotion && <span className="ml-2 normal-case text-emerald-600">promo</span>}{line.unitPriceCents !== line.quotedCents && <span className="ml-2 normal-case text-amber-600">price changed</span>}</div>
      </td>
      <td className="px-3 text-center"><span className="rounded-full border border-ink-200 px-2 py-0.5 text-[11px] font-bold uppercase text-ink-600 dark:border-ink-700">{line.unitCode}</span></td>
      <td className="px-3 text-right font-mono tabular-nums">{money(line.unitPriceCents)}</td>
      <td className="px-3" onClick={(e) => e.stopPropagation()}>
        <div className="mx-auto flex w-fit items-center rounded-full border border-ink-200 bg-white shadow-sm dark:border-ink-700 dark:bg-ink-900">
          <button type="button" aria-label="Decrease" className="flex h-9 w-9 items-center justify-center rounded-full hover:bg-ink-100 dark:hover:bg-ink-800" onClick={() => (line.qty - step > 0 ? onChange({ qty: roundQty(line.qty - step) }) : onRemove())}><Icon name="minus" className="h-4 w-4" /></button>
          <input aria-label="Quantity" className="w-12 bg-transparent text-center font-bold tabular-nums focus:outline-none" value={line.qty} inputMode="decimal" onFocus={onSelect}
            onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n) && n > 0) onChange({ qty: allowFraction ? roundQty(n) : Math.round(n) }); }} />
          <button type="button" aria-label="Increase" className="flex h-9 w-9 items-center justify-center rounded-full hover:bg-ink-100 dark:hover:bg-ink-800" onClick={() => onChange({ qty: roundQty(line.qty + step) })}><Icon name="plus" className="h-4 w-4" /></button>
        </div>
      </td>
      <td className="px-3 text-right font-mono tabular-nums text-red-600">{line.discountCents ? `-${money(line.discountCents)}` : <span className="text-ink-300">—</span>}</td>
      <td className="px-5 text-right font-mono text-[15px] font-bold tabular-nums">{money(total)}</td>
    </tr>
  );
}

/** Edit the selected line: quantity, unit, price, discount, serials, prescription. */
function LineModal({ line, focus, allowFraction, canDiscount, onClose, onSave, onRemove }: { line: Line; focus: 'qty' | 'discount'; allowFraction: boolean; canDiscount: boolean; onClose: () => void; onSave: (p: Partial<Line>) => void; onRemove: () => void }) {
  const [d, setD] = useState({ qty: String(line.qty), unitCode: line.unitCode, unitPriceCents: line.unitPriceCents as number | null, discountCents: line.discountCents as number | null, serials: line.serials.join(', '), prescriptionRef: line.prescriptionRef ?? '' });
  const save = () => {
    const n = Number(d.qty);
    if (!Number.isFinite(n) || n <= 0) return;
    onSave({ qty: allowFraction ? roundQty(n) : Math.round(n), unitCode: d.unitCode !== line.unitCode ? d.unitCode : undefined, unitPriceCents: d.unitPriceCents ?? 0, discountCents: d.discountCents ?? 0, serials: d.serials.split(/[,\s]+/).filter(Boolean), prescriptionRef: d.prescriptionRef || undefined });
  };
  return (
    <Modal open onClose={onClose} title={line.product.name} subtitle={`SKU ${line.product.sku} · ${money(line.unitPriceCents)} per ${line.unitCode}`} icon="box" size="md"
      footer={<><Button variant="ghost" className="mr-auto text-red-600" onClick={onRemove}><Icon name="trash" className="h-4 w-4" />Remove item</Button><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={save}>Apply</Button></>}>
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <Field label="Quantity"><Input autoFocus={focus === 'qty'} inputMode="decimal" value={d.qty} onChange={(e) => setD({ ...d, qty: e.target.value })} /></Field>
        {line.product.units.length > 1 && <Field label="Unit"><Select value={d.unitCode} onChange={(e) => setD({ ...d, unitCode: e.target.value })} options={line.product.units.map((u) => ({ value: u.code, label: `${u.name} (${u.factor} ${line.product.baseUnit})` }))} /></Field>}
        <Field label="Unit price"><MoneyInput value={d.unitPriceCents} onChange={(v) => setD({ ...d, unitPriceCents: v })} /></Field>
        {canDiscount && <Field label="Line discount"><MoneyInput autoFocus={focus === 'discount'} value={d.discountCents} onChange={(v) => setD({ ...d, discountCents: v })} /></Field>}
        {line.product.trackSerials && <Field label={`Serial / IMEI (${d.qty})`} className="sm:col-span-2"><Input value={d.serials} onChange={(e) => setD({ ...d, serials: e.target.value })} placeholder="Scan serial numbers" /></Field>}
        {line.product.requiresPrescription && <Field label="Prescription reference" className="sm:col-span-2"><Input value={d.prescriptionRef} onChange={(e) => setD({ ...d, prescriptionRef: e.target.value })} /></Field>}
        <button type="submit" className="hidden" />
      </form>
    </Modal>
  );
}

function CustomerPicker({ onClose, onPick }: { onClose: () => void; onPick: (c: Cart['customer']) => void }) {
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '' });
  const list = useQuery({ queryKey: ['customers-pick', q], queryFn: () => api<{ data: any[] }>('/customers', { query: { q: q || undefined, limit: 20 } }).then((r) => r.data) });
  const [error, setError] = useState<unknown>(null);
  return (
    <Modal open onClose={onClose} title="Select customer">
      <Input autoFocus placeholder="Search name, phone or code" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul className="mt-3 max-h-72 divide-y divide-ink-100 overflow-y-auto dark:divide-ink-800">
        <li><button className="w-full px-2 py-2 text-left text-sm hover:bg-ink-50 dark:hover:bg-ink-800" onClick={() => onPick(null)}>Walk-in customer</button></li>
        {list.data?.filter((c) => c.kind !== 'walk_in').map((c) => (
          <li key={c._id}><button className="flex w-full justify-between px-2 py-2 text-left text-sm hover:bg-ink-50 dark:hover:bg-ink-800" onClick={() => onPick(c)}>
            <span><span className="font-medium">{c.name}</span> <span className="text-ink-500">{c.phone}</span></span>
            <span className="text-xs text-ink-500">{c.balanceCents ? `owes ${money(c.balanceCents)}` : ''} {c.priceList !== 'retail' ? c.priceList : ''}</span>
          </button></li>
        ))}
      </ul>
      {creating ? (
        <form className="mt-3 grid grid-cols-2 gap-2" onSubmit={async (e) => { e.preventDefault(); try { const r = await api<{ data: any }>('/customers', { body: { name: form.name, phone: form.phone || undefined } }); onPick(r.data); } catch (err) { setError(err); } }}>
          <Input required placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Input placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <div className="col-span-2"><ErrorBox error={error} /></div>
          <Button type="submit" className="col-span-2">Add customer</Button>
        </form>
      ) : <Button variant="secondary" className="mt-3 w-full" onClick={() => setCreating(true)}><Icon name="plus" className="h-4 w-4" />New customer</Button>}
    </Modal>
  );
}

function PaymentModal({ cart, total, till, shift, onClose, onDone }: { cart: Cart; total: number; till: { _id: string }; shift: any; onClose: () => void; onDone: (sale: any) => void }) {
  const { has, can } = useAuth();
  const toast = useToast();
  // Stable id for this payment attempt: retries after a network error replay instead of double-selling.
  const [requestId] = useState(newRequestId);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [method, setMethod] = useState('cash');
  const paid = payments.reduce((a, p) => a + p.amountCents, 0);
  const remaining = total - paid;
  const [amount, setAmount] = useState<number | null>(remaining);
  const [tendered, setTendered] = useState<number | null>(null);
  const [reference, setReference] = useState('');
  const [stk, setStk] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [override, setOverride] = useState<{ permission: string; message: string } | null>(null);

  useEffect(() => setAmount(remaining), [remaining]);

  // Live M-Pesa / gateway status via websocket, with polling as a fallback.
  useRealtime('payment.updated', (p) => { if (stk && p.id === stk.id) setStk(p); }, [stk?.id]);
  useEffect(() => {
    if (!stk || stk.status !== 'pending') return;
    const t = setInterval(async () => { try { setStk((await api<{ data: any }>(`/payments/intents/${stk.id}`)).data); } catch { /* keep waiting */ } }, 3000);
    return () => clearInterval(t);
  }, [stk]);
  useEffect(() => {
    if (stk?.status === 'succeeded' && !payments.some((p) => p.paymentIntentId === stk.id)) {
      const isMpesa = (stk.provider ?? 'mpesa') === 'mpesa';
      const label = isMpesa ? 'M-Pesa' : paymentLabel('gateway', stk.provider);
      // A customer may have paid more than is left (e.g. a code entered at the till); only what is due is used.
      const free = (stk.paidAmountCents ?? stk.amountCents) - (stk.allocatedCents ?? 0);
      setPayments((ps) => [...ps, { method: isMpesa ? 'mpesa' : 'gateway', amountCents: Math.min(free, ps.reduce((a, p) => a - p.amountCents, total)), paymentIntentId: stk.id, label: `${label} ${stk.receiptNumber ?? ''}` }]);
      toast.success(`${label} payment confirmed`);
    }
  }, [stk, payments, toast, total]);

  const c2b = useQuery({ queryKey: ['c2b-open'], queryFn: () => api<{ data: any[] }>('/payments/intents', { query: { status: 'succeeded', unallocated: 'true', provider: 'mpesa', limit: 10 } }).then((r) => r.data), enabled: method === 'mpesa' && has('mpesa'), refetchInterval: 5000 });
  const gateways = useQuery({ queryKey: ['gateways', till._id], queryFn: () => api<{ data: GatewayOption[] }>('/payments/gateways', { query: { tillId: till._id } }).then((r) => r.data), enabled: has('payments'), staleTime: 60_000 });

  const methods = [
    { key: 'cash', label: 'Cash' },
    ...(has('mpesa') ? [{ key: 'mpesa', label: 'M-Pesa' }] : []),
    ...(gateways.data?.length ? [{ key: 'gateway', label: 'Mobile money & cards' }] : []),
    { key: 'card', label: 'Card' },
    { key: 'bank', label: 'Bank' },
    ...(has('customerCredit') && cart.customer && cart.customer.kind !== 'walk_in' ? [{ key: 'credit', label: 'On account' }] : []),
    ...(has('loyalty') && cart.customer?.loyaltyPoints ? [{ key: 'loyalty', label: `Points (${cart.customer.loyaltyPoints})` }] : []),
  ];

  const addPayment = () => {
    if (!amount || amount <= 0) return;
    const a = Math.min(amount, remaining);
    if (method === 'cash') setPayments((ps) => [...ps, { method, amountCents: a, tenderedCents: Math.max(tendered ?? a, a), label: 'Cash' }]);
    else setPayments((ps) => [...ps, { method, amountCents: a, reference: reference || undefined, label: paymentLabel(method) }]);
    setTendered(null);
    setReference('');
  };


  const complete = async (overrideToken?: string) => {
    setBusy(true);
    setError(null);
    let final = payments;
    if (remaining > 0 && method === 'cash' && (tendered ?? 0) >= remaining) final = [...payments, { method: 'cash', amountCents: remaining, tenderedCents: tendered!, label: 'Cash' }];
    try {
      const body = {
        clientRequestId: requestId,
        tillId: till._id,
        customerId: cart.customer?._id,
        priceList: cart.priceList,
        couponCode: cart.couponCode || undefined,
        lines: cart.lines.map((l) => ({ productId: l.product._id, unitCode: l.unitCode, qty: l.qty, unitPriceCents: l.unitPriceCents !== l.quotedCents ? l.unitPriceCents : undefined, discountCents: l.discountCents || undefined, serials: l.serials.length ? l.serials : undefined, prescriptionRef: l.prescriptionRef })),
        cartDiscountCents: cart.cartDiscountCents,
        payments: final.map(({ label: _l, ...p }) => p),
        ageVerified: cart.ageVerified,
        salesDocumentId: cart.salesDocumentId,
        overrideToken,
      };
      const r = await api<{ data: any }>('/sales', { body, idempotencyKey: requestId });
      onDone(r.data);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'OVERRIDE_REQUIRED') setOverride({ permission: e.details?.permission, message: e.message });
      else setError(e);
    } finally {
      setBusy(false);
    }
  };

  const changeDue = method === 'cash' && tendered ? Math.max(0, tendered - remaining) : payments.reduce((a, p) => a + ((p.tenderedCents ?? p.amountCents) - p.amountCents), 0);
  const canComplete = remaining === 0 || (method === 'cash' && (tendered ?? 0) >= remaining);

  return (
    <Modal open onClose={onClose} title={`Payment · ${money(total)}`} size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Back</Button><Button size="lg" loading={busy} disabled={!canComplete} onClick={() => complete()}>Complete sale</Button></>}>
      <div className="grid gap-4 md:grid-cols-[1fr_220px]">
        <div>
          <div className="mb-3 flex flex-wrap gap-2">
            {methods.map((m) => <Button key={m.key} variant={method === m.key ? 'primary' : 'secondary'} onClick={() => setMethod(m.key)}>{m.label}</Button>)}
          </div>
          {remaining > 0 && (
            <div className="space-y-3">
              <Field label="Amount"><MoneyInput value={amount} onChange={setAmount} /></Field>
              {method === 'cash' && (
                <>
                  <Field label="Cash received"><MoneyInput value={tendered} onChange={setTendered} autoFocus /></Field>
                  <div className="flex flex-wrap gap-2">{[remaining, ...[50000, 100000, 200000].filter((v) => v > remaining)].slice(0, 4).map((v) => <Button key={v} size="sm" variant="secondary" onClick={() => setTendered(v)}>{money(v)}</Button>)}</div>
                </>
              )}
              {method === 'mpesa' && (
                <MpesaPanel amount={amount} tillId={till._id} intent={stk} setIntent={setStk} unallocated={c2b.data} usedIds={payments.map((p) => p.paymentIntentId!).filter(Boolean)}
                  onUse={(i) => setPayments((ps) => [...ps, { method: 'mpesa', amountCents: Math.min(i.paidAmountCents - (i.allocatedCents ?? 0), remaining), paymentIntentId: i.id, label: `M-Pesa ${i.receiptNumber}` }])} />
              )}
              {method === 'gateway' && gateways.data && <GatewayPanel gateways={gateways.data} amount={amount} tillId={till._id} customer={cart.customer} intent={stk} setIntent={setStk} />}
              {['card', 'bank'].includes(method) && <Field label="Reference (approval code)"><Input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>}
              {method === 'credit' && cart.customer && <p className="text-sm text-ink-600">Balance {money(cart.customer.balanceCents)} · limit {money(cart.customer.creditLimitCents)}{!can('sales.credit') && ' · needs manager approval'}</p>}
              {method !== 'mpesa' && method !== 'gateway' && <Button variant="secondary" onClick={addPayment}>Add {paymentLabel(method).toLowerCase()} payment</Button>}
            </div>
          )}
          <div className="mt-3"><ErrorBox error={error} /></div>
        </div>
        <div className="rounded-lg bg-ink-50 p-3 text-sm dark:bg-ink-800/50">
          <div className="label">Payments</div>
          <ul className="space-y-1">{payments.map((p, i) => (
            <li key={i} className="flex items-center justify-between"><span>{p.label}</span><span className="flex items-center gap-1 tabular-nums">{money(p.amountCents)}{!p.paymentIntentId && <button aria-label="Remove payment" onClick={() => setPayments((ps) => ps.filter((_, j) => j !== i))}><Icon name="x" className="h-3.5 w-3.5" /></button>}</span></li>
          ))}</ul>
          <div className="mt-3 border-t border-ink-200 pt-2 dark:border-ink-700">
            <div className="flex justify-between"><span>Remaining</span><span className="font-semibold tabular-nums">{money(Math.max(0, remaining))}</span></div>
            <div className="flex justify-between text-lg font-semibold text-emerald-700"><span>Change</span><span className="tabular-nums" data-testid="change-due">{money(changeDue)}</span></div>
          </div>
          {shift && <p className="mt-3 text-xs text-ink-500">Shift {shift.number}</p>}
        </div>
      </div>
      {override && <OverrideModal permission={override.permission} message={override.message} onClose={() => setOverride(null)} onApproved={(token) => { setOverride(null); complete(token); }} />}
    </Modal>
  );
}

/** Supervisor approval on the cashier's screen: email + PIN/password, staff card + PIN, or fingerprint. */
export function OverrideModal({ permission, message, onClose, onApproved }: { permission: string; message: string; onClose: () => void; onApproved: (token: string) => void }) {
  const { me } = useAuth();
  const [mode, setMode] = useState<'card' | 'email' | 'finger'>('card');
  const [email, setEmail] = useState('');
  const [card, setCard] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const pinRef = useRef<HTMLInputElement>(null);
  const approve = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'finger') {
        const r = await fingerprint<{ overrideToken: string }>('override', { permission, forUserId: me!.user.id });
        onApproved(r.overrideToken);
        return;
      }
      const digits = /^\d{4,8}$/.test(pin);
      // The till tells the server which branch the approval is for (supervisors may be limited to some branches).
      const tillId = getWorkstation().tillId || undefined;
      const body = mode === 'card' ? { cardCode: card.trim(), pin: pin || undefined, permission, tillId } : { email, pin: digits ? pin : undefined, password: digits ? undefined : pin, permission, tillId };
      const r = await api<{ overrideToken: string }>('/auth/override', { body });
      onApproved(r.overrideToken);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const modes = [{ key: 'card', label: 'Staff card' }, { key: 'email', label: 'Email' }, ...(bridgeConfigured() ? [{ key: 'finger', label: 'Fingerprint' }] : [])] as { key: typeof mode; label: string }[];
  return (
    <Modal open onClose={onClose} title="Supervisor approval" size="sm" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={approve}>{mode === 'finger' ? 'Scan finger' : 'Approve'}</Button></>}>
      <p className="mb-3 text-sm">{message}</p>
      <div className="mb-3 flex gap-1 rounded-lg bg-ink-100 p-1 text-sm dark:bg-ink-800" role="radiogroup" aria-label="Approve with">
        {modes.map((m) => <button key={m.key} type="button" role="radio" aria-checked={mode === m.key} className={`flex-1 rounded-md py-1.5 ${mode === m.key ? 'bg-white shadow dark:bg-ink-700' : 'text-ink-500'}`} onClick={() => { setMode(m.key); setError(null); }}>{m.label}</button>)}
      </div>
      <div className="space-y-3">
        {mode === 'card' && <Field label="Supervisor card"><Input autoFocus type="password" autoComplete="off" value={card} placeholder="Scan the supervisor's card" onChange={(e) => setCard(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); pinRef.current?.focus(); } }} /></Field>}
        {mode === 'email' && <Field label="Supervisor email"><Input autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></Field>}
        {mode !== 'finger' && <Field label={mode === 'card' ? 'PIN' : 'PIN or password'}><Input ref={pinRef} type="password" value={pin} onChange={(e) => setPin(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') approve(); }} /></Field>}
        {mode === 'finger' && <p className="text-sm text-ink-500">Press <strong>Scan finger</strong>; the supervisor places an enrolled finger on the reader.</p>}
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}

function ReceiptModal({ sale: initial, tillId, onClose }: { sale: any; tillId: string; onClose: () => void }) {
  const toast = useToast();
  const { has } = useAuth();
  const [to, setTo] = useState('');
  // eTIMS signs in the background; give it a few seconds so the printed receipt carries the KRA signature.
  const [sale, setSale] = useState<any>(initial);
  const [waited, setWaited] = useState(!initial.etims || initial.etims.status !== 'pending');
  useEffect(() => {
    if (waited) return;
    let n = 0;
    const t = setInterval(async () => {
      n += 1;
      const s = await api<{ data: any }>(`/sales/${initial._id}`).then((r) => r.data).catch(() => null);
      if (s) setSale(s);
      if (s?.etims?.status !== 'pending' || n >= 6) {
        clearInterval(t);
        setWaited(true);
      }
    }, 700);
    return () => clearInterval(t);
  }, [initial._id, waited]);
  const print = async () => {
    try {
      await api(`/sales/${sale._id}/print`, { body: { tillId } });
      toast.success('Sent to receipt printer');
    } catch {
      await openPrintable(`/sales/${sale._id}/receipt?format=html`).catch((e) => toast.error(e));
    }
  };
  useEffect(() => {
    if (waited && getWorkstation().autoPrint) print();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waited]);
  return (
    <Modal open onClose={onClose} title={`Sale ${sale.number} complete`} size="sm" footer={<Button size="lg" className="w-full" onClick={onClose} autoFocus>New sale</Button>}>
      <div className="text-center">
        <div className="text-sm text-ink-500">Total</div>
        <div className="text-3xl font-semibold">{money(sale.totalCents)}</div>
        {sale.changeCents > 0 && <div className="mt-2 text-xl font-semibold text-emerald-700">Change: {money(sale.changeCents)}</div>}
        {sale.etims && (
          <div className="mt-2 text-xs">
            {sale.etims.status === 'signed' ? <Badge tone="green">KRA eTIMS signed · CU {sale.etims.sdcId}/{sale.etims.rcptNo}</Badge>
              : sale.etims.status === 'failed' ? <Badge tone="red">eTIMS rejected: see KRA eTIMS page</Badge>
              : <Badge tone="amber">{waited ? 'eTIMS will sign when KRA is reachable; reprint later' : 'Signing with KRA eTIMS…'}</Badge>}
          </div>
        )}
      </div>
      <div className="mt-4 space-y-2">
        <Button variant="secondary" className="w-full" onClick={print}><Icon name="printer" className="h-4 w-4" />Print receipt</Button>
        {(has('sms') || has('email')) && (
          <div className="flex gap-2">
            <Input placeholder="Phone or email for receipt" value={to} onChange={(e) => setTo(e.target.value)} />
            <Button variant="secondary" onClick={async () => { await api(`/sales/${sale._id}/send-receipt`, { body: to.includes('@') ? { email: to } : { sms: to } }).then(() => toast.success('Receipt queued')).catch(toast.error); }}>Send</Button>
          </div>
        )}
      </div>
    </Modal>
  );
}

export { toCentsInput };
