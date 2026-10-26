import { printReceipt } from '../../lib/printing';
import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, ApiError, newRequestId } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useList, useLocations } from '../../lib/hooks';
import { dateTime, money, qty } from '../../lib/format';
import { getWorkstation } from '../../lib/workstation';
import { DataTable } from '../../components/DataTable';
import { Badge, Button, Card, Checkbox, ErrorBox, Field, Input, Modal, PageHeader, Select, useToast } from '../../components/ui';
import { Icon } from '../../components/icons';
import { OverrideModal } from '../POS';

export const RETURN_REASONS = [
  { value: 'damaged', label: 'Damaged' },
  { value: 'expired', label: 'Expired' },
  { value: 'wrong_item', label: 'Wrong item' },
  { value: 'not_wanted', label: 'Changed mind' },
  { value: 'quality', label: 'Quality problem' },
  { value: 'overcharged', label: 'Overcharged' },
  { value: 'other', label: 'Other' },
];
const reasonLabel = (code?: string) => RETURN_REASONS.find((r) => r.value === code)?.label ?? 'Not given';
const methodLabel: Record<string, string> = { cash: 'Cash', mpesa: 'M-Pesa', card: 'Card', account: 'Customer account', credit_note: 'Store credit' };

const printNote = (id: string) => printReceipt(id, { kind: 'return' });

