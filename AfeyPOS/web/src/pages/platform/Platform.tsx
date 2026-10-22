import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import { api, setAccessToken, tryRestoreSession } from '../../lib/api';
import { dateTime, money } from '../../lib/format';
import { DataTable } from '../../components/DataTable';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Stat, StatusBadge, cx, useToast } from '../../components/ui';

const p = <T = any,>(path: string, opts: Parameters<typeof api>[1] = {}) => api<T>(path, { ...opts, scope: 'platform' });

export function PlatformLayout() {
  const nav = useNavigate();
  const [state, setState] = useState<'loading' | 'in' | 'out'>('loading');
  useEffect(() => { tryRestoreSession('platform').then((ok) => setState(ok ? 'in' : 'out')); }, []);
  if (state === 'loading') return <Loading />;
  if (state === 'out') return <PlatformLogin onDone={() => setState('in')} />;
  const links = [['/platform', 'Overview'], ['/platform/tenants', 'Tenants'], ['/platform/plans', 'Plans'], ['/platform/support', 'Support access'], ['/platform/jobs', 'Jobs & notifications'], ['/platform/audit', 'Audit']];
  return (
    <div className="min-h-screen">
      <header className="flex items-center gap-4 border-b border-ink-200 bg-ink-900 px-4 py-3 text-white">
        <span className="font-semibold">Afey POS · Platform</span>
        <nav className="flex gap-1 overflow-x-auto text-sm">{links.map(([to, l]) => <NavLink key={to} to={to} end className={({ isActive }) => cx('rounded px-2 py-1', isActive ? 'bg-white/15' : 'text-white/70 hover:text-white')}>{l}</NavLink>)}</nav>
        <button className="ml-auto text-sm text-white/70" onClick={async () => { await p('/auth/logout', { body: {} }); setAccessToken(null, 'platform'); nav('/platform'); setState('out'); }}>Sign out</button>
      </header>
      <main className="p-4 lg:p-6"><Outlet /></main>
    </div>
  );
}

function PlatformLogin({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ email: '', password: '', code: '' });
  const [mfa, setMfa] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await p<any>('/auth/login', { body: { email: f.email, password: f.password, code: f.code || undefined } });
      if (r.mfaRequired) return setMfa(true);
      setAccessToken(r.accessToken, 'platform');
      onDone();
    } catch (err) { setError(err); }
  };
  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-900 p-4">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-3 p-6">
        <h1 className="text-lg font-semibold">Platform owner sign-in</h1>
        <Field label="Email"><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Password"><Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        {mfa && <Field label="Authenticator code"><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>}
        <ErrorBox error={error} />
        <Button type="submit" className="w-full">Sign in</Button>
      </form>
    </div>
  );
}

export function PlatformOverview() {
  const h = useQuery({ queryKey: ['p-health'], queryFn: () => p<{ data: any }>('/health').then((r) => r.data), refetchInterval: 30_000 });
  const t = useQuery({ queryKey: ['p-tenants-summary'], queryFn: () => p<{ data: any[]; total: number }>('/tenants', { query: { limit: 200 } }) });
  if (!h.data) return <Loading />;
  const byStatus = (s: string) => t.data?.data.filter((x) => x.status === s).length ?? 0;
  const jobs = Object.fromEntries(h.data.jobs.map((j: any) => [j._id, j.n]));
  return (
    <div>
      <PageHeader title="System overview" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Tenants" value={t.data?.total ?? '…'} hint={`${byStatus('active')} active · ${byStatus('trial')} trial · ${byStatus('suspended')} suspended`} />
        <Stat label="Database" value={h.data.database.ping ? 'Healthy' : 'Down'} tone={h.data.database.ping ? 'green' : 'red'} hint={`MongoDB ${h.data.database.version} · ${h.data.database.transactions ? 'transactions on' : 'NO transactions'}`} />
        <Stat label="Failed jobs" value={(jobs.failed ?? 0) + (jobs.dead ?? 0)} tone={jobs.dead ? 'red' : undefined} hint={`${jobs.queued ?? 0} queued`} />
        <Stat label="Failing integrations" value={h.data.failingIntegrations} tone={h.data.failingIntegrations ? 'red' : undefined} />
        <Stat label="Uptime" value={`${Math.round(h.data.uptimeSeconds / 3600)} h`} hint={`${h.data.memoryMb} MB · Node ${h.data.node}`} />
      </div>
      <Card title="Recent backups" className="mt-4"><DataTable rows={h.data.recentBackups} empty="No backups recorded" columns={[{ key: 'd', header: 'Started', render: (r: any) => dateTime(r.startedAt) }, { key: 's', header: 'Scope', render: (r: any) => r.scope }, { key: 'st', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> }, { key: 'n', header: 'Documents', render: (r: any) => r.documents ?? '' }]} /></Card>
    </div>
  );
}

