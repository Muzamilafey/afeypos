import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  TERMINAL_CONNECTION_LABELS, terminalProviderLabel, terminalStatusMessage, terminalTxnOpen,
  type TerminalConnection, type TerminalProviderInfo,
} from '@afeypos/shared';
import { api, newRequestId } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useLocations } from '../../lib/hooks';
import { dateTime, money } from '../../lib/format';
import { DataTable } from '../../components/DataTable';
import { Badge, Button, Card, Checkbox, EmptyState, ErrorBox, Field, Input, Loading, Modal, MoneyInput, PageHeader, Select, Tabs, useToast } from '../../components/ui';

type Provider = Omit<TerminalProviderInfo, 'availability'> & { availability: TerminalProviderInfo['availability'] | 'disabled_here' };
type Check = { at?: string; ok?: boolean; message?: string } | undefined;
export interface Terminal {
  id: string; name: string; provider: string; mode: 'sandbox' | 'live'; branchId: string; tillIds: string[]; connection: TerminalConnection;
  device: { model?: string; serialNumber?: string; firmware?: string; os?: string }; integrationVersion?: string; status: string;
  checks: { installed?: Check; registered?: Check; paired?: Check; connectivity?: Check; tills?: Check; test?: Check };
  health: { online?: boolean; ready?: boolean; lastCheckAt?: string; lastSuccessAt?: string; lastError?: { code: string; message: string; at: string } };
  openTransactions?: number; approvedNotLinked?: number;
}
export interface TerminalTxn {
  id: string; terminalId: string; provider: string; tillId?: string; kind: 'sale' | 'refund' | 'test'; reference: string; amountCents: number; currency: string;
  status: string; open: boolean; sandbox: boolean; verified: boolean; authCode?: string; cardScheme?: string; last4?: string; message?: string; removeCard?: boolean;
  connectionLost?: boolean; saleId?: string; saleNumber?: string; refundedCents: number; resolution?: string; createdAt: string;
  events: { status: string; at: string; source: string; message?: string }[];
}

const AVAILABILITY: Record<Provider['availability'], { label: string; tone: 'green' | 'amber' | 'gray' | 'blue' }> = {
  available: { label: 'Available', tone: 'green' },
  sandbox: { label: 'Test only (no real money)', tone: 'blue' },
  provider_access_required: { label: 'Provider access required', tone: 'amber' },
  not_supported: { label: 'Not yet supported', tone: 'gray' },
  disabled_here: { label: 'Turned off here', tone: 'gray' },
};
const usable = (p: Provider) => p.availability === 'available' || p.availability === 'sandbox';
const STATUS_TONE: Record<string, 'green' | 'amber' | 'red' | 'gray' | 'blue'> = { enabled: 'green', ready: 'blue', paired: 'blue', registered: 'amber', draft: 'amber', disabled: 'gray' };
const txnTone = (s: string): 'green' | 'amber' | 'red' | 'gray' => (s === 'approved' ? 'green' : s === 'unknown' || terminalTxnOpen(s) ? 'amber' : s === 'declined' || s === 'failed' ? 'red' : 'gray');

/** Settings → Payments → Bank card terminals: onboarding, the terminals dashboard and their payments. */
export function CardTerminalsPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState(can('terminals.manage') ? 'terminals' : 'payments');
  const [wizard, setWizard] = useState<{ terminal?: Terminal } | null>(null);
  const terminals = useQuery({ queryKey: ['card-terminals'], queryFn: () => api<{ data: Terminal[] }>('/payment-terminals').then((r) => r.data), refetchInterval: 15_000 });
  const providers = useQuery({ queryKey: ['card-terminal-providers'], queryFn: () => api<{ data: Provider[] }>('/payment-terminals/providers').then((r) => r.data) });
  return (
    <div className="max-w-6xl">
      <PageHeader title="Bank card terminals" subtitle="Card machines connected to Afey POS: the terminal reads the card and the PIN; Afey POS sends the amount and records only verified approvals."
        actions={can('terminals.manage') && <Button onClick={() => setWizard({})}>Add a terminal</Button>} />
      <Tabs tabs={[...(can('terminals.manage') ? [{ key: 'terminals', label: 'Terminals' }] : []), { key: 'payments', label: 'Card payments' }, { key: 'providers', label: 'Supported providers' }]} value={tab} onChange={setTab} />
      {tab === 'terminals' && (terminals.data ? <TerminalList terminals={terminals.data} providers={providers.data ?? []} onSetup={(t) => setWizard({ terminal: t })} /> : <Loading />)}
      {tab === 'payments' && <PaymentsTab terminals={terminals.data ?? []} />}
      {tab === 'providers' && <ProvidersTab providers={providers.data ?? []} />}
      {wizard && providers.data && <SetupWizard providers={providers.data} initial={wizard.terminal} onClose={() => { setWizard(null); terminals.refetch(); }} />}
    </div>
  );
}

