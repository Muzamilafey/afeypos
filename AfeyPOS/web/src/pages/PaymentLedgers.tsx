import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useLocations } from '../lib/hooks';
import { dateTime, money } from '../lib/format';
import { DataTable } from '../components/DataTable';
import { Badge, Button, Field, Input, Modal, PageHeader, Select, Stat } from '../components/ui';
import { Icon } from '../components/icons';
import { MpesaMark } from '../components/PayVisuals';

/** Finance → M-Pesa logs, M-Pesa payments and Cash: what came in, filterable, with totals and a CSV download. */

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const monthAgo = () => isoDay(new Date(Date.now() - 30 * 86_400_000));

function Filters({ from, to, q, setFrom, setTo, setQ, placeholder, children }: { from: string; to: string; q: string; setFrom: (v: string) => void; setTo: (v: string) => void; setQ: (v: string) => void; placeholder: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end gap-2 border-b border-ink-100 p-3 dark:border-ink-800">
      <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
      <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      <Field label="Search" className="min-w-[200px] flex-1"><Input value={q} placeholder={placeholder} onChange={(e) => setQ(e.target.value)} /></Field>
      {children}
    </div>
  );
}

function csv(name: string, header: string[], rows: (string | number | undefined | null)[][]) {
  const cell = (v: unknown) => {
    const s = v === undefined || v === null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const blob = new Blob([[header, ...rows].map((r) => r.map(cell).join(',')).join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name}-${isoDay(new Date())}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function Pager({ page, total, limit, setPage }: { page: number; total: number; limit: number; setPage: (n: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / limit));
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-between border-t border-ink-100 p-3 text-sm dark:border-ink-800">
      <span className="text-ink-500">Page {page} of {pages} · {total} in all</span>
      <div className="flex gap-2"><Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button><Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button></div>
    </div>
  );
}

// ---------------- M-Pesa logs ----------------

const KIND: Record<string, string> = {
  c2b_confirmation: 'Paid to Till/Paybill', c2b_validation: 'Validation', stk_callback: 'Prompt result', stk_request: 'Prompt sent (failed)', stk_query: 'Prompt status check',
  txn_status: 'Code check', b2c_result: 'Payout result', async_timeout: 'Timed out', gateway_webhook: 'Gateway message', gateway_verify: 'Gateway check',
};
const OUTCOME_TONE = (o?: string): 'green' | 'amber' | 'red' | 'gray' => (!o ? 'gray' : /matched|succeeded|confirmed|recorded|receipt_added/.test(o) ? (o === 'recorded' ? 'amber' : 'green') : /duplicate/.test(o) ? 'gray' : /fail|reject|malformed|unknown|mismatch|timeout|not_/.test(o) ? 'red' : 'amber');

export function MpesaLogsPage() {
  const [from, setFrom] = useState(monthAgo());
  const [to, setTo] = useState(isoDay(new Date()));
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<any>(null);
  const limit = 50;
  const list = useQuery({
    queryKey: ['mpesa-logs', from, to, q, kind, page],
    queryFn: () => api<{ data: any[]; total: number; kinds: Record<string, number> }>('/payments/mpesa/logs', { query: { from: from || undefined, to: to || undefined, q: q || undefined, kind: kind || undefined, page, limit } }),
    refetchInterval: 20_000, placeholderData: (p) => p,
  });
  const rows = list.data?.data ?? [];
  return (
    <div>
      <PageHeader title="M-Pesa logs" subtitle="Every message between this server and Safaricom" actions={<Button variant="secondary" disabled={!rows.length} onClick={() => csv('mpesa-logs', ['Time', 'Type', 'Outcome', 'Receipt', 'Amount', 'Phone', 'Number', 'Account', 'Payer', 'Result'], rows.map((r) => [dateTime(r.at), KIND[r.kind] ?? r.kind, r.outcome, r.receipt, r.amountCents !== undefined ? (r.amountCents / 100).toFixed(2) : '', r.phone, r.shortCode, r.account, r.payer, r.resultDesc]))}><Icon name="download" className="h-4 w-4" />CSV</Button>} />
      <div className="card">
        <Filters from={from} to={to} q={q} setFrom={(v) => { setFrom(v); setPage(1); }} setTo={(v) => { setTo(v); setPage(1); }} setQ={(v) => { setQ(v); setPage(1); }} placeholder="Receipt, account or request id">
          <Field label="Type"><Select value={kind} onChange={(e) => { setKind(e.target.value); setPage(1); }} placeholder="All types" options={Object.entries(KIND).map(([value, label]) => ({ value, label: `${label}${list.data?.kinds?.[value] ? ` (${list.data.kinds[value]})` : ''}` }))} /></Field>
        </Filters>
        <DataTable rows={rows} loading={list.isLoading} error={list.error} empty="No message from Safaricom in this period" columns={[
          { key: 't', header: 'Time', render: (r: any) => dateTime(r.at) },
          { key: 'k', header: 'Type', render: (r: any) => KIND[r.kind] ?? r.kind },
          { key: 'r', header: 'Receipt', render: (r: any) => <span className="font-mono">{r.receipt ?? '—'}</span> },
          { key: 'a', header: 'Amount', className: 'num', render: (r: any) => (r.amountCents !== undefined ? money(r.amountCents) : '') },
          { key: 'p', header: 'From', render: (r: any) => <span className="text-xs">{r.payer ? <b>{r.payer}</b> : null} {r.phone}</span> },
          { key: 'n', header: 'Till / Paybill', render: (r: any) => <span className="text-xs">{r.shortCode}{r.account ? ` · ${r.account}` : ''}</span> },
          { key: 'o', header: 'Outcome', render: (r: any) => <span>{r.outcome && <Badge tone={OUTCOME_TONE(r.outcome)}>{r.outcome.replace(/_/g, ' ')}</Badge>}<div className="max-w-[260px] text-xs text-ink-500">{r.resultDesc ?? r.error ?? ''}</div></span> },
          { key: 'x', header: '', render: (r: any) => <Button size="sm" variant="ghost" onClick={() => setOpen(r)}>Details</Button> },
        ]} />
        <Pager page={page} total={list.data?.total ?? 0} limit={limit} setPage={setPage} />
      </div>
      {open && (
        <Modal open onClose={() => setOpen(null)} title={KIND[open.kind] ?? open.kind} subtitle={`${dateTime(open.at)}${open.ip ? ` · from ${open.ip}` : ''}`} size="lg">
          <pre className="max-h-[60vh] overflow-auto rounded-md bg-ink-50 p-3 text-xs dark:bg-ink-800">{JSON.stringify(open.payload, null, 2)}</pre>
          <p className="mt-2 text-xs text-ink-500">Phone numbers are partly hidden.</p>
        </Modal>
      )}
    </div>
  );
}

// ---------------- M-Pesa payments ----------------

export function MpesaReceivedPage() {
  const [from, setFrom] = useState(monthAgo());
  const [to, setTo] = useState(isoDay(new Date()));
  const [q, setQ] = useState('');
  const [used, setUsed] = useState('');
  const [source, setSource] = useState('');
  const [page, setPage] = useState(1);
  const limit = 50;
  const list = useQuery({
    queryKey: ['mpesa-received', from, to, q, used, source, page],
    queryFn: () => api<{ data: any[]; total: number; summary: { count: number; totalCents: number; usedCents: number; unusedCents: number } }>('/payments/mpesa/received', { query: { from: from || undefined, to: to || undefined, q: q || undefined, used: used || undefined, source: source || undefined, page, limit } }),
    refetchInterval: 20_000, placeholderData: (p) => p,
  });
  const rows = list.data?.data ?? [];
  const s = list.data?.summary;
  const reset = () => setPage(1);
  return (
    <div>
      <PageHeader title="M-Pesa payments" subtitle="Every successful M-Pesa payment, confirmed by Safaricom" actions={<Button variant="secondary" disabled={!rows.length} onClick={() => csv('mpesa-payments', ['Time', 'Receipt', 'Amount', 'Used', 'Used for', 'Payer', 'Phone', 'How'], rows.map((r) => [dateTime(r.completedAt), r.receiptNumber, (r.amountCents / 100).toFixed(2), (r.usedCents / 100).toFixed(2), r.usedFor, r.payerName, r.phone, r.source === 'stk' ? 'Prompt' : 'Paid to Till/Paybill']))}><Icon name="download" className="h-4 w-4" />CSV</Button>} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="mpesa-received-summary">
        <div className="card flex items-center justify-center p-3"><MpesaMark className="h-10" /></div>
        <Stat label="Received" value={money(s?.totalCents ?? 0)} hint={`${s?.count ?? 0} payment${s?.count === 1 ? '' : 's'}`} />
        <Stat label="Used on sales" value={money(s?.usedCents ?? 0)} />
        <Stat label="Not used yet" value={money(s?.unusedCents ?? 0)} tone={(s?.unusedCents ?? 0) > 0 ? 'red' : undefined} />
      </div>
      <div className="card">
        <Filters from={from} to={to} q={q} setFrom={(v) => { setFrom(v); reset(); }} setTo={(v) => { setTo(v); reset(); }} setQ={(v) => { setQ(v); reset(); }} placeholder="Receipt, name, phone or sale number">
          <Field label="Used"><Select value={used} onChange={(e) => { setUsed(e.target.value); reset(); }} placeholder="All" options={[{ value: 'used', label: 'Used on a sale' }, { value: 'unused', label: 'Not used yet' }]} /></Field>
          <Field label="How"><Select value={source} onChange={(e) => { setSource(e.target.value); reset(); }} placeholder="All" options={[{ value: 'stk', label: 'Prompt (STK)' }, { value: 'c2b', label: 'Paid to Till/Paybill' }]} /></Field>
        </Filters>
        <DataTable rows={rows} loading={list.isLoading} error={list.error} empty="No M-Pesa payment in this period" columns={[
          { key: 't', header: 'Time', render: (r: any) => dateTime(r.completedAt) },
          { key: 'r', header: 'Receipt', render: (r: any) => <span className="font-mono">{r.receiptNumber}</span> },
          { key: 'p', header: 'From', render: (r: any) => <span>{r.payerName ? <b>{r.payerName}</b> : 'M-Pesa customer'}<div className="text-xs text-ink-500">{r.phone}</div></span> },
          { key: 'h', header: 'How', render: (r: any) => (r.source === 'stk' ? 'Prompt' : `Paid to ${r.account ? 'Paybill' : 'Till'} ${r.shortCode ?? ''}`) },
          { key: 'a', header: 'Amount', className: 'num', render: (r: any) => <b>{money(r.amountCents)}</b> },
          { key: 'u', header: 'Used for', render: (r: any) => (r.usedCents >= r.amountCents ? r.usedFor ?? 'Used' : r.usedCents > 0 ? <span>{r.usedFor} <Badge tone="amber">{money(r.amountCents - r.usedCents)} left</Badge></span> : <Badge tone="amber">not used</Badge>) },
        ]} />
        <Pager page={page} total={list.data?.total ?? 0} limit={limit} setPage={setPage} />
      </div>
    </div>
  );
}

// ---------------- Cash ----------------

export function CashPaymentsPage() {
  const locs = useLocations();
  const [from, setFrom] = useState(isoDay(new Date()));
  const [to, setTo] = useState(isoDay(new Date()));
  const [q, setQ] = useState('');
  const [tillId, setTillId] = useState('');
  const list = useQuery({
    queryKey: ['cash-payments', from, to, q, tillId],
    queryFn: () => api<{ data: any[]; summary: { sales: number; refunds: number; cashInCents: number; refundsCents: number; netCents: number } }>('/payments/cash', { query: { from: from || undefined, to: to || undefined, q: q || undefined, tillId: tillId || undefined } }),
    refetchInterval: 30_000, placeholderData: (p) => p,
  });
  const rows = list.data?.data ?? [];
  const s = list.data?.summary;
  const tillName = (id?: string) => locs.data?.tills.find((t: any) => t._id === id)?.name ?? '';
  return (
    <div>
      <PageHeader title="Cash" subtitle="Cash taken on sales and cash given back on returns" actions={<Button variant="secondary" disabled={!rows.length} onClick={() => csv('cash', ['Time', 'Type', 'Number', 'Till', 'By', 'Cash', 'Given', 'Change', 'Other payments'], rows.map((r) => [dateTime(r.at), r.kind === 'sale' ? 'Sale' : 'Refund', r.number, tillName(r.tillId), r.by, (r.amountCents / 100).toFixed(2), (r.tenderedCents / 100).toFixed(2), (r.changeCents / 100).toFixed(2), (r.otherCents / 100).toFixed(2)]))}><Icon name="download" className="h-4 w-4" />CSV</Button>} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="cash-summary">
        <Stat label="Cash taken" value={money(s?.cashInCents ?? 0)} hint={`${s?.sales ?? 0} sale${s?.sales === 1 ? '' : 's'}`} />
        <Stat label="Cash refunded" value={money(s?.refundsCents ?? 0)} hint={`${s?.refunds ?? 0} return${s?.refunds === 1 ? '' : 's'}`} />
        <Stat label="Net cash" value={money(s?.netCents ?? 0)} />
        <Stat label="Change given" value={money(rows.reduce((a, r) => a + (r.changeCents ?? 0), 0))} hint="for the rows shown" />
      </div>
      <div className="card">
        <Filters from={from} to={to} q={q} setFrom={setFrom} setTo={setTo} setQ={setQ} placeholder="Sale or return number">
          <Field label="Till"><Select value={tillId} onChange={(e) => setTillId(e.target.value)} placeholder="All tills" options={(locs.data?.tills ?? []).map((t: any) => ({ value: t._id, label: t.name }))} /></Field>
        </Filters>
        <DataTable rows={rows} loading={list.isLoading} error={list.error} empty="No cash in this period" columns={[
          { key: 't', header: 'Time', render: (r: any) => dateTime(r.at) },
          { key: 'k', header: '', render: (r: any) => <Badge tone={r.kind === 'sale' ? 'green' : 'amber'}>{r.kind === 'sale' ? 'Sale' : 'Refund'}</Badge> },
          { key: 'n', header: 'Number', render: (r: any) => <span className="font-mono">{r.number}</span> },
          { key: 'l', header: 'Till', render: (r: any) => tillName(r.tillId) || '—' },
          { key: 'b', header: 'By', render: (r: any) => r.by },
          { key: 'a', header: 'Cash', className: 'num', render: (r: any) => <b className={r.amountCents < 0 ? 'text-red-600' : ''}>{money(r.amountCents)}</b> },
          { key: 'g', header: 'Given', className: 'num', render: (r: any) => (r.kind === 'sale' ? money(r.tenderedCents) : '') },
          { key: 'c', header: 'Change', className: 'num', render: (r: any) => (r.changeCents ? money(r.changeCents) : '') },
          { key: 'o', header: 'Also paid', className: 'num', render: (r: any) => (r.otherCents ? money(r.otherCents) : '') },
        ]} />
      </div>
    </div>
  );
}
