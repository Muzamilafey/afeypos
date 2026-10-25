import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { api, newRequestId } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useList } from '../../lib/hooks';
import { date, dateTime, money } from '../../lib/format';
import { DataTable } from '../../components/DataTable';
import { Button, Card, Checkbox, ErrorBox, Field, Input, Loading, Modal, MoneyInput, PageHeader, Select, Stat, StatusBadge, useToast } from '../../components/ui';
import { CustomerCrmPanel } from '../crm/CRM';
import { Icon } from '../../components/icons';

function PartyForm({ kind, initial, onSaved, onClose }: { kind: 'customer' | 'supplier'; initial?: any; onSaved: () => void; onClose: () => void }) {
  const { me, can } = useAuth();
  const [f, setF] = useState<any>(initial ? { ...initial, dateOfBirth: initial.dateOfBirth?.slice(0, 10) ?? '', tagsText: (initial.tags ?? []).join(', ') } : { name: '', phone: '', email: '', taxPin: '', address: '', kind: 'retail', priceList: 'retail', creditLimitCents: 0, paymentTermsDays: 30 });
  const [error, setError] = useState<unknown>(null);
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    try {
      const body: any = { name: f.name, phone: f.phone || undefined, email: f.email || undefined, taxPin: f.taxPin || undefined, address: f.address || undefined, paymentTermsDays: Number(f.paymentTermsDays) };
      if (kind === 'customer') Object.assign(body, { kind: f.kind === 'walk_in' ? 'retail' : f.kind, priceList: f.priceList, creditLimitCents: f.creditLimitCents, dateOfBirth: f.dateOfBirth || undefined, tags: String(f.tagsText ?? '').split(',').map((x) => x.trim()).filter(Boolean), marketingOptIn: Boolean(f.marketingOptIn) });
      else body.contactPerson = f.contactPerson || undefined;
      const path = kind === 'customer' ? '/customers' : '/suppliers';
      if (initial?._id) await api(`${path}/${initial._id}`, { method: 'PATCH', body });
      else await api(path, { body });
      onSaved();
    } catch (e) { setError(e); }
  };
  return (
    <Modal open onClose={onClose} title={initial ? `Edit ${kind}` : `New ${kind}`} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={save}>Save</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" className="sm:col-span-2"><Input value={f.name} onChange={set('name')} autoFocus /></Field>
        <Field label="Phone"><Input value={f.phone ?? ''} onChange={set('phone')} /></Field>
        <Field label="Email"><Input value={f.email ?? ''} onChange={set('email')} /></Field>
        <Field label="KRA PIN / Tax ID"><Input value={f.taxPin ?? ''} onChange={set('taxPin')} /></Field>
        <Field label="Payment terms (days)"><Input type="number" value={f.paymentTermsDays} onChange={set('paymentTermsDays')} /></Field>
        <Field label="Address" className="sm:col-span-2"><Input value={f.address ?? ''} onChange={set('address')} /></Field>
        {kind === 'customer' && (
          <>
            <Field label="Customer type"><Select value={f.kind} onChange={set('kind')} options={['retail', 'wholesale', 'contractor', 'corporate'].map((x) => ({ value: x, label: x }))} /></Field>
            <Field label="Price list"><Select value={f.priceList} onChange={set('priceList')} options={me!.capabilities.priceLists.map((x) => ({ value: x, label: x }))} /></Field>
            <Field label="Date of birth (for birthday greetings)"><Input type="date" value={f.dateOfBirth ?? ''} onChange={set('dateOfBirth')} /></Field>
            <Field label="Tags" hint="Comma separated, e.g. hotel, estate A"><Input value={f.tagsText ?? ''} onChange={set('tagsText')} /></Field>
            <div className="sm:col-span-2"><Checkbox label="Agrees to receive offers by SMS / email (ask the customer)" checked={Boolean(f.marketingOptIn)} onChange={(v) => setF({ ...f, marketingOptIn: v })} /></div>
            {me!.capabilities.modules.includes('customerCredit') && <Field label="Credit limit" hint={can('credit.approve') ? undefined : 'Requires credit approval permission'}><MoneyInput value={f.creditLimitCents} onChange={(v) => setF({ ...f, creditLimitCents: v ?? 0 })} disabled={!can('credit.approve')} /></Field>}
          </>
        )}
      </div>
      <div className="mt-3"><ErrorBox error={error} /></div>
    </Modal>
  );
}

