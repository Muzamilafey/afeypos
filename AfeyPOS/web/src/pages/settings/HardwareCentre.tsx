import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { COMPAT_STATUS, CONNECTION_LABELS, HARDWARE_CATALOG, HARDWARE_CATEGORIES, type CompatEntry, type Connection, type HardwareCategory } from '@afeypos/shared';
import { api } from '../../lib/api';
import { useLocations } from '../../lib/hooks';
import { dateTime } from '../../lib/format';
import { bridge, bridgeConfigured } from '../../lib/bridge';
import { openCashDrawer, printHtmlString } from '../../lib/printing';
import { Badge, Button, Card, ErrorBox, Field, Input, Modal, PageHeader, Select, Tabs, useToast } from '../../components/ui';
import { Icon } from '../../components/icons';

type Tab = 'devices' | 'catalog' | 'add';
const STATE_TONE: Record<string, 'green' | 'red' | 'gray'> = { ok: 'green', error: 'red', untested: 'gray' };
const STATE_LABEL: Record<string, string> = { ok: 'Working', error: 'Problem', untested: 'Not tested yet' };
const KIND_LABEL: Record<string, string> = { receipt_printer: 'Receipt printer', label_printer: 'Label printer', a4_printer: 'A4 printer', cash_drawer: 'Cash drawer', customer_display: 'Customer display', scale: 'Weighing scale', barcode_scanner: 'Barcode scanner', rfid_reader: 'RFID reader', fingerprint_reader: 'Fingerprint reader', card_terminal: 'Card terminal' };
/** Catalogue connection → how a registered device connects. */
const DEVICE_CONNECTION: Partial<Record<Connection, string>> = { usb: 'usb', serial: 'serial', usb_serial: 'serial', lan: 'network', wifi: 'network', bluetooth: 'bluetooth', keyboard: 'keyboard_wedge', bridge: 'bridge', browser: 'browser' };
const SETUP_PAGE: Record<string, { to: string; label: string }> = {
  scales: { to: '/settings/hardware/scales', label: 'Set up in Weighing scales' },
  terminals: { to: '/settings/payments/terminals', label: 'Set up in Bank card terminals' },
  fingerprint: { to: '/settings/hardware', label: 'Pair under Hardware → Fingerprint readers' },
};

/** Settings → Hardware → Device compatibility: what works with Afey POS, your devices' health, guided set-up. */
export function HardwareCentrePage() {
  const [tab, setTab] = useState<Tab>('devices');
  const [testing, setTesting] = useState<any>(null);
  return (
    <div className="max-w-6xl">
      <PageHeader title="Device compatibility" subtitle="What works with Afey POS, the health of your devices, and step-by-step set-up with a real test"
        actions={<Button onClick={() => setTab('add')}><Icon name="plus" className="h-4 w-4" />Add a device</Button>} />
      <Tabs value={tab} onChange={(k) => setTab(k as Tab)} tabs={[{ key: 'devices', label: 'Your devices' }, { key: 'catalog', label: 'Compatibility list' }, { key: 'add', label: 'Add a device' }]} />
      {tab === 'devices' && <DevicesTab onTest={setTesting} />}
      {tab === 'catalog' && <CatalogTab />}
      {tab === 'add' && <AddDeviceWizard onDone={(d) => { setTab('devices'); if (d) setTesting(d); }} />}
      {testing && <TestModal device={testing} onClose={() => setTesting(null)} />}
    </div>
  );
}