// ---------------- dashboard ----------------

function TerminalList({ terminals, providers, onSetup }: { terminals: Terminal[]; providers: Provider[]; onSetup: (t: Terminal) => void }) {
  const locs = useLocations();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState('');
  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success(ok);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy('');
      qc.invalidateQueries({ queryKey: ['card-terminals'] });
    }
  };
  if (!terminals.length) return <EmptyState title="No card terminals yet" icon="card">Press <b>Add a terminal</b> to connect a supported terminal. Banks that have not published an integration are listed under <b>Supported providers</b>.</EmptyState>;
  const branchName = (id: string) => locs.data?.branches.find((b) => b._id === id)?.name ?? '';
  const tillNames = (ids: string[]) => ids.map((id) => locs.data?.tills.find((t) => t._id === id)?.name).filter(Boolean).join(', ') || 'none';
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {terminals.map((t) => {
        const info = providers.find((p) => p.key === t.provider);
        const h = t.health ?? {};
        return (
          <Card key={t.id} title={<span className="flex flex-wrap items-center gap-2">{t.name}<Badge tone={STATUS_TONE[t.status] ?? 'gray'}>{t.status}</Badge>{t.mode === 'sandbox' && <Badge tone="blue">test only</Badge>}</span>}
            actions={t.status !== 'enabled' && <Button size="sm" onClick={() => onSetup(t)}>{t.status === 'disabled' ? 'Set up again' : 'Continue setup'}</Button>}>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm" data-testid={`terminal-${t.name}`}>
              <dt className="text-ink-500">Provider</dt><dd>{terminalProviderLabel(t.provider)}{info?.bank ? ` · ${info.bank}` : ''}</dd>
              <dt className="text-ink-500">Terminal</dt><dd>{t.device?.model ?? '—'}{t.device?.serialNumber ? ` · ${t.device.serialNumber}` : ''}</dd>
              <dt className="text-ink-500">Branch and tills</dt><dd>{branchName(t.branchId)} · {tillNames(t.tillIds)}</dd>
              <dt className="text-ink-500">Connection</dt><dd>{TERMINAL_CONNECTION_LABELS[t.connection]} · {h.online === undefined ? 'not checked' : h.online ? (h.ready ? <Badge tone="green">connected, ready</Badge> : <Badge tone="amber">connected, not ready</Badge>) : <Badge tone="red">not connected</Badge>}</dd>
              <dt className="text-ink-500">Last successful connection</dt><dd>{h.lastSuccessAt ? dateTime(h.lastSuccessAt) : 'never'}</dd>
              <dt className="text-ink-500">Integration version</dt><dd>{t.integrationVersion ?? '—'}{t.device?.firmware ? ` · firmware ${t.device.firmware}` : ''}</dd>
              <dt className="text-ink-500">Needs attention</dt>
              <dd>{(t.openTransactions ?? 0) + (t.approvedNotLinked ?? 0) === 0 ? 'nothing' : <span className="text-amber-700">{t.openTransactions ? `${t.openTransactions} unfinished` : ''}{t.openTransactions && t.approvedNotLinked ? ' · ' : ''}{t.approvedNotLinked ? `${t.approvedNotLinked} approved, not on a sale` : ''}</span>}</dd>
              {h.lastError && <><dt className="text-ink-500">Last error</dt><dd className="text-red-700">{h.lastError.message} <span className="text-xs text-ink-500">({dateTime(h.lastError.at)})</span></dd></>}
            </dl>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" loading={busy === `check:${t.id}`} disabled={!t.checks?.paired?.ok} onClick={() => act(`check:${t.id}`, () => api(`/payment-terminals/${t.id}/check`, { body: {} }), 'Connection checked')}>Reconnect / check</Button>
              {t.status === 'enabled' && <Button size="sm" variant="secondary" loading={busy === `off:${t.id}`} onClick={() => act(`off:${t.id}`, () => api(`/payment-terminals/${t.id}/disable`, { body: {} }), 'Terminal disabled')}>Disable</Button>}
              <Button size="sm" variant="ghost" loading={busy === `rm:${t.id}`} onClick={() => { if (window.confirm(`Remove ${t.name}? Its pairing is deleted; payment records are kept.`)) act(`rm:${t.id}`, () => api(`/payment-terminals/${t.id}`, { method: 'DELETE' }), 'Terminal removed'); }}>Remove</Button>
            </div>
            {t.provider === 'simulator' && <SimulatorPanel terminal={t} />}
          </Card>
        );
      })}
    </div>
  );
}

