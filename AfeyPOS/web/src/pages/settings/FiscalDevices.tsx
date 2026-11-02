import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateTime, money } from '../../lib/format';
import { DataTable } from '../../components/DataTable';
import { Badge, Button, Card, ErrorBox, Field, Input, Modal, PageHeader, Select, Stat, Tabs, useToast } from '../../components/ui';
import { Icon } from '../../components/icons';

type Tab = 'devices' | 'transactions' | 'reports' | 'find';

const FISCAL_LABEL: Record<string, string> = {
  pending: 'Pending', processing: 'Processing', signed: 'Fiscalized', rejected: 'Rejected', failed: 'Failed', awaiting_confirmation: 'Awaiting confirmation',
  device_disconnected: 'Device disconnected', requires_reconciliation: 'Requires reconciliation',
};
const FISCAL_TONE: Record<string, 'green' | 'amber' | 'red' | 'gray' | 'blue'> = {
  signed: 'green', pending: 'amber', processing: 'blue', awaiting_confirmation: 'amber', device_disconnected: 'amber', rejected: 'red', failed: 'red', requires_reconciliation: 'red',
};
/** Device colours: green working, yellow invoices waiting, red offline or invoices need a person, grey off / not known. */
const COLOUR: Record<string, { dot: string; label: string }> = {
  green: { dot: 'bg-emerald-500', label: 'Working' }, yellow: { dot: 'bg-amber-400', label: 'Invoices waiting' }, red: { dot: 'bg-red-500', label: 'Needs attention' }, grey: { dot: 'bg-ink-300', label: 'Off / not known' },
};
const CAP_LABEL: Record<string, string> = {
  submitInvoice: 'Sales invoices', submitCreditNote: 'Credit notes', submitDebitNote: 'Debit notes', cancelTransaction: 'Cancel', transactionStatus: 'Status query', lastFiscalReceipt: 'Last receipt',
  initialize: 'Initialise', itemRegistration: 'Item registration', safeResend: 'Safe resend', localOnly: 'On this computer only',
};

export function FiscalStatusBadge({ status }: { status?: string }) {
  if (!status) return <Badge>Not fiscal</Badge>;
  return <Badge tone={FISCAL_TONE[status] ?? 'gray'}>{FISCAL_LABEL[status] ?? status}</Badge>;
}

/** Settings → Tax & Fiscalization → Fiscal devices. */
export function FiscalDevicesPage() {
  const [tab, setTab] = useState<Tab>('devices');
  const { can } = useAuth();
  return (
    <div className="max-w-6xl">
      <PageHeader title="Tax & fiscal devices" subtitle="KRA eTIMS (OSCU / VSCU) and TIMS ETR devices: their health, every fiscal transaction, reconciliation and fiscal reports"
        actions={can('integrations.manage') ? <Link to="/settings/integrations"><Button variant="secondary"><Icon name="plus" className="h-4 w-4" />Add or edit a device</Button></Link> : undefined} />
      <Tabs value={tab} onChange={(k) => setTab(k as Tab)} tabs={[{ key: 'devices', label: 'Devices' }, { key: 'transactions', label: 'Fiscal transactions' }, { key: 'reports', label: 'Reports' }, ...(can('integrations.manage') ? [{ key: 'find', label: 'Find a device' }] : [])]} />
      {tab === 'devices' && <DevicesTab />}
      {tab === 'transactions' && <TransactionsTab />}
      {tab === 'reports' && <ReportsTab />}
      {tab === 'find' && <FindTab />}
    </div>
  );
}

