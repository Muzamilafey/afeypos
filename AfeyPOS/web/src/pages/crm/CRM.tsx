import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { date, dateTime, money } from '../../lib/format';
import { DataTable } from '../../components/DataTable';
import { Badge, Button, Card, Checkbox, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Stat, StatusBadge, Tabs, useConfirm, useToast } from '../../components/ui';
import { BarChart } from '../../components/Chart';
import { Icon } from '../../components/icons';

export const SEGMENT_LABELS: Record<string, string> = { new: 'New', champion: 'Champions', loyal: 'Loyal', active: 'Active', at_risk: 'At risk', lost: 'Lost', never: 'No purchases' };
const SEGMENT_TONE: Record<string, 'green' | 'blue' | 'amber' | 'red' | 'gray'> = { new: 'blue', champion: 'green', loyal: 'green', active: 'blue', at_risk: 'amber', lost: 'red', never: 'gray' };
const ACTIVITY_TYPES = ['note', 'call', 'visit', 'sms', 'whatsapp', 'email', 'complaint', 'task'].map((x) => ({ value: x, label: x }));

export function SegmentBadge({ segment }: { segment: string }) {
  return <Badge tone={SEGMENT_TONE[segment] ?? 'gray'}>{SEGMENT_LABELS[segment] ?? segment}</Badge>;
}

export function CrmPage() {
  const [tab, setTab] = useState('overview');
  return (
    <div>
      <PageHeader title="CRM" subtitle="Know your regulars, win back the ones drifting away, and stay in touch" />
      <Tabs tabs={[{ key: 'overview', label: 'Overview' }, { key: 'followups', label: 'Follow-ups' }, { key: 'campaigns', label: 'Campaigns' }]} value={tab} onChange={setTab} />
      {tab === 'overview' && <Overview />}
      {tab === 'followups' && <FollowUps />}
      {tab === 'campaigns' && <Campaigns />}
    </div>
  );
}

function Overview() {
  const q = useQuery({ queryKey: ['crm-overview'], queryFn: () => api<{ data: any }>('/crm/overview').then((r) => r.data) });
  if (!q.data) return <Loading />;
  const d = q.data;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Customers" value={String(d.customers)} />
        <Stat label="Agreed to offers" value={String(d.optedIn)} hint="Only these receive campaigns" />
        <Stat label="At risk" value={String(d.segments.find((s: any) => s.name === 'at_risk')?.count ?? 0)} hint="No purchase in 61-120 days" tone="red" />
        <Stat label="Follow-ups due" value={String(d.followUps.length)} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Segments"><BarChart data={d.segments.map((s: any) => ({ label: SEGMENT_LABELS[s.name] ?? s.name, value: s.count }))} format={(v: number) => String(v)} /></Card>
        <Card title="Tiers (last 12 months)"><BarChart data={d.tiers.map((s: any) => ({ label: s.name, value: s.count }))} format={(v: number) => String(v)} /></Card>
        <Card title="Top customers">
          <DataTable rows={d.top} empty="No sales to named customers yet" columns={[
            { key: 'n', header: 'Customer', render: (c: any) => <Link className="underline" to={`/customers/${c._id}`}>{c.name}</Link> },
            { key: 't', header: 'Tier', render: (c: any) => c.tier }, { key: 's', header: 'Segment', render: (c: any) => <SegmentBadge segment={c.segment} /> },
            { key: 'v', header: 'Visits', className: 'num', render: (c: any) => c.visits }, { key: 'a', header: 'Spend', className: 'num', render: (c: any) => money(c.spendCents) },
          ]} />
        </Card>
        <Card title="Win back: valuable customers at risk">
          <DataTable rows={d.atRisk} empty="Nobody at risk" columns={[
            { key: 'n', header: 'Customer', render: (c: any) => <Link className="underline" to={`/customers/${c._id}`}>{c.name}</Link> },
            { key: 'p', header: 'Phone', render: (c: any) => c.phone ?? '—' }, { key: 'l', header: 'Last visit', render: (c: any) => date(c.lastAt) },
            { key: 'a', header: '12-month spend', className: 'num', render: (c: any) => money(c.spendCents) },
          ]} />
        </Card>
        <Card title="Birthdays this week">
          {d.birthdays.length ? <ul className="text-sm">{d.birthdays.map((b: any) => <li key={b._id} className="flex justify-between py-1"><Link className="underline" to={`/customers/${b._id}`}>{b.name}</Link><span className="text-ink-500">{new Date(b.dateOfBirth).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' })}</span></li>)}</ul> : <p className="text-sm text-ink-500">No birthdays this week</p>}
        </Card>
      </div>
    </div>
  );
}

function FollowUps() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['crm-followups'], queryFn: () => api<{ data: any[] }>('/crm/activities', { query: { open: true } }).then((r) => r.data) });
  return (
    <div className="card"><DataTable rows={q.data} loading={q.isLoading} empty="No open follow-ups" columns={[
      { key: 'd', header: 'Due', render: (a: any) => <span className={new Date(a.dueAt) < new Date() ? 'font-medium text-red-600' : ''}>{dateTime(a.dueAt)}</span> },
      { key: 'c', header: 'Customer', render: (a: any) => <Link className="underline" to={`/customers/${a.customerId}`}>{a.customerName}</Link> },
      { key: 's', header: 'What', render: (a: any) => <div><div>{a.subject}</div>{a.body && <div className="text-xs text-ink-500">{a.body}</div>}</div> },
      { key: 'x', header: '', render: (a: any) => <Button size="sm" variant="secondary" onClick={() => api(`/crm/activities/${a._id}`, { method: 'PATCH', body: { done: true } }).then(() => qc.invalidateQueries({ queryKey: ['crm-followups'] }))}><Icon name="check" className="h-4 w-4" />Done</Button> },
    ]} /></div>
  );
}