/** Test-only controls: what a real terminal can do to the integration (switched off, unplugged, busy...). */
function SimulatorPanel({ terminal }: { terminal: Terminal }) {
  const toast = useToast();
  const set = (flags: Record<string, boolean>, msg: string) => api(`/payment-terminals/${terminal.id}/simulator`, { body: flags }).then(() => toast.info(msg)).catch(toast.error);
  return (
    <div className="mt-4 rounded-md border border-dashed border-sky-300 bg-sky-50/60 p-3 text-xs dark:border-sky-800 dark:bg-sky-950/30">
      <div className="mb-2 font-semibold text-sky-800 dark:text-sky-300">Simulated terminal (training): make it misbehave</div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={() => set({ poweredOff: true }, 'Simulated terminal switched off')}>Switch off</Button>
        <Button size="sm" variant="secondary" onClick={() => set({ disconnected: true }, 'Simulated terminal disconnected')}>Disconnect</Button>
        <Button size="sm" variant="secondary" onClick={() => set({ busy: true }, 'Simulated terminal busy')}>Make busy</Button>
        <Button size="sm" variant="secondary" onClick={() => set({ credentialsExpired: true }, 'Simulated pairing expired')}>Expire pairing</Button>
        <Button size="sm" onClick={() => set({ poweredOff: false, disconnected: false, busy: false, credentialsExpired: false }, 'Simulated terminal back to normal')}>Back to normal</Button>
      </div>
    </div>
  );
}

function ProvidersTab({ providers }: { providers: Provider[] }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-600 dark:text-ink-300">A provider is offered for real payments only after its integration has been built from the provider’s own documentation and certified on real hardware. None is guessed.</p>
      {providers.map((p) => (
        <Card key={p.key} title={<span className="flex items-center gap-2">{p.label}<Badge tone={AVAILABILITY[p.availability].tone}>{AVAILABILITY[p.availability].label}</Badge></span>}>
          <p className="text-sm">{p.description}</p>
          {p.models.length > 0 && <p className="mt-2 text-sm"><b>Terminals:</b> {p.models.map((m) => `${m.name} (${m.os})`).join(', ')}</p>}
          <p className="mt-1 text-sm"><b>Connections:</b> {p.connections.length ? p.connections.map((c) => TERMINAL_CONNECTION_LABELS[c]).join(', ') : 'none until the provider’s specification is available'}</p>
          {p.accessSteps && !usable(p) && (
            <details className="mt-2 text-sm"><summary className="cursor-pointer font-semibold text-brand-700">What is needed to support it</summary>
              <ol className="mt-2 list-decimal space-y-1 pl-5">{p.accessSteps.map((s) => <li key={s}>{s}</li>)}</ol>
            </details>
          )}
        </Card>
      ))}
    </div>
  );
}

// ---------------- onboarding wizard ----------------

const STEPS = ['Provider', 'Terminal & connection', 'Install', 'Find the terminal', 'Pair', 'Connection test', 'Tills', 'Test payment', 'Result'] as const;