export function PlatformTenants() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const list = useQuery({ queryKey: ['p-tenants', q, status], queryFn: () => p<{ data: any[]; total: number }>('/tenants', { query: { q: q || undefined, status: status || undefined, limit: 100 } }) });
  return (
    <div>
      <PageHeader title="Tenants" />
      <div className="card">
        <div className="flex gap-2 border-b border-ink-100 p-3 dark:border-ink-800"><Input className="max-w-xs" placeholder="Search name or subdomain" value={q} onChange={(e) => setQ(e.target.value)} /><Select className="max-w-[180px]" value={status} onChange={(e) => setStatus(e.target.value)} placeholder="All statuses" options={['trial', 'active', 'past_due', 'suspended', 'cancelled'].map((s) => ({ value: s, label: s }))} /></div>
        <DataTable rows={list.data?.data} loading={list.isLoading} error={list.error} onRowClick={(r: any) => nav(`/platform/tenants/${r._id}`)} columns={[
          { key: 'n', header: 'Business', render: (r: any) => <div><div className="font-medium">{r.name}</div><div className="text-xs text-ink-500">{r.slug}</div></div> },
          { key: 't', header: 'Type', render: (r: any) => r.businessType }, { key: 'p', header: 'Plan', render: (r: any) => r.planCode },
          { key: 's', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> }, { key: 'c', header: 'Created', render: (r: any) => dateTime(r.createdAt) },
          { key: 'tr', header: 'Trial ends', render: (r: any) => (r.trialEndsAt ? dateTime(r.trialEndsAt) : '—') },
        ]} />
      </div>
    </div>
  );
}

