import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CASHIER_PAGE_OPTIONS, PAYMENT_METHOD_OPTIONS, KENYA_BANKS, type CheckoutRules } from '@afeypos/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Button, Card, cx, ErrorBox, Field, Input, Loading, MoneyInput, PageHeader, useToast } from '../../components/ui';
import { Icon } from '../../components/icons';

interface Terminal { name: string; bank: string; terminalId: string }

/** On/off row with a title and explanation; the switch is a real checkbox for keyboards and screen readers. */
function Toggle({ label, help, checked, onChange }: { label: string; help?: ReactNode; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-3">
      <span className="min-w-0"><span className="block text-sm font-semibold">{label}</span>{help && <span className="mt-0.5 block text-xs text-ink-500">{help}</span>}</span>
      <span className="relative mt-0.5 inline-flex shrink-0">
        <input type="checkbox" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
        <span className="h-6 w-11 rounded-full bg-ink-200 transition peer-checked:bg-brand-500 peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500 peer-focus-visible:ring-offset-2 dark:bg-ink-700" />
        <span className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition peer-checked:translate-x-5" />
      </span>
    </label>
  );
}

const pctInput = (bp: number) => String(bp / 100);
const BANKS = KENYA_BANKS.filter((b) => b !== 'SACCO card' && b !== 'Foreign bank card');

