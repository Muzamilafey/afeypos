import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateTime } from '../../lib/format';
import { DataTable } from '../../components/DataTable';
import { Badge, Button, Card, ErrorBox, Loading, Modal, PageHeader, useToast } from '../../components/ui';

interface HqStatus {
  role: 'hq';
  keyFingerprint: string;
  branches: { id: string; code: string; name: string; hasServer: boolean; online: boolean; sync: { lastSeenAt?: string; lastPushAt?: string; lastPullAt?: string; pendingUp?: number; lastError?: string } }[];
  conflicts: Conflict[];
}
interface BranchStatus {
  role: 'branch';
  branchCode: string;
  hqUrl: string;
  enabled: boolean;
  running: boolean;
  online: boolean;
  lastSuccessAt?: string;
  last?: { startedAt: string; finishedAt?: string; ok: boolean; error?: string; pushed: Record<string, number>; pulled: Record<string, number> };
  conflicts: Conflict[];
  check?: { branchFound: boolean; branchName?: string; warehouses: number; tills: number; totals: { branches: number; warehouses: number; tills: number }; storesWithoutBranch: string[] };
}
interface Conflict { _id: string; collectionName: string; docId: string; reason: string; branchCode?: string; at: string }

const ago = (d?: string) => (d ? dateTime(d) : 'never');

export function SyncPage() {
  const { me } = useAuth();
  const q = useQuery({ queryKey: ['sync-status'], queryFn: () => api<{ data: HqStatus | BranchStatus | { role: 'standalone' } }>('/settings/sync/status').then((r) => r.data), refetchInterval: 10_000 });
  if (!q.data) return <Loading />;
  const d = q.data;
  return (
    <div className="max-w-5xl">
      <PageHeader title="Branch sync" subtitle={d.role === 'hq' ? 'Head office: branches with their own servers sync here' : d.role === 'branch' ? `This is the server of branch ${d.branchCode}` : 'This installation runs a single shop'} />
      {d.role === 'hq' && <HqSync data={d} onChange={() => q.refetch()} />}
      {d.role === 'branch' && <BranchSync data={d} onChange={() => q.refetch()} />}
      {d.role === 'standalone' && (
        <Card>
          <p className="text-sm text-ink-600 dark:text-ink-300">
            {me!.tenant.name} runs as a single-shop installation: every till connects to this server. To run several branches that keep selling when the internet is down,
            host this system online as head office (<code>DEPLOYMENT_MODE=hq</code>) and give each branch its own server (<code>DEPLOYMENT_MODE=branch</code>). See docs/SYNC.md.
          </p>
        </Card>
      )}
    </div>
  );
}

function Conflicts({ rows, onChange }: { rows: Conflict[]; onChange: () => void }) {
  const toast = useToast();
  if (!rows.length) return null;
  return (
    <Card title="Records that need attention" className="mt-4">
      <p className="mb-2 text-sm text-ink-500">These records could not be applied (for example a duplicate code). Fix the cause, then mark them resolved.</p>
      <DataTable rows={rows} columns={[
        { key: 'a', header: 'When', render: (r: Conflict) => dateTime(r.at) },
        { key: 'b', header: 'Branch', render: (r: Conflict) => r.branchCode ?? '' },
        { key: 'c', header: 'Records', render: (r: Conflict) => r.collectionName },
        { key: 'd', header: 'Reason', render: (r: Conflict) => <span className="text-xs">{r.reason}</span> },
        { key: 'e', header: '', render: (r: Conflict) => <Button size="sm" variant="secondary" onClick={() => api(`/settings/sync/conflicts/${r._id}/resolve`, { body: {} }).then(onChange).catch(toast.error)}>Resolved</Button> },
      ]} />
    </Card>
  );
}