function stepFor(t?: Terminal): number {
  if (!t) return 0;
  const c = t.checks ?? {};
  if (!c.installed?.ok) return 2;
  if (!c.registered?.ok) return 3;
  if (!c.paired?.ok) return 4;
  if (!c.connectivity?.ok) return 5;
  if (!c.tills?.ok) return 6;
  if (!c.test?.ok) return 7;
  return 8;
}

function SetupWizard({ providers, initial, onClose }: { providers: Provider[]; initial?: Terminal; onClose: () => void }) {
  const toast = useToast();
  const locs = useLocations();
  const [terminal, setTerminal] = useState<Terminal | undefined>(initial);
  const [step, setStep] = useState(stepFor(initial));
  const [provider, setProvider] = useState<Provider | undefined>(providers.find((p) => p.key === initial?.provider));
  const [form, setForm] = useState({ name: '', branchId: '', connection: '' as TerminalConnection | '' });
  const [devices, setDevices] = useState<{ deviceId: string; model?: string; serialNumber?: string; address?: string }[] | null>(null);
  const [screen, setScreen] = useState<{ hint?: string; simulated?: string } | null>(null);
  const [code, setCode] = useState('');
  const [tillIds, setTillIds] = useState<string[]>(initial?.tillIds ?? []);
  const [testTxn, setTestTxn] = useState<TerminalTxn | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const branchTills = useMemo(() => (locs.data?.tills ?? []).filter((t) => t.active && t.branchId === (terminal?.branchId ?? form.branchId)), [locs.data, terminal, form.branchId]);

  useEffect(() => {
    if (!form.branchId && locs.data?.branches[0]) setForm((f) => ({ ...f, branchId: locs.data!.branches[0]._id }));
  }, [locs.data, form.branchId]);

  const run = async <T,>(fn: () => Promise<T>, after?: (r: T) => void) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      after?.(r);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const refresh = (t: Terminal) => { setTerminal(t); setStep(stepFor(t)); };

  // The test payment: follow it until the terminal gives its final, verified answer.
  useEffect(() => {
    if (!testTxn || !testTxn.open) return;
    const timer = setInterval(async () => {
      try {
        const x = (await api<{ data: TerminalTxn }>(`/payment-terminals/transactions/${testTxn.id}`, { query: { refresh: '1' } })).data;
        setTestTxn(x);
        if (!x.open && terminal) refresh((await api<{ data: Terminal }>(`/payment-terminals/${terminal.id}`)).data);
      } catch { /* keep trying */ }
    }, 1500);
    return () => clearInterval(timer);
  }, [testTxn, terminal]);

  const c = terminal?.checks ?? {};
  const checklist: [string, Check][] = [['Terminal application or driver installed', c.installed], ['Terminal registered', c.registered], ['Paired and authorised', c.paired], ['Connected and ready', c.connectivity], ['Tills chosen', c.tills], ['Test payment approved and verified', c.test]];
  const allOk = checklist.every(([, k]) => k?.ok);

  return (
    <Modal open onClose={onClose} title={terminal ? `Set up ${terminal.name}` : 'Add a bank card terminal'} subtitle={`Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`} size="lg"
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      <ol className="mb-5 flex flex-wrap gap-1 text-[11px]" aria-label="Setup steps">
        {STEPS.map((s, i) => <li key={s} className={`rounded-full px-2 py-0.5 ${i === step ? 'bg-brand-600 text-white' : i < step ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300' : 'bg-ink-100 text-ink-500 dark:bg-ink-800'}`}>{i + 1}. {s}</li>)}
      </ol>

      {step === 0 && (
        <div className="space-y-2" role="radiogroup" aria-label="Provider">
          <p className="mb-2 text-sm text-ink-600 dark:text-ink-300">Choose the bank or terminal provider. Only providers whose integration is built and tested can be set up; the others show what is needed first.</p>
          {providers.map((p) => (
            <button key={p.key} type="button" role="radio" aria-checked={provider?.key === p.key} disabled={!usable(p)} onClick={() => { setProvider(p); setForm((f) => ({ ...f, connection: p.connections[0] ?? '' })); }}
              className={`w-full rounded-lg border p-3 text-left text-sm ${provider?.key === p.key ? 'border-brand-500 ring-2 ring-brand-200' : 'border-ink-200 dark:border-ink-700'} ${usable(p) ? 'hover:border-brand-400' : 'cursor-not-allowed opacity-70'}`}>
              <div className="flex items-center justify-between gap-2"><b>{p.label}</b><Badge tone={AVAILABILITY[p.availability].tone}>{AVAILABILITY[p.availability].label}</Badge></div>
              <div className="mt-1 text-ink-600 dark:text-ink-300">{p.description}</div>
            </button>
          ))}
          <div className="flex justify-end pt-2"><Button disabled={!provider || !usable(provider)} onClick={() => setStep(1)}>Next</Button></div>
        </div>
      )}

      {step === 1 && provider && (
        <div className="space-y-4">
          <div className="rounded-lg bg-ink-50 p-3 text-sm dark:bg-ink-800/50">
            <div className="label">Compatible terminals</div>
            <ul className="list-disc pl-5">{provider.models.map((m) => <li key={m.name}><b>{m.name}</b> · {m.os} · {m.connections.map((x) => TERMINAL_CONNECTION_LABELS[x]).join(', ')}{m.notes ? <div className="text-xs text-ink-500">{m.notes}</div> : null}</li>)}</ul>
          </div>
          <Field label="How the terminal connects">
            <div className="grid gap-2 sm:grid-cols-2">
              {(['lan', 'usb', 'serial', 'cloud'] as TerminalConnection[]).map((cn) => {
                const ok = provider.connections.includes(cn);
                return (
                  <label key={cn} className={`flex items-center gap-2 rounded-md border p-2 text-sm ${ok ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'} ${form.connection === cn ? 'border-brand-500' : 'border-ink-200 dark:border-ink-700'}`}>
                    <input type="radio" name="connection" disabled={!ok} checked={form.connection === cn} onChange={() => setForm({ ...form, connection: cn })} />
                    <span>{TERMINAL_CONNECTION_LABELS[cn]}{!ok && <span className="block text-xs text-ink-500">Not supported by this integration</span>}</span>
                  </label>
                );
              })}
            </div>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name"><Input value={form.name} placeholder="e.g. Till 1 card terminal" onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="Branch"><Select value={form.branchId} onChange={(e) => setForm({ ...form, branchId: e.target.value })} options={(locs.data?.branches ?? []).map((b) => ({ value: b._id, label: b.name }))} /></Field>
          </div>
          <ErrorBox error={error} />
          <div className="flex justify-between"><Button variant="secondary" onClick={() => setStep(0)}>Back</Button>
            <Button loading={busy} disabled={!form.name.trim() || !form.connection || !form.branchId} onClick={() => run(() => api<{ data: Terminal }>('/payment-terminals', { body: { name: form.name.trim(), provider: provider.key, connection: form.connection, branchId: form.branchId } }), (r) => refresh(r.data))}>Create and continue</Button></div>
        </div>
      )}

      {step === 2 && terminal && (
        <div className="space-y-3 text-sm">
          <p>Install what the provider requires on this computer or terminal, using only the provider’s official software:</p>
          <ol className="list-decimal space-y-1 pl-5">{(provider?.installSteps ?? []).map((s) => <li key={s}>{s}</li>)}</ol>
          <ErrorBox error={error} />
          <div className="flex justify-end"><Button loading={busy} onClick={() => run(() => api<{ data: Terminal }>(`/payment-terminals/${terminal.id}/installed`, { body: {} }), (r) => refresh(r.data))}>It is installed</Button></div>
        </div>
      )}

      {step === 3 && terminal && (
        <div className="space-y-3 text-sm">
          <p>Switch the terminal on. Afey POS looks for it with the provider’s own discovery; a device is trusted only after pairing, never just because it is on the network.</p>
          <Button variant="secondary" loading={busy && !devices} onClick={() => run(() => api<{ data: any[]; supported: boolean }>(`/payment-terminals/${terminal.id}/discover`), (r) => setDevices(r.data))}>Find terminals</Button>
          {devices && !devices.length && <p className="text-amber-700">No terminal found. Check it is switched on and connected, then try again.</p>}
          {devices?.map((d) => (
            <div key={d.deviceId} className="flex items-center justify-between rounded-md border border-ink-200 p-2 dark:border-ink-700">
              <span><b>{d.model ?? 'Terminal'}</b> · {d.serialNumber ?? d.deviceId}{d.address ? ` · ${d.address}` : ''}</span>
              <Button size="sm" loading={busy} onClick={() => run(() => api<{ data: Terminal; pairingHint?: string; simulatedScreen?: string }>(`/payment-terminals/${terminal.id}/register`, { body: { deviceId: d.deviceId } }), (r) => { setScreen({ hint: r.pairingHint, simulated: r.simulatedScreen }); refresh(r.data); })}>Use this terminal</Button>
            </div>
          ))}
          <ErrorBox error={error} />
        </div>
      )}

      {step === 4 && terminal && (
        <div className="space-y-3 text-sm">
          <p>{screen?.hint ?? 'Enter the pairing code shown on the terminal.'}</p>
          {screen?.simulated && (
            <div className="mx-auto w-48 rounded-xl bg-ink-900 p-4 text-center font-mono text-white shadow-inner" aria-label="Simulated terminal screen">
              <div className="text-[10px] uppercase tracking-wide text-ink-400">Simulated terminal</div>
              <div className="mt-1 whitespace-pre-line text-lg">{screen.simulated}</div>
            </div>
          )}
          {!screen && <Button size="sm" variant="ghost" onClick={() => setStep(3)}>Show the pairing code again (register again)</Button>}
          <Field label="Pairing code"><Input autoFocus value={code} inputMode="numeric" onChange={(e) => setCode(e.target.value)} /></Field>
          <ErrorBox error={error} />
          <div className="flex justify-end"><Button loading={busy} disabled={!code.trim()} onClick={() => run(() => api<{ data: Terminal }>(`/payment-terminals/${terminal.id}/pair`, { body: { pairingCode: code.trim() } }), (r) => { setCode(''); refresh(r.data); })}>Pair</Button></div>
        </div>
      )}

      {step === 5 && terminal && (
        <div className="space-y-3 text-sm">
          <p>Afey POS now checks that the paired terminal answers, proves its identity and is ready for a payment.</p>
          {c.connectivity && !c.connectivity.ok && <p className="text-red-700">{c.connectivity.message}</p>}
          <ErrorBox error={error} />
          <div className="flex justify-end"><Button loading={busy} onClick={() => run(() => api<{ data: Terminal }>(`/payment-terminals/${terminal.id}/check`, { body: {} }), (r) => refresh(r.data))}>Test the connection</Button></div>
        </div>
      )}

      {step === 6 && terminal && (
        <div className="space-y-3 text-sm">
          <p>Which tills may send payments to this terminal?</p>
          {branchTills.map((t) => <Checkbox key={t._id} label={`${t.name} (${t.code})`} checked={tillIds.includes(t._id)} onChange={(v) => setTillIds(v ? [...tillIds, t._id] : tillIds.filter((x) => x !== t._id))} />)}
          {!branchTills.length && <p className="text-amber-700">This branch has no tills yet (Settings → Branches & tills).</p>}
          <ErrorBox error={error} />
          <div className="flex justify-end"><Button loading={busy} disabled={!tillIds.length} onClick={() => run(() => api<{ data: Terminal }>(`/payment-terminals/${terminal.id}/tills`, { method: 'PUT', body: { tillIds } }), (r) => refresh(r.data))}>Save tills</Button></div>
        </div>
      )}

      {step === 7 && terminal && (
        <div className="space-y-3 text-sm">
          <p>A {terminal.mode === 'sandbox' ? 'test (sandbox) ' : ''}payment of {money(100)} checks the whole path: Afey POS sends it, the terminal processes it, and Afey POS confirms the result with the terminal. It never pays a sale.</p>
          {testTxn && <TxnStatus txn={testTxn} />}
          <ErrorBox error={error} />
          <div className="flex justify-end"><Button loading={busy || Boolean(testTxn?.open)} onClick={() => run(() => api<{ data: TerminalTxn }>(`/payment-terminals/${terminal.id}/test`, { body: { clientRequestId: newRequestId() } }), (r) => setTestTxn(r.data))}>{testTxn && !testTxn.open ? 'Run the test again' : 'Run the test payment'}</Button></div>
        </div>
      )}

      {step === 8 && terminal && (
        <div className="space-y-3 text-sm">
          <ul className="space-y-1.5" data-testid="setup-result">
            {checklist.map(([label, k]) => <li key={label} className="flex items-start gap-2"><Badge tone={k?.ok ? 'green' : 'red'}>{k?.ok ? 'Passed' : 'Not done'}</Badge><span>{label}{k?.message ? <span className="block text-xs text-ink-500">{k.message}</span> : null}</span></li>)}
          </ul>
          {terminal.mode === 'sandbox' && <p className="rounded-md bg-sky-50 p-2 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300">This terminal is test-only: payments made with it are marked <b>SIMULATED – NOT A REAL PAYMENT</b> on the sale and receipt.</p>}
          <ErrorBox error={error} />
          <div className="flex justify-end gap-2">
            {terminal.status === 'enabled' ? <Badge tone="green">Enabled for payments</Badge> : (
              <Button disabled={!allOk} loading={busy} onClick={() => run(() => api<{ data: Terminal }>(`/payment-terminals/${terminal.id}/enable`, { body: {} }), (r) => { refresh(r.data); toast.success(`${r.data.name} is ready at the till`); })}>Enable for payments</Button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

/** What the terminal says, in the words the cashier sees at checkout. */
export function TxnStatus({ txn }: { txn: TerminalTxn }) {
  const m = terminalStatusMessage(txn);
  const cls = { info: 'bg-ink-50 text-ink-800', wait: 'bg-sky-50 text-sky-900', ok: 'bg-emerald-50 text-emerald-900', bad: 'bg-red-50 text-red-800', warn: 'bg-amber-50 text-amber-900' }[m.tone];
  return (
    <div className={`rounded-lg p-3 text-sm ${cls} dark:bg-ink-800/60 dark:text-ink-100`} role="status" aria-live="polite" data-testid="terminal-status">
      <div className="flex items-center justify-between gap-2"><b>{m.title}</b>{txn.sandbox && <Badge tone="blue">SIMULATED</Badge>}</div>
      <div className="mt-1 text-xs">{money(txn.amountCents)} · ref {txn.reference}{txn.cardScheme ? ` · ${txn.cardScheme}` : ''}{txn.last4 ? ` ****${txn.last4}` : ''}{txn.authCode ? ` · AUTH ${txn.authCode}` : ''}</div>
      {txn.message && m.tone !== 'ok' && <div className="mt-1 text-xs">{txn.message}</div>}
    </div>
  );
}

// ---------------- payments & reconciliation ----------------

function PaymentsTab({ terminals }: { terminals: Terminal[] }) {
  const { can } = useAuth();
  const toast = useToast();
  const [attention, setAttention] = useState(false);
  const [refund, setRefund] = useState<TerminalTxn | null>(null);
  const list = useQuery({ queryKey: ['card-terminal-txns', attention], queryFn: () => api<{ data: TerminalTxn[] }>('/payment-terminals-transactions', { query: { needsAttention: attention ? 'true' : undefined, limit: 100 } }).then((r) => r.data), refetchInterval: 10_000 });
  const name = (id: string) => terminals.find((t) => t.id === id)?.name ?? '';
  const recheck = (x: TerminalTxn) => api(`/payment-terminals/transactions/${x.id}/reconcile`, { body: {} }).then(() => { toast.success('Checked with the terminal'); list.refetch(); }).catch(toast.error);
  const notCharged = (x: TerminalTxn) => {
    const note = window.prompt('Only if the terminal’s own report shows this payment was NOT charged. What did you check?');
    if (!note || note.trim().length < 5) return;
    api(`/payment-terminals/transactions/${x.id}/resolve`, { body: { outcome: 'not_charged', note: note.trim() } }).then(() => { toast.success('Marked not charged'); list.refetch(); }).catch(toast.error);
  };
  return (
    <div>
      <div className="mb-3 flex items-center gap-4"><Checkbox label="Only what needs attention (unfinished, unknown, approved but not on a sale)" checked={attention} onChange={setAttention} /></div>
      <div className="card">
        <DataTable rows={list.data} loading={list.isLoading} error={list.error} empty="No card terminal payments" columns={[
          { key: 't', header: 'Time', render: (x: TerminalTxn) => dateTime(x.createdAt) },
          { key: 'n', header: 'Terminal', render: (x: TerminalTxn) => name(x.terminalId) },
          { key: 'k', header: 'Type', render: (x: TerminalTxn) => ({ sale: 'Payment', refund: 'Refund', test: 'Setup test' })[x.kind] },
          { key: 'a', header: 'Amount', className: 'num', render: (x: TerminalTxn) => money(x.amountCents) },
          { key: 's', header: 'Status', render: (x: TerminalTxn) => <span className="flex flex-wrap gap-1"><Badge tone={txnTone(x.status)}>{x.status}</Badge>{x.verified && <Badge tone="green">verified</Badge>}{x.sandbox && <Badge tone="blue">simulated</Badge>}</span> },
          { key: 'c', header: 'Card', render: (x: TerminalTxn) => [x.cardScheme, x.last4 ? `****${x.last4}` : '', x.authCode ? `AUTH ${x.authCode}` : ''].filter(Boolean).join(' ') },
          { key: 'sale', header: 'Sale', render: (x: TerminalTxn) => x.saleNumber ?? (x.kind === 'sale' && x.status === 'approved' ? <Badge tone="amber">not on a sale</Badge> : '') },
          { key: 'r', header: 'Refunded', className: 'num', render: (x: TerminalTxn) => (x.refundedCents ? money(x.refundedCents) : '') },
          { key: 'x', header: '', render: (x: TerminalTxn) => (
            <span className="flex flex-wrap gap-1">
              {(x.open || x.resolution === 'not_charged') && can('terminals.reconcile') && <Button size="sm" variant="secondary" onClick={() => recheck(x)}>Check again</Button>}
              {x.status === 'unknown' && can('terminals.reconcile') && <Button size="sm" variant="ghost" onClick={() => notCharged(x)}>Not charged…</Button>}
              {x.kind === 'sale' && x.status === 'approved' && x.verified && x.refundedCents < x.amountCents && can('terminals.refund') && <Button size="sm" variant="ghost" onClick={() => setRefund(x)}>Refund…</Button>}
            </span>
          ) },
        ]} />
      </div>
      {refund && <RefundModal txn={refund} onClose={() => { setRefund(null); list.refetch(); }} />}
    </div>
  );
}

function RefundModal({ txn, onClose }: { txn: TerminalTxn; onClose: () => void }) {
  const left = txn.amountCents - txn.refundedCents;
  const [amount, setAmount] = useState<number | null>(left);
  const [reason, setReason] = useState('');
  const [requestId] = useState(newRequestId);
  const [result, setResult] = useState<TerminalTxn | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!result?.open) return;
    const t = setInterval(() => api<{ data: TerminalTxn }>(`/payment-terminals/transactions/${result.id}`, { query: { refresh: '1' } }).then((r) => setResult(r.data)).catch(() => undefined), 1500);
    return () => clearInterval(t);
  }, [result]);
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult((await api<{ data: TerminalTxn }>(`/payment-terminals/transactions/${txn.id}/refund`, { body: { amountCents: amount, reason: reason.trim(), clientRequestId: requestId } })).data);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={`Refund card payment ${txn.reference}`} size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Close</Button>{!result && <Button loading={busy} disabled={!amount || amount > left || reason.trim().length < 3} onClick={send}>Send refund to terminal</Button>}</>}>
      <div className="space-y-3">
        <p className="text-sm">Paid {money(txn.amountCents)}{txn.saleNumber ? ` on ${txn.saleNumber}` : ''}; {money(left)} can still be refunded. The customer presents the same card on the terminal.</p>
        <Field label="Amount"><MoneyInput value={amount} onChange={setAmount} disabled={Boolean(result)} /></Field>
        <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} disabled={Boolean(result)} /></Field>
        {result && <TxnStatus txn={result} />}
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}