export function CheckoutRulesPage() {
  const toast = useToast();
  const { reload } = useAuth();
  const q = useQuery({ queryKey: ['checkout-rules'], queryFn: () => api<{ data: { rules: CheckoutRules; cardTerminals: Terminal[] } }>('/settings/checkout-rules').then((r) => r.data) });
  const [rules, setRules] = useState<CheckoutRules | null>(null);
  const [terminals, setTerminals] = useState<Terminal[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (q.data && !rules) { setRules(q.data.rules); setTerminals(q.data.cardTerminals); }
  }, [q.data, rules]);
  if (!rules) return <Loading />;
  const set = <K extends keyof CheckoutRules>(k: K, patch: Partial<CheckoutRules[K]>) => { setRules({ ...rules, [k]: Array.isArray(rules[k]) ? patch : { ...(rules[k] as object), ...patch } } as CheckoutRules); setDirty(true); };
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ data: { rules: CheckoutRules; cardTerminals: Terminal[] } }>('/settings/checkout-rules', { method: 'PUT', body: { rules, cardTerminals: terminals.filter((t) => t.name.trim()) } });
      setRules(r.data.rules); setTerminals(r.data.cardTerminals); setDirty(false);
      await reload();
      toast.success('Checkout rules saved. Tills use them from the next action.');
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const pageOn = (k: string) => rules.cashierPages.includes(k);

  return (
    <div className="max-w-5xl">
      <PageHeader title="Checkout rules" subtitle="Decide what cashiers may do alone. Anything else needs a supervisor on the till: staff card + PIN, fingerprint or email + PIN."
        actions={<Button loading={busy} disabled={!dirty} onClick={save}>{dirty ? 'Save rules' : 'Saved'}</Button>} />
      <ErrorBox error={error} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={<span className="flex items-center gap-2"><Icon name="cart" className="h-4 w-4 text-brand-500" />Items in the sale</span>}>
          <div className="divide-y divide-ink-100 dark:divide-ink-800">
            <Toggle label="Removing an item needs a supervisor" help="Deleting a scanned item asks for a manager card scan. Every removal is recorded in the audit trail either way." checked={rules.items.removeNeedsApproval} onChange={(v) => set('items', { removeNeedsApproval: v })} />
            <Toggle label="Lowering a quantity needs a supervisor" help="Changing 3 to 2 counts as removing an item." checked={rules.items.reduceQtyNeedsApproval} onChange={(v) => set('items', { reduceQtyNeedsApproval: v })} />
            <Toggle label="Clearing the whole sale needs a supervisor" checked={rules.items.clearNeedsApproval} onChange={(v) => set('items', { clearNeedsApproval: v })} />
            <Toggle label="Cashiers may hold and resume sales" checked={rules.items.holdAllowed} onChange={(v) => set('items', { holdAllowed: v })} />
          </div>
          <p className="mt-2 text-xs text-ink-500">Supervisors are users with the permission <b>Remove scanned items</b> (Branch manager and above). Change it in <Link className="text-brand-600 hover:underline" to="/settings/roles">Roles &amp; permissions</Link>.</p>
        </Card>

        <Card title={<span className="flex items-center gap-2"><Icon name="percent" className="h-4 w-4 text-violet-500" />Discounts by cashiers</span>}>
          <Toggle label="Cashiers may give discounts" help="Off: every discount needs a supervisor." checked={rules.discounts.allowed} onChange={(v) => set('discounts', { allowed: v })} />
          <div className={cx('mt-2 grid gap-3 sm:grid-cols-3', !rules.discounts.allowed && 'pointer-events-none opacity-50')}>
            <Field label="Max on one item (%)"><Input inputMode="decimal" value={pctInput(rules.discounts.lineLimitBp)} onChange={(e) => set('discounts', { lineLimitBp: Math.round(Math.min(100, Math.max(0, Number(e.target.value) || 0)) * 100) })} /></Field>
            <Field label="Max on the sale (%)"><Input inputMode="decimal" value={pctInput(rules.discounts.saleLimitBp)} onChange={(e) => set('discounts', { saleLimitBp: Math.round(Math.min(100, Math.max(0, Number(e.target.value) || 0)) * 100) })} /></Field>
            <Field label="Max amount per sale" hint="0 = no limit"><MoneyInput value={rules.discounts.maxAmountCents} onChange={(v) => set('discounts', { maxAmountCents: v ?? 0 })} /></Field>
          </div>
          <p className="mt-3 text-xs text-ink-500">Above these limits the till asks for a supervisor (permission <b>Override discount limits</b>).</p>
        </Card>

        <Card title={<span className="flex items-center gap-2"><Icon name="clock" className="h-4 w-4 text-amber-500" />Shift control</span>}>
          <div className="divide-y divide-ink-100 dark:divide-ink-800">
            <Toggle label="Selling needs an open shift" checked={rules.shifts.required} onChange={(v) => set('shifts', { required: v })} />
            <Toggle label="One open shift per cashier" help="A cashier cannot open a second till before closing the first." checked={rules.shifts.oneOpenShiftPerCashier} onChange={(v) => set('shifts', { oneOpenShiftPerCashier: v })} />
            <Toggle label="Blind cash count" help="Cashiers count the drawer without seeing the expected amount or the difference." checked={rules.shifts.blindClose} onChange={(v) => set('shifts', { blindClose: v })} />
            <Toggle label="Closing a shift needs a supervisor" checked={rules.shifts.closeNeedsApproval} onChange={(v) => set('shifts', { closeNeedsApproval: v })} />
          </div>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <Field label="Minimum opening float"><MoneyInput value={rules.shifts.minOpeningFloatCents} onChange={(v) => set('shifts', { minOpeningFloatCents: v ?? 0 })} /></Field>
            <Field label="Cash pickup above" hint="The till warns to hand over cash. 0 = never"><MoneyInput value={rules.shifts.maxCashInDrawerCents} onChange={(v) => set('shifts', { maxCashInDrawerCents: v ?? 0 })} /></Field>
          </div>
        </Card>

        <Card title={<span className="flex items-center gap-2"><Icon name="wallet" className="h-4 w-4 text-emerald-500" />Payment methods at checkout</span>}>
          <p className="mb-2 text-xs text-ink-500">Only the ticked ways to pay appear on the checkout page, and the server refuses the others. Keep at least one.</p>
          <div className="grid gap-1.5 sm:grid-cols-2" data-testid="payment-methods">
            {PAYMENT_METHOD_OPTIONS.map((p) => {
              const on = rules.paymentMethods.includes(p.key);
              const last = on && rules.paymentMethods.length === 1;
              return (
                <label key={p.key} title={last ? 'At least one way to pay stays on' : undefined} className={cx('flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm transition', on ? 'border-brand-300 bg-brand-50/60 dark:border-brand-500/40 dark:bg-brand-500/10' : 'border-ink-200 dark:border-ink-700')}>
                  <input type="checkbox" aria-label={p.label} className="mt-0.5 h-4 w-4 rounded border-ink-300 text-brand-600" checked={on} disabled={last} onChange={(e) => { setRules({ ...rules, paymentMethods: e.target.checked ? [...rules.paymentMethods, p.key] : rules.paymentMethods.filter((k) => k !== p.key) }); setDirty(true); }} />
                  <span>{p.label}{p.hint && <span className="block text-xs text-ink-500">{p.hint}</span>}</span>
                </label>
              );
            })}
          </div>
        </Card>

        <Card title={<span className="flex items-center gap-2"><Icon name="lock" className="h-4 w-4 text-sky-500" />Pages cashiers can open</span>}>
          <p className="mb-2 text-xs text-ink-500">For users whose only role is <b>Cashier</b>. Checkout always stays. Their permissions still decide what they can change on each page.</p>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {CASHIER_PAGE_OPTIONS.map((p) => (
              <label key={p.key} className={cx('flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition', pageOn(p.key) ? 'border-brand-300 bg-brand-50/60 dark:border-brand-500/40 dark:bg-brand-500/10' : 'border-ink-200 dark:border-ink-700')}>
                <input type="checkbox" className="h-4 w-4 rounded border-ink-300 text-brand-600" checked={pageOn(p.key)} onChange={(e) => { setRules({ ...rules, cashierPages: e.target.checked ? [...rules.cashierPages, p.key] : rules.cashierPages.filter((k) => k !== p.key) }); setDirty(true); }} />
                {p.label}
              </label>
            ))}
          </div>
          <label className="mt-2 flex items-center gap-2 rounded-md border border-dashed border-ink-200 px-3 py-2 text-sm text-ink-500 dark:border-ink-700"><input type="checkbox" checked disabled className="h-4 w-4" />Checkout (always)</label>
        </Card>

        <Card className="lg:col-span-2" title={<span className="flex items-center gap-2"><Icon name="card" className="h-4 w-4 text-emerald-600" />Card machines (bank POS / PDQ)</span>}
          actions={<Button size="sm" variant="secondary" disabled={terminals.length >= 30} onClick={() => { setTerminals([...terminals, { name: '', bank: 'Equity Bank', terminalId: '' }]); setDirty(true); }}><Icon name="plus" className="h-3.5 w-3.5" />Add card machine</Button>}>
          <p className="mb-3 text-xs text-ink-500">Bank card machines work on their own: the cashier keys the amount into the machine, the customer taps or inserts the card, and the cashier enters the approval code shown on the slip. Listing your machines here lets the till record which one took each payment, for reconciliation with the bank. Online card payments go through <Link className="text-brand-600 hover:underline" to="/settings/integrations">Integrations</Link> (Pesapal and others).</p>
          {terminals.length === 0 ? <p className="text-sm text-ink-500">No card machines listed: the till still takes card payments with an approval code.</p> : (
            <div className="space-y-2">
              {terminals.map((t, i) => (
                <div key={i} role="group" aria-label={`Card machine ${i + 1}`} className="grid items-end gap-2 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
                  <Field label="Name"><Input value={t.name} maxLength={40} placeholder="e.g. Till 1 Equity PDQ" onChange={(e) => { setTerminals(terminals.map((x, j) => (j === i ? { ...x, name: e.target.value } : x))); setDirty(true); }} /></Field>
                  <Field label="Bank"><select className="input" value={t.bank} onChange={(e) => { setTerminals(terminals.map((x, j) => (j === i ? { ...x, bank: e.target.value } : x))); setDirty(true); }}>{BANKS.map((b) => <option key={b}>{b}</option>)}</select></Field>
                  <Field label="Terminal ID"><Input value={t.terminalId} maxLength={40} placeholder="TID on the machine" onChange={(e) => { setTerminals(terminals.map((x, j) => (j === i ? { ...x, terminalId: e.target.value } : x))); setDirty(true); }} /></Field>
                  <Button variant="ghost" aria-label={`Remove card machine ${i + 1}`} onClick={() => { setTerminals(terminals.filter((_, j) => j !== i)); setDirty(true); }}><Icon name="trash" className="h-4 w-4" /></Button>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
