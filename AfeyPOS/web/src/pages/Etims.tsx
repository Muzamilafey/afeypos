import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, money } from '../lib/format';
import { DataTable } from '../components/DataTable';
import { Badge, Button, Card, Loading, PageHeader, Stat, useToast } from '../components/ui';

interface Status {
  configs: { id: string; name: string; provider: string; environment: string; tin?: string; bhfId?: string; sdcId?: string; mrcNo?: string; initializedAt?: string; enabled: boolean }[];
  sales: Record<string, number>;
  returns: Record<string, number>;
  failed: { kind: 'sale' | 'return'; _id: string; number: string; totalCents?: number; refundCents?: number; completedAt?: string; createdAt?: string; etims: { invcNo: number; error?: string; attempts: number } }[];
  pending: { _id: string; number: string; totalCents: number; completedAt: string; etims: { invcNo: number; error?: string; attempts: number } }[];
  unregisteredProducts: number;
}

export function EtimsPage() {
  const toast = useToast();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['etims-status'], queryFn: () => api<{ data: Status }>('/etims/status').then((r) => r.data), refetchInterval: 15_000 });
  if (!q.data) return <Loading />;
  const d = q.data;
  const retry = (kind: string, id: string) => api('/etims/retry', { body: { kind, id } }).then(() => { toast.success('Queued for signing'); q.refetch(); }).catch(toast.error);
  return (
    <div className="max-w-5xl">
      <PageHeader title="KRA eTIMS" subtitle="Sales and credit notes signed by KRA (OSCU) or your VSCU" actions={can('integrations.manage') && d.unregisteredProducts > 0 ? <Button variant="secondary" onClick={() => api<{ data: { queued: number } }>('/etims/items/register-all', { body: {} }).then((r) => toast.success(`${r.data.queued} products queued for registration`)).catch(toast.error)}>Register all products ({d.unregisteredProducts})</Button> : undefined} />
      {!d.configs.length && (
        <Card className="mb-4"><p className="text-sm">No eTIMS device is set up yet. Add one under <Link className="underline" to="/settings/integrations">Settings → Integrations → Add KRA eTIMS</Link>, then press <strong>Initialise device</strong>.</p></Card>
      )}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Sales signed" value={String(d.sales.signed ?? 0)} />
        <Stat label="Waiting to sign" value={String((d.sales.pending ?? 0) + (d.returns.pending ?? 0))} hint="Retried automatically while KRA is unreachable" tone={(d.sales.pending ?? 0) > 0 ? 'red' : undefined} />
        <Stat label="Credit notes signed" value={String(d.returns.signed ?? 0)} />
        <Stat label="Rejected by KRA" value={String(d.failed.length)} tone={d.failed.length ? 'red' : undefined} hint="Fix the cause, then retry" />
      </div>
      <Card title="Devices" className="mb-4">
        <DataTable rows={d.configs} empty="No devices" columns={[
          { key: 'n', header: 'Name', render: (c) => c.name },
          { key: 'm', header: 'Type', render: (c) => (c.provider === 'vscu' ? 'VSCU' : c.provider === 'oscu' ? 'OSCU' : 'Simulator') },
          { key: 'e', header: 'Mode', render: (c) => <Badge tone={c.environment === 'production' ? 'green' : 'amber'}>{c.environment}</Badge> },
          { key: 't', header: 'KRA PIN / branch', render: (c) => `${c.tin ?? ''} / ${c.bhfId ?? ''}` },
          { key: 's', header: 'SCU / MRC', render: (c) => (c.sdcId ? `${c.sdcId} / ${c.mrcNo ?? ''}` : <Badge tone="amber">not initialised</Badge>) },
        ]} />
      </Card>
      {d.failed.length > 0 && (
        <Card title="Rejected by KRA" className="mb-4">
          <DataTable rows={d.failed} columns={[
            { key: 'n', header: 'Document', render: (r) => `${r.kind === 'sale' ? 'Sale' : 'Credit note'} ${r.number}` },
            { key: 'i', header: 'Invoice no.', render: (r) => r.etims.invcNo },
            { key: 'a', header: 'Amount', className: 'num', render: (r) => money(r.totalCents ?? r.refundCents ?? 0) },
            { key: 'e', header: 'Reason', render: (r) => <span className="text-xs text-red-600">{r.etims.error}</span> },
            { key: 'x', header: '', render: (r) => <Button size="sm" variant="secondary" onClick={() => retry(r.kind, r._id)}>Retry</Button> },
          ]} />
        </Card>
      )}
      <Card title="Waiting to be signed">
        <DataTable rows={d.pending} empty="Nothing waiting: every sale is signed" columns={[
          { key: 'n', header: 'Sale', render: (r) => r.number },
          { key: 'd', header: 'Time', render: (r) => dateTime(r.completedAt) },
          { key: 'i', header: 'Invoice no.', render: (r) => r.etims.invcNo },
          { key: 'a', header: 'Amount', className: 'num', render: (r) => money(r.totalCents) },
          { key: 't', header: 'Attempts', className: 'num', render: (r) => r.etims.attempts },
          { key: 'e', header: 'Last error', render: (r) => <span className="text-xs text-ink-500">{r.etims.error ?? ''}</span> },
        ]} />
      </Card>
    </div>
  );
}