export function PlatformTenantDetail() {
  const { id } = useParams();
  const toast = useToast();
  const q = useQuery({ queryKey: ['p-tenant', id], queryFn: () => p<{ data: any }>(`/tenants/${id}`).then((r) => r.data) });
  const plans = useQuery({ queryKey: ['p-plans'], queryFn: () => p<{ data: any[] }>('/plans').then((r) => r.data) });
  const [reason, setReason] = useState('');
  const [domains, setDomains] = useState('');
  useEffect(() => { if (q.data) setDomains((q.data.customDomains ?? []).join(', ')); }, [q.data]);
  if (!q.data) return <Loading />;
  const t = q.data;
  const patch = (body: any) => p(`/tenants/${id}`, { method: 'PATCH', body }).then(() => { toast.success('Updated'); q.refetch(); }).catch(toast.error);
  return (
    <div className="max-w-4xl">
      <PageHeader title={t.name} subtitle={`${t.slug} · ${t.businessType}`} actions={<StatusBadge status={t.status} />} />
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Active users" value={t.usage.users} /><Stat label="Products" value={t.usage.products} /><Stat label="Sales (30 days)" value={t.usage.sales30d} /><Stat label="SMS this month" value={t.usage?.smsCount ?? t.usage.smsCount ?? 0} />
        <Stat label="Failed jobs" value={t.usage.failedJobs} tone={t.usage.failedJobs ? 'red' : undefined} /><Stat label="Failed notifications" value={t.usage.failedNotifications} />
      </div>
      <Card title="Integrations health" className="mt-4"><ul className="text-sm">{t.usage.integrations.map((i: any) => <li key={i._id}>{i.kind} · {i.provider} · {i.environment} · {i.enabled ? 'enabled' : 'disabled'} {i.lastTest && <Badge tone={i.lastTest.ok ? 'green' : 'red'}>{i.lastTest.ok ? 'ok' : 'failing'}</Badge>}</li>)}</ul></Card>
      <Card title="Subscription" className="mt-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Plan"><Select value={t.planCode} onChange={(e) => patch({ planCode: e.target.value })} options={(plans.data ?? []).map((x) => ({ value: x.code, label: `${x.name} (${money(x.priceMonthlyCents)}/mo)` }))} /></Field>
          <Field label="Paid until"><Input type="date" defaultValue={t.currentPeriodEnd?.slice(0, 10)} onBlur={(e) => e.target.value && patch({ currentPeriodEnd: e.target.value, status: 'active' })} /></Field>
          <Field label="Custom domains"><Input value={domains} onChange={(e) => setDomains(e.target.value)} onBlur={() => patch({ customDomains: domains.split(',').map((d) => d.trim()).filter(Boolean) })} /></Field>
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-2">
          {t.status !== 'suspended' ? <><Field label="Suspension reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field><Button variant="danger" disabled={!reason} onClick={() => patch({ status: 'suspended', reason })}>Suspend</Button></> : <Button onClick={() => patch({ status: 'active' })}>Reactivate</Button>}
        </div>
        {t.suspendedReason && <p className="mt-2 text-sm text-red-600">Suspended: {t.suspendedReason}</p>}
      </Card>
    </div>
  );
}

export function PlatformPlans() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['p-plans'], queryFn: () => p<{ data: any[] }>('/plans').then((r) => r.data) });
  const [edit, setEdit] = useState<any>(null);
  return (
    <div>
      <PageHeader title="Plans & entitlements" actions={<Button onClick={() => setEdit({ code: '', name: '', priceMonthlyCents: 0, trialDays: 14, limits: { branches: 1, users: 3, tills: 1, products: 2000, smsPerMonth: 100 } })}>New plan</Button>} />
      <div className="card"><DataTable rows={q.data} onRowClick={setEdit} columns={[
        { key: 'c', header: 'Code', render: (r: any) => r.code }, { key: 'n', header: 'Name', render: (r: any) => r.name }, { key: 'p', header: 'Price', render: (r: any) => money(r.priceMonthlyCents) },
        { key: 'l', header: 'Limits', render: (r: any) => `${r.limits.branches} branches · ${r.limits.users} users · ${r.limits.tills} tills · ${r.limits.smsPerMonth} SMS` },
        { key: 'm', header: 'Modules', render: (r: any) => (r.modules?.length ? `${r.modules.length} modules` : 'All') },
      ]} /></div>
      {edit && <Modal open onClose={() => setEdit(null)} title={edit._id ? `Edit ${edit.code}` : 'New plan'} footer={<Button onClick={async () => { try { const { _id, __v: _v, createdAt: _c, updatedAt: _u, code, ...rest } = edit; if (_id) await p(`/plans/${code}`, { method: 'PATCH', body: rest }); else await p('/plans', { body: edit }); setEdit(null); qc.invalidateQueries({ queryKey: ['p-plans'] }); } catch (e) { toast.error(e); } }}>Save</Button>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Code"><Input value={edit.code} disabled={Boolean(edit._id)} onChange={(e) => setEdit({ ...edit, code: e.target.value })} /></Field>
          <Field label="Name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <Field label="Monthly price (cents)"><Input type="number" value={edit.priceMonthlyCents} onChange={(e) => setEdit({ ...edit, priceMonthlyCents: Number(e.target.value) })} /></Field>
          <Field label="Trial days"><Input type="number" value={edit.trialDays} onChange={(e) => setEdit({ ...edit, trialDays: Number(e.target.value) })} /></Field>
          {Object.keys(edit.limits).map((k) => <Field key={k} label={k}><Input type="number" value={edit.limits[k]} onChange={(e) => setEdit({ ...edit, limits: { ...edit.limits, [k]: Number(e.target.value) } })} /></Field>)}
        </div>
      </Modal>}
    </div>
  );
}

