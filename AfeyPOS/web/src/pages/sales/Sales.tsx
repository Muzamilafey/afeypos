import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { api, newRequestId, openPrintable } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useList, useLocations } from '../../lib/hooks';
import { dateTime, money, qty } from '../../lib/format';
import { getWorkstation } from '../../lib/workstation';
import { DataTable } from '../../components/DataTable';
import { Button, Card, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, StatusBadge, Checkbox, useConfirm, useToast } from '../../components/ui';

export function SalesPage() {
  const nav = useNavigate();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const list = useList(['sales'], '/sales', { page, q: q || undefined, from: from || undefined, limit: 25 });
  return (
    <div>
      <PageHeader title="Sales history" subtitle="Search by receipt number, M-Pesa reference or serial number" />
      <div className="card">
        <div className="flex flex-wrap gap-2 border-b border-ink-100 p-3 dark:border-ink-800">
          <Input className="max-w-xs" placeholder="Search" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
          <Input type="date" className="max-w-[180px]" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
        </div>
        <DataTable rows={list.data?.data} loading={list.isLoading} error={list.error} page={page} total={list.data?.total} limit={25} onPage={setPage} onRowClick={(r: any) => nav(`/sales/${r._id}`)}
          columns={[
            { key: 'n', header: 'Receipt', render: (r: any) => <span className="font-medium">{r.number}</span> },
            { key: 'd', header: 'Date', render: (r: any) => dateTime(r.completedAt) },
            { key: 'i', header: 'Items', render: (r: any) => r.lines.length },
            { key: 'p', header: 'Paid by', render: (r: any) => r.payments.map((p: any) => p.method).join(', ') || '—' },
            { key: 't', header: 'Total', className: 'num', render: (r: any) => money(r.totalCents) },
            { key: 's', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
          ]} />
      </div>
    </div>
  );
}

export function SaleDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['sale', id], queryFn: () => api<{ data: any }>(`/sales/${id}`).then((r) => r.data) });
  const [returning, setReturning] = useState(false);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const s = q.data;
  const voidSale = async () => {
    const ok = await confirm({ title: `Void ${s.number}?`, message: 'All items are returned to stock, cash is reversed and M-Pesa payments are released for re-use. This cannot be undone.', confirmLabel: 'Void sale', danger: true });
    if (!ok) return;
    try {
      await api(`/sales/${s._id}/void`, { body: { clientRequestId: newRequestId(), reason: 'Voided from sales history' } });
      toast.success('Sale voided');
      qc.invalidateQueries({ queryKey: ['sale', id] });
    } catch (e) { toast.error(e); }
  };
  return (
    <div>
      <PageHeader title={`Sale ${s.number}`} subtitle={dateTime(s.completedAt)} actions={<>
        <Button variant="secondary" onClick={() => openPrintable(`/sales/${s._id}/receipt?format=html`).catch(toast.error)}>Reprint</Button>
        <Button variant="secondary" onClick={() => openPrintable(`/sales/${s._id}/invoice`).catch(toast.error)}>A4 invoice</Button>
        {can('sales.return') && s.status !== 'voided' && s.status !== 'returned' && <Button variant="secondary" onClick={() => setReturning(true)}>Return items</Button>}
        {can('sales.void') && s.status === 'completed' && <Button variant="danger" onClick={voidSale}>Void</Button>}
      </>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Items" className="lg:col-span-2">
          <table className="min-w-full text-sm"><thead><tr><th className="th">Item</th><th className="th num">Qty</th><th className="th num">Price</th><th className="th num">Total</th></tr></thead>
            <tbody>{s.lines.map((l: any) => <tr key={l._id}><td className="td">{l.name}{l.serials?.length ? <div className="text-xs text-ink-500">S/N {l.serials.join(', ')}</div> : null}{l.returnedQty ? <div className="text-xs text-red-600">{qty(l.returnedQty)} returned</div> : null}</td><td className="td num">{qty(l.qty)} {l.unitCode}</td><td className="td num">{money(l.unitPriceCents)}</td><td className="td num">{money(l.totalCents)}</td></tr>)}</tbody>
          </table>
        </Card>
        <Card title="Summary">
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between"><dt>Status</dt><dd><StatusBadge status={s.status} /></dd></div>
            <div className="flex justify-between"><dt>Customer</dt><dd>{s.customer?.name ?? 'Walk-in'}</dd></div>
            <div className="flex justify-between"><dt>Discounts</dt><dd>{money(s.discountCents)}</dd></div>
            <div className="flex justify-between"><dt>Tax</dt><dd>{money(s.taxCents)}</dd></div>
            <div className="flex justify-between font-semibold"><dt>Total</dt><dd>{money(s.totalCents)}</dd></div>
            {s.payments.map((p: any, i: number) => <div key={i} className="flex justify-between text-ink-600"><dt className="capitalize">{p.method} {p.reference}</dt><dd>{money(p.amountCents)}</dd></div>)}
            {s.refundedCents > 0 && <div className="flex justify-between text-red-600"><dt>Refunded</dt><dd>{money(s.refundedCents)}</dd></div>}
            {s.overrides?.length > 0 && <div className="pt-2 text-xs text-amber-700">Supervisor approved: {s.overrides.map((o: any) => o.action).join('; ')}</div>}
          </dl>
        </Card>
        {s.returns?.length > 0 && <Card title="Returns" className="lg:col-span-3"><ul className="text-sm">{s.returns.map((r: any) => <li key={r._id}>{r.number} · {dateTime(r.createdAt)} · {money(r.refundCents)} via {r.refundMethod} · {r.reason}</li>)}</ul></Card>}
      </div>
      {returning && <ReturnModal sale={s} onClose={() => setReturning(false)} onDone={() => { setReturning(false); qc.invalidateQueries({ queryKey: ['sale', id] }); }} />}
    </div>
  );
}

