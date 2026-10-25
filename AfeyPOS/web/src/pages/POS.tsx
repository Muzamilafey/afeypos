import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { allocateProportionally, calculateTax, lineAmount, roundQty, type PriceListKey } from '@afeypos/shared';
import { api, ApiError, newRequestId, openPrintable } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLocations } from '../lib/hooks';
import { getWorkstation, setWorkstation } from '../lib/workstation';
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
        return { ...c, lines: [...c.lines, { key: newRequestId(), product, unitCode, qty: lineQty, unitPriceCents: qt.unitPriceCents, quotedCents: qt.unitPriceCents, discountCents: 0, serials: [], promotion: qt.source === 'promotion' }] };
      });
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

  return (
    <div className="-m-4 flex h-[calc(100vh-3.5rem)] flex-col lg:-m-6 lg:flex-row">
      {/* left: search & products */}
      <div className="flex min-w-0 flex-1 flex-col border-r border-ink-200 dark:border-ink-800">
        <div className="flex items-center gap-2 border-b border-ink-200 bg-white p-3 dark:border-ink-800 dark:bg-ink-900">
          <div className="relative flex-1">
            <Icon name="barcode" className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-ink-400" />
            <input ref={searchRef} autoFocus value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onScan(e.currentTarget.value); } }}
              placeholder="Scan barcode or search name / SKU (F2)" aria-label="Scan or search products" className={cx('input pl-10', big && 'py-3 text-base')} />
          </div>
          <Badge tone="green">{till.name}</Badge>
        </div>
        {categories.data && categories.data.length > 0 && (
          <div className="flex gap-2 overflow-x-auto border-b border-ink-200 bg-white px-3 py-2 dark:border-ink-800 dark:bg-ink-900">
            <button onClick={() => setCategory(null)} className={cx('whitespace-nowrap rounded-full px-3 py-1.5 text-sm', !category ? 'bg-brand-600 text-white dark:bg-brand-100 dark:text-brand-900' : 'bg-ink-100 dark:bg-ink-800')}>All</button>
            {categories.data.filter((c) => c.active !== false).map((c) => <button key={c._id} onClick={() => setCategory(c._id === category ? null : c._id)} className={cx('whitespace-nowrap rounded-full px-3 py-1.5 text-sm', category === c._id ? 'bg-brand-600 text-white dark:bg-brand-100 dark:text-brand-900' : 'bg-ink-100 dark:bg-ink-800')}>{c.name}</button>)}
          </div>
        )}
        <div className="flex-1 overflow-y-auto p-3">
          {error ? <div className="mb-3"><ErrorBox error={error} /></div> : null}
          {results.isFetching && <Spinner />}
          {(search.length >= 2 || category) && results.data && (
            <div className={cx('grid gap-2', big ? 'grid-cols-2 sm:grid-cols-3 xl:grid-cols-4' : 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3')}>
              {results.data.map((p) => (
                <button key={p._id} onClick={() => { addProduct(p); searchRef.current?.focus(); }} className={cx('card text-left transition hover:border-brand-500', big ? 'p-4' : 'p-3')}>
                  <div className="line-clamp-2 font-medium">{p.name}</div>
                  <div className="mt-1 flex items-center justify-between text-sm">
                    <span className="text-ink-500">{p.sku}</span>
                    <span className="font-semibold">{money(p.prices?.[cart.priceList] ?? p.prices?.retail)}</span>
                  </div>
                  <div className={cx('mt-1 text-xs', (p.stock?.qty ?? 0) <= 0 ? 'text-red-600' : 'text-ink-500')}>In stock: {fmtQty(p.stock?.qty)} {p.baseUnit}</div>
                </button>
              ))}
              {!results.data.length && <p className="text-sm text-ink-500">No products found.</p>}
            </div>
          )}
          {!search && !category && <div className="flex h-full flex-col items-center justify-center text-center text-ink-400"><Icon name="barcode" className="mb-2 h-12 w-12" /><p>Scan an item or pick a category</p><p className="mt-2 text-xs">F2 search · F4 customer · F8 suspend · F9 pay</p></div>}
        </div>
      </div>

      {/* right: cart */}
      <div className="flex w-full flex-col bg-white dark:bg-ink-900 lg:w-[440px]">
        <div className="flex items-center gap-1 overflow-x-auto border-b border-ink-200 px-2 py-2 dark:border-ink-800">
          {carts.map((c, i) => (
            <button key={c.id} onClick={() => setActive(i)} className={cx('flex items-center gap-1 whitespace-nowrap rounded-md px-2.5 py-1 text-xs', i === active ? 'bg-brand-600 text-white dark:bg-brand-100 dark:text-brand-900' : 'bg-ink-100 dark:bg-ink-800')}>
              {c.label}{c.lines.length ? ` (${c.lines.length})` : ''}
            </button>
          ))}
          <button onClick={suspend} title="Suspend sale (F8)" className="rounded-md px-2 py-1 text-xs text-ink-600 hover:bg-ink-100 dark:hover:bg-ink-800"><Icon name="pause" className="h-4 w-4" /></button>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b border-ink-200 px-3 py-2 dark:border-ink-800">
          <button onClick={() => setCustomerOpen(true)} className="flex min-w-0 flex-1 items-center gap-2 rounded-lg bg-ink-50 px-3 py-2 text-left text-sm hover:bg-ink-100 dark:bg-ink-800">
            <Icon name="user" className="h-4 w-4" />
            <span className="truncate">{cart.customer ? cart.customer.name : 'Walk-in customer (F4)'}</span>
          </button>
          {caps.checkout.showPriceListSelector && caps.priceLists.length > 1 && (
            <select aria-label="Price list" className="input w-auto py-2" value={cart.priceList} onChange={(e) => { const c = { ...cart, priceList: e.target.value as PriceListKey }; requoteAll(c); }}>
              {caps.priceLists.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          )}
        </div>
        <div className="flex-1 overflow-y-auto">
          {!cart.lines.length && <div className="p-8 text-center text-sm text-ink-400">Cart is empty</div>}
          <ul className="divide-y divide-ink-100 dark:divide-ink-800">
            {cart.lines.map((l) => (
              <CartLine key={l.key} line={l} allowFraction={caps.checkout.allowFractionalQty && l.product.allowFractional} showUnits={l.product.units.length > 1} canDiscount={can('sales.discount')}
                onChange={(patch) => setLine(l.key, patch)} onRemove={() => update((c) => ({ ...c, lines: c.lines.filter((x) => x.key !== l.key) }))} />
            ))}
          </ul>
        </div>
        <div className="border-t border-ink-200 p-3 dark:border-ink-800">
          {cart.lines.length > 0 && can('sales.discount') && (
            <div className="mb-2 flex items-center gap-2 text-sm">
              <span className="text-ink-500">Cart discount</span>
              <MoneyInput className="w-28 py-1" value={cart.cartDiscountCents} onChange={(v) => update((c) => ({ ...c, cartDiscountCents: v ?? 0 }))} aria-label="Cart discount" />
              {has('promotions') && <Input className="w-28 py-1" placeholder="Coupon" value={cart.couponCode} onChange={(e) => update((c) => ({ ...c, couponCode: e.target.value.toUpperCase() }))} onBlur={() => requoteAll(cart)} aria-label="Coupon code" />}
            </div>
          )}
          {needsAge && <div className="mb-2 rounded-lg bg-amber-50 p-2 text-sm dark:bg-amber-900/30"><Checkbox label={`Customer is ${Math.max(...cart.lines.map((l) => l.product.minAge ?? 18))}+ (ID checked)`} checked={cart.ageVerified} onChange={(v) => update((c) => ({ ...c, ageVerified: v }))} /></div>}
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between"><dt className="text-ink-500">Items</dt><dd className="tabular-nums">{fmtQty(totals.items)}</dd></div>
            {totals.discount > 0 && <div className="flex justify-between text-red-600"><dt>Discounts</dt><dd className="tabular-nums">-{money(totals.discount)}</dd></div>}
            <div className="flex justify-between"><dt className="text-ink-500">{settings.pricesIncludeTax === false ? 'Tax' : 'Incl. tax'}</dt><dd className="tabular-nums">{money(totals.tax)}</dd></div>
            <div className="flex justify-between text-2xl font-semibold"><dt>Total</dt><dd className="tabular-nums" data-testid="cart-total">{money(totals.total)}</dd></div>
          </dl>
          <div className="mt-3 grid grid-cols-3 gap-2">
            <Button variant="secondary" size={big ? 'lg' : 'md'} onClick={() => removeCart(active)} disabled={!cart.lines.length}><Icon name="trash" className="h-4 w-4" />Clear</Button>
            <Button size={big ? 'xl' : 'lg'} className="col-span-2" disabled={!cart.lines.length || (needsAge && !cart.ageVerified)} onClick={() => setPaying(true)}>Pay {money(totals.total)}</Button>
          </div>
        </div>
      </div>

      {customerOpen && <CustomerPicker onClose={() => setCustomerOpen(false)} onPick={(c) => { setCustomerOpen(false); const next = { ...cart, customer: c, priceList: (c?.priceList as PriceListKey) && caps.priceLists.includes(c?.priceList as PriceListKey) ? (c!.priceList as PriceListKey) : cart.priceList }; requoteAll(next); }} />}
      {paying && (
        <PaymentModal cart={cart} total={totals.total} till={till} shift={shift} onClose={() => setPaying(false)}
          onDone={(sale) => { setPaying(false); setLastSale(sale); removeCart(active); qc.invalidateQueries({ queryKey: ['pos-search'] }); searchRef.current?.focus(); }} />
      )}
      {lastSale && <ReceiptModal sale={lastSale} tillId={till._id} onClose={() => { setLastSale(null); searchRef.current?.focus(); }} />}
    </div>
  );
}

function CartLine({ line, allowFraction, showUnits, canDiscount, onChange, onRemove }: { line: Line; allowFraction: boolean; showUnits: boolean; canDiscount: boolean; onChange: (p: Partial<Line>) => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  const step = allowFraction ? 0.5 : 1;
  const total = lineAmount(line.qty, line.unitPriceCents) - line.discountCents;
  return (
    <li className="px-3 py-2">
      <div className="flex items-start gap-2">
        <button className="min-w-0 flex-1 text-left" onClick={() => setOpen((o) => !o)}>
          <div className="truncate text-sm font-medium">{line.product.name}</div>
          <div className="text-xs text-ink-500">{money(line.unitPriceCents)} / {line.unitCode}{line.promotion && <span className="ml-1 text-emerald-600">promo</span>}{line.unitPriceCents !== line.quotedCents && <span className="ml-1 text-amber-600">price changed</span>}</div>
        </button>
        <div className="flex items-center gap-1">
          <button aria-label="Decrease" className="rounded bg-ink-100 p-1.5 dark:bg-ink-800" onClick={() => line.qty - step > 0 ? onChange({ qty: roundQty(line.qty - step) }) : onRemove()}><Icon name="minus" className="h-3.5 w-3.5" /></button>
          <input aria-label="Quantity" className="w-14 rounded border border-ink-200 bg-transparent px-1 py-1 text-center text-sm tabular-nums dark:border-ink-700" value={line.qty} inputMode="decimal"
            onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n) && n > 0) onChange({ qty: allowFraction ? roundQty(n) : Math.round(n) }); }} />
          <button aria-label="Increase" className="rounded bg-ink-100 p-1.5 dark:bg-ink-800" onClick={() => onChange({ qty: roundQty(line.qty + step) })}><Icon name="plus" className="h-3.5 w-3.5" /></button>
        </div>
        <div className="w-24 text-right text-sm font-semibold tabular-nums">{money(total)}</div>
      </div>
      {open && (
        <div className="mt-2 grid grid-cols-2 gap-2 rounded-lg bg-ink-50 p-2 dark:bg-ink-800/50">
          {showUnits && <Field label="Unit"><Select value={line.unitCode} onChange={(e) => onChange({ unitCode: e.target.value })} options={line.product.units.map((u) => ({ value: u.code, label: `${u.name} (${u.factor} ${line.product.baseUnit})` }))} /></Field>}
          <Field label="Unit price"><MoneyInput value={line.unitPriceCents} onChange={(v) => onChange({ unitPriceCents: v ?? 0 })} /></Field>
          {canDiscount && <Field label="Line discount"><MoneyInput value={line.discountCents} onChange={(v) => onChange({ discountCents: v ?? 0 })} /></Field>}
          {line.product.trackSerials && <Field label={`Serial / IMEI (${line.qty})`} className="col-span-2"><Input value={line.serials.join(', ')} onChange={(e) => onChange({ serials: e.target.value.split(/[,\s]+/).filter(Boolean) })} placeholder="Scan serial numbers" /></Field>}
          {line.product.requiresPrescription && <Field label="Prescription reference" className="col-span-2"><Input value={line.prescriptionRef ?? ''} onChange={(e) => onChange({ prescriptionRef: e.target.value })} /></Field>}
          <Button size="sm" variant="ghost" className="col-span-2 text-red-600" onClick={onRemove}>Remove item</Button>
        </div>
      )}
    </li>
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