function DevicesTab() {
  const toast = useToast();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['fiscal-devices'], queryFn: () => api<{ data: any[] }>('/fiscal/devices').then((r) => r.data), refetchInterval: 15_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const test = async (id: string) => {
    setBusy(id);
    try {
      const r = await api<{ data: { state: string; message: string; problems: string[] } }>(`/fiscal/devices/${id}/test`, { body: {} });
      if (r.data.state === 'offline') toast.error(r.data.message);
      else toast.success(r.data.message);
      q.refetch();
    } catch (e) { toast.error(e); } finally { setBusy(null); }
  };
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return null;
  if (!q.data.length) return <Card><p className="text-sm">No fiscal device is set up yet. Add one under <Link className="underline" to="/settings/integrations">Settings → Integrations → KRA eTIMS</Link>.</p></Card>;
  return (
    <div className="grid gap-4 md:grid-cols-2" data-testid="fiscal-devices">
      {q.data.map((d) => (
        <Card key={d.id} title={<span className="flex items-center gap-2"><span className={`inline-block h-3 w-3 rounded-full ${COLOUR[d.colour]?.dot}`} aria-label={COLOUR[d.colour]?.label} />{d.name}</span>}
          actions={can('integrations.manage') && <Button size="sm" variant="secondary" loading={busy === d.id} onClick={() => test(d.id)}>Test connection</Button>}>
          <div className="space-y-2 text-sm">
            <div className="flex flex-wrap gap-2">
              <Badge tone="blue">{d.kindLabel}</Badge>
              <Badge tone={d.environment === 'production' ? 'green' : 'amber'}>{d.environment}</Badge>
              {!d.enabled && <Badge>Turned off</Badge>}
              <span className="text-xs text-ink-500">{COLOUR[d.colour]?.label}</span>
            </div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              <dt className="text-ink-500">Serial / SCU</dt><dd>{d.info.serial ?? '—'}{d.info.sdcId ? ` · ${d.info.sdcId}` : ''}</dd>
              <dt className="text-ink-500">Reached at</dt><dd className="break-all font-mono">{d.info.endpoint ?? '—'}</dd>
              <dt className="text-ink-500">State</dt><dd>{d.health ? `${d.health.state} · ${d.health.message ?? ''}` : 'Not checked yet'}</dd>
              <dt className="text-ink-500">Last success</dt><dd>{d.health?.lastSuccessAt ? dateTime(d.health.lastSuccessAt) : '—'}</dd>
              <dt className="text-ink-500">Last problem</dt><dd className="text-red-600">{d.health?.lastError ?? '—'}</dd>
              <dt className="text-ink-500">Waiting / need attention</dt><dd>{d.queue.waiting} / <span className={d.queue.attention ? 'font-semibold text-red-600' : ''}>{d.queue.attention}</span> · fiscalized {d.queue.signed ?? 0}</dd>
            </dl>
            <div className="flex flex-wrap gap-1">
              {Object.entries(d.capabilities).filter(([k]) => k !== 'deviceInfo').map(([k, v]) => <Badge key={k} tone={v ? 'green' : 'gray'}>{v ? '✓' : '✗'} {CAP_LABEL[k] ?? k}</Badge>)}
            </div>
            {d.warnings.length > 0 && <ul className="list-disc pl-5 text-xs text-amber-700">{d.warnings.map((w: string) => <li key={w}>{w}</li>)}</ul>}
          </div>
        </Card>
      ))}
    </div>
  );
}

function TransactionsTab() {
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<{ kind: string; id: string } | null>(null);
  const params = new URLSearchParams({ ...(status ? { status } : {}), ...(search ? { q: search } : {}) });
  const q = useQuery({ queryKey: ['fiscal-tx', status, search], queryFn: () => api<{ data: any[] }>(`/fiscal/transactions?${params}`).then((r) => r.data), refetchInterval: 15_000 });
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <Field label="Status"><Select aria-label="Fiscal status" value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: '', label: 'All' }, { value: 'open', label: 'On the way' }, { value: 'attention', label: 'Needs attention' }, ...Object.entries(FISCAL_LABEL).map(([value, label]) => ({ value, label }))]} /></Field>
        <Field label="Search"><Input aria-label="Search fiscal transactions" placeholder="Receipt, invoice no., CU invoice" value={search} onChange={(e) => setSearch(e.target.value)} /></Field>
      </div>
      <Card bodyClassName="p-0">
        <DataTable rows={q.data?.map((r) => ({ ...r, _id: r.id }))} loading={q.isLoading} error={q.error} empty="No fiscal transactions" onRowClick={(r) => setOpen({ kind: r.kind, id: r.id })} columns={[
          { key: 'n', header: 'Document', render: (r) => `${r.kind === 'sale' ? 'Sale' : 'Credit note'} ${r.number}` },
          { key: 'd', header: 'Time', render: (r) => dateTime(r.at) },
          { key: 'v', header: 'Device', render: (r) => r.deviceName },
          { key: 'i', header: 'Invoice no.', className: 'num', render: (r) => r.etims.invcNo },
          { key: 'a', header: 'Amount', className: 'num', render: (r) => money(r.amountCents ?? 0) },
          { key: 's', header: 'Status', render: (r) => <FiscalStatusBadge status={r.etims.status} /> },
          { key: 'c', header: 'Fiscal number', render: (r) => <span className="font-mono text-xs">{r.etims.cuInvoiceNo ?? r.etims.rcptSign ?? ''}</span> },
          { key: 'e', header: 'Last error', render: (r) => <span className="text-xs text-red-600">{r.etims.error ?? ''}</span> },
        ]} />
      </Card>
      {open && <TransactionModal kind={open.kind} id={open.id} onClose={() => { setOpen(null); q.refetch(); }} />}
    </div>
  );
}