function ReturnModal({ sale, onClose, onDone }: { sale: any; onClose: () => void; onDone: () => void }) {
  const locs = useLocations();
  const toast = useToast();
  const [requestId] = useState(newRequestId);
  const [lines, setLines] = useState<Record<string, { qty: number; restock: boolean; serials: string }>>({});
  const [method, setMethod] = useState('cash');
  const [reason, setReason] = useState('');
  const [tillId, setTillId] = useState(getWorkstation().tillId ?? '');
  const [error, setError] = useState<unknown>(null);
  const submit = async () => {
    try {
      const payload = Object.entries(lines).filter(([, v]) => v.qty > 0).map(([lineId, v]) => ({ lineId, qty: v.qty, restock: v.restock, serials: v.serials ? v.serials.split(/[,\s]+/).filter(Boolean) : undefined }));
      await api(`/sales/${sale._id}/returns`, { body: { clientRequestId: requestId, tillId: method === 'cash' ? tillId : undefined, lines: payload, refundMethod: method, reason }, idempotencyKey: requestId });
      toast.success('Return processed');
      onDone();
    } catch (e) { setError(e); }
  };
  return (
    <Modal open onClose={onClose} title={`Return items from ${sale.number}`} size="lg" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} disabled={!reason}>Process return</Button></>}>
      <table className="min-w-full text-sm"><thead><tr><th className="th">Item</th><th className="th">Returnable</th><th className="th">Qty</th><th className="th">Restock</th></tr></thead>
        <tbody>{sale.lines.map((l: any) => {
          const max = l.qty - (l.returnedQty ?? 0);
          const v = lines[l._id] ?? { qty: 0, restock: true, serials: '' };
          return <tr key={l._id}><td className="td">{l.name}{l.serials?.length ? <Input className="mt-1" placeholder="Serials returned" value={v.serials} onChange={(e) => setLines({ ...lines, [l._id]: { ...v, serials: e.target.value } })} /> : null}</td><td className="td">{qty(max)}</td>
            <td className="td"><Input type="number" min={0} max={max} step="any" className="w-24" value={v.qty} onChange={(e) => setLines({ ...lines, [l._id]: { ...v, qty: Math.min(max, Number(e.target.value)) } })} /></td>
            <td className="td"><Checkbox label="" checked={v.restock} onChange={(c) => setLines({ ...lines, [l._id]: { ...v, restock: c } })} /></td></tr>;
        })}</tbody></table>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Field label="Refund via"><Select value={method} onChange={(e) => setMethod(e.target.value)} options={[{ value: 'cash', label: 'Cash' }, { value: 'mpesa', label: 'M-Pesa (manual reversal)' }, { value: 'card', label: 'Card' }, ...(sale.customerId ? [{ value: 'account', label: 'Customer account' }] : []), { value: 'credit_note', label: 'Credit note' }]} /></Field>
        {method === 'cash' && <Field label="Till paying out"><Select value={tillId} onChange={(e) => setTillId(e.target.value)} placeholder="Select till" options={(locs.data?.tills ?? []).map((t) => ({ value: t._id, label: t.name }))} /></Field>}
        <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
      <div className="mt-3"><ErrorBox error={error} /></div>
    </Modal>
  );
}