export function OverrideModal({ permission, message, onClose, onApproved }: { permission: string; message: string; onClose: () => void; onApproved: (token: string) => void }) {
  const [email, setEmail] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<unknown>(null);
  return (
    <Modal open onClose={onClose} title="Supervisor approval" size="sm" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={async () => { try { const r = await api<{ overrideToken: string }>('/auth/override', { body: { email, pin: /^\d{4,8}$/.test(pin) ? pin : undefined, password: /^\d{4,8}$/.test(pin) ? undefined : pin, permission } }); onApproved(r.overrideToken); } catch (e) { setError(e); } }}>Approve</Button></>}>
      <p className="mb-3 text-sm">{message}</p>
      <div className="space-y-3">
        <Field label="Supervisor email"><Input autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="PIN or password"><Input type="password" value={pin} onChange={(e) => setPin(e.target.value)} /></Field>
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}

function ReceiptModal({ sale, tillId, onClose }: { sale: any; tillId: string; onClose: () => void }) {
  const toast = useToast();
  const { has } = useAuth();
  const [to, setTo] = useState('');
  const print = async () => {
    try {
      await api(`/sales/${sale._id}/print`, { body: { tillId } });
      toast.success('Sent to receipt printer');
    } catch {
      await openPrintable(`/sales/${sale._id}/receipt?format=html`).catch((e) => toast.error(e));
    }
  };
  useEffect(() => {
    if (getWorkstation().autoPrint) print();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Modal open onClose={onClose} title={`Sale ${sale.number} complete`} size="sm" footer={<Button size="lg" className="w-full" onClick={onClose} autoFocus>New sale</Button>}>
      <div className="text-center">
        <div className="text-sm text-ink-500">Total</div>
        <div className="text-3xl font-semibold">{money(sale.totalCents)}</div>
        {sale.changeCents > 0 && <div className="mt-2 text-xl font-semibold text-emerald-700">Change: {money(sale.changeCents)}</div>}
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