function TransactionModal({ kind, id, onClose }: { kind: string; id: string; onClose: () => void }) {
  const toast = useToast();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['fiscal-tx-one', kind, id], queryFn: () => api<{ data: any }>(`/fiscal/transactions/${kind}/${id}`).then((r) => r.data) });
  const [action, setAction] = useState<'' | 'resend' | 'record' | 'mark_failed'>('');
  const [f, setF] = useState<Record<string, string>>({});
  const d = q.data;
  const etr = d?.device?.kind?.startsWith('etr');
  const send = async (body: Record<string, unknown>) => {
    try {
      const r = await api<{ data: { status: string } }>(`/fiscal/transactions/${kind}/${id}/reconcile`, { body });
      toast.success(`Now: ${FISCAL_LABEL[r.data.status] ?? r.data.status}`);
      setAction('');
      q.refetch();
    } catch (e) { toast.error(e); }
  };
  const canAct = can('integrations.manage') && d && d.etims.status !== 'signed';
  return (
    <Modal open onClose={onClose} size="xl" title={d ? `${kind === 'sale' ? 'Sale' : 'Credit note'} ${d.number}` : 'Fiscal transaction'} subtitle={d ? `${d.device?.name ?? 'Removed device'} · invoice no. ${d.etims.invcNo}` : undefined}>
      {d && (
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <FiscalStatusBadge status={d.etims.status} />
            {d.etims.via && <Badge tone="blue">{d.etims.via === 'manual' ? 'Recorded by a person' : d.etims.via === 'status_query' ? 'Found by status query' : 'Answered by the device'}</Badge>}
            <span>{money(d.amountCents ?? 0)} · {dateTime(d.at)} · {d.etims.attempts ?? 0} attempts</span>
          </div>
          {d.etims.error && <p className="rounded bg-red-50 p-2 text-xs text-red-700 dark:bg-red-500/10">{d.etims.error}</p>}
          {d.etims.status === 'signed' && (
            <dl className="grid grid-cols-2 gap-x-3 text-xs">
              {etr ? <><dt className="text-ink-500">CU invoice no.</dt><dd className="font-mono">{d.etims.cuInvoiceNo}</dd><dt className="text-ink-500">CU serial</dt><dd className="font-mono">{d.etims.cuSerial}</dd></>
                : <><dt className="text-ink-500">Receipt signature</dt><dd className="font-mono">{d.etims.rcptSign}</dd><dt className="text-ink-500">SCU / receipt</dt><dd className="font-mono">{d.etims.sdcId} / {d.etims.rcptNo}</dd></>}
              {d.etims.reconcileNote && <><dt className="text-ink-500">Note</dt><dd>{d.etims.reconcileNote}</dd></>}
            </dl>
          )}
          {canAct && (
            <div className="rounded-lg border border-ink-100 p-3 dark:border-ink-800">
              <div className="mb-2 font-semibold">Reconcile</div>
              <div className="flex flex-wrap gap-2">
                {d.device?.capabilities?.transactionStatus && <Button size="sm" variant="secondary" onClick={() => send({ action: 'check' })}>Ask the device again</Button>}
                <Button size="sm" variant="secondary" onClick={() => setAction('resend')}>Not on the device: send again</Button>
                <Button size="sm" variant="secondary" onClick={() => setAction('record')}>Found on the device / KRA: record it</Button>
                <Button size="sm" variant="secondary" onClick={() => setAction('mark_failed')}>Mark as not fiscalized</Button>
              </div>
              {action && (
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {action === 'record' && (etr
                    ? <><Field label="CU invoice no. (from the device)"><Input value={f.cuInvoiceNo ?? ''} onChange={(e) => setF({ ...f, cuInvoiceNo: e.target.value })} /></Field><Field label="CU serial"><Input value={f.cuSerial ?? ''} onChange={(e) => setF({ ...f, cuSerial: e.target.value })} /></Field><Field label="QR / verification link printed by the device (optional)"><Input value={f.qrUrl ?? ''} onChange={(e) => setF({ ...f, qrUrl: e.target.value })} /></Field></>
                    : <><Field label="Receipt signature (from KRA eTIMS)"><Input value={f.rcptSign ?? ''} onChange={(e) => setF({ ...f, rcptSign: e.target.value })} /></Field><Field label="Receipt no."><Input value={f.rcptNo ?? ''} onChange={(e) => setF({ ...f, rcptNo: e.target.value })} /></Field><Field label="Internal data"><Input value={f.intrlData ?? ''} onChange={(e) => setF({ ...f, intrlData: e.target.value })} /></Field></>)}
                  <Field label="What you checked (kept in the audit trail)" className="sm:col-span-2"><Input value={f.note ?? ''} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder={action === 'resend' ? 'e.g. Device journal has no invoice with this number' : ''} /></Field>
                  <div className="sm:col-span-2"><Button size="sm" onClick={() => send({ action, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '')), ...(f.rcptNo ? { rcptNo: Number(f.rcptNo) } : {}) })}>Confirm</Button></div>
                </div>
              )}
              <p className="mt-2 text-xs text-ink-500">Only record numbers shown by the device or KRA. Afey POS never makes up a fiscal number, signature or QR code.</p>
            </div>
          )}
          <div>
            <div className="mb-1 font-semibold">History</div>
            <div className="space-y-2" data-testid="fiscal-history">
              {d.log.map((l: any) => (
                <details key={l._id} className="rounded border border-ink-100 p-2 dark:border-ink-800">
                  <summary className="cursor-pointer text-xs"><b>{l.operation.replace('_', ' ')}</b> · {dateTime(l.at)} · {FISCAL_LABEL[l.outcome] ?? l.outcome ?? ''} {l.durationMs != null ? `· ${l.durationMs} ms` : ''} {l.error ? <span className="text-red-600">· {l.error}</span> : null}</summary>
                  {l.note && <p className="mt-1 text-xs">Note: {l.note}</p>}
                  {l.request && <pre className="mt-1 max-h-48 overflow-auto rounded bg-ink-50 p-2 text-[11px] dark:bg-ink-900">{JSON.stringify(l.request, null, 2)}</pre>}
                  {l.response && <pre className="mt-1 max-h-48 overflow-auto rounded bg-ink-50 p-2 text-[11px] dark:bg-ink-900">{JSON.stringify(l.response, null, 2)}</pre>}
                </details>
              ))}
              {!d.log.length && <p className="text-xs text-ink-500">No attempts logged yet (invoices from before the fiscal log was added have none).</p>}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

function ReportsTab() {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(new Date(Date.now() - 6 * 86400_000).toISOString().slice(0, 10));
  const [to, setTo] = useState(today);
  const q = useQuery({ queryKey: ['fiscal-report', from, to], queryFn: () => api<{ data: any }>(`/fiscal/reports?from=${from}&to=${to}`).then((r) => r.data) });
  const r = q.data;
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      <ErrorBox error={q.error} />
      {r && (
        <div className="space-y-4" data-testid="fiscal-report">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Fiscalized sales" value={money(r.sales.fiscalized.cents)} hint={`${r.sales.fiscalized.n} receipts`} />
            <Stat label="Net fiscalized (less credit notes)" value={money(r.netFiscalizedCents)} />
            <Stat label="On the way" value={String(r.sales.open.n + r.creditNotes.open.n)} hint="Pending, processing, awaiting confirmation, device disconnected" />
            <Stat label="Need attention" value={String(r.sales.attention.n + r.creditNotes.attention.n)} tone={r.sales.attention.n + r.creditNotes.attention.n ? 'red' : undefined} hint="Rejected, failed, requires reconciliation" />
          </div>
          {r.sales.withoutFiscal.n > 0 && <p className="text-sm text-amber-700">{r.sales.withoutFiscal.n} sales ({money(r.sales.withoutFiscal.cents)}) in this period were made without a fiscal device assigned.</p>}
          {r.duplicateInvoiceNumbers.length > 0 && <p className="text-sm font-semibold text-red-600">{r.duplicateInvoiceNumbers.length} invoice numbers were used twice for one device: check that each server has its own device.</p>}
          <Card title="VAT on fiscalized sales">
            <DataTable rows={r.vat.map((v: any) => ({ ...v, _id: v.taxType }))} empty="No fiscalized sales" columns={[
              { key: 't', header: 'KRA tax type', render: (v: any) => v.taxType },
              { key: 'r', header: 'Rate', className: 'num', render: (v: any) => `${v.rate}%` },
              { key: 'x', header: 'Taxable', className: 'num', render: (v: any) => money(v.taxableCents) },
              { key: 'v', header: 'VAT', className: 'num', render: (v: any) => money(v.taxCents) },
            ]} />
          </Card>
          <Card title="Devices">
            <DataTable rows={r.devices.map((d: any) => ({ ...d, _id: d.id }))} columns={[
              { key: 'n', header: 'Device', render: (d: any) => d.name },
              { key: 'a', header: 'Attempts', className: 'num', render: (d: any) => d.attempts },
              { key: 's', header: 'Success rate', className: 'num', render: (d: any) => (d.successRate == null ? '—' : `${d.successRate}%`) },
              { key: 'm', header: 'Avg. time', className: 'num', render: (d: any) => (d.avgMs == null ? '—' : `${d.avgMs} ms`) },
              { key: 'd', header: 'Downtime', className: 'num', render: (d: any) => `${d.downtimeMinutes} min` },
            ]} />
          </Card>
          <Card title="Sales vs fiscalized, by day">
            <DataTable rows={r.daily.map((d: any) => ({ ...d, _id: d.date }))} empty="No sales" columns={[
              { key: 'd', header: 'Day', render: (d: any) => d.date },
              { key: 's', header: 'Sales', className: 'num', render: (d: any) => money(d.salesCents) },
              { key: 'f', header: 'Fiscalized', className: 'num', render: (d: any) => money(d.fiscalizedCents) },
              { key: 'g', header: 'Not fiscalized', className: 'num', render: (d: any) => <span className={d.gapCents ? 'text-red-600' : ''}>{money(d.gapCents)}</span> },
              { key: 'r', header: 'Receipts', className: 'num', render: (d: any) => `${d.fiscalizedReceipts} / ${d.receipts}` },
            ]} />
          </Card>
        </div>
      )}
    </div>
  );
}

