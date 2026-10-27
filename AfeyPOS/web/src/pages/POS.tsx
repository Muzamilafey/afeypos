import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { allocateProportionally, calculateTax, CARD_NETWORKS, KENYA_BANKS, lineAmount, mergeCheckoutRules, paymentMethodAllowed, roundQty, type PriceListKey } from '@afeypos/shared';
import { PosTile, type PosTileKind } from '../components/PosTiles';
import { api, ApiError, newRequestId } from '../lib/api';
import { useAuth } from '../lib/auth';
import { usePublicConfig } from './Auth';
import { useLocations } from '../lib/hooks';
import { getWorkstation, setWorkstation } from '../lib/workstation';
import { bridgeConfigured, fingerprint } from '../lib/bridge';
import { money, mpesaPayer, paymentLabel, qty as fmtQty, toCentsInput } from '../lib/format';
import { connectRealtime, useRealtime } from '../lib/realtime';
import { TxnStatus, type TerminalTxn } from './settings/CardTerminals';
import { printHtml, printReceipt } from '../lib/printing';
import { CashCount, cashCountTotal, type CashCounts } from '../components/CashCount';
import { Badge, Button, Checkbox, cx, ErrorBox, Field, Input, Modal, MoneyInput, Select, Spinner, useToast } from '../components/ui';
import { Icon } from '../components/icons';
import { GatewayPanel, type GatewayOption } from '../components/GatewayPayment';
import { MpesaPaid, MpesaPanel } from '../components/MpesaPayment';

interface Product {
  _id: string; name: string; sku: string; baseUnit: string; units: { code: string; name: string; factor: number }[]; prices: Record<string, number | undefined>;
  taxRateBp: number | null; trackSerials: boolean; trackBatches: boolean; allowFractional: boolean; requiresPrescription: boolean; ageRestricted: boolean; minAge?: number; categoryId?: string; stock?: { qty: number }; attributes?: Record<string, string | undefined>;
}
interface Line { __approved?: boolean; key: string; product: Product; unitCode: string; qty: number; unitPriceCents: number; quotedCents: number; discountCents: number; serials: string[]; prescriptionRef?: string; promotion?: boolean }
interface Cart { id: string; label: string; lines: Line[]; customer: { _id: string; name: string; priceList?: string; balanceCents?: number; creditLimitCents?: number; loyaltyPoints?: number; kind?: string } | null; priceList: PriceListKey; cartDiscountCents: number; couponCode: string; ageVerified: boolean; salesDocumentId?: string }
interface Payment { method: string; amountCents: number; tenderedCents?: number; reference?: string; paymentIntentId?: string; terminalTransactionId?: string; label?: string }

const newCart = (n: number, priceList: PriceListKey): Cart => ({ id: newRequestId(), label: `Sale ${n}`, lines: [], customer: null, priceList, cartDiscountCents: 0, couponCode: '', ageVerified: false });

export function POSPage() {
  const { me } = useAuth();
  const locs = useLocations();
  const [tillId, setTillId] = useState(getWorkstation().tillId ?? '');
  // A branch server sells only from its own branch's tills (other branches' tills arrive by sync, read-only).
  const serverBranch = usePublicConfig().data?.branchCode?.toUpperCase();
  const serverBranchId = serverBranch ? locs.data?.branches.find((b) => b.code?.toUpperCase() === serverBranch)?._id : undefined;
  const tills = (locs.data?.tills ?? []).filter((t) => t.active && (!me?.user.branchIds.length || me.user.branchIds.includes(t.branchId)) && (!serverBranch || t.branchId === serverBranchId));
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
  const requireShift = (me?.tenant.checkoutRules ?? mergeCheckoutRules(undefined, me?.tenant.settings ?? {})).shifts.required;
  if (requireShift && !shift.data) return <OpenShift tillId={tillId} tillName={till.name} onOpened={() => shift.refetch()} onChangeTill={() => { setWorkstation({ tillId: undefined }); setTillId(''); }} />;
  return <Checkout till={till} shift={shift.data} onShiftClosed={() => shift.refetch()} />;
}