export function PartiesPage({ kind }: { kind: 'customer' | 'supplier' }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const path = kind === 'customer' ? '/customers' : '/suppliers';
  const list = useList([path], path, { page, q: q || undefined, limit: 25 });
  return (
    <div>
      <PageHeader title={kind === 'customer' ? 'Customers' : 'Suppliers'} actions={can(kind === 'customer' ? 'customers.manage' : 'suppliers.manage') && <Button onClick={() => setCreating(true)}><Icon name="plus" className="h-4 w-4" />New {kind}</Button>} />
      <div className="card">
        <div className="border-b border-ink-100 p-3 dark:border-ink-800"><Input className="max-w-sm" placeholder="Search name, phone or code" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></div>
        <DataTable rows={list.data?.data} loading={list.isLoading} error={list.error} page={page} total={list.data?.total} limit={25} onPage={setPage} onRowClick={(r: any) => nav(`${path}/${r._id}`)}
          columns={[
            { key: 'n', header: 'Name', render: (r: any) => <div><div className="font-medium">{r.name}</div><div className="text-xs text-ink-500">{r.code}</div></div> },
            { key: 'p', header: 'Phone', render: (r: any) => r.phone ?? '—' },
            ...(kind === 'customer' ? [{ key: 'k', header: 'Type', render: (r: any) => r.kind.replace('_', ' ') }, { key: 'l', header: 'Credit limit', className: 'num', render: (r: any) => money(r.creditLimitCents) }] : []),
            { key: 'b', header: kind === 'customer' ? 'Owes us' : 'We owe', className: 'num', render: (r: any) => <span className={r.balanceCents > 0 ? 'font-medium text-red-600' : ''}>{money(r.balanceCents)}</span> },
          ]} />
      </div>
      {creating && <PartyForm kind={kind} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); qc.invalidateQueries({ queryKey: [path] }); }} />}
    </div>
  );
}