function HqSync({ data, onChange }: { data: HqStatus; onChange: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [issued, setIssued] = useState<{ branch: string; env: Record<string, string>; keyFingerprint: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const issue = async (id: string, code: string) => {
    setError(null);
    try {
      const r = await api<{ data: { env: Record<string, string>; keyFingerprint: string } }>(`/settings/branches/${id}/sync-token`, { body: {} });
      setIssued({ branch: code, env: r.data.env, keyFingerprint: r.data.keyFingerprint });
      onChange();
      qc.invalidateQueries({ queryKey: ['locations'] });
    } catch (e) {
      setError(e);
    }
  };
  const revoke = async (id: string) => {
    if (!window.confirm('Stop this branch server from syncing? Its stock will be managed from head office again.')) return;
    await api(`/settings/branches/${id}/sync-token`, { method: 'DELETE' }).then(onChange).catch(toast.error);
  };
  return (
    <>
      <Card>
        <DataTable rows={data.branches} columns={[
          { key: 'n', header: 'Branch', render: (b) => <div><div className="font-medium">{b.name}</div><div className="text-xs text-ink-500">{b.code}</div></div> },
          { key: 's', header: 'Runs on', render: (b) => (b.hasServer ? <Badge tone="blue">own server</Badge> : <span className="text-sm text-ink-500">head office</span>) },
          { key: 'o', header: 'Status', render: (b) => (!b.hasServer ? '—' : b.online ? <Badge tone="green">online</Badge> : <Badge tone="amber">offline</Badge>) },
          { key: 'l', header: 'Last sync', render: (b) => (b.hasServer ? <span className="text-xs">{ago(b.sync.lastPushAt ?? b.sync.lastSeenAt)}</span> : '') },
          { key: 'p', header: 'Waiting to send', className: 'num', render: (b) => (b.hasServer ? (b.sync.pendingUp ?? '—') : '') },
          { key: 'e', header: '', render: (b) => (b.sync.lastError ? <span className="text-xs text-red-600">{b.sync.lastError}</span> : null) },
          { key: 'a', header: '', render: (b) => (
            <div className="flex gap-1">
              <Button size="sm" variant="secondary" onClick={() => issue(b.id, b.code)}>{b.hasServer ? 'New token' : 'Give it its own server'}</Button>
              {b.hasServer && <Button size="sm" variant="ghost" onClick={() => revoke(b.id)}>Stop</Button>}
            </div>
          ) },
        ]} />
        <p className="mt-3 text-xs text-ink-500">A branch with its own server keeps its own database and keeps selling without internet; it syncs sales, stock and customers here and receives products, prices, staff and settings. Stock in its stores can then only change on the branch server.</p>
        <div className="mt-2"><ErrorBox error={error} /></div>
      </Card>
      <Conflicts rows={data.conflicts} onChange={onChange} />
      {issued && (
        <Modal open onClose={() => setIssued(null)} title={`Branch server for ${issued.branch}`} size="lg" footer={<Button onClick={() => setIssued(null)}>Done</Button>}>
          <p className="mb-2 text-sm">Put these lines in the branch server's <code>server/.env</code>. The token is shown only once.</p>
          <pre className="overflow-x-auto rounded-lg bg-ink-900 p-3 text-xs text-ink-100">{Object.entries(issued.env).map(([k, v]) => `${k}=${v}`).join('\n')}</pre>
          <p className="mt-3 text-sm">Also copy <strong>ENCRYPTION_KEY</strong> from this head-office server's <code>.env</code> (fingerprint <code>{issued.keyFingerprint}</code>), then start the branch server on an empty database. It downloads the business, staff and products by itself.</p>
          <Button className="mt-3" variant="secondary" onClick={() => navigator.clipboard?.writeText(Object.entries(issued.env).map(([k, v]) => `${k}=${v}`).join('\n')).then(() => toast.success('Copied'), () => toast.error('Copy failed'))}>Copy</Button>
        </Modal>
      )}
    </>
  );
}

function BranchSync({ data, onChange }: { data: BranchStatus; onChange: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const r = await api<{ data: BranchStatus['last'] }>('/settings/sync/run', { body: {} });
      if (r.data?.ok) toast.success('Synced with head office');
      else toast.error(r.data?.error ?? 'Sync failed');
      onChange();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const last = data.last;
  const total = (m?: Record<string, number>) => Object.values(m ?? {}).reduce((a, b) => a + b, 0);
  return (
    <>
      <Card actions={<Button loading={busy || data.running} onClick={run}>Sync now</Button>}>
        <div className="grid gap-4 sm:grid-cols-3">
          <div><div className="label">Head office</div><div className="break-all text-sm">{data.hqUrl || 'not configured'}</div></div>
          <div><div className="label">Connection</div>{data.online ? <Badge tone="green">online</Badge> : <Badge tone="amber">offline: selling continues</Badge>}</div>
          <div><div className="label">Last successful sync</div><div className="text-sm">{ago(data.lastSuccessAt)}</div></div>
        </div>
        {last && (
          <div className="mt-4 text-sm">
            Last run {dateTime(last.startedAt)}: {last.ok ? `sent ${total(last.pushed)} and received ${total(last.pulled)} records` : <span className="text-red-600">{last.error}</span>}
          </div>
        )}
        {!data.enabled && <p className="mt-3 text-sm text-amber-700">Automatic sync is off (SYNC_ENABLED=false in server/.env).</p>}
      </Card>
      {data.check && <BranchCheck code={data.branchCode} check={data.check} onChange={onChange} />}
      <Conflicts rows={data.conflicts} onChange={onChange} />
    </>
  );
}

/** Whether this server has what it needs to sell: its own branch, that branch's stores and tills. */
function BranchCheck({ code, check, onChange }: { code: string; check: NonNullable<BranchStatus['check']>; onChange: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const ok = check.branchFound && check.warehouses > 0 && check.tills > 0 && !check.storesWithoutBranch.length;
  const again = async () => {
    setBusy(true);
    try {
      await api('/settings/sync/resync', { body: { scope: 'down' } });
      const r = await api<{ data: BranchStatus['last'] }>('/settings/sync/run', { body: {} });
      if (r.data?.ok) toast.success('Downloaded everything again from head office');
      else toast.error(r.data?.error ?? 'Sync failed');
      onChange();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const row = (good: boolean, text: string) => <li className="flex items-start gap-2"><Badge tone={good ? 'green' : 'red'}>{good ? 'OK' : 'Missing'}</Badge><span>{text}</span></li>;
  return (
    <Card title="This server's branch" className="mt-4" actions={<Button variant="secondary" loading={busy} onClick={again}>Download everything again</Button>}>
      <ul className="space-y-2 text-sm" data-testid="branch-check">
        {row(check.branchFound, check.branchFound ? `Branch ${code}: ${check.branchName}` : `Branch ${code} has not arrived from head office (BRANCH_CODE must match the branch code at head office exactly)`)}
        {row(check.warehouses > 0, `${check.warehouses} store${check.warehouses === 1 ? '' : 's'} of branch ${code}`)}
        {row(check.tills > 0, `${check.tills} till${check.tills === 1 ? '' : 's'} of branch ${code}`)}
        {check.storesWithoutBranch.length > 0 && row(false, `Stores whose branch is missing here: ${check.storesWithoutBranch.join(', ')}`)}
      </ul>
      <p className="mt-3 text-xs text-ink-500">
        On this server: {check.totals.branches} branches, {check.totals.warehouses} stores, {check.totals.tills} tills.
        {ok ? ' Everything needed to sell is here.' : ' If something is missing, press Download everything again (safe: nothing is lost), then check "Records that need attention" below.'}
      </p>
    </Card>
  );
}