const SEGMENT_OPTIONS = Object.entries(SEGMENT_LABELS).map(([value, label]) => ({ value, label }));

function Campaigns() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { has } = useAuth();
  const list = useQuery({ queryKey: ['crm-campaigns'], queryFn: () => api<{ data: any[] }>('/crm/campaigns').then((r) => r.data) });
  const [f, setF] = useState<any>(null);
  const [preview, setPreview] = useState<any>(null);
  const [error, setError] = useState<unknown>(null);
  const segment = () => ({ ...(f.segments.length ? { segments: f.segments } : {}), ...(f.tags ? { tags: f.tags.split(',').map((x: string) => x.trim().toLowerCase()).filter(Boolean) } : {}), ...(f.birthdayMonth ? { birthdayMonth: Number(f.birthdayMonth) } : {}), ...(f.minSpend ? { minSpendCents: Math.round(Number(f.minSpend) * 100) } : {}) });
  const doPreview = () => api<{ data: any }>('/crm/segments/preview', { body: segment() }).then((r) => setPreview(r.data)).catch(setError);
  const save = () => api('/crm/campaigns', { body: { name: f.name, channel: f.channel, subject: f.subject || undefined, message: f.message, segment: segment() } }).then(() => { setF(null); setPreview(null); qc.invalidateQueries({ queryKey: ['crm-campaigns'] }); }).catch(setError);
  const send = async (c: any) => {
    if (!(await confirm({ title: `Send "${c.name}"?`, message: 'Messages go only to customers who agreed to receive offers. This cannot be undone.', confirmLabel: 'Send now' }))) return;
    api<{ data: any }>(`/crm/campaigns/${c._id}/send`, { body: {} }).then((r) => { toast.success(`${r.data.queued} messages queued${r.data.skipped ? `, ${r.data.skipped} skipped (no ${c.channel === 'sms' ? 'phone' : 'email'})` : ''}`); qc.invalidateQueries({ queryKey: ['crm-campaigns'] }); }).catch(toast.error);
  };
  const smsParts = f ? Math.ceil(((f.message?.length ?? 0) + 40) / 160) : 0;
  return (
    <div>
      <div className="mb-3 flex justify-end"><Button onClick={() => { setF({ name: '', channel: has('sms') ? 'sms' : 'email', message: '', segments: [], tags: '', birthdayMonth: '', minSpend: '' }); setPreview(null); setError(null); }}><Icon name="plus" className="h-4 w-4" />New campaign</Button></div>
      <div className="card"><DataTable rows={list.data} loading={list.isLoading} empty="No campaigns yet" columns={[
        { key: 'n', header: 'Campaign', render: (c: any) => <div><div className="font-medium">{c.name}</div><div className="max-w-md truncate text-xs text-ink-500">{c.message}</div></div> },
        { key: 'c', header: 'Channel', render: (c: any) => c.channel.toUpperCase() },
        { key: 's', header: 'Status', render: (c: any) => <StatusBadge status={c.status} /> },
        { key: 'r', header: 'Sent', className: 'num', render: (c: any) => (c.status === 'sent' ? `${c.queued} / ${c.recipients}` : '—') },
        { key: 'd', header: 'When', render: (c: any) => dateTime(c.sentAt ?? c.createdAt) },
        { key: 'x', header: '', render: (c: any) => c.status === 'draft' && <div className="flex gap-1"><Button size="sm" onClick={() => send(c)}>Send</Button><Button size="sm" variant="ghost" onClick={() => api(`/crm/campaigns/${c._id}/cancel`, { body: {} }).then(() => qc.invalidateQueries({ queryKey: ['crm-campaigns'] }))}>Cancel</Button></div> },
      ]} /></div>
      {f && (
        <Modal open onClose={() => setF(null)} title="New campaign" size="lg" footer={<><Button variant="secondary" onClick={doPreview}>Who receives it?</Button><Button disabled={!f.name || f.message.length < 5} onClick={save}>Save draft</Button></>}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name"><Input value={f.name} placeholder="Weekend offer" onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Send by"><Select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })} options={[{ value: 'sms', label: 'SMS' }, { value: 'email', label: 'Email' }]} /></Field>
            {f.channel === 'email' && <Field label="Email subject" className="sm:col-span-2"><Input value={f.subject ?? ''} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>}
            <Field label="Message" className="sm:col-span-2" hint={f.channel === 'sms' ? `{{name}} becomes the customer's first name · about ${smsParts} SMS per customer (business name and opt-out added)` : '{{name}} becomes the first name'}>
              <textarea className="input min-h-24" maxLength={480} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} placeholder="Hi {{name}}, ..." />
            </Field>
            <div className="sm:col-span-2"><div className="label">Segments (none = everyone who opted in)</div><div className="flex flex-wrap gap-3">{SEGMENT_OPTIONS.map((s) => <Checkbox key={s.value} label={s.label} checked={f.segments.includes(s.value)} onChange={(v) => setF({ ...f, segments: v ? [...f.segments, s.value] : f.segments.filter((x: string) => x !== s.value) })} />)}</div></div>
            <Field label="Tags" hint="Comma separated"><Input value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} /></Field>
            <Field label="Birthday month"><Select value={f.birthdayMonth} onChange={(e) => setF({ ...f, birthdayMonth: e.target.value })} placeholder="Any" options={Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: new Date(2000, i, 1).toLocaleString(undefined, { month: 'long' }) }))} /></Field>
            <Field label="Spent at least (12 months, KES)"><Input inputMode="decimal" value={f.minSpend} onChange={(e) => setF({ ...f, minSpend: e.target.value })} /></Field>
          </div>
          {preview && <p className="mt-3 rounded-lg bg-ink-50 p-3 text-sm dark:bg-ink-800" data-testid="campaign-preview"><strong>{preview.count}</strong> customers who agreed to offers ({preview.withPhone} with a phone, {preview.withEmail} with email){preview.sample.length ? `: ${preview.sample.slice(0, 6).map((s: any) => s.name).join(', ')}${preview.count > 6 ? '…' : ''}` : ''}</p>}
          <div className="mt-3"><ErrorBox error={error} /></div>
        </Modal>
      )}
    </div>
  );
}