function DevicesTab({ onTest }: { onTest: (d: any) => void }) {
  const locs = useLocations();
  const q = useQuery({ queryKey: ['hardware-health'], queryFn: () => api<{ data: any[]; summary: Record<string, number> }>('/hardware/health'), refetchInterval: 30_000 });
  const branch = (id: string | null) => (id ? (locs.data?.branches as any[] | undefined)?.find((b) => b._id === id)?.name ?? '—' : 'All');
  const tills = (ids: string[]) => ids?.map((id) => locs.data?.tills.find((t) => t._id === id)?.name).filter(Boolean).join(', ') || '—';
  const s = q.data?.summary;
  return (
    <div>
      {s && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="hardware-summary">
          {[['Devices', s.total, ''], ['Working', s.ok, 'text-emerald-600'], ['Problems', s.error, s.error ? 'text-red-600' : ''], ['Not tested', s.untested, s.untested ? 'text-amber-600' : '']].map(([l, v, c]) => (
            <div key={String(l)} className="card p-3"><div className="text-xs text-ink-500">{l}</div><div className={`text-2xl font-semibold ${c}`}>{v}</div></div>
          ))}
        </div>
      )}
      <ErrorBox error={q.error} />
      <div className="card overflow-x-auto">
        <table className="w-full text-sm" data-testid="hardware-health">
          <thead><tr className="text-left text-xs text-ink-500"><th className="px-3 py-2">Device</th><th>Type</th><th>Branch / till</th><th>Status</th><th>Last worked</th><th>Last problem</th><th /></tr></thead>
          <tbody>
            {(q.data?.data ?? []).map((r) => (
              <tr key={`${r.source}:${r.id}`} className="border-t border-ink-100 dark:border-ink-800">
                <td className="px-3 py-2"><div className="font-medium">{r.name}{r.simulated && <Badge tone="blue">simulated</Badge>}</div><div className="text-xs text-ink-500">{r.model ?? ''}{r.connection ? ` · ${r.connection}` : ''}</div></td>
                <td>{KIND_LABEL[r.kind] ?? r.kind}</td>
                <td className="text-xs">{branch(r.branchId)}<div className="text-ink-500">{tills(r.tillIds)}</div></td>
                <td><Badge tone={STATE_TONE[r.state]}>{STATE_LABEL[r.state]}</Badge></td>
                <td className="text-xs">{r.lastSuccessAt ? dateTime(r.lastSuccessAt) : '—'}</td>
                <td className="max-w-xs text-xs text-red-600">{r.lastError ? `${r.lastError.message}${r.lastError.at ? ` · ${dateTime(r.lastError.at)}` : ''}` : ''}</td>
                <td className="px-3 text-right">
                  {r.source === 'device' ? <Button size="sm" variant="secondary" onClick={() => onTest(r)}>Test</Button>
                    : <Link className="text-xs text-brand-600 hover:underline" to={r.source === 'scale' ? '/settings/hardware/scales' : r.source === 'terminal' ? '/settings/payments/terminals' : '/settings/hardware'}>Open</Link>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {q.data && !q.data.data.length && <p className="p-4 text-sm text-ink-500">No devices yet. Use Add a device.</p>}
      </div>
    </div>
  );
}

function CatalogTab() {
  const [cat, setCat] = useState<string>('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<CompatEntry | null>(null);
  const rows = HARDWARE_CATALOG.filter((e) => (!cat || e.category === cat) && (!q || `${e.manufacturer} ${e.model}`.toLowerCase().includes(q.toLowerCase())));
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2">
        <Select className="w-56" aria-label="Category" value={cat} onChange={(e) => setCat(e.target.value)} placeholder="All categories" options={HARDWARE_CATEGORIES.map((c) => ({ value: c.key, label: c.label }))} />
        <Input className="max-w-xs" placeholder="Search manufacturer or model" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="grid gap-3 md:grid-cols-2" data-testid="compat-list">
        {rows.map((e) => (
          <button key={e.id} type="button" onClick={() => setOpen(e)} className="card p-4 text-left transition hover:border-brand-400">
            <div className="flex items-start justify-between gap-2">
              <div><div className="font-semibold">{e.manufacturer}</div><div className="text-sm">{e.model}</div></div>
              <Badge tone={COMPAT_STATUS[e.status].tone}>{COMPAT_STATUS[e.status].label}</Badge>
            </div>
            <div className="mt-2 text-xs text-ink-500">{HARDWARE_CATEGORIES.find((c) => c.key === e.category)?.label} · {e.connections.map((c) => CONNECTION_LABELS[c]).join(', ')}</div>
            <div className="mt-1 text-xs text-ink-600 dark:text-ink-300">{e.limitations}</div>
          </button>
        ))}
      </div>
      <p className="mt-4 text-xs text-ink-500">"Verified compatible" means tested end to end with that exact device or software. Everything else must pass its own test at your shop; a model not listed is not assumed to work.</p>
      {open && (
        <Modal open onClose={() => setOpen(null)} title={`${open.manufacturer} ${open.model}`} subtitle={COMPAT_STATUS[open.status].label}>
          <dl className="space-y-2 text-sm">
            {([['Category', HARDWARE_CATEGORIES.find((c) => c.key === open.category)?.label], ['Connections', open.connections.map((c) => CONNECTION_LABELS[c]).join(', ')], ['Operating systems', open.os.join(', ')], ['Protocols', open.protocols.join(', ')], ['Drivers', open.drivers], ['SDK', open.sdk], ['What it does', open.operations.join('; ') || '—'], ['Limitations', open.limitations], ['Documentation', open.docs], ['Last verified', open.lastVerified ?? 'Not verified']] as [string, string][]).map(([k, v]) => (
              <div key={k} className="grid grid-cols-[9rem_1fr] gap-2"><dt className="text-ink-500">{k}</dt><dd>{v}</dd></div>
            ))}
          </dl>
        </Modal>
      )}
    </div>
  );
}

const DEVICE_KIND: Partial<Record<HardwareCategory, string>> = { barcode_scanner: 'barcode_scanner', receipt_printer: 'receipt_printer', label_printer: 'label_printer', cash_drawer: 'cash_drawer', customer_display: 'customer_display' };

/** Category → exact model → connection → branch and till → settings → save, then the test. */
function AddDeviceWizard({ onDone }: { onDone: (device: any | null) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const locs = useLocations();
  const [category, setCategory] = useState<HardwareCategory | ''>('');
  const [entryId, setEntryId] = useState('');
  const [model, setModel] = useState('');
  const [connection, setConnection] = useState('');
  const [branchId, setBranchId] = useState('');
  const [tillId, setTillId] = useState('');
  const [name, setName] = useState('');
  const [settings, setSettings] = useState<Record<string, any>>({ port: 9100, width: 42, labelLanguage: 'zpl', baudRate: 9600 });
  const [error, setError] = useState<unknown>(null);
  const entries = HARDWARE_CATALOG.filter((e) => e.category === category);
  const entry = entries.find((e) => e.id === entryId);
  const conns = useMemo(() => [...new Set((entry?.connections ?? []).map((c) => DEVICE_CONNECTION[c]).filter(Boolean) as string[])], [entry]);
  const kind = category ? DEVICE_KIND[category] : undefined;
  const branch = branchId || (locs.data?.branches as any[] | undefined)?.[0]?._id || '';
  const step = !category ? 1 : !entry ? 2 : entry.status === 'unsupported' || entry.setup !== 'device' || !kind ? 3 : !connection ? 4 : 5;
  const save = async () => {
    setError(null);
    try {
      const r = await api<{ data: any }>('/hardware/devices', { body: {
        kind, name: name || `${entry!.manufacturer === 'Any' ? '' : `${entry!.manufacturer} `}${KIND_LABEL[kind!]}`.trim(), connection, branchId: branch || undefined, tillId: tillId || undefined,
        catalogId: entry!.id, manufacturer: entry!.manufacturer, model: model || entry!.model,
        settings: connection === 'network' ? { host: settings.host, port: Number(settings.port) || 9100, width: Number(settings.width) || 42, ...(kind === 'label_printer' ? { labelLanguage: settings.labelLanguage } : {}) }
          : connection === 'serial' ? { serialPort: settings.serialPort, baudRate: Number(settings.baudRate) || 9600 }
            : connection === 'bridge' ? { printerName: settings.printerName, ...(kind === 'label_printer' ? { labelLanguage: settings.labelLanguage } : {}) } : {},
      } });
      toast.success('Device saved: now test it');
      qc.invalidateQueries({ queryKey: ['hardware-health'] });
      onDone({ ...r.data, id: r.data._id, source: 'device' });
    } catch (e) { setError(e); }
  };
  return (
    <Card>
      <ol className="mb-4 flex flex-wrap gap-2 text-xs">{['Device type', 'Model', 'How it is set up', 'Connection', 'Where and settings'].map((s, i) => <li key={s} className={`rounded-full px-3 py-1 ${i + 1 === step ? 'bg-brand-600 text-white' : i + 1 < step ? 'bg-emerald-100 text-emerald-800' : 'bg-ink-100 text-ink-600 dark:bg-ink-800'}`}>{i + 1}. {s}</li>)}</ol>
      <ErrorBox error={error} />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <Field label="1. What kind of device?"><Select aria-label="Device type" value={category} onChange={(e) => { setCategory(e.target.value as HardwareCategory); setEntryId(''); setConnection(''); }} placeholder="Choose…" options={HARDWARE_CATEGORIES.map((c) => ({ value: c.key, label: c.label }))} /></Field>
          {category && <Field label="2. Manufacturer and model"><Select aria-label="Model" value={entryId} onChange={(e) => { setEntryId(e.target.value); setConnection(''); }} placeholder="Choose…" options={entries.map((e) => ({ value: e.id, label: `${e.manufacturer}: ${e.model} (${COMPAT_STATUS[e.status].label})` }))} /></Field>}
          {entry && entry.manufacturer === 'Any' && <Field label="Exact model (as printed on the device)"><Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. Xprinter XP-80C" /></Field>}
          {entry && (
            <div className="rounded-lg bg-ink-50 p-3 text-sm dark:bg-ink-900">
              <Badge tone={COMPAT_STATUS[entry.status].tone}>{COMPAT_STATUS[entry.status].label}</Badge>
              <p className="mt-2">{entry.limitations}</p>
              {entry.drivers && entry.drivers !== 'None' && <p className="mt-1 text-xs text-ink-500">Driver: {entry.drivers}</p>}
              {entry.sdk && entry.sdk !== 'None' && <p className="mt-1 text-xs text-ink-500">SDK: {entry.sdk}</p>}
            </div>
          )}
          {entry && entry.status === 'unsupported' && <p className="text-sm text-red-600">This one is not supported. {entry.limitations}</p>}
          {entry && entry.status !== 'unsupported' && SETUP_PAGE[entry.setup] && <Link to={SETUP_PAGE[entry.setup].to}><Button>{SETUP_PAGE[entry.setup].label}</Button></Link>}
          {entry && entry.setup === 'display' && <p className="text-sm">Open it from the till: More → Customer display, then move that window to the customer's screen.</p>}
        </div>
        {step >= 4 && kind && (
          <div className="space-y-3">
            <Field label="4. Connection"><Select aria-label="Connection" value={connection} onChange={(e) => setConnection(e.target.value)} placeholder="Choose…" options={conns.map((c) => ({ value: c, label: c === 'network' ? 'Network (LAN / Wi-Fi, port 9100)' : c === 'bridge' ? 'Device bridge on the till PC' : c === 'keyboard_wedge' ? 'Keyboard emulation' : c === 'browser' ? 'Browser print window' : c.toUpperCase() }))} /></Field>
            {connection && <>
              <Field label="5. Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={`e.g. Till 1 ${KIND_LABEL[kind].toLowerCase()}`} /></Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Branch"><Select value={branch} onChange={(e) => { setBranchId(e.target.value); setTillId(''); }} options={((locs.data?.branches as any[]) ?? []).map((b) => ({ value: b._id, label: b.name }))} /></Field>
                <Field label="Till"><Select value={tillId} onChange={(e) => setTillId(e.target.value)} placeholder="Any till" options={(locs.data?.tills ?? []).filter((t: any) => !branch || t.branchId === branch).map((t: any) => ({ value: t._id, label: t.name }))} /></Field>
              </div>
              {connection === 'network' && <div className="grid grid-cols-2 gap-2"><Field label="IP address"><Input value={settings.host ?? ''} onChange={(e) => setSettings({ ...settings, host: e.target.value })} placeholder="192.168.1.50" /></Field><Field label="Port"><Input type="number" value={settings.port} onChange={(e) => setSettings({ ...settings, port: e.target.value })} /></Field></div>}
              {connection === 'serial' && <div className="grid grid-cols-2 gap-2"><Field label="Port"><Input value={settings.serialPort ?? ''} onChange={(e) => setSettings({ ...settings, serialPort: e.target.value })} placeholder="COM3" /></Field><Field label="Baud"><Input type="number" value={settings.baudRate} onChange={(e) => setSettings({ ...settings, baudRate: e.target.value })} /></Field></div>}
              {connection === 'bridge' && kind !== 'barcode_scanner' && <Field label="Printer name in the device bridge" hint="As set in the bridge (e.g. receipt, label)"><Input value={settings.printerName ?? ''} onChange={(e) => setSettings({ ...settings, printerName: e.target.value })} placeholder="receipt" /></Field>}
              {kind === 'label_printer' && connection !== 'browser' && <Field label="Printer language"><Select value={settings.labelLanguage} onChange={(e) => setSettings({ ...settings, labelLanguage: e.target.value })} options={[{ value: 'zpl', label: 'ZPL (Zebra)' }, { value: 'tspl', label: 'TSPL (TSC, Xprinter…)' }]} /></Field>}
              {connection === 'bridge' && !bridgeConfigured() && <p className="text-xs text-amber-700">This computer is not paired with the device bridge: test from the till PC where it is installed.</p>}
              <Button onClick={save}>Save and test</Button>
            </>}
          </div>
        )}
      </div>
    </Card>
  );
}

/** A real test for each kind of device; the result is recorded (nothing is marked working without one). */
function TestModal({ device, onClose }: { device: any; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [scan, setScan] = useState('');
  const [state, setState] = useState<'idle' | 'running' | 'asked' | 'done'>('idle');
  const [message, setMessage] = useState('');
  const id = device._id ?? device.id;
  const report = async (ok: boolean, msg: string, method: 'scan' | 'bridge' | 'browser' | 'manual') => {
    await api(`/hardware/devices/${id}/test-result`, { body: { ok, message: msg, method } });
    qc.invalidateQueries({ queryKey: ['hardware-health'] });
    setState('done');
    setMessage(msg);
    if (ok) toast.success(msg); else toast.error(msg);
  };
  const run = async () => {
    setState('running');
    try {
      if (device.connection === 'network') {
        const r = await api<{ data: { ok: boolean; message: string } }>(`/hardware/devices/${id}/test`, { body: {} });
        qc.invalidateQueries({ queryKey: ['hardware-health'] });
        setState('done'); setMessage(r.data.message);
        return;
      }
      if (device.kind === 'cash_drawer') { await openCashDrawer({ reason: 'Drawer test from Device compatibility' }); setState('asked'); setMessage('Did the drawer open?'); return; }
      if (device.connection === 'bridge' && device.kind === 'customer_display') { await bridge('/display', { line1: 'Afey POS test', line2: 'Karibu!' }); setState('asked'); setMessage('Does the display show "Afey POS test"?'); return; }
      if (device.connection === 'bridge') { await bridge('/printers/test', { name: device.settings?.printerName || 'receipt' }, 20_000); setState('asked'); setMessage('Did the test page print?'); return; }
      await printHtmlString(`<!doctype html><html><body style="font:14px sans-serif;text-align:center"><b>Afey POS test page</b><br>${new Date().toLocaleString()}</body></html>`);
      setState('asked'); setMessage('Did the test page print?');
    } catch (e: any) {
      await report(false, e?.message ?? 'The device did not answer', device.connection === 'bridge' ? 'bridge' : 'browser');
    }
  };
  return (
    <Modal open onClose={onClose} title={`Test ${device.name}`} subtitle={KIND_LABEL[device.kind] ?? device.kind}>
      {device.kind === 'barcode_scanner' ? (
        <div className="space-y-2">
          <p className="text-sm">Click the box and scan any barcode. It passes when the code arrives followed by Enter.</p>
          <Input autoFocus aria-label="Scan here" value={scan} onChange={(e) => setScan(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (scan.trim().length >= 4) void report(true, `Scanned ${scan.trim()}`, 'scan'); else void report(false, 'Enter arrived without a barcode', 'scan'); } }} placeholder="Scan here" />
          <Button variant="secondary" onClick={() => report(false, 'No scan received', 'scan')}>It did not scan</Button>
        </div>
      ) : (
        <div className="space-y-3">
          {state === 'idle' && <Button onClick={run}>Run the test</Button>}
          {state === 'running' && <p className="text-sm">Testing…</p>}
          {state === 'asked' && (
            <div className="space-y-2"><p className="text-sm font-medium">{message}</p>
              <div className="flex gap-2"><Button onClick={() => report(true, message.replace('Did the', 'The').replace('Does the', 'The').replace('?', ': yes'), 'manual')}>Yes</Button><Button variant="secondary" onClick={() => report(false, message.replace('?', ': no'), 'manual')}>No</Button></div>
            </div>
          )}
        </div>
      )}
      {state === 'done' && <p className="mt-3 text-sm" data-testid="test-outcome">{message}</p>}
    </Modal>
  );
}
