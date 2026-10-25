import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useList } from '../lib/hooks';
import { dateTime, money } from '../lib/format';
import { DataTable } from '../components/DataTable';
import { Button, Checkbox, PageHeader, Select, Stat, StatusBadge, useConfirm, useToast } from '../components/ui';

/** M-Pesa B2C payouts (salaries, advances, refunds): a second person approves, then sends. */
export function PayoutsPage() {
  const { can, me } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [status, setStatus] = useState('draft');
  const [picked, setPicked] = useState<string[]>([]);
  const list = useList<any>(['payouts'], '/payments/payouts', { status: status || undefined, limit: 200 });
  const rows = list.data?.data ?? [];
  const chosen = rows.filter((r) => picked.includes(r._id));
  const total = chosen.reduce((s, r) => s + r.amountCents, 0);
  const run = (path: string, msg: (r: any) => string) => api<any>(path, { body: { ids: picked } }).then((r) => { toast.success(msg(r)); setPicked([]); qc.invalidateQueries({ queryKey: ['payouts'] }); }).catch(toast.error);
  const mine = chosen.some((r) => String(r.requestedBy) === me?.user.id);
  return (
    <div>
      <PageHeader title="M-Pesa payouts" subtitle="Salaries, advances and refunds sent to phones (B2C). Someone other than the requester approves and sends." />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select className="max-w-xs" value={status} onChange={(e) => { setStatus(e.target.value); setPicked([]); }} options={[{ value: 'draft', label: 'Waiting for approval' }, { value: 'approved', label: 'Approved, not sent' }, { value: 'sent', label: 'Sent, waiting for Safaricom' }, { value: 'succeeded', label: 'Paid' }, { value: 'failed', label: 'Failed' }, { value: '', label: 'All' }]} />
        {picked.length > 0 && <span className="text-sm">{picked.length} selected · {money(total)}</span>}
        {status === 'draft' && can('payouts.approve') && <Button disabled={!picked.length || mine} title={mine ? 'You requested some of these; another person must approve' : undefined} onClick={() => run('/payments/payouts/approve', (r) => `${r.data.approved} approved`)}>Approve</Button>}
        {status === 'approved' && can('payouts.approve') && <Button disabled={!picked.length} onClick={async () => { if (await confirm({ title: `Send ${money(total)}?`, message: `${picked.length} M-Pesa payments are sent now.`, confirmLabel: 'Send' })) run('/payments/payouts/send', (r) => `${r.data.filter((x: any) => x.status === 'sent').length} sent`); }}>Send money</Button>}
        {['draft', 'approved'].includes(status) && <Button variant="secondary" disabled={!picked.length} onClick={() => run('/payments/payouts/cancel', () => 'Cancelled')}>Cancel</Button>}
      </div>
      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4"><Stat label="Listed" value={money(rows.reduce((s, r) => s + r.amountCents, 0))} hint={`${rows.length} payouts`} /></div>
      <div className="card"><DataTable rows={rows} loading={list.isLoading} empty="No payouts" columns={[
        ...(['draft', 'approved'].includes(status) ? [{ key: 'c', header: '', render: (r: any) => <Checkbox label="" checked={picked.includes(r._id)} onChange={(v) => setPicked(v ? [...picked, r._id] : picked.filter((x) => x !== r._id))} /> }] : []),
        { key: 'p', header: 'Payee', render: (r: any) => <div><div className="font-medium">{r.payeeName ?? r.phone}</div><div className="text-xs text-ink-500">{r.phone}</div></div> },
        { key: 'f', header: 'For', render: (r: any) => `${r.purpose}${r.ref?.number ? ` · ${r.ref.number}` : ''}` },
        { key: 'a', header: 'Amount', className: 'num', render: (r: any) => money(r.amountCents) },
        { key: 'd', header: 'Created', render: (r: any) => dateTime(r.createdAt) },
        { key: 's', header: 'Status', render: (r: any) => <div><StatusBadge status={r.status} />{r.receiptNumber && <div className="text-xs">{r.receiptNumber}</div>}{r.status === 'failed' && <div className="text-xs text-red-600">{r.resultDesc}</div>}</div> },
        ...(status === 'sent' ? [{ key: 'x', header: '', render: (r: any) => <Button size="sm" variant="ghost" onClick={() => api(`/payments/payouts/${r._id}/simulate`, { body: {} }).then(() => qc.invalidateQueries({ queryKey: ['payouts'] })).catch(toast.error)}>Simulate result</Button> }] : []),
      ]} /></div>
    </div>
  );
}