/** Shown on the customer page: tier, segment, habits, favourite products, activities and consent. */
export function CustomerCrmPanel({ customerId, customer }: { customerId: string; customer: any }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['crm-insights', customerId], queryFn: () => api<{ data: any }>(`/crm/customers/${customerId}/insights`).then((r) => r.data) });
  const [act, setAct] = useState<any>(null);
  const [error, setError] = useState<unknown>(null);
  if (!q.data) return null;
  const d = q.data;
  const refresh = () => qc.invalidateQueries({ queryKey: ['crm-insights', customerId] });
  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-3">
      <Card title="Customer insight" className="lg:col-span-1">
        <div className="mb-2 flex flex-wrap gap-2">{d.tier && <Badge tone="blue">{d.tier}</Badge>}<SegmentBadge segment={d.segment} />{(customer.tags ?? []).map((t: string) => <Badge key={t}>{t}</Badge>)}</div>
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <div><dt className="text-ink-500">12-month spend</dt><dd className="font-medium">{money(d.spendCents)}</dd></div>
          <div><dt className="text-ink-500">Visits</dt><dd>{d.visits}</dd></div>
          <div><dt className="text-ink-500">Average basket</dt><dd>{money(d.avgBasketCents)}</dd></div>
          <div><dt className="text-ink-500">Last visit</dt><dd>{d.lastAt ? `${d.daysSinceLast} days ago` : '—'}</dd></div>
          <div><dt className="text-ink-500">Customer since</dt><dd>{date(d.firstAt)}</dd></div>
          <div><dt className="text-ink-500">Lifetime</dt><dd>{money(d.lifetimeCents)}</dd></div>
        </dl>
        {d.nextTier && <p className="mt-2 text-xs text-ink-500">{money(d.nextTier.needCents)} more in 12 months reaches {d.nextTier.name}.</p>}
        <div className="mt-3 flex items-center justify-between text-sm">
          <span>{customer.marketingOptIn ? <Badge tone="green">Agrees to offers</Badge> : <Badge>No marketing consent</Badge>}</span>
          {customer.marketingOptIn && <Button size="sm" variant="ghost" onClick={() => api(`/crm/customers/${customerId}/opt-out`, { body: {} }).then(() => { toast.success('Opted out'); qc.invalidateQueries(); }).catch(toast.error)}>Record opt-out</Button>}
        </div>
      </Card>
      <Card title="Favourite products" className="lg:col-span-1">
        {d.favourites.length ? <ul className="text-sm">{d.favourites.map((f: any) => <li key={String(f._id)} className="flex justify-between py-0.5"><span>{f.name}</span><span className="text-ink-500">{f.times}× · {money(f.spendCents)}</span></li>)}</ul> : <p className="text-sm text-ink-500">No purchases yet</p>}
      </Card>
      <Card title="Activity" className="lg:col-span-1" actions={can('crm.manage') && <Button size="sm" onClick={() => { setAct({ type: 'note', subject: '', body: '', dueAt: '' }); setError(null); }}><Icon name="plus" className="h-4 w-4" />Add</Button>}>
        {d.activities.length ? <ul className="space-y-2 text-sm">{d.activities.slice(0, 8).map((a: any) => (
          <li key={a._id} className="border-b border-ink-100 pb-2 dark:border-ink-800">
            <div className="flex justify-between"><span className="font-medium">{a.subject}</span><Badge tone={a.done ? 'gray' : 'amber'}>{a.done ? a.type : `due ${date(a.dueAt)}`}</Badge></div>
            {a.body && <div className="text-ink-600 dark:text-ink-300">{a.body}</div>}
            <div className="text-xs text-ink-500">{dateTime(a.createdAt)} · {a.createdByName}{!a.done && <button className="ml-2 underline" onClick={() => api(`/crm/activities/${a._id}`, { method: 'PATCH', body: { done: true } }).then(refresh)}>mark done</button>}</div>
          </li>
        ))}</ul> : <p className="text-sm text-ink-500">No notes yet</p>}
      </Card>
      {act && (
        <Modal open onClose={() => setAct(null)} title="Add activity" footer={<Button disabled={act.subject.length < 2} onClick={() => api('/crm/activities', { body: { customerId, type: act.type, subject: act.subject, body: act.body || undefined, dueAt: act.dueAt || undefined } }).then(() => { setAct(null); refresh(); }).catch(setError)}>Save</Button>}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Type"><Select value={act.type} onChange={(e) => setAct({ ...act, type: e.target.value })} options={ACTIVITY_TYPES} /></Field>
            <Field label="Follow up on" hint="Empty: just a note"><Input type="datetime-local" value={act.dueAt} onChange={(e) => setAct({ ...act, dueAt: e.target.value })} /></Field>
            <Field label="Subject" className="sm:col-span-2"><Input value={act.subject} onChange={(e) => setAct({ ...act, subject: e.target.value })} /></Field>
            <Field label="Details" className="sm:col-span-2"><textarea className="input min-h-20" value={act.body} onChange={(e) => setAct({ ...act, body: e.target.value })} /></Field>
          </div>
          <div className="mt-3"><ErrorBox error={error} /></div>
        </Modal>
      )}
    </div>
  );
}
