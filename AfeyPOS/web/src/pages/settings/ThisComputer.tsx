import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useLocations } from '../../lib/hooks';
import { bridge, bridgeConfigured, bridgeStatus, type BridgeStatus } from '../../lib/bridge';
import { PRINT_MODES, printMode, type PrintMode } from '../../lib/printing';
import { getWorkstation, setWorkstation } from '../../lib/workstation';
import { dateTime } from '../../lib/format';
import { DataTable } from '../../components/DataTable';
import { Badge, Button, Card, Checkbox, cx, ErrorBox, Field, Input, Modal, Select, useToast } from '../../components/ui';

type BridgePrinter = { type: 'system'; name: string } | { type: 'network'; host: string; port?: number } | { type: 'device'; path: string } | { type: 'windows-share'; share: string };

/**
 * Where this computer's receipts go, so the cashier never sees a print window: through the device bridge
 * (printer picked from the list of printers installed on this PC), the till's network printer, or kiosk printing.
 */
export function ReceiptPrinterCard() {
  const toast = useToast();
  const [mode, setMode] = useState<PrintMode>(printMode());
  const [auto, setAuto] = useState(Boolean(getWorkstation().autoPrint));
  const [width, setWidth] = useState(getWorkstation().receiptWidth ?? 42);
  const paired = bridgeConfigured();
  const printers = useQuery({ queryKey: ['bridge-printers'], queryFn: () => bridge<{ configured: Record<string, BridgePrinter>; system: { name: string; default?: boolean; port?: string }[]; devices: string[] }>('/printers', undefined, 15_000), enabled: mode === 'bridge' && paired, retry: false });
  const current = printers.data?.configured?.receipt;
  const [choice, setChoice] = useState<string>('');
  const [host, setHost] = useState('');
  const [busy, setBusy] = useState(false);
  const save = (patch: Parameters<typeof setWorkstation>[0]) => setWorkstation(patch);
  const describe = (p?: BridgePrinter) => (!p ? 'Not set' : p.type === 'system' ? p.name : p.type === 'network' ? `${p.host}:${p.port ?? 9100}` : p.type === 'device' ? p.path : p.share);
  const options = [
    ...(printers.data?.system ?? []).map((p) => ({ value: `system:${p.name}`, label: `${p.name}${p.default ? ' (default)' : ''}${p.port ? ` · ${p.port}` : ''}` })),
    ...(printers.data?.devices ?? []).map((d) => ({ value: `device:${d}`, label: `USB device ${d}` })),
    { value: 'network', label: 'Network printer (IP address)…' },
  ];
  const chosen = (): BridgePrinter | null => {
    if (choice === 'network') return /^[\w.-]+$/.test(host.trim()) ? { type: 'network', host: host.trim(), port: 9100 } : null;
    if (choice.startsWith('system:')) return { type: 'system', name: choice.slice(7) };
    if (choice.startsWith('device:')) return { type: 'device', path: choice.slice(7) };
    return null;
  };
  const setPrinter = async (test: boolean) => {
    const p = chosen();
    if (!p) return toast.error(choice === 'network' ? 'Enter the printer IP address' : 'Choose a printer');
    setBusy(true);
    try {
      if (test) await bridge('/printers/test', { printer: p }, 20_000);
      else { await bridge('/printers/set', { name: 'receipt', printer: p }); await printers.refetch(); }
      toast.success(test ? 'Test page sent: check the printer' : 'Receipt printer saved on this computer');
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  return (
    <Card className="mb-4" title="This computer: receipt printer">
      <div role="radiogroup" aria-label="How receipts print" className="grid gap-2 md:grid-cols-2">
        {PRINT_MODES.map((m) => (
          <button key={m.value} type="button" role="radio" aria-checked={mode === m.value} onClick={() => { setMode(m.value); save({ printMode: m.value }); }}
            className={cx('rounded-lg border p-3 text-left transition', mode === m.value ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500 dark:bg-brand-500/10' : 'border-ink-200 hover:border-ink-300 dark:border-ink-700')}>
            <span className="block text-sm font-semibold">{m.label}</span><span className="mt-0.5 block text-xs text-ink-500">{m.help}</span>
          </button>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-4">
        <Field label="Paper"><Select value={String(width)} onChange={(e) => { setWidth(Number(e.target.value)); save({ receiptWidth: Number(e.target.value) }); }} options={[{ value: '32', label: '58 mm (32 characters)' }, { value: '42', label: '80 mm (42 characters)' }, { value: '48', label: '80 mm (48 characters)' }]} /></Field>
        <Checkbox label="Print the receipt automatically after each sale" checked={auto} onChange={(v) => { setAuto(v); save({ autoPrint: v }); }} />
      </div>
      {mode === 'bridge' && (
        <div className="mt-4 rounded-lg border border-ink-100 p-3 dark:border-ink-800">
          {!paired ? <p className="text-sm text-amber-700">Pair the device bridge first (card below), then choose the printer here.</p> : printers.isError ? <ErrorBox error={printers.error} /> : (
            <>
              <p className="mb-2 text-sm">Current receipt printer: <b data-testid="bridge-receipt-printer">{describe(current)}</b></p>
              <div className="grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
                <Field label="Printer"><Select value={choice} onChange={(e) => setChoice(e.target.value)} placeholder={printers.isLoading ? 'Looking for printers…' : 'Choose a printer'} options={options} /></Field>
                <Button variant="secondary" loading={busy} onClick={() => setPrinter(true)}>Print test</Button>
                <Button loading={busy} onClick={() => setPrinter(false)}>Use this printer</Button>
              </div>
              {choice === 'network' && <Field label="Printer IP address" className="mt-2"><Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.50" /></Field>}
              <p className="mt-2 text-xs text-ink-500">Thermal printers installed in Windows (any driver, or "Generic / Text Only") and CUPS printers on Linux/macOS are listed. The bridge sends the receipt as a raw ESC/POS job, so it prints at once with the logo-free thermal layout and cuts the paper.</p>
            </>
          )}
        </div>
      )}
      {mode === 'silent' && (
        <div className="mt-4 rounded-lg bg-ink-50 p-3 text-xs text-ink-600 dark:bg-ink-800/50 dark:text-ink-300">
          <p className="mb-1 font-semibold">Set the receipt printer as the computer's default printer, then start the browser like this (e.g. a desktop shortcut):</p>
          <code className="block break-all rounded bg-white p-2 font-mono dark:bg-ink-900">"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk-printing --app={window.location.origin}/pos</code>
          <p className="mt-1">Microsoft Edge accepts the same option (msedge.exe). Without it, the print window still appears.</p>
        </div>
      )}
      {mode === 'network' && <p className="mt-3 text-xs text-ink-500">Add the printer under <b>Hardware devices</b> below (type Receipt printer, connection Network, the till) or set it on the till under Branches &amp; tills.</p>}
    </Card>
  );
}

/** Pairs this browser with the Afey device bridge running on the same PC. */
export function BridgePairingCard() {
  const toast = useToast();
  const w = getWorkstation();
  const [url, setUrl] = useState(w.bridgeUrl ?? 'http://127.0.0.1:9123');
  const [token, setToken] = useState(w.bridgeToken ?? '');
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const save = () => {
    // The bridge only listens on this PC (loopback); the page's security policy allows nothing else.
    if (url.trim() && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(url.trim())) {
      toast.error('Use the bridge on this computer, e.g. http://127.0.0.1:9123');
      return false;
    }
    setWorkstation({ bridgeUrl: url.trim() || undefined, bridgeToken: token.trim() || undefined });
    toast.success('Saved for this computer');
    return true;
  };
  const test = async () => {
    if (!save()) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      setStatus(await bridgeStatus());
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="mb-4" title="This computer: device bridge">
      <p className="mb-3 text-sm text-ink-600 dark:text-ink-300">USB printers, scales, displays and fingerprint readers on this till are reached through the Afey device bridge. Install it on this PC, then enter its address and the <code>pairingToken</code> from its <code>config.json</code>. These settings stay on this computer only.</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Bridge address"><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://127.0.0.1:9123" /></Field>
        <Field label="Pairing token" className="sm:col-span-2"><Input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} /></Field>
      </div>
      <div className="mt-3 flex gap-2">
        <Button variant="secondary" onClick={save}>Save</Button>
        <Button loading={busy} onClick={test}>Test connection</Button>
        {(w.bridgeUrl || w.bridgeToken) && <Button variant="ghost" onClick={() => { setWorkstation({ bridgeUrl: undefined, bridgeToken: undefined }); setToken(''); toast.success('Unpaired'); }}>Unpair</Button>}
      </div>
      {status && (
        <div className="mt-3 flex flex-wrap gap-2 text-sm" data-testid="bridge-status">
          <Badge tone="green">Bridge connected</Badge>
          <Badge tone={status.fingerprint.connected ? 'green' : 'amber'}>Fingerprint: {status.fingerprint.model ?? status.fingerprint.vendor} {status.fingerprint.connected ? 'ready' : 'not ready'}</Badge>
          <Badge tone={status.biometricDevicePaired ? 'green' : 'amber'}>{status.biometricDevicePaired ? 'Reader registered' : 'Reader not registered yet'}</Badge>
          {status.printers.length > 0 && <Badge>Printers: {status.printers.join(', ')}</Badge>}
          {!status.fingerprint.connected && status.fingerprint.message && <span className="text-xs text-ink-500">{status.fingerprint.message}</span>}
        </div>
      )}
      <div className="mt-3"><ErrorBox error={error} /></div>
    </Card>
  );
}

/** Registers fingerprint readers; the device key is shown once to paste into the bridge's config.json. */
export function FingerprintReadersCard() {
  const { has, can } = useAuth();
  const locs = useLocations();
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ['bio-devices'], queryFn: () => api<{ data: any[] }>('/biometrics/devices').then((r) => r.data), enabled: has('biometrics') && can('hardware.manage') });
  const [form, setForm] = useState<any>(null);
  const [created, setCreated] = useState<{ id: string; deviceKey: string } | null>(null);
  if (!has('biometrics')) return null;
  const save = async () => {
    try {
      const r = await api<{ data: { id: string; deviceKey: string } }>('/biometrics/devices', { body: { name: form.name, vendor: form.vendor, model: form.model || undefined, branchId: form.branchId || undefined, tillId: form.tillId || undefined } });
      setCreated(r.data);
      setForm(null);
      qc.invalidateQueries({ queryKey: ['bio-devices'] });
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <Card className="mb-4" title="Fingerprint readers" actions={<Button size="sm" onClick={() => setForm({ name: '', vendor: 'zkteco' })}>Register reader</Button>}>
      <DataTable rows={list.data} loading={list.isLoading} empty="No readers registered" columns={[
        { key: 'n', header: 'Name', render: (r: any) => r.name },
        { key: 'v', header: 'Reader', render: (r: any) => `${r.vendor}${r.model ? ` ${r.model}` : ''}` },
        { key: 'b', header: 'Branch', render: (r: any) => locs.data?.branches.find((b) => b._id === r.branchId)?.name ?? 'All' },
        { key: 's', header: 'Last used', render: (r: any) => (r.lastSeenAt ? dateTime(r.lastSeenAt) : 'Never') },
      ]} />
      <p className="mt-2 text-xs text-ink-500">Readers at a branch only recognise staff allowed at that branch. Fingerprint templates are encrypted and never leave the server except to a registered reader.</p>
      {form && (
        <Modal open onClose={() => setForm(null)} title="Register fingerprint reader" footer={<Button onClick={save} disabled={form.name.length < 2}>Register</Button>}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name"><Input value={form.name} placeholder="Till 1 reader" onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="Make"><Select value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })} options={[{ value: 'zkteco', label: 'ZKTeco' }, { value: 'secugen', label: 'SecuGen' }, { value: 'simulator', label: 'Simulator (training)' }]} /></Field>
            <Field label="Model"><Input value={form.model ?? ''} placeholder="ZK9500" onChange={(e) => setForm({ ...form, model: e.target.value })} /></Field>
            <Field label="Branch"><Select value={form.branchId ?? ''} onChange={(e) => setForm({ ...form, branchId: e.target.value })} placeholder="All branches" options={(locs.data?.branches ?? []).map((b) => ({ value: b._id, label: b.name }))} /></Field>
          </div>
        </Modal>
      )}
      {created && (
        <Modal open onClose={() => setCreated(null)} title="Reader registered" footer={<Button onClick={() => setCreated(null)}>Done</Button>}>
          <p className="mb-2 text-sm">Copy these into the device bridge's <code>config.json</code> on the till PC, then restart the bridge. The key is shown only once.</p>
          <pre className="overflow-x-auto rounded-lg bg-ink-100 p-3 text-xs dark:bg-ink-800" data-testid="reader-config">{JSON.stringify({ biometricDevice: { deviceId: created.id, deviceKey: created.deviceKey } }, null, 2)}</pre>
        </Modal>
      )}
    </Card>
  );
}