export function PartyDetailPage({ kind }: { kind: 'customer' | 'supplier' }) {
  const { id } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const { can, has } = useAuth();
  const path = kind === 'customer' ? '/customers' : '/suppliers';
  const q = useQuery({ queryKey: [path, id], queryFn: () => api<{ data: any }>(`${path}/${id}`).then((r) => r.data) });
  const statement = useQuery({ queryKey: [path, id, 'statement'], queryFn: () => api<{ data: any }>(`/customers/${id}/statement`).then((r) => r.data), enabled: kind === 'customer' });
  const [editing, setEditing] = useState(false);
  const [paying, setPaying] = useState(false);
  const [pay, setPay] = useState<{ amountCents: number | null; method: string; reference: string }>({ amountCents: null, method: 'cash', reference: '' });
  const [requestId, setRequestId] = useState(newRequestId);
  const [error, setError] = useState<unknown>(null);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const p = q.data;
  const entries = kind === 'customer' ? statement.data?.entries ?? [] : p.entries ?? [];
  const ageing = kind === 'customer' ? statement.data?.ageing : p.ageing;
  const canPay = kind === 'customer' ? can('customers.payments') && has('customerCredit') : can('suppliers.pay');
  return (
    <div>
      <PageHeader title={p.name} subtitle={`${p.code}${p.phone ? ' · ' + p.phone : ''}`} actions={<>
        <Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button>
        {kind === 'customer' && (p.email || p.phone) && <Button variant="secondary" onClick={() => api(`/customers/${id}/statement/send`, { body: {} }).then(() => toast.success('Statement queued')).catch(toast.error)}>Send statement</Button>}
        {canPay && <Button onClick={() => setPaying(true)}>{kind === 'customer' ? 'Receive payment' : 'Pay supplier'}</Button>}
      </>} />
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label={kind === 'customer' ? 'Balance owed' : 'We owe'} value={money(p.balanceCents)} tone={p.balanceCents > 0 ? 'red' : undefined} />
        {kind === 'customer' && <Stat label="Credit limit" value={money(p.creditLimitCents)} hint={`Available ${money(Math.max(0, p.creditLimitCents - p.balanceCents))}`} />}
        {ageing && <Stat label="Overdue > 30 days" value={money((ageing.d31_60 ?? 0) + (ageing.d61_90 ?? 0) + (ageing.d90plus ?? 0))} />}
        {kind === 'customer' && has('loyalty') && <Stat label="Loyalty points" value={p.loyaltyPoints} />}
      </div>
      {ageing && (
        <Card title="Ageing" className="mt-4">
          <div className="grid grid-cols-5 gap-2 text-sm">{[['Current', ageing.current], ['1-30', ageing.d1_30], ['31-60', ageing.d31_60], ['61-90', ageing.d61_90], ['90+', ageing.d90plus]].map(([l, v]) => <div key={l as string}><div className="label">{l}</div>{money(v as number)}</div>)}</div>
        </Card>
      )}
      {kind === 'customer' && has('crm') && <CustomerCrmPanel customerId={p._id} customer={p} />}
      <Card title="Account history" className="mt-4">
        <table className="min-w-full text-sm"><thead><tr><th className="th">Date</th><th className="th">Type</th><th className="th">Document</th><th className="th">Due</th><th className="th num">Amount</th><th className="th num">Balance</th></tr></thead>
          <tbody>{entries.map((e: any) => <tr key={e._id}><td className="td">{dateTime(e.at)}</td><td className="td">{e.kind.replace('_', ' ')}</td><td className="td">{e.ref?.number} {e.reference && !String(e.reference).startsWith('req:') ? e.reference : ''}</td><td className="td">{e.dueDate ? date(e.dueDate) : ''}</td><td className="td num">{money(e.amountCents)}</td><td className="td num">{money(e.balanceAfterCents)}</td></tr>)}</tbody></table>
      </Card>
      {kind === 'supplier' && p.goodsReceipts?.length > 0 && (
        <Card title="Goods received" className="mt-4">
          <DataTable rows={p.goodsReceipts} columns={[{ key: 'n', header: 'GRN', render: (g: any) => g.number }, { key: 'i', header: 'Invoice', render: (g: any) => g.supplierInvoiceNo ?? '—' }, { key: 'd', header: 'Due', render: (g: any) => date(g.dueDate) }, { key: 't', header: 'Total', className: 'num', render: (g: any) => money(g.totalCents) }, { key: 'p', header: 'Paid', className: 'num', render: (g: any) => money(g.paidCents) }]} />
        </Card>
      )}
      {editing && <PartyForm kind={kind} initial={p} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); qc.invalidateQueries({ queryKey: [path, id] }); }} />}
      <Modal open={paying} onClose={() => setPaying(false)} title={kind === 'customer' ? 'Receive payment' : 'Pay supplier'} size="sm" footer={<Button onClick={async () => {
        try {
          await api(`${path}/${id}/payments`, { body: { clientRequestId: requestId, amountCents: pay.amountCents, method: pay.method, reference: pay.reference || undefined }, idempotencyKey: requestId });
          setPaying(false); setRequestId(newRequestId()); setPay({ amountCents: null, method: 'cash', reference: '' });
          qc.invalidateQueries({ queryKey: [path, id] }); toast.success('Payment recorded');
        } catch (e) { setError(e); }
      }} disabled={!pay.amountCents}>Record payment</Button>}>
        <div className="space-y-3">
          <Field label="Amount"><MoneyInput value={pay.amountCents} onChange={(v) => setPay({ ...pay, amountCents: v })} autoFocus /></Field>
          <Field label="Method"><Select value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })} options={['cash', 'bank', 'cheque', 'card', 'other', ...(kind === 'supplier' ? ['mpesa'] : [])].map((x) => ({ value: x, label: x }))} /></Field>
          <Field label="Reference"><Input value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} /></Field>
          <p className="text-xs text-ink-500">Allocated automatically to the oldest open {kind === 'customer' ? 'invoices' : 'goods received notes'}. M-Pesa account payments from customers are recorded from the M-Pesa page.</p>
          <ErrorBox error={error} />
        </div>
      </Modal>
    </div>
  );
}

export { StatusBadge };