function OpenShift({ tillId, tillName, onOpened, onChangeTill }: { tillId: string; tillName: string; onOpened: () => void; onChangeTill: () => void }) {
  const { me } = useAuth();
  const [counts, setCounts] = useState<CashCounts>({});
  const [byTotal, setByTotal] = useState(false);
  const [floatCents, setFloat] = useState<number | null>(0);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const currency = me?.tenant.settings?.currency;
  const amount = byTotal ? (floatCents ?? 0) : cashCountTotal(counts, currency);
  const open = async () => {
    setBusy(true); setError(null);
    try { await api('/shifts', { body: { tillId, openingFloatCents: amount, denominations: byTotal ? undefined : counts } }); onOpened(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <div className="mx-auto max-w-xl card p-6">
      <div className="mb-4 flex items-start gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700"><Icon name="play" className="h-5 w-5" /></span>
        <div><h2 className="text-lg font-bold">Start shift on {tillName}</h2><p className="text-sm text-ink-500">Count the cash in the drawer (the float) before you start selling.</p></div>
      </div>
      {byTotal
        ? <Field label="Opening float"><MoneyInput value={floatCents} onChange={setFloat} autoFocus onKeyDown={(e) => { if (e.key === 'Enter') open(); }} /></Field>
        : <CashCount counts={counts} onChange={setCounts} autoFocus label="Opening float" />}
      <button type="button" className="mt-2 text-xs font-semibold text-brand-600 hover:underline" onClick={() => setByTotal(!byTotal)}>{byTotal ? 'Count notes and coins instead' : 'Enter the total instead'}</button>
      <div className="mt-4"><ErrorBox error={error} /></div>
      <div className="mt-4 flex gap-2">
        <Button className="flex-1" size="lg" loading={busy} onClick={open}>Start shift · {money(amount)}</Button>
        <Button variant="secondary" size="lg" onClick={onChangeTill}>Change till</Button>
      </div>
    </div>
  );
}

/**
 * End shift at the till: count the drawer note by note and coin by coin, then close the shift (a supervisor
 * may need to approve, per Checkout rules) and print the Z report. In blind mode the expected cash is hidden.
 */
function EndShiftModal({ shift, cartHasItems, onClose, onClosed }: { shift: any; cartHasItems: boolean; onClose: () => void; onClosed: () => void }) {
  const { me } = useAuth();
  const toast = useToast();
  const summary = useQuery({ queryKey: ['shift-summary', shift._id], queryFn: () => api<{ data: any }>(`/shifts/${shift._id}/summary`).then((r) => r.data) });
  const [counts, setCounts] = useState<CashCounts>({});
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [approval, setApproval] = useState<{ permission: string; message: string } | null>(null);
  const [done, setDone] = useState<any>(null);
  const counted = cashCountTotal(counts, me?.tenant.settings?.currency);
  const s = summary.data;
  const blind = Boolean(s?.blind);
  const close = async (overrideToken?: string) => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ data: any }>(`/shifts/${shift._id}/close`, { body: { countedCashCents: counted, denominations: counts, notes: notes || undefined, overrideToken } });
      setDone(r.data);
      printHtml(`/shifts/${shift._id}/report`).catch(() => undefined);
    } catch (e: any) {
      if (e?.code === 'OVERRIDE_REQUIRED') setApproval({ permission: e.details?.permission ?? 'shifts.manage', message: e.message });
      else setError(e);
    } finally { setBusy(false); }
  };
  if (done) {
    const v = done.shift?.varianceCents;
    return (
      <Modal open onClose={onClosed} title={`Shift ${shift.number} closed`} icon="check" subtitle="The Z report was sent to the printer."
        footer={<><Button variant="secondary" onClick={() => printHtml(`/shifts/${shift._id}/report`).catch(toast.error)}><Icon name="printer" className="h-4 w-4" />Print Z report again</Button><Button autoFocus onClick={onClosed}>Done</Button></>}>
        <div className="space-y-3 text-sm">
          <div className="flex justify-between rounded-lg bg-ink-50 px-4 py-3 dark:bg-ink-800/50"><span>Counted cash</span><b className="text-lg">{money(done.shift.countedCashCents)}</b></div>
          {!blind && done.expectedCashCents !== undefined && <div className="flex justify-between px-4"><span>Expected</span><span>{money(done.expectedCashCents)}</span></div>}
          {!blind && v !== undefined && <div className={cx('flex justify-between rounded-lg px-4 py-3 font-bold', v === 0 ? 'bg-emerald-50 text-emerald-800' : v < 0 ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-800')}><span>{v === 0 ? 'Balanced' : v < 0 ? 'Short' : 'Over'}</span><span>{money(v)}</span></div>}
          {blind && <p className="text-ink-500">The count is recorded. A supervisor reviews the difference.</p>}
        </div>
      </Modal>
    );
  }
  return (
    <Modal open onClose={onClose} title={`End shift ${shift.number}`} icon="clock" subtitle={`Started ${new Date(shift.openedAt).toLocaleString()} with a float of ${money(shift.openingFloatCents)}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={cartHasItems} onClick={() => close()}>Close shift · {money(counted)}</Button></>}>
      <div className="space-y-4">
        {cartHasItems && <p role="alert" className="rounded-md bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">Finish or hold the current sale before ending the shift.</p>}
        {s && (
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <div className="rounded-md bg-ink-50 p-2.5 dark:bg-ink-800/50"><div className="text-[11px] uppercase text-ink-500">Sales</div><b>{s.sales.count}</b></div>
            <div className="rounded-md bg-ink-50 p-2.5 dark:bg-ink-800/50"><div className="text-[11px] uppercase text-ink-500">Takings</div><b>{money(s.sales.totalCents)}</b></div>
            <div className="rounded-md bg-ink-50 p-2.5 dark:bg-ink-800/50"><div className="text-[11px] uppercase text-ink-500">Cash sales</div><b>{money(s.paymentsByMethod?.cash?.totalCents ?? 0)}</b></div>
            <div className="rounded-md bg-ink-50 p-2.5 dark:bg-ink-800/50"><div className="text-[11px] uppercase text-ink-500">Expected cash</div><b>{blind ? 'Hidden' : money(s.expectedCashCents)}</b></div>
          </div>
        )}
        <CashCount counts={counts} onChange={setCounts} autoFocus={!cartHasItems} label="Counted cash" />
        {!blind && s && counted > 0 && (
          <p className={cx('text-sm font-semibold', counted === s.expectedCashCents ? 'text-emerald-700' : counted < s.expectedCashCents ? 'text-red-600' : 'text-amber-700')}>
            {counted === s.expectedCashCents ? 'Matches the expected cash.' : `${counted < s.expectedCashCents ? 'Short by' : 'Over by'} ${money(Math.abs(counted - s.expectedCashCents))}`}
          </p>
        )}
        <Field label="Notes (optional)"><Input value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. 500 note given to supervisor at 4 pm" /></Field>
        <ErrorBox error={error} />
      </div>
      {approval && <OverrideModal permission={approval.permission} message={approval.message} onClose={() => setApproval(null)} onApproved={(token) => { setApproval(null); close(token); }} />}
    </Modal>
  );
}

function Checkout({ till, shift, onShiftClosed }: { till: { _id: string; name: string; warehouseId: string; branchId: string }; shift: any; onShiftClosed: () => void }) {
  const { me, can, has } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const caps = me!.capabilities;
  const settings = me!.tenant.settings ?? {};
  const rules = me!.tenant.checkoutRules ?? mergeCheckoutRules(undefined, settings);
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
  const [paying, setPaying] = useState<false | string>(false);
  // Removing scanned items may need a supervisor (Checkout rules); the action runs once approved and recorded.
  const [removal, setRemoval] = useState<{ kind: 'remove' | 'reduce' | 'clear'; lines: { productId: string; name: string; qty: number; amountCents: number }[]; then: () => void } | null>(null);
  const [loyaltyOpen, setLoyaltyOpen] = useState(false);
  const [voucherOpen, setVoucherOpen] = useState(false);
  const [voucherCode, setVoucherCode] = useState('');
  const [endingShift, setEndingShift] = useState(false);
  const [startingShift, setStartingShift] = useState(false);
  const [customerOpen, setCustomerOpen] = useState(false);
  const [lastSale, setLastSale] = useState<any>(null);
  const [error, setError] = useState<unknown>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [panel, setPanel] = useState<null | { kind: 'line'; focus: 'qty' | 'discount' } | { kind: 'cart' } | { kind: 'resume' } | { kind: 'browse' } | { kind: 'more' }>(null);

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

  const needsApproval = (kind: 'remove' | 'reduce' | 'clear') => !can('sales.items.remove') && (kind === 'clear' ? rules.items.clearNeedsApproval : kind === 'reduce' ? rules.items.reduceQtyNeedsApproval : rules.items.removeNeedsApproval);
  /** Records the removal (always) and runs it; asks for a supervisor first when the rules say so. */
  const guardRemoval = (kind: 'remove' | 'reduce' | 'clear', lines: Line[] | { line: Line; qty: number }[], then: () => void) => {
    const rows = lines.map((x) => ('line' in x ? { l: x.line, q: x.qty } : { l: x, q: x.qty })).map(({ l, q }) => ({ productId: l.product._id, name: l.product.name, qty: q, amountCents: lineAmount(q, l.unitPriceCents) }));
    if (!rows.length) return then();
    if (needsApproval(kind)) {
      setRemoval({ kind, lines: rows, then });
      return;
    }
    api('/pos/item-removals', { body: { tillId: till._id, kind, lines: rows } }).catch(() => undefined);
    then();
  };

  const setLine = async (key: string, patch: Partial<Line>) => {
    const line = cart.lines.find((l) => l.key === key);
    if (!line) return;
    if (patch.qty !== undefined && patch.qty < line.qty && !patch.__approved) {
      guardRemoval('reduce', [{ line, qty: roundQty(line.qty - patch.qty) }], () => setLine(key, { ...patch, __approved: true }));
      return;
    }
    delete patch.__approved;
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
    if (!cart.lines.length || !rules.items.holdAllowed) return;
    setCarts((cs) => [...cs, newCart(cs.length + 1, caps.checkout.defaultPriceList)]);
    setActive(carts.length);
    toast.info(`${cart.label} suspended`);
  };
  /** The cashier clears a sale (or discards a held one): recorded, and may need a supervisor. */
  const clearCart = (i: number) => {
    const c = carts[i];
    if (!c?.lines.length) return removeCart(i);
    guardRemoval('clear', c.lines, () => removeCart(i));
  };
  const removeCart = (i: number) => {
    setCarts((cs) => (cs.length === 1 ? [newCart(1, caps.checkout.defaultPriceList)] : cs.filter((_, j) => j !== i)));
    setActive(0);
  };

  // Keyboard: the till works without a mouse. Shortcuts act only when no window (payment, customer...) is open.
  const anyOpen = Boolean(paying || panel || customerOpen || lastSale || removal || loyaltyOpen || voucherOpen || endingShift);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (anyOpen) return;
      // The scan box always listens: a barcode scanner types like a keyboard, so characters typed while
      // focus is on a button, a line or nowhere go into the scan box (Enter then adds the item).
      const el = document.activeElement as HTMLElement | null;
      const editable = Boolean(el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable));
      if (!editable && e.key.length === 1 && e.key !== ' ' && e.key !== '+' && e.key !== '-' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        searchRef.current?.focus();
        setSearch((v) => v + e.key);
        return;
      }
      const inSearch = document.activeElement === searchRef.current;
      const typingElsewhere = !inSearch && /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement as HTMLElement | null)?.tagName ?? '');
      const searchEmpty = !searchRef.current?.value;
      const idx = cart.lines.findIndex((l) => l.key === selected?.key);
      const key = e.key;
      if (key === 'F2') { e.preventDefault(); searchRef.current?.focus(); return; }
      if (key === 'F3') { e.preventDefault(); if (has('mpesa') && allowed('mpesa')) pay('mpesa'); return; }
      if (key === 'F4') { e.preventDefault(); setCustomerOpen(true); return; }
      if (key === 'F6') { e.preventDefault(); if (allowed('card')) pay('card'); return; }
      if (key === 'F7') { e.preventDefault(); if (!cantPay && allowed('voucher')) setVoucherOpen(true); return; }
      if (key === 'F8') { e.preventDefault(); suspend(); return; }
      if (key === 'F9' || key === 'F12') { e.preventDefault(); pay('cash'); return; }
      if (key === 'F10') { e.preventDefault(); setPanel({ kind: 'more' }); return; }
      if (typingElsewhere || !searchEmpty || !cart.lines.length) return;
      // With the scan box empty: arrows pick a line, +/- change its quantity, Delete removes it.
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        e.preventDefault();
        const next = cart.lines[Math.max(0, Math.min(cart.lines.length - 1, (idx < 0 ? cart.lines.length : idx) + (key === 'ArrowDown' ? 1 : -1)))];
        if (next) setSelectedKey(next.key);
      } else if ((key === '+' || key === '-') && selected) {
        e.preventDefault();
        const step = caps.checkout.allowFractionalQty && selected.product.allowFractional ? 0.5 : 1;
        const q = roundQty(selected.qty + (key === '+' ? step : -step));
        if (q > 0) setLine(selected.key, { qty: q });
        else removeLine(selected.key);
      } else if (key === 'Delete' && selected) {
        e.preventDefault();
        removeLine(selected.key);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  // Cash pickup warning (Checkout rules): the server only says whether one is due, even in blind mode.
  const pickup = useQuery({ queryKey: ['pickup', shift?._id], queryFn: () => api<{ data: { pickupDue?: boolean } }>(`/shifts/${shift._id}/summary`).then((r) => Boolean(r.data.pickupDue)), enabled: Boolean(shift?._id) && rules.shifts.maxCashInDrawerCents > 0, refetchInterval: 120_000 });
  const pickupDue = Boolean(pickup.data);
  const needsAge = has('ageVerification') && cart.lines.some((l) => l.product.ageRestricted);
  const big = caps.checkout.touchMode;
  const selected = cart.lines.find((l) => l.key === selectedKey) ?? cart.lines[cart.lines.length - 1];
  const held = carts.map((c, i) => ({ c, i })).filter(({ i }) => i !== active);
  const removeLine = (key: string) => {
    const line = cart.lines.find((x) => x.key === key);
    if (line) guardRemoval('remove', [line], () => update((c) => ({ ...c, lines: c.lines.filter((x) => x.key !== key) })));
  };
  const taxLabel = settings.pricesIncludeTax === false ? 'Tax' : `Tax${settings.defaultTaxRateBp ? ` (${settings.defaultTaxRateBp / 100}%)` : ''}`;
  // Only the ways to pay the owner allows (Checkout rules); a method that is off opens the first allowed one.
  const allowed = (m: string) => paymentMethodAllowed(rules, m);
  const pay = (method: string) => cart.lines.length && !(needsAge && !cart.ageVerified) && setPaying(allowed(method) ? method : rules.paymentMethods[0]);
  const cantPay = !cart.lines.length || (needsAge && !cart.ageVerified);
  // Main tiles: ways to pay and the sale's customer. Editing the sale is under More.
  const allTiles: { kind: PosTileKind; label: string; onClick: () => void; disabled?: boolean; hint?: string; title?: string; badge?: string }[] = [
    { kind: 'mpesa', label: 'M-Pesa payment', hint: 'F3', onClick: () => pay('mpesa'), disabled: cantPay || !has('mpesa'), title: has('mpesa') ? undefined : 'Turn on M-Pesa in Settings > Integrations' },
    { kind: 'cash', label: 'Cash payment', onClick: () => pay('cash'), disabled: cantPay, hint: 'Enter' },
    { kind: 'card', label: 'Card payment', hint: 'F6', onClick: () => pay('card'), disabled: cantPay },
    { kind: 'loyalty', label: 'Loyalty card', onClick: () => setLoyaltyOpen(true), disabled: !has('loyalty'), title: has('loyalty') ? undefined : 'Turn on the Loyalty module in Settings' },
    { kind: 'voucher', label: 'Voucher', hint: 'F7', onClick: () => setVoucherOpen(true), disabled: cantPay, badge: cart.couponCode || undefined },
    { kind: 'customer', label: cart.customer ? `Customer: ${cart.customer.name}` : 'Customer', onClick: () => setCustomerOpen(true), hint: 'F4', badge: cart.customer ? '✓' : undefined },
    { kind: 'hold', label: 'Hold sale', onClick: suspend, disabled: !cart.lines.length || !rules.items.holdAllowed, hint: 'F8', title: rules.items.holdAllowed ? undefined : 'Holding sales is turned off in Checkout rules' },
  ];
  const tiles = allTiles.filter((t) => !['mpesa', 'cash', 'card', 'voucher'].includes(t.kind) || allowed(t.kind));
  const more: { key: string; label: string; icon: string; tone: string; onClick: () => void; disabled?: boolean; count?: number; lock?: boolean }[] = [
    { key: 'qty', label: 'Quantity', icon: 'plus', tone: 'text-emerald-600 bg-emerald-50', onClick: () => setPanel({ kind: 'line', focus: 'qty' }), disabled: !selected },
    { key: 'ldisc', label: 'Line discount', icon: 'percent', tone: 'text-sky-600 bg-sky-50', onClick: () => setPanel({ kind: 'line', focus: 'discount' }), disabled: !selected || !can('sales.discount') },
    { key: 'del', label: 'Delete item', icon: 'trash', tone: 'text-red-600 bg-red-50', onClick: () => { setPanel(null); if (selected) removeLine(selected.key); }, disabled: !selected, lock: needsApproval('remove') },
    { key: 'gdisc', label: 'Sale discount', icon: 'tag', tone: 'text-violet-600 bg-violet-50', onClick: () => setPanel({ kind: 'cart' }), disabled: !cart.lines.length || !can('sales.discount') },
    { key: 'resume', label: 'Resume held', icon: 'play', tone: 'text-orange-600 bg-orange-50', onClick: () => setPanel({ kind: 'resume' }), disabled: !held.length, count: held.length },
    { key: 'browse', label: 'Browse products', icon: 'grid', tone: 'text-teal-600 bg-teal-50', onClick: () => setPanel({ kind: 'browse' }) },
    ...(shift ? [{ key: 'endshift', label: 'End shift', icon: 'clock', tone: 'text-amber-700 bg-amber-50', onClick: () => { setPanel(null); setEndingShift(true); } }] : []),
    { key: 'clear', label: 'Clear sale', icon: 'x', tone: 'text-ink-600 bg-ink-100', onClick: () => { setPanel(null); clearCart(active); }, disabled: !cart.lines.length, lock: needsApproval('clear') },
  ];

  return (
    // Fills the window under the shell's header (48px) and breadcrumb (42px), inside the page padding; the footer is hidden here.
    <div className="flex flex-col gap-3 lg:h-[calc(100vh-80px)] lg:min-h-[520px] lg:flex-row">
      {/* main: search, transaction lines, totals */}
      <section className="card flex min-w-0 flex-1 flex-col overflow-hidden" aria-label="Current sale">
        <div className="flex flex-wrap items-center gap-2 border-b border-ink-100 px-4 py-3 dark:border-ink-800">
          <div className="relative min-w-[240px] flex-1">
            <Icon name="search" className="absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-ink-400" />
            <input ref={searchRef} autoFocus value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (e.currentTarget.value.trim()) onScan(e.currentTarget.value); else pay('cash'); } if (e.key === 'Escape') setSearch(''); }}
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
          <Badge tone="green">{till.name}</Badge>
          {!shift && (
            <button type="button" onClick={() => setStartingShift(true)} className="inline-flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-semibold text-emerald-800 hover:bg-emerald-100 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
              <Icon name="play" className="h-3.5 w-3.5" />Start shift
            </button>
          )}
          {shift && (
            <button type="button" onClick={() => setEndingShift(true)} title={`Shift ${shift.number} since ${new Date(shift.openedAt).toLocaleTimeString()}`}
              className="inline-flex items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-100 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              <Icon name="clock" className="h-3.5 w-3.5" />End shift
            </button>
          )}
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
              <p className="mt-1 text-xs">Enter pay cash · F3 M-Pesa · F6 card · F7 voucher · F4 customer · F8 hold · F10 more</p>
              <p className="mt-0.5 text-xs">↑ ↓ pick a line · + − quantity · Delete remove · F2 scan box</p>
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
        {pickupDue && <div role="alert" className="flex items-center gap-2 rounded-lg bg-amber-100 px-3 py-2 text-[13px] font-semibold text-amber-900 dark:bg-amber-900/40 dark:text-amber-100"><Icon name="alert" className="h-4 w-4 shrink-0" />Cash pickup due: hand cash over to a supervisor.</div>}
        <div className="grid min-h-0 flex-1 auto-rows-fr grid-cols-2 gap-2.5 overflow-y-auto">
          {tiles.map((t) => <PosTile key={t.kind} {...t} big={big} />)}
          <button type="button" onClick={() => setPanel({ kind: 'more' })} aria-haspopup="dialog"
            className="card flex min-h-[56px] items-center justify-center gap-2 transition hover:-translate-y-px hover:shadow-md">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-ink-100 text-ink-600 dark:bg-ink-800 dark:text-ink-300"><Icon name="grid" className="h-4 w-4" /></span>
            <span className="text-[13px] font-extrabold uppercase tracking-wide text-ink-800 dark:text-ink-100">More</span>
            {held.length > 0 && <span className="rounded-full bg-orange-100 px-1.5 text-[11px] font-bold text-orange-700">{held.length}</span>}
          </button>
        </div>
        {needsAge && <div className="card p-3 text-sm"><Checkbox label={`Customer is ${Math.max(...cart.lines.map((l) => l.product.minAge ?? 18))}+ (ID checked)`} checked={cart.ageVerified} onChange={(v) => update((c) => ({ ...c, ageVerified: v }))} /></div>}
        <button type="button" aria-label={`Pay ${money(totals.total)}`} disabled={cantPay} onClick={() => setPaying('cash')}
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
                <Button size="sm" variant="ghost" aria-label={`Discard ${c.label}`} onClick={() => clearCart(i)}><Icon name="trash" className="h-4 w-4" /></Button>
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

      {panel?.kind === 'more' && (
        <Modal open onClose={() => setPanel(null)} title="More actions" icon="grid" subtitle={selected ? `Selected: ${selected.product.name}` : 'Scan an item first to change it.'} size="md">
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
            {more.map((t) => (
              <button key={t.key} type="button" onClick={t.onClick} disabled={t.disabled}
                className="relative flex min-h-[92px] flex-col items-center justify-center gap-1.5 rounded-lg border border-ink-100 bg-white p-3 transition hover:-translate-y-px hover:border-brand-300 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:translate-y-0 disabled:hover:shadow-none dark:border-ink-800 dark:bg-ink-900">
                {t.lock && <Icon name="lock" className="absolute right-2 top-2 h-3.5 w-3.5 text-ink-400" aria-label="Needs a supervisor" />}
                <span className={cx('flex h-9 w-9 items-center justify-center rounded-full', t.tone)}><Icon name={t.icon} className="h-[18px] w-[18px]" /></span>
                <span className="text-[12.5px] font-extrabold uppercase tracking-wide">{t.label}{t.count ? ` (${t.count})` : ''}</span>
              </button>
            ))}
          </div>
          {(needsApproval('remove') || needsApproval('clear')) && <p className="mt-3 flex items-center gap-1.5 text-xs text-ink-500"><Icon name="lock" className="h-3.5 w-3.5" />Locked actions need a supervisor's card scan.</p>}
        </Modal>
      )}
      {removal && (
        <OverrideModal permission="sales.items.remove"
          message={`${removal.kind === 'clear' ? 'Clearing this sale' : removal.kind === 'reduce' ? 'Lowering the quantity' : `Removing ${removal.lines[0]?.name ?? 'this item'}`} needs a supervisor. Scan the supervisor's card.`}
          onClose={() => { setRemoval(null); searchRef.current?.focus(); }}
          onApproved={async (token) => {
            const r = removal;
            setRemoval(null);
            try {
              await api('/pos/item-removals', { body: { tillId: till._id, kind: r.kind, lines: r.lines, overrideToken: token } });
              r.then();
              toast.success('Approved and recorded');
            } catch (e) { toast.error(e); }
            searchRef.current?.focus();
          }} />
      )}
      {voucherOpen && <VoucherModal current={cart.couponCode} coupons={has('promotions')} onPay={(code) => { setVoucherOpen(false); setVoucherCode(code); setPaying('voucher'); }} onClose={() => { setVoucherOpen(false); searchRef.current?.focus(); }} onApply={async (code) => {
        const next = { ...cart, couponCode: code };
        await requoteAll(next);
        setVoucherOpen(false);
        const applied = next.lines.length > 0 && code ? (await Promise.all(next.lines.map((l) => quote(l.product, l.unitCode, l.qty, next).catch(() => null)))).some((q) => q?.source === 'promotion') : false;
        if (!code) toast.info('Voucher removed');
        else if (applied) toast.success(`Voucher ${code} applied`);
        else toast.error(`Voucher ${code} does not apply to these items (or has expired)`);
        searchRef.current?.focus();
      }} />}
      {loyaltyOpen && <LoyaltyCardModal onClose={() => { setLoyaltyOpen(false); searchRef.current?.focus(); }} onFound={(c) => {
        setLoyaltyOpen(false);
        const next = { ...cart, customer: c, priceList: (c.priceList as PriceListKey) && caps.priceLists.includes(c.priceList as PriceListKey) ? (c.priceList as PriceListKey) : cart.priceList };
        requoteAll(next);
        if (c.loyaltyPoints && cart.lines.length) setPaying('loyalty');
        else toast.info(`${c.name} added to the sale${c.loyaltyPoints ? '' : ': no points to spend yet'}`);
      }} />}
      {customerOpen && <CustomerPicker onClose={() => setCustomerOpen(false)} onPick={(c) => { setCustomerOpen(false); const next = { ...cart, customer: c, priceList: (c?.priceList as PriceListKey) && caps.priceLists.includes(c?.priceList as PriceListKey) ? (c!.priceList as PriceListKey) : cart.priceList }; requoteAll(next); }} />}
      {paying && (
        <PaymentModal cart={cart} total={totals.total} till={till} shift={shift} initialMethod={paying} initialVoucher={paying === 'voucher' ? voucherCode : undefined} onClose={() => setPaying(false)}
          onDone={(sale) => { setPaying(false); setLastSale(sale); removeCart(active); pickup.refetch(); qc.invalidateQueries({ queryKey: ['pos-search'] }); searchRef.current?.focus(); }} />
      )}
      {startingShift && (
        <Modal open onClose={() => setStartingShift(false)} title="Start shift" icon="play">
          <OpenShift tillId={till._id} tillName={till.name} onOpened={() => { setStartingShift(false); onShiftClosed(); }} onChangeTill={() => setStartingShift(false)} />
        </Modal>
      )}
      {endingShift && shift && <EndShiftModal shift={shift} cartHasItems={cart.lines.length > 0} onClose={() => { setEndingShift(false); searchRef.current?.focus(); }} onClosed={() => { setEndingShift(false); qc.invalidateQueries({ queryKey: ['shifts'] }); onShiftClosed(); }} />}
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

/**
 * Pay with Voucher: a gift voucher with a balance (GV-...) pays for the sale; a discount coupon (a code set up
 * under Promotions) lowers the prices. Both are re-checked on the server when the sale completes.
 */
function VoucherModal({ current, coupons, onClose, onApply, onPay }: { current: string; coupons: boolean; onClose: () => void; onApply: (code: string) => Promise<void>; onPay: (code: string) => void }) {
  const [mode, setMode] = useState<'gift' | 'coupon'>('gift');
  const [code, setCode] = useState('');
  const [coupon, setCoupon] = useState(current);
  const [info, setInfo] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const check = async () => {
    setBusy(true); setError(null); setInfo(null);
    try { setInfo((await api<{ data: any }>('/vouchers/check', { query: { code: code.trim().toUpperCase() } })).data); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const apply = async (c: string) => { setBusy(true); try { await onApply(c.trim().toUpperCase()); } finally { setBusy(false); } };
  return (
    <Modal open onClose={onClose} title="Pay with voucher" icon="tag" size="sm"
      footer={mode === 'gift'
        ? <><Button variant="secondary" onClick={onClose}>Cancel</Button>{info?.usable ? <Button onClick={() => onPay(info.code)}>Pay with this voucher</Button> : <Button loading={busy} disabled={!code.trim()} onClick={check}>Check voucher</Button>}</>
        : <>{current && <Button variant="ghost" onClick={() => apply('')}>Remove coupon</Button>}<Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!coupon.trim()} onClick={() => apply(coupon)}>Apply coupon</Button></>}>
      {coupons && (
        <div className="mb-3 flex gap-1 rounded-lg bg-ink-100 p-1 text-sm dark:bg-ink-800" role="radiogroup" aria-label="Voucher type">
          {([['gift', 'Gift voucher'], ['coupon', 'Discount coupon']] as const).map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={mode === k} onClick={() => { setMode(k); setError(null); }} className={cx('flex-1 rounded-md py-1.5', mode === k ? 'bg-white font-semibold shadow dark:bg-ink-700' : 'text-ink-500')}>{l}</button>)}
        </div>
      )}
      {mode === 'gift' ? (
        <>
          <Field label="Voucher code"><Input autoFocus value={code} onChange={(e) => { setCode(e.target.value.toUpperCase()); setInfo(null); }} onKeyDown={(e) => { if (e.key === 'Enter' && code.trim()) { e.preventDefault(); if (info?.usable) onPay(info.code); else check(); } }} placeholder="Scan the voucher, e.g. GV-ABCD2345" /></Field>
          {info && (
            <div className={cx('mt-3 rounded-lg p-3 text-sm', info.usable ? 'bg-[#84603a] text-white' : 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-200')} data-testid="voucher-info">
              {info.usable ? <><div className="text-xs uppercase tracking-widest opacity-80">Balance</div><div className="text-2xl font-black">{money(info.balanceCents)}</div><div className="text-xs opacity-90">of {money(info.initialCents)}{info.expiresAt ? ` · valid until ${new Date(info.expiresAt).toLocaleDateString()}` : ''}</div></> : info.problem}
            </div>
          )}
        </>
      ) : (
        <>
          <Field label="Coupon code"><Input autoFocus value={coupon} onChange={(e) => setCoupon(e.target.value.toUpperCase())} onKeyDown={(e) => { if (e.key === 'Enter' && coupon.trim()) apply(coupon); }} placeholder="e.g. KARIBU10" /></Field>
          <p className="mt-2 text-xs text-ink-500">Coupons are set up as promotions with a code under Promotions.</p>
        </>
      )}
      <div className="mt-2"><ErrorBox error={error} /></div>
    </Modal>
  );
}

/** Scan or type a loyalty card (the customer's code) or phone number to put the customer on the sale. */
function LoyaltyCardModal({ onClose, onFound }: { onClose: () => void; onFound: (c: NonNullable<Cart['customer']>) => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const find = async () => {
    const q = code.trim();
    if (!q) return;
    setBusy(true); setError(null);
    try {
      onFound((await api<{ data: any }>('/loyalty/lookup', { query: { code: q } })).data);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="Loyalty card" icon="star" subtitle="Scan the customer's card, or type the card code or phone number." size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={find}>Find customer</Button></>}>
      <Field label="Card code or phone"><Input autoFocus value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); find(); } }} placeholder="Scan card" /></Field>
      <p className="mt-2 text-xs text-ink-500">With points available, the payment opens on Points so the customer can pay with them.</p>
      <div className="mt-2"><ErrorBox error={error} /></div>
    </Modal>
  );
}

function PaymentModal({ cart, total, till, shift, initialMethod, initialVoucher, onClose, onDone }: { cart: Cart; total: number; till: { _id: string }; shift: any; initialMethod?: string; initialVoucher?: string; onClose: () => void; onDone: (sale: any) => void }) {
  const { has, can, me } = useAuth();
  const terminals: { name: string; bank: string; terminalId: string }[] = me?.tenant.settings?.cardTerminals ?? [];
  const [voucher, setVoucher] = useState<{ code: string; info: any | null }>({ code: initialVoucher ?? '', info: null });
  const [card, setCard] = useState({ terminal: terminals[0]?.name ?? '', type: 'Visa', issuer: '', last4: '', approval: '' });
  const toast = useToast();
  // Stable id for this payment attempt: retries after a network error replay instead of double-selling.
  const [requestId] = useState(newRequestId);
  const [payments, setPayments] = useState<Payment[]>([]);
  const checkoutRules = me?.tenant.checkoutRules ?? mergeCheckoutRules(undefined, me?.tenant.settings ?? {});
  const [method, setMethod] = useState(initialMethod && paymentMethodAllowed(checkoutRules, initialMethod) ? initialMethod : paymentMethodAllowed(checkoutRules, 'cash') ? 'cash' : checkoutRules.paymentMethods[0]);
  const paid = payments.reduce((a, p) => a + p.amountCents, 0);
  const remaining = total - paid;
  const [amount, setAmount] = useState<number | null>(remaining);
  const [tendered, setTendered] = useState<number | null>(null);
  const [reference, setReference] = useState('');
  const [stk, setStk] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [override, setOverride] = useState<{ permission: string; message: string } | null>(null);
  // The terminal's last answer stays on screen (e.g. "remove your card") after it paid the rest of the sale.
  const [terminalDone, setTerminalDone] = useState<TerminalTxn | null>(null);
  const [mpesaDone, setMpesaDone] = useState<any>(null);

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
      const who = mpesaPayer(stk);
      setPayments((ps) => [...ps, { method: isMpesa ? 'mpesa' : 'gateway', amountCents: Math.min(free, ps.reduce((a, p) => a - p.amountCents, total)), paymentIntentId: stk.id, label: `${label} ${stk.receiptNumber ?? ''}${who ? ` · ${who}` : ''}` }]);
      toast.success(`${label} payment confirmed: ${money(stk.paidAmountCents ?? stk.amountCents)}${who ? ` from ${who}` : ''}`);
      if (isMpesa) setMpesaDone(stk);
    }
  }, [stk, payments, toast, total]);

  const gateways = useQuery({ queryKey: ['gateways', till._id], queryFn: () => api<{ data: GatewayOption[] }>('/payments/gateways', { query: { tillId: till._id } }).then((r) => r.data), enabled: has('payments'), staleTime: 60_000 });

  const methods = [
    { key: 'cash', label: 'Cash' },
    ...(has('mpesa') ? [{ key: 'mpesa', label: 'M-Pesa' }] : []),
    ...(gateways.data?.length ? [{ key: 'gateway', label: 'Mobile money & cards' }] : []),
    { key: 'card', label: 'Card' },
    { key: 'bank', label: 'Bank' },
    ...(has('customerCredit') && cart.customer && cart.customer.kind !== 'walk_in' ? [{ key: 'credit', label: 'On account' }] : []),
    ...(has('loyalty') && cart.customer?.loyaltyPoints ? [{ key: 'loyalty', label: `Points (${cart.customer.loyaltyPoints})` }] : []),
    { key: 'voucher', label: 'Gift voucher' },
  ].filter((m) => paymentMethodAllowed(checkoutRules, m.key));
  // Gift voucher: look up the balance; Points: offer what the program allows on this sale.
  const checkVoucher = async (code = voucher.code) => {
    setError(null);
    try {
      const info = (await api<{ data: any }>('/vouchers/check', { query: { code: code.trim().toUpperCase() } })).data;
      setVoucher({ code: info.code, info });
      if (info.usable) setAmount(Math.min(info.balanceCents, remaining));
    } catch (e) { setVoucher({ code, info: null }); setError(e); }
  };
  useEffect(() => {
    if (method === 'voucher' && voucher.code && !voucher.info) checkVoucher();
    if (method === 'loyalty' && cart.customer) {
      api<{ data: { amountCents: number; points: number; minRedeemPoints: number } }>('/loyalty/redeemable', { query: { customerId: cart.customer._id, totalCents: total } })
        .then((r) => { setAmount(Math.min(r.data.amountCents, remaining)); if (!r.data.points) setError(new ApiError(422, 'POINTS', r.data.minRedeemPoints ? `Not enough points for this sale (at least ${r.data.minRedeemPoints} needed)` : 'No points can be used on this sale')); })
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method]);

  const addPayment = () => {
    if (!amount || amount <= 0) return;
    const a = Math.min(amount, remaining);
    if (method === 'voucher') {
      if (!voucher.info?.usable) { checkVoucher(); return; }
      const use = Math.min(a, voucher.info.balanceCents - payments.filter((p) => p.method === 'voucher' && p.reference === voucher.code).reduce((x, p) => x + p.amountCents, 0));
      if (use <= 0) { setError(new ApiError(422, 'VOUCHER', 'This voucher is already used in full on this sale')); return; }
      setPayments((ps) => [...ps, { method, amountCents: use, reference: voucher.code, label: `Voucher ${voucher.code}` }]);
      setVoucher({ code: '', info: null });
      return;
    }
    if (method === 'card') {
      // Bank card machine: the approval code on the slip proves the payment; the machine and card are recorded.
      if (!/^[A-Za-z0-9]{4,12}$/.test(card.approval.trim())) { setError(new ApiError(400, 'CARD_APPROVAL', 'Enter the approval code printed on the card machine slip')); return; }
      const ref = [card.terminal, `${card.type}${card.last4 ? ` ****${card.last4}` : ''}`, card.issuer, `AUTH ${card.approval.trim().toUpperCase()}`].filter(Boolean).join(' · ').slice(0, 100);
      setPayments((ps) => [...ps, { method, amountCents: a, reference: ref, label: `Card ${card.type}${card.last4 ? ` ****${card.last4}` : ''}` }]);
      setCard({ ...card, last4: '', approval: '' });
      setError(null);
      return;
    }
    if (method === 'cash') setPayments((ps) => [...ps, { method, amountCents: a, tenderedCents: Math.max(tendered ?? a, a), label: 'Cash' }]);
    else setPayments((ps) => [...ps, { method, amountCents: a, reference: reference || undefined, label: paymentLabel(method) }]);
    setTendered(null);
    setReference('');
  };


  const complete = async (overrideToken?: string, cashTendered?: number) => {
    setBusy(true);
    setError(null);
    let final = payments;
    const given = cashTendered ?? tendered ?? 0;
    if (remaining > 0 && method === 'cash' && given >= remaining) final = [...payments, { method: 'cash', amountCents: remaining, tenderedCents: given, label: 'Cash' }];
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
  /**
   * Enter in "Cash received": completes the sale (empty = the exact amount). Less than due is kept as part
   * of the payment so the rest can be paid another way.
   */
  const onCashEnter = () => {
    if (busy) return;
    if (remaining <= 0) return complete();
    if (tendered === null || tendered === undefined) return complete(undefined, remaining);
    if (tendered >= remaining) return complete();
    if (tendered > 0) {
      setPayments((ps) => [...ps, { method: 'cash', amountCents: tendered, tenderedCents: tendered, label: 'Cash' }]);
      setTendered(null);
      toast.info(`${money(remaining - tendered)} still to pay: choose another way to pay`);
    }
  };
  // Enter anywhere else in the payment window (not in a field) completes a fully paid sale.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || override) return;
      const tag = (document.activeElement as HTMLElement | null)?.tagName ?? '';
      if (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(tag)) return;
      if (canComplete && !busy) { e.preventDefault(); complete(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

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
              <Field label="Amount"><MoneyInput value={amount} onChange={setAmount} onKeyDown={(e) => { if (e.key === 'Enter' && method !== 'cash' && method !== 'mpesa' && method !== 'gateway') { e.preventDefault(); addPayment(); } }} /></Field>
              {method === 'cash' && (
                <>
                  <Field label="Cash received" hint="Enter completes the sale; leave empty for the exact amount"><MoneyInput value={tendered} onChange={setTendered} autoFocus onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onCashEnter(); } }} /></Field>
                  <div className="flex flex-wrap gap-2">{[remaining, ...[50000, 100000, 200000].filter((v) => v > remaining)].slice(0, 4).map((v) => <Button key={v} size="sm" variant="secondary" onClick={() => setTendered(v)}>{money(v)}</Button>)}</div>
                </>
              )}
              {method === 'mpesa' && (
                <MpesaPanel amount={amount} tillId={till._id} intent={stk} setIntent={setStk} usedIds={payments.map((p) => p.paymentIntentId!).filter(Boolean)}
                  onUse={(i) => { setMpesaDone(i); setPayments((ps) => [...ps, { method: 'mpesa', amountCents: Math.min(i.paidAmountCents - (i.allocatedCents ?? 0), remaining), paymentIntentId: i.id, label: `M-Pesa ${i.receiptNumber}${mpesaPayer(i) ? ` · ${mpesaPayer(i)}` : ''}` }]); }} />
              )}
              {method === 'gateway' && gateways.data && <GatewayPanel gateways={gateways.data} amount={amount} tillId={till._id} customer={cart.customer} intent={stk} setIntent={setStk} />}
              {method === 'card' && (
                <TerminalPanel tillId={till._id} amount={Math.min(amount ?? 0, remaining)} remaining={remaining} usedIds={payments.map((p) => p.terminalTransactionId!).filter(Boolean)}
                  onApproved={(x) => { setTerminalDone(x); setPayments((ps) => (ps.some((p) => p.terminalTransactionId === x.id) ? ps : [...ps, { method: 'card', amountCents: x.amountCents, terminalTransactionId: x.id, label: `Card ${x.cardScheme ?? ''}${x.last4 ? ` ****${x.last4}` : ''}${x.sandbox ? ' (simulated)' : ''}`.trim() }])); }} />
              )}
              {method === 'card' && (
                <div className="space-y-3 rounded-lg border border-sky-100 bg-sky-50/50 p-3 dark:border-sky-900 dark:bg-sky-950/20">
                  <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">Card machine not connected to Afey POS</div>
                  <p className="text-xs text-ink-600 dark:text-ink-300">Cards from every bank in Kenya and abroad (Visa, Mastercard, UnionPay, Amex…) work on any bank's card machine. <b>1.</b> Key <b>{money(Math.min(amount ?? 0, remaining))}</b> into the card machine. <b>2.</b> The customer taps or inserts the card. <b>3.</b> Enter the approval code from the slip.</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {terminals.length > 0 && <Field label="Card machine"><Select value={card.terminal} onChange={(e) => setCard({ ...card, terminal: e.target.value })} options={terminals.map((t) => ({ value: t.name, label: `${t.name}${t.bank ? ` (${t.bank})` : ''}` }))} /></Field>}
                    <Field label="Card"><Select value={card.type} onChange={(e) => setCard({ ...card, type: e.target.value })} options={[...CARD_NETWORKS, 'Other card'].map((v) => ({ value: v, label: v }))} /></Field>
                    <Field label="Card's bank (optional)"><Select value={card.issuer} onChange={(e) => setCard({ ...card, issuer: e.target.value })} options={[{ value: '', label: 'Not recorded' }, ...KENYA_BANKS.map((b) => ({ value: b, label: b }))]} /></Field>
                    <Field label="Last 4 digits (optional)"><Input inputMode="numeric" maxLength={4} value={card.last4} onChange={(e) => setCard({ ...card, last4: e.target.value.replace(/\D/g, '').slice(0, 4) })} /></Field>
                    <Field label="Approval code"><Input autoFocus value={card.approval} maxLength={12} placeholder="From the slip" onChange={(e) => setCard({ ...card, approval: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') addPayment(); }} /></Field>
                  </div>
                  {gateways.data?.some((g) => g.provider === 'pesapal') && <button type="button" className="text-xs font-semibold text-brand-600 hover:underline" onClick={() => setMethod('gateway')}>No card machine? Let the customer pay by card online with Pesapal (QR code) →</button>}
                </div>
              )}
              {method === 'voucher' && (
                <div className="space-y-2 rounded-lg border border-[#e7d8c6] bg-[#f7efe6] p-3 dark:border-[#5b4329] dark:bg-[#2a2016]">
                  <div className="flex items-end gap-2">
                    <Field label="Voucher code" className="flex-1"><Input autoFocus={!initialVoucher} value={voucher.code} onChange={(e) => setVoucher({ code: e.target.value.toUpperCase(), info: null })} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (voucher.info?.usable) addPayment(); else checkVoucher(); } }} placeholder="GV-ABCD2345" /></Field>
                    <Button variant="secondary" onClick={() => checkVoucher()}>Check</Button>
                  </div>
                  {voucher.info && <p className="text-sm" data-testid="voucher-balance">{voucher.info.usable ? <>Balance <b>{money(voucher.info.balanceCents)}</b>{voucher.info.balanceCents > remaining ? ` · ${money(voucher.info.balanceCents - remaining)} stays on the voucher` : ''}</> : <span className="text-red-600">{voucher.info.problem}</span>}</p>}
                </div>
              )}
              {method === 'bank' && <Field label="Reference (bank transfer)"><Input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>}
              {method === 'credit' && cart.customer && <p className="text-sm text-ink-600">Balance {money(cart.customer.balanceCents)} · limit {money(cart.customer.creditLimitCents)}{!can('sales.credit') && ' · needs manager approval'}</p>}
              {method !== 'mpesa' && method !== 'gateway' && <Button variant="secondary" onClick={addPayment}>Add {paymentLabel(method).toLowerCase()} payment</Button>}
            </div>
          )}
          {terminalDone && remaining <= 0 && <div className="mt-3"><TxnStatus txn={terminalDone} /></div>}
          {mpesaDone && remaining <= 0 && <div className="mt-3"><MpesaPaid intent={mpesaDone} /></div>}
          <div className="mt-3"><ErrorBox error={error} /></div>
        </div>
        <div className="rounded-lg bg-ink-50 p-3 text-sm dark:bg-ink-800/50">
          <div className="label">Payments</div>
          <ul className="space-y-1">{payments.map((p, i) => (
            <li key={i} className="flex items-center justify-between"><span>{p.label}</span><span className="flex items-center gap-1 tabular-nums">{money(p.amountCents)}{!p.paymentIntentId && !p.terminalTransactionId && <button aria-label="Remove payment" onClick={() => setPayments((ps) => ps.filter((_, j) => j !== i))}><Icon name="x" className="h-3.5 w-3.5" /></button>}</span></li>
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

/**
 * Supervisor approval on the cashier's screen: scanning the supervisor's staff card approves at once (no PIN),
 * or, with a reader paired, the fingerprint tab listens for a finger as soon as it is chosen.
 */
export function OverrideModal({ permission, message, onClose, onApproved }: { permission: string; message: string; onClose: () => void; onApproved: (token: string) => void }) {
  const { me } = useAuth();
  const [mode, setMode] = useState<'card' | 'finger'>('card');
  const [card, setCard] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const cardRef = useRef<HTMLInputElement>(null);
  const approvedRef = useRef(onApproved);
  approvedRef.current = onApproved;
  const busyRef = useRef(false);
  const approveCard = async (code = card) => {
    if (!code.trim() || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      // The till tells the server which branch the approval is for (supervisors may be limited to some branches).
      const tillId = getWorkstation().tillId || undefined;
      const r = await api<{ overrideToken: string }>('/auth/override', { body: { cardCode: code.trim(), permission, tillId } });
      approvedRef.current(r.overrideToken);
    } catch (e) {
      setError(e);
      // Ready for the next scan.
      setCard('');
      cardRef.current?.focus();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  // Scanners that do not send Enter: a full card code followed by a short pause approves too.
  useEffect(() => {
    if (mode !== 'card' || card.trim().length < 16) return;
    const t = setTimeout(() => approveCard(card), 300);
    return () => clearTimeout(t);
  }, [card, mode]); // eslint-disable-line react-hooks/exhaustive-deps
  // Fingerprint: keep the reader listening until a supervisor's finger approves or the tab is left.
  const [listening, setListening] = useState(false);
  useEffect(() => {
    if (mode !== 'finger') return;
    const ctrl = new AbortController();
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      while (!ctrl.signal.aborted) {
        setListening(true);
        try {
          const r = await fingerprint<{ overrideToken: string }>('override', { permission, forUserId: me!.user.id }, ctrl.signal);
          if (ctrl.signal.aborted) return;
          setError(null);
          approvedRef.current(r.overrideToken);
          return;
        } catch (e) {
          if (ctrl.signal.aborted) return;
          setListening(false);
          setError(e);
          // A wrong finger or a timeout re-arms quickly; an unreachable bridge is retried a little slower.
          await wait(/reach the Afey device bridge|not paired/.test(String((e as Error)?.message)) ? 3000 : 1200);
        }
      }
    })();
    return () => { ctrl.abort(); setListening(false); };
  }, [mode, permission, me]);
  const fingerOk = bridgeConfigured();
  const modes = [{ key: 'card', label: 'Staff card' }, ...(fingerOk ? [{ key: 'finger', label: 'Fingerprint' }] : [])] as { key: typeof mode; label: string }[];
  return (
    <Modal open onClose={onClose} title="Supervisor approval" size="sm" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button>{mode === 'card' && <Button loading={busy} disabled={!card.trim()} onClick={() => approveCard()}>Approve</Button>}</>}>
      <p className="mb-3 text-sm">{message}</p>
      {modes.length > 1 && (
        <div className="mb-3 flex gap-1 rounded-lg bg-ink-100 p-1 text-sm dark:bg-ink-800" role="radiogroup" aria-label="Approve with">
          {modes.map((m) => <button key={m.key} type="button" role="radio" aria-checked={mode === m.key} className={`flex-1 rounded-md py-1.5 ${mode === m.key ? 'bg-white shadow dark:bg-ink-700' : 'text-ink-500'}`} onClick={() => { setMode(m.key); setError(null); }}>{m.label}</button>)}
        </div>
      )}
      <div className="space-y-3">
        {mode === 'card' && (
          <Field label="Supervisor card" hint="Scan the card: it approves straight away.">
            <Input ref={cardRef} autoFocus type="password" autoComplete="off" value={card} placeholder="Scan the supervisor's card"
              onChange={(e) => setCard(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); approveCard(); } }} />
          </Field>
        )}
        {mode === 'finger' && (
          <div className="flex flex-col items-center gap-3 py-6 text-center" role="status" aria-live="polite">
            <span className={`flex h-20 w-20 items-center justify-center rounded-full ${listening ? 'animate-pulse bg-brand-100 text-brand-700 ring-4 ring-brand-200 dark:bg-brand-950 dark:ring-brand-800' : 'bg-ink-100 text-ink-400 dark:bg-ink-800'}`}>
              <svg viewBox="0 0 24 24" className="h-10 w-10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M12 11v4m-4-4a4 4 0 0 1 8 0v2a8 8 0 0 1-1 4M5 9a7 7 0 0 1 13.7-2M5 13v-2m14 2c0 2-.4 3.7-1 5M9 21c1-2 1.5-4 1.5-6v-4a1.5 1.5 0 0 1 3 0" /></svg>
            </span>
            <p className="text-sm font-medium">{listening ? 'Waiting for the supervisor’s finger…' : 'Getting the reader ready…'}</p>
            <p className="text-xs text-ink-500">The supervisor places an enrolled finger on the reader.</p>
          </div>
        )}
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}

function ReceiptModal({ sale: initial, tillId, onClose }: { sale: any; tillId: string; onClose: () => void }) {
  const toast = useToast();
  const { has } = useAuth();
  const [to, setTo] = useState('');
  const [receiptHtml, setReceiptHtml] = useState<string | null>(null);
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
      const how = await printReceipt(sale._id, { tillId });
      if (how === 'printer') toast.success('Receipt printed');
    } catch (e: any) {
      toast.error(`Printer not reached (${e?.message ?? 'error'}): used the print window instead`);
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
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={print}><Icon name="printer" className="h-4 w-4" />Print receipt</Button>
          <Button variant="secondary" aria-expanded={receiptHtml !== null} onClick={() => (receiptHtml !== null ? setReceiptHtml(null) : api<Response>(`/sales/${sale._id}/receipt?format=html`, { raw: true }).then((r) => r.text()).then(setReceiptHtml).catch(toast.error))}><Icon name="eye" className="h-4 w-4" />{receiptHtml !== null ? 'Hide receipt' : 'View receipt'}</Button>
        </div>
        {receiptHtml !== null && <iframe title="Receipt" srcDoc={receiptHtml} sandbox="allow-same-origin" className="h-[50vh] w-full rounded-md border border-ink-100 bg-[#e9ebee] dark:border-ink-800" />}
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

/**
 * Bank card terminal at the till: Afey POS sends the amount and a unique reference; the terminal reads the card
 * and the PIN. The payment is added to the sale only once the terminal's status check verified the approval.
 * An unfinished or unknown payment (e.g. after the till restarted) is picked up again here, and no new charge
 * can start on that terminal until it is resolved.
 */
function TerminalPanel({ tillId, amount, remaining, usedIds, onApproved }: { tillId: string; amount: number; remaining: number; usedIds: string[]; onApproved: (x: TerminalTxn) => void }) {
  const toast = useToast();
  const terminals = useQuery({ queryKey: ['till-terminals', tillId], queryFn: () => api<{ data: { id: string; name: string; provider: string; mode: string; health: any; device: { model?: string } }[] }>(`/payment-terminals/for-till/${tillId}`).then((r) => r.data), staleTime: 30_000 });
  const pending = useQuery({ queryKey: ['till-terminal-open', tillId], queryFn: () => api<{ data: TerminalTxn[] }>(`/payment-terminals/transactions/open-for-till/${tillId}`).then((r) => r.data), refetchInterval: 8000 });
  const [terminalId, setTerminalId] = useState('');
  const [txn, setTxn] = useState<TerminalTxn | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const added = useRef(new Set<string>());
  useEffect(() => { if (!terminalId && terminals.data?.[0]) setTerminalId(terminals.data[0].id); }, [terminals.data, terminalId]);
  // Live updates for this till (the server sends terminal progress to the till's room); polling is the fallback.
  useEffect(() => { connectRealtime()?.emit('till:join', tillId); }, [tillId]);
  useRealtime('terminal.updated', (x: TerminalTxn) => { if (txn && x.id === txn.id) setTxn(x); }, [txn?.id]);
  // Resume what is unfinished on this till's terminals (the till may have been restarted mid-payment).
  useEffect(() => {
    if (txn || !pending.data) return;
    const open = pending.data.find((x) => x.open);
    if (open) setTxn(open);
  }, [pending.data, txn]);
  useEffect(() => {
    if (!txn?.open) return;
    const t = setInterval(() => api<{ data: TerminalTxn }>(`/payment-terminals/transactions/${txn.id}`, { query: { refresh: '1' } }).then((r) => setTxn(r.data)).catch(() => undefined), 1500);
    return () => clearInterval(t);
  }, [txn?.id, txn?.open]);
  // Only a verified approval becomes a payment, and only once.
  useEffect(() => {
    if (!txn || txn.status !== 'approved' || !txn.verified || txn.saleId || usedIds.includes(txn.id) || added.current.has(txn.id)) return;
    added.current.add(txn.id);
    onApproved(txn);
    pending.refetch();
  }, [txn, usedIds, onApproved, pending]);

  if (!terminals.data?.length) return null;
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      setTxn((await api<{ data: TerminalTxn }>('/payment-terminals/transactions', { body: { terminalId, tillId, amountCents: amount, clientRequestId: newRequestId() } })).data);
    } catch (e: any) {
      // The terminal still has an unfinished payment: show it instead of starting another.
      if (e instanceof ApiError && e.code === 'TERMINAL_HAS_OPEN_PAYMENT' && e.details?.transactionId) {
        setTxn((await api<{ data: TerminalTxn }>(`/payment-terminals/transactions/${e.details.transactionId}`, { query: { refresh: '1' } })).data);
      } else setError(e);
    } finally {
      setBusy(false);
    }
  };
  const act = (path: string, body: object = {}) => api<{ data: TerminalTxn }>(`/payment-terminals/transactions/${txn!.id}/${path}`, { body }).then((r) => setTxn(r.data)).catch(toast.error);
  const recovered = (pending.data ?? []).filter((x) => x.status === 'approved' && x.verified && !x.saleId && !usedIds.includes(x.id) && x.amountCents <= remaining && x.id !== txn?.id);
  const t = terminals.data.find((x) => x.id === terminalId);
  const final = txn && !txn.open;
  return (
    <div className="space-y-3 rounded-lg border border-emerald-200 bg-emerald-50/40 p-3 dark:border-emerald-900 dark:bg-emerald-950/20" data-testid="terminal-panel">
      <div className="flex flex-wrap items-end gap-2">
        {terminals.data.length > 1 && <Field label="Card terminal" className="flex-1"><Select value={terminalId} onChange={(e) => setTerminalId(e.target.value)} options={terminals.data.map((x) => ({ value: x.id, label: x.name }))} /></Field>}
        <div className="flex-1 text-sm"><b>{t?.name}</b>{t?.mode === 'sandbox' && <Badge tone="blue">test only</Badge>}<div className="text-xs text-ink-500">The customer uses the card on the terminal; Afey POS never sees the PIN or the card number.</div></div>
        {(!txn || final) && <Button loading={busy} disabled={!amount || amount > remaining} onClick={start}>{txn ? 'Charge again' : `Charge ${money(amount)} on the terminal`}</Button>}
      </div>
      {txn && <TxnStatus txn={txn} />}
      {txn?.open && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => api<{ data: TerminalTxn }>(`/payment-terminals/transactions/${txn.id}`, { query: { refresh: '1' } }).then((r) => setTxn(r.data)).catch(toast.error)}>Check now</Button>
          <Button size="sm" variant="ghost" onClick={() => act('cancel')}>Cancel on terminal</Button>
          {txn.sandbox && <>
            <span className="self-center text-xs text-ink-500">Simulator:</span>
            <Button size="sm" variant="ghost" onClick={() => act('simulate', { outcome: 'approved' })}>Approve</Button>
            <Button size="sm" variant="ghost" onClick={() => act('simulate', { outcome: 'declined' })}>Decline</Button>
          </>}
        </div>
      )}
      {txn?.status === 'unknown' && <p className="text-xs text-amber-800">Do not charge the customer again: Afey POS keeps asking the terminal. A manager can resolve it under Card terminal payments.</p>}
      {recovered.map((x) => (
        <div key={x.id} className="flex items-center justify-between rounded-md bg-white p-2 text-sm dark:bg-ink-900">
          <span>Approved earlier, not on a sale: <b>{money(x.amountCents)}</b> {x.cardScheme} {x.last4 ? `****${x.last4}` : ''}</span>
          <Button size="sm" onClick={() => { added.current.add(x.id); onApproved(x); pending.refetch(); }}>Use this payment</Button>
        </div>
      ))}
      <ErrorBox error={error} />
    </div>
  );
}