export function ShiftsPage() {
  const { can } = useAuth();
  const locs = useLocations();
  const qc = useQueryClient();
  const toast = useToast();
  const list = useList(['shifts'], '/shifts', { limit: 50 });
  const [selected, setSelected] = useState<any>(null);
  const tillName = (id: string) => locs.data?.tills.find((t) => t._id === id)?.name ?? '—';
  return (
    <div>
      <PageHeader title="Shifts & tills" subtitle={can('shifts.manage') ? 'All shifts' : 'Your shifts'} />
      <div className="card">
        <DataTable rows={list.data?.data} loading={list.isLoading} error={list.error} onRowClick={setSelected}
          columns={[
            { key: 'n', header: 'Shift', render: (r: any) => r.number },
            { key: 't', header: 'Till', render: (r: any) => tillName(r.tillId) },
            { key: 'o', header: 'Opened', render: (r: any) => dateTime(r.openedAt) },
            { key: 'c', header: 'Closed', render: (r: any) => dateTime(r.closedAt) },
            { key: 'e', header: 'Expected cash', className: 'num', render: (r: any) => (r.expectedCashCents !== undefined ? money(r.expectedCashCents) : '—') },
            { key: 'v', header: 'Variance', className: 'num', render: (r: any) => (r.varianceCents !== undefined ? <span className={r.varianceCents < 0 ? 'text-red-600' : r.varianceCents > 0 ? 'text-amber-600' : ''}>{money(r.varianceCents)}</span> : '—') },
            { key: 's', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
          ]} />
      </div>
      {selected && <ShiftModal shift={selected} onClose={() => setSelected(null)} onChanged={() => { qc.invalidateQueries({ queryKey: ['shifts'] }); qc.invalidateQueries({ queryKey: ['shift'] }); toast.success('Saved'); }} />}
    </div>
  );
}

function ShiftModal({ shift, onClose, onChanged }: { shift: any; onClose: () => void; onChanged: () => void }) {
  const { can } = useAuth();
  const summary = useQuery({ queryKey: ['shift-summary', shift._id], queryFn: () => api<{ data: any }>(`/shifts/${shift._id}/summary`).then((r) => r.data) });
  const [counted, setCounted] = useState('');
  const [cash, setCash] = useState({ type: 'cash_out', amount: '', reason: '' });
  const [error, setError] = useState<unknown>(null);
  const s = summary.data;
  return (
    <Modal open onClose={onClose} title={`Shift ${shift.number}`} size="lg">
      {!s ? <Loading /> : (
        <div className="space-y-4 text-sm">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div><div className="label">Sales</div>{s.sales.count} · {money(s.sales.totalCents)}</div>
            <div><div className="label">Expected cash</div><span className="text-lg font-semibold">{money(s.expectedCashCents)}</span></div>
            <div><div className="label">Voids</div>{s.voids.count} · {money(s.voids.totalCents)}</div>
            <div><div className="label">Discounts</div>{money(s.sales.discountCents)}</div>
          </div>
          <div><div className="label">By payment method</div>{Object.entries(s.paymentsByMethod).map(([k, v]: any) => <div key={k} className="flex justify-between"><span className="capitalize">{k}</span><span>{money(v.totalCents)}</span></div>)}</div>
          <div><div className="label">Cash movements</div>{Object.entries(s.cashMovements).map(([k, v]: any) => <div key={k} className="flex justify-between"><span>{k.replace('_', ' ')}</span><span>{money(v.totalCents)}</span></div>)}</div>
          {shift.status === 'open' && (
            <>
              {can('cash.movement') && (
                <div className="flex flex-wrap items-end gap-2 rounded-lg bg-ink-50 p-3 dark:bg-ink-800/50">
                  <Field label="Cash"><Select value={cash.type} onChange={(e) => setCash({ ...cash, type: e.target.value })} options={[{ value: 'cash_out', label: 'Cash out' }, { value: 'cash_in', label: 'Cash in' }]} /></Field>
                  <Field label="Amount"><Input inputMode="decimal" value={cash.amount} onChange={(e) => setCash({ ...cash, amount: e.target.value })} /></Field>
                  <Field label="Reason"><Input value={cash.reason} onChange={(e) => setCash({ ...cash, reason: e.target.value })} /></Field>
                  <Button variant="secondary" onClick={async () => { try { await api(`/shifts/${shift._id}/cash`, { body: { type: cash.type, amountCents: Math.round(Number(cash.amount) * 100), reason: cash.reason } }); setCash({ ...cash, amount: '', reason: '' }); summary.refetch(); } catch (e) { setError(e); } }}>Record</Button>
                </div>
              )}
              <div className="flex items-end gap-2 border-t border-ink-100 pt-3 dark:border-ink-800">
                <Field label="Counted cash in drawer"><Input inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} /></Field>
                <Button onClick={async () => { try { await api(`/shifts/${shift._id}/close`, { body: { countedCashCents: Math.round(Number(counted) * 100) } }); onChanged(); onClose(); } catch (e) { setError(e); } }} disabled={counted === ''}>Close shift</Button>
              </div>
              {counted !== '' && <p>Variance: <strong>{money(Math.round(Number(counted) * 100) - s.expectedCashCents)}</strong></p>}
            </>
          )}
          {shift.status === 'closed' && <p>Counted {money(shift.countedCashCents)} · variance <strong className={shift.varianceCents < 0 ? 'text-red-600' : ''}>{money(shift.varianceCents)}</strong></p>}
          <ErrorBox error={error} />
        </div>
      )}
    </Modal>
  );
}