export function ReturnsPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [matches, setMatches] = useState<any[] | null>(null);
  const [sale, setSale] = useState<any>(null);
  const [q, setQ] = useState('');
  const [reasonCode, setReasonCode] = useState('');
  const [page, setPage] = useState(1);
  const list = useList(['returns'], '/returns', { page, q: q || undefined, reasonCode: reasonCode || undefined, limit: 25 });
  const input = useRef<HTMLInputElement>(null);

  const open = async (id: string) => {
    const s = await api<{ data: any }>(`/sales/${id}`).then((r) => r.data);
    setMatches(null);
    if (s.status === 'voided' || s.status === 'returned') toast.error(`${s.number} has already been ${s.status === 'voided' ? 'voided' : 'fully returned'}`);
    else setSale(s);
  };
  const find = async () => {
    if (code.trim().length < 2) return;
    try {
      const r = await api<{ data: any[] }>('/sales/lookup', { query: { code: code.trim() } });
      if (!r.data.length) toast.error(`No sale found for "${code.trim()}"`);
      else if (r.data.length === 1) await open(r.data[0]._id);
      else setMatches(r.data);
      setCode('');
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <div>
      <PageHeader title="Returns" subtitle="Scan the receipt barcode or type the receipt number, M-Pesa code or serial number" />
      <Card className="mb-4">
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); find(); }}>
          <Field label="Receipt"><Input ref={input} autoFocus className="w-72" data-testid="return-lookup" placeholder="e.g. RCP-000123" value={code} onChange={(e) => setCode(e.target.value)} /></Field>
          <Button type="submit"><Icon name="barcode" className="h-4 w-4" />Find sale</Button>
        </form>
        {matches && (
          <ul className="mt-3 divide-y divide-ink-100 text-sm dark:divide-ink-800">
            {matches.map((m) => (
              <li key={m._id} className="flex items-center justify-between py-2">
                <span>{m.number} · {dateTime(m.completedAt)} · {money(m.totalCents)}</span>
                <Button size="sm" variant="secondary" onClick={() => open(m._id)}>Return items</Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Recent returns">
        <div className="mb-3 flex flex-wrap gap-2">
          <Input className="max-w-xs" placeholder="Search return or receipt number" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
          <Select className="max-w-xs" value={reasonCode} onChange={(e) => { setReasonCode(e.target.value); setPage(1); }} placeholder="All reasons" options={RETURN_REASONS} />
        </div>
        <DataTable rows={list.data?.data ?? []} loading={list.isLoading} empty="No returns yet" page={page} total={list.data?.total} limit={25} onPage={setPage} columns={[
          { key: 'n', header: 'Return', render: (r: any) => <span className="font-medium">{r.number}{r.isVoid && <span className="ml-2"><Badge tone="amber">void</Badge></span>}</span> },
          { key: 's', header: 'Receipt', render: (r: any) => <Link className="underline" to={`/sales/${r.saleId}`}>{r.saleNumber}</Link> },
          { key: 'd', header: 'When', render: (r: any) => dateTime(r.createdAt) },
          { key: 'r', header: 'Reason', render: (r: any) => <span title={r.reason}>{reasonLabel(r.reasonCode)}</span> },
          { key: 'm', header: 'Refund', render: (r: any) => methodLabel[r.refundMethod] ?? r.refundMethod },
          { key: 'a', header: 'Amount', className: 'num', render: (r: any) => money(r.refundCents) },
          { key: 'u', header: 'By', render: (r: any) => <>{r.processedByName}{r.approvedByName && <span className="text-xs text-ink-500"> · approved {r.approvedByName}</span>}</> },
          { key: 'p', header: '', render: (r: any) => <Button size="sm" variant="secondary" onClick={() => printNote(r._id).catch(toast.error)}><Icon name="printer" className="h-4 w-4" /></Button> },
        ]} />
      </Card>
      {sale && <ReturnWizard sale={sale} onClose={() => { setSale(null); input.current?.focus(); }} onDone={() => { setSale(null); qc.invalidateQueries({ queryKey: ['returns'] }); input.current?.focus(); }} />}
    </div>
  );
}

/** Choose lines and quantities, how to refund and why; asks a supervisor when the policy requires it. */
export function ReturnWizard({ sale, onClose, onDone }: { sale: any; onClose: () => void; onDone: () => void }) {
  const locs = useLocations();
  const toast = useToast();
  const qc = useQueryClient();
  const { has } = useAuth();
  const policy = sale.returnPolicy ?? { restockByDefault: true };
  const [requestId] = useState(newRequestId);
  const [lines, setLines] = useState<Record<string, { qty: number; restock: boolean; serials: string }>>({});
  const paidBy = [...(sale.payments ?? [])].sort((a: any, b: any) => b.amountCents - a.amountCents)[0]?.method;
  const [method, setMethod] = useState(paidBy === 'mpesa' ? 'mpesa' : paidBy === 'card' ? 'card' : paidBy === 'credit' && sale.customerId ? 'account' : 'cash');
  const [b2c, setB2c] = useState(Boolean(policy.mpesaPhone));
  const [phone, setPhone] = useState(policy.mpesaPhone ?? '');
  const [reasonCode, setReasonCode] = useState('');
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [tillId, setTillId] = useState(getWorkstation().tillId ?? '');
  const [error, setError] = useState<unknown>(null);
  const [override, setOverride] = useState<{ permission: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const get = (l: any) => lines[l._id] ?? { qty: 0, restock: policy.restockByDefault !== false, serials: '' };
  const remaining = (l: any) => Math.round(((l.qty ?? 0) - (l.returnedQty ?? 0)) * 1000) / 1000;
  const set = (l: any, patch: Partial<{ qty: number; restock: boolean; serials: string }>) => setLines((x) => ({ ...x, [l._id]: { ...get(l), ...patch } }));
  const refund = sale.lines.reduce((a: number, l: any) => a + (l.qty ? Math.round(((l.totalCents ?? 0) * get(l).qty) / l.qty) : 0), 0);
  const chosen = sale.lines.filter((l: any) => get(l).qty > 0);
  const notes = reason.trim() || reasonLabel(reasonCode);

  const submit = async (overrideToken?: string) => {
    setBusy(true);
    setError(null);
    try {
      const payload = chosen.map((l: any) => ({ lineId: l._id, qty: get(l).qty, restock: get(l).restock, serials: get(l).serials ? get(l).serials.split(/[,\s]+/).filter(Boolean) : undefined }));
      const r = await api<{ data: any }>(`/sales/${sale._id}/returns`, {
        body: {
          clientRequestId: requestId, tillId: method === 'cash' ? tillId : undefined, lines: payload, refundMethod: method, reasonCode: reasonCode || undefined, reason: notes,
          reference: reference || undefined, mpesaPhone: method === 'mpesa' && b2c ? phone : undefined, overrideToken,
        },
        idempotencyKey: requestId,
      });
      toast.success(`Return ${r.data.number} done: refund ${money(r.data.refundCents)}${r.data.payoutId ? ' (M-Pesa payout awaiting approval)' : ''}`);
      printNote(r.data._id).catch(() => undefined);
      // Stock, sales and shift totals all changed.
      qc.invalidateQueries();
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'OVERRIDE_REQUIRED') setOverride({ permission: e.details?.permission, message: e.message });
      else setError(e);
    } finally {
      setBusy(false);
    }
  };

  const methods = [
    { value: 'cash', label: 'Cash from till' },
    ...(has('mpesa') ? [{ value: 'mpesa', label: 'M-Pesa' }] : []),
    { value: 'card', label: 'Card reversal' },
    ...(sale.customerId ? [{ value: 'account', label: 'Credit customer account' }] : []),
    { value: 'credit_note', label: 'Store credit note' },
  ];

  return (
    <Modal open onClose={onClose} title={`Return from ${sale.number}`} size="xl" footer={<>
      <span className="mr-auto text-lg font-semibold tabular-nums" data-testid="return-total">Refund {money(refund)}</span>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button onClick={() => submit()} disabled={busy || !chosen.length || !reasonCode || (method === 'cash' && !tillId)}>Process return</Button>
    </>}>
      <div className="mb-3 flex flex-wrap gap-2 text-sm text-ink-600 dark:text-ink-300">
        <span>Sold {dateTime(sale.completedAt)}</span><span>·</span><span>{money(sale.totalCents)}</span>
        {sale.customer && <><span>·</span><span>{sale.customer.name}</span></>}
        {policy.outsideWindow && <Badge tone="amber">Outside the {policy.windowDays}-day return window: a manager must approve</Badge>}
        {policy.approvalAboveCents > 0 && refund > policy.approvalAboveCents && <Badge tone="amber">Above {money(policy.approvalAboveCents)}: a manager must approve</Badge>}
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead><tr><th className="th">Item</th><th className="th num">Price</th><th className="th num">Can return</th><th className="th">Return</th><th className="th">Back to shelf</th><th className="th num">Refund</th></tr></thead>
          <tbody>{sale.lines.map((l: any) => {
            const max = remaining(l);
            const v = get(l);
            const step = Number.isInteger(max) ? 1 : 0.001;
            return (
              <tr key={l._id} className={max <= 0 ? 'opacity-50' : undefined}>
                <td className="td">{l.name}{l.serials?.length ? <Input className="mt-1" placeholder="Serial numbers returned" value={v.serials} onChange={(e) => set(l, { serials: e.target.value })} /> : null}</td>
                <td className="td num">{money(l.qty ? Math.round(l.totalCents / l.qty) : 0)}</td>
                <td className="td num">{qty(max)}</td>
                <td className="td">
                  <div className="flex items-center gap-1">
                    <Button size="sm" variant="secondary" aria-label="Less" disabled={v.qty <= 0} onClick={() => set(l, { qty: Math.max(0, Math.round((v.qty - step) * 1000) / 1000) })}><Icon name="minus" className="h-3 w-3" /></Button>
                    <Input type="number" min={0} max={max} step="any" className="w-20 text-center" value={v.qty} disabled={max <= 0} onChange={(e) => set(l, { qty: Math.min(max, Math.max(0, Number(e.target.value) || 0)) })} />
                    <Button size="sm" variant="secondary" aria-label="More" disabled={v.qty >= max} onClick={() => set(l, { qty: Math.min(max, Math.round((v.qty + step) * 1000) / 1000) })}><Icon name="plus" className="h-3 w-3" /></Button>
                    <Button size="sm" variant="ghost" disabled={max <= 0} onClick={() => set(l, { qty: max })}>All</Button>
                  </div>
                </td>
                <td className="td"><Checkbox label={v.restock ? 'Yes' : 'No (write off)'} checked={v.restock} onChange={(c) => set(l, { restock: c })} /></td>
                <td className="td num">{money(l.qty ? Math.round((l.totalCents * v.qty) / l.qty) : 0)}</td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>
      <div className="mt-2"><Button size="sm" variant="ghost" onClick={() => setLines(Object.fromEntries(sale.lines.map((l: any) => [l._id, { ...get(l), qty: remaining(l) }])))}>Return everything</Button></div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Reason"><Select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} placeholder="Choose…" options={RETURN_REASONS} /></Field>
        <Field label="Notes"><Input value={reason} placeholder="Optional details" onChange={(e) => setReason(e.target.value)} /></Field>
        <Field label="Refund"><Select value={method} onChange={(e) => setMethod(e.target.value)} options={methods} /></Field>
        {method === 'cash' && <Field label="Till paying out"><Select value={tillId} onChange={(e) => setTillId(e.target.value)} placeholder="Select till" options={(locs.data?.tills ?? []).map((t) => ({ value: t._id, label: t.name }))} /></Field>}
        {method === 'card' && <Field label="Card reversal reference"><Input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>}
      </div>
      {method === 'mpesa' && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Checkbox label="Send the refund to the customer's phone (M-Pesa B2C, approved by a manager)" checked={b2c} onChange={setB2c} />
          {b2c ? <Field label="Customer phone"><Input value={phone} placeholder="07XX XXX XXX" onChange={(e) => setPhone(e.target.value)} /></Field>
            : <Field label="Reversal / transaction code"><Input value={reference} placeholder="Reversed from the M-Pesa portal" onChange={(e) => setReference(e.target.value.toUpperCase())} /></Field>}
        </div>
      )}
      <div className="mt-3"><ErrorBox error={error} /></div>
      {override && <OverrideModal permission={override.permission} message={override.message} onClose={() => setOverride(null)} onApproved={(token) => { setOverride(null); submit(token); }} />}
    </Modal>
  );
}