export function PlatformSupport() {
  const toast = useToast();
  const q = useQuery({ queryKey: ['p-grants'], queryFn: () => p<{ data: any[] }>('/support/grants').then((r) => r.data) });
  const tenants = useQuery({ queryKey: ['p-tenants-all'], queryFn: () => p<{ data: any[] }>('/tenants', { query: { limit: 200 } }).then((r) => r.data) });
  const [f, setF] = useState({ tenantId: '', reason: '', durationMinutes: 60 });
  const start = async (g: any) => {
    try {
      const r = await p<{ data: any }>(`/support/grants/${g._id}/session`, { body: {} });
      toast.info(`Read-only session issued until ${dateTime(r.data.expiresAt)}. Use it at ${r.data.tenantUrl}.`);
      await navigator.clipboard?.writeText(r.data.accessToken).catch(() => undefined);
    } catch (e) { toast.error(e); }
  };
  return (
    <div className="max-w-4xl">
      <PageHeader title="Support access" subtitle="Time-limited, read-only, approved by the tenant owner and fully audited" />
      <Card title="Request access" className="mb-4">
        <div className="grid gap-3 sm:grid-cols-4">
          <Select value={f.tenantId} onChange={(e) => setF({ ...f, tenantId: e.target.value })} placeholder="Tenant" options={(tenants.data ?? []).map((t) => ({ value: t._id, label: t.name }))} />
          <Input className="sm:col-span-2" placeholder="Reason (shown to the tenant)" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
          <Button onClick={() => p('/support/grants', { body: f }).then(() => { q.refetch(); toast.success('Request sent to the tenant owner'); }).catch(toast.error)}>Request</Button>
        </div>
      </Card>
      <div className="card"><DataTable rows={q.data} columns={[
        { key: 't', header: 'Tenant', render: (r: any) => tenants.data?.find((t) => t._id === r.tenantId)?.name ?? r.tenantId }, { key: 'r', header: 'Reason', render: (r: any) => r.reason },
        { key: 's', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> }, { key: 'e', header: 'Expires', render: (r: any) => dateTime(r.expiresAt) },
        { key: 'a', header: '', render: (r: any) => r.status === 'approved' ? <Button size="sm" onClick={() => start(r)}>Start session</Button> : r.status === 'pending' ? <Button size="sm" variant="secondary" onClick={() => { const j = prompt('Emergency justification (audited)'); if (j) p(`/support/grants/${r._id}/emergency-approve`, { body: { justification: j } }).then(() => q.refetch()).catch(toast.error); }}>Emergency approve</Button> : null },
      ]} /></div>
    </div>
  );
}

export function PlatformJobs() {
  const toast = useToast();
  const jobs = useQuery({ queryKey: ['p-jobs'], queryFn: () => p<{ data: any[] }>('/jobs').then((r) => r.data) });
  const notes = useQuery({ queryKey: ['p-notes'], queryFn: () => p<{ data: any[] }>('/notifications', { query: { status: 'failed' } }).then((r) => r.data) });
  return (
    <div className="space-y-4">
      <PageHeader title="Jobs & notification queues" />
      <Card title="Failed background jobs"><DataTable rows={jobs.data} empty="No failed jobs" columns={[
        { key: 't', header: 'Type', render: (r: any) => r.type }, { key: 'a', header: 'Attempts', render: (r: any) => r.attempts }, { key: 'e', header: 'Error', render: (r: any) => <span className="text-xs">{r.lastError}</span> },
        { key: 'u', header: 'Updated', render: (r: any) => dateTime(r.updatedAt) }, { key: 'x', header: '', render: (r: any) => <Button size="sm" variant="secondary" onClick={() => p(`/jobs/${r._id}/retry`, { body: {} }).then(() => jobs.refetch()).catch(toast.error)}>Retry</Button> },
      ]} /></Card>
      <Card title="Failed notifications (metadata only)"><DataTable rows={notes.data} empty="No failed notifications" columns={[
        { key: 'c', header: 'Channel', render: (r: any) => r.channel }, { key: 'p', header: 'Provider', render: (r: any) => r.provider ?? '—' }, { key: 'e', header: 'Error', render: (r: any) => <span className="text-xs">{r.error}</span> }, { key: 'd', header: 'When', render: (r: any) => dateTime(r.createdAt) },
      ]} /></Card>
    </div>
  );
}

export function PlatformAudit() {
  const q = useQuery({ queryKey: ['p-audit'], queryFn: () => p<{ data: any[] }>('/audit', { query: { limit: 200 } }).then((r) => r.data) });
  return (
    <div>
      <PageHeader title="Platform audit trail" />
      <div className="card"><DataTable rows={q.data} columns={[{ key: 't', header: 'Time', render: (r: any) => dateTime(r.at) }, { key: 'a', header: 'Action', render: (r: any) => <code className="text-xs">{r.action}</code> }, { key: 'u', header: 'Actor', render: (r: any) => r.actor?.name ?? r.actor?.kind }, { key: 'd', header: 'Details', render: (r: any) => <span className="text-xs">{JSON.stringify(r.details)}</span> }]} /></div>
    </div>
  );
}