/** Looks on this computer for fiscal programs, their addresses and folders, and USB / COM devices (listed only). */
function FindTab() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [found, setFound] = useState<{ candidates: any[] } | null>(null);
  const look = async () => {
    setBusy(true);
    setError(null);
    try { setFound((await api<{ data: { candidates: any[] } }>('/etims/etr/detect')).data); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Card title="Find a fiscal device on this computer" actions={<Button size="sm" loading={busy} onClick={look}><Icon name="search" className="h-4 w-4" />{found ? 'Look again' : 'Look'}</Button>}>
      <p className="text-sm text-ink-600 dark:text-ink-300">Works on the shop computer (Windows or Linux) that runs Afey POS. It lists fiscal programs, the local addresses they answer on, their inbox / outbox folders, and USB / COM devices. Nothing is sent to any device: USB and serial devices are only listed. Use what you find under <Link className="underline" to="/settings/integrations">Integrations → KRA eTIMS → ETR device</Link>, then press Test.</p>
      <ErrorBox error={error} />
      {found && (
        <ul className="mt-3 space-y-1 text-sm" data-testid="fiscal-found">
          {found.candidates.map((c, i) => (
            <li key={i} className="rounded border border-ink-100 p-2 dark:border-ink-800">
              <Badge tone={c.kind === 'http' || c.kind === 'folder' ? 'green' : 'gray'}>{c.kind}</Badge> <b>{c.name}</b>{' '}
              <span className="font-mono text-xs">{c.url ?? (c.inbox ? `${c.inbox} → ${c.outbox}` : c.detail ?? '')}</span>
              {c.kind === 'http' && <span className="ml-1 text-xs">{c.answers ? '(answers)' : '(no answer)'}</span>}
            </li>
          ))}
          {!found.candidates.length && <li className="text-amber-700">Nothing found. Start the device's program, then look again.</li>}
        </ul>
      )}
    </Card>
  );
}
