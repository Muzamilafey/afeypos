import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SCALE_ADAPTERS, SCALE_BRANDS, SCALE_FORMAT_PRESETS, validateScaleFormats, type ScaleAdapterKey, type ScaleBarcodeFormat, type ScaleReading } from '@afeypos/shared';
import { api, download } from '../../lib/api';
import { useLocations } from '../../lib/hooks';
import { date } from '../../lib/format';
import { bridgeConfigured } from '../../lib/bridge';
import { parseTypedWeight, readBridgeScale } from '../../lib/scale';
import { Badge, Button, Card, Checkbox, ErrorBox, Field, Input, Modal, PageHeader, Select, useToast } from '../../components/ui';
import { Icon } from '../../components/icons';
import { ReadingView } from '../../components/Weigh';

const STATUS_TONE: Record<string, 'green' | 'amber' | 'red' | 'gray'> = { verified: 'green', unverified: 'amber', failed: 'red', disabled: 'gray' };
const JOB_TONE: Record<string, 'green' | 'amber' | 'red' | 'gray' | 'blue'> = { succeeded: 'green', awaiting_import: 'amber', queued: 'blue', sending: 'blue', failed: 'red', superseded: 'gray' };

/** Settings → Hardware → Weighing scales: register, verify with a real reading, send prices, scale label formats. */
export function ScalesPage() {
  const qc = useQueryClient();
  const scales = useQuery({ queryKey: ['scales'], queryFn: () => api<{ data: any[] }>('/scales').then((r) => r.data) });
  const [adding, setAdding] = useState(false);
  const [testing, setTesting] = useState<any>(null);
  const [jobsFor, setJobsFor] = useState<any>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['scales'] });
  const rows = scales.data ?? [];
  return (
    <div className="max-w-5xl">
      <PageHeader title="Weighing scales" subtitle="Counter scales that weigh at the till, and label scales that print price labels" actions={<Button onClick={() => setAdding(true)}><Icon name="plus" className="h-4 w-4" />Add scale</Button>} />
      <div className="mb-4 grid gap-3 sm:grid-cols-4" data-testid="scale-stats">
        <Stat label="Scales" value={rows.length} />
        <Stat label="Verified" value={rows.filter((s) => s.status === 'verified').length} />
        <Stat label="Need testing" value={rows.filter((s) => s.status !== 'verified').length} tone={rows.some((s) => s.status !== 'verified') ? 'amber' : undefined} />
        <Stat label="Prices out of date" value={rows.filter((s) => s.pluStatus?.applies && !s.pluStatus.upToDate).length} tone={rows.some((s) => s.pluStatus?.applies && !s.pluStatus.upToDate) ? 'red' : undefined} />
      </div>
      <ErrorBox error={scales.error} />
      <div className="space-y-3">
        {rows.length === 0 && !scales.isLoading && <Card><p className="text-sm text-ink-500">No scales yet. Add the scale at your deli or butchery counter, then test it with a known weight.</p></Card>}
        {rows.map((s) => (
          <div key={s._id} className="card flex flex-wrap items-center gap-3 p-4" data-testid="scale-row">
            <div className="min-w-48 flex-1">
              <div className="flex items-center gap-2 font-medium">{s.name}{s.simulated && <Badge tone="blue">simulated</Badge>}</div>
              <div className="text-xs text-ink-500">{SCALE_BRANDS.find((b) => b.key === s.brand)?.name ?? s.brand}{s.model ? ` ${s.model}` : ''} · {s.adapterInfo?.label} · {s.role === 'both' ? 'counter + label' : s.role}</div>
              {s.lastCheck?.message && <div className={`mt-1 text-xs ${s.lastCheck.ok ? 'text-emerald-700' : 'text-red-600'}`}>{s.lastCheck.message} · {date(s.lastCheck.at)}</div>}
            </div>
            <Badge tone={STATUS_TONE[s.status] ?? 'gray'}>{s.status}</Badge>
            {s.pluStatus?.applies && <Badge tone={s.pluStatus.upToDate ? 'green' : 'red'}>{s.pluStatus.upToDate ? `prices current (v${s.pluStatus.confirmedVersion})` : `${s.pluStatus.count} PLUs to send`}</Badge>}
            {s.lastJob && <Badge tone={JOB_TONE[s.lastJob.status] ?? 'gray'}>last send: {s.lastJob.status.replace('_', ' ')}</Badge>}
            <div className="flex gap-1">
              {s.adapter !== 'file-export' && <Button size="sm" variant="secondary" onClick={() => setTesting(s)}>Test</Button>}
              {s.role !== 'counter' && <Button size="sm" variant="secondary" onClick={() => setJobsFor(s)}>Send prices</Button>}
              <Button size="sm" variant="ghost" aria-label="Remove scale" onClick={async () => { if (confirm(`Remove ${s.name}?`)) { await api(`/scales/${s._id}`, { method: 'DELETE' }); refresh(); } }}><Icon name="trash" className="h-4 w-4" /></Button>
            </div>
          </div>
        ))}
      </div>
      <ScaleBarcodesCard />
      <Card className="mt-4" title="What works with what">
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink-600 dark:text-ink-300">
          {SCALE_BRANDS.filter((b) => b.key !== 'simulator').map((b) => <li key={b.key}><b>{b.name}:</b> {b.note}</li>)}
          <li>Afey POS does not program scales over a maker's own network protocol. Label scales get a PLU file for the maker's software; a send only counts once you confirm the import.</li>
        </ul>
      </Card>
      {adding && <AddScaleModal onClose={() => setAdding(false)} onSaved={(s) => { setAdding(false); refresh(); if (s.adapter !== 'file-export') setTesting(s); }} />}
      {testing && <TestScaleModal scale={testing} onClose={() => { setTesting(null); refresh(); }} />}
      {jobsFor && <SendPricesModal scale={jobsFor} onClose={() => { setJobsFor(null); refresh(); }} />}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'amber' | 'red' }) {
  return <div className="card p-3"><div className="text-xs text-ink-500">{label}</div><div className={`text-2xl font-semibold ${tone === 'red' ? 'text-red-600' : tone === 'amber' ? 'text-amber-600' : ''}`}>{value}</div></div>;
}

function AddScaleModal({ onClose, onSaved }: { onClose: () => void; onSaved: (s: any) => void }) {
  const locs = useLocations();
  const [f, setF] = useState<any>({ name: '', brand: 'cas', model: '', adapter: 'bridge-serial', role: 'counter', branchId: '', tillIds: [], settings: { port: 'COM3', baud: 9600, syncAll: true } });
  const [error, setError] = useState<unknown>(null);
  const brand = SCALE_BRANDS.find((b) => b.key === f.brand)!;
  const adapter = SCALE_ADAPTERS[f.adapter as ScaleAdapterKey];
  const branchId = f.branchId || locs.data?.branches[0]?._id || '';
  const roles = [
    ...(adapter.readWeight ? [{ value: 'counter', label: 'Counter: weighs at the till' }] : []),
    ...(adapter.pluSync !== 'none' && brand.labelScales ? [{ value: 'label', label: 'Label: prints price labels from its PLU list' }] : []),
    ...(adapter.readWeight && adapter.pluSync !== 'none' && brand.labelScales ? [{ value: 'both', label: 'Both' }] : []),
  ];
  const set = (patch: any) => setF((x: any) => {
    const next = { ...x, ...patch };
    const b = SCALE_BRANDS.find((y) => y.key === next.brand)!;
    if (!b.adapters.includes(next.adapter)) next.adapter = b.adapters[0];
    const a = SCALE_ADAPTERS[next.adapter as ScaleAdapterKey];
    if (!a.readWeight) next.role = 'label';
    else if (a.pluSync === 'none' || !b.labelScales) next.role = 'counter';
    return next;
  });
  const save = async () => {
    setError(null);
    try {
      const body = { ...f, branchId, model: f.model || undefined, settings: { ...f.settings, port: f.adapter === 'bridge-serial' ? f.settings.port : undefined, baud: f.adapter === 'bridge-serial' ? Number(f.settings.baud) : undefined } };
      const r = await api<{ data: any }>('/scales', { body });
      onSaved(r.data);
    } catch (e) { setError(e); }
  };
  return (
    <Modal open onClose={onClose} title="Add a weighing scale" footer={<Button onClick={save}>Save and test</Button>}>
      <ErrorBox error={error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name"><Input value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Butchery scale" /></Field>
        <Field label="Brand"><Select value={f.brand} onChange={(e) => set({ brand: e.target.value })} options={SCALE_BRANDS.map((b) => ({ value: b.key, label: b.name }))} /></Field>
        <Field label="Model (as printed on the scale)"><Input value={f.model} onChange={(e) => set({ model: e.target.value })} /></Field>
        <Field label="Connection"><Select value={f.adapter} onChange={(e) => set({ adapter: e.target.value })} options={brand.adapters.map((a) => ({ value: a, label: SCALE_ADAPTERS[a].label }))} /></Field>
        <Field label="What it does"><Select value={f.role} onChange={(e) => set({ role: e.target.value })} options={roles} /></Field>
        <Field label="Branch"><Select value={branchId} onChange={(e) => set({ branchId: e.target.value, tillIds: [] })} options={(locs.data?.branches ?? []).map((b: any) => ({ value: b._id, label: b.name }))} /></Field>
        {f.adapter === 'bridge-serial' && <>
          <Field label="Serial port on the till PC" hint="COM3 on Windows, /dev/ttyUSB0 on Linux"><Input value={f.settings.port} onChange={(e) => set({ settings: { ...f.settings, port: e.target.value } })} /></Field>
          <Field label="Baud rate" hint="From the scale's settings (often 9600)"><Input type="number" value={f.settings.baud} onChange={(e) => set({ settings: { ...f.settings, baud: e.target.value } })} /></Field>
        </>}
        {f.role !== 'label' && (
          <div className="sm:col-span-2">
            <div className="label">Tills that weigh on it</div>
            <div className="flex flex-wrap gap-3">{(locs.data?.tills ?? []).filter((t: any) => t.branchId === branchId).map((t: any) => <Checkbox key={t._id} label={t.name} checked={f.tillIds.includes(t._id)} onChange={(v) => set({ tillIds: v ? [...f.tillIds, t._id] : f.tillIds.filter((x: string) => x !== t._id) })} />)}</div>
          </div>
        )}
        {f.role !== 'counter' && <div className="sm:col-span-2"><Checkbox label="Send every product with a PLU (untick to send only products assigned to this scale)" checked={f.settings.syncAll !== false} onChange={(v) => set({ settings: { ...f.settings, syncAll: v } })} /></div>}
      </div>
      <p className="mt-3 text-xs text-ink-500">{adapter.description} {brand.note}</p>
      {f.adapter === 'bridge-serial' && <p className="mt-1 text-xs text-ink-500">Also put the same port in the device bridge's config.json under "scale" on that till PC (see docs/WEIGHING-SCALES.md).</p>}
    </Modal>
  );
}

/** Test with a known weight: the reading must settle and match within 1% (at least 5 g). */
function TestScaleModal({ scale, onClose }: { scale: any; onClose: () => void }) {
  const toast = useToast();
  const [expected, setExpected] = useState('1');
  const [reading, setReading] = useState<ScaleReading | null>(null);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const read = async () => {
    setError(null);
    setBusy(true);
    try { setReading(await readBridgeScale()); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const verify = async () => {
    setError(null);
    try {
      const r = await api<{ data: any }>(`/scales/${scale._id}/verify`, { body: { expectedKg: Number(expected), reading: scale.adapter === 'simulator' ? undefined : reading ?? undefined } });
      toast.success(r.data.lastCheck?.message ?? 'Scale verified');
      onClose();
    } catch (e) { setError(e); }
  };
  return (
    <Modal open onClose={onClose} title={`Test ${scale.name}`} footer={<Button disabled={scale.adapter !== 'simulator' && !reading} onClick={verify}>Check reading</Button>}>
      <ErrorBox error={error} />
      <ol className="mb-3 list-decimal space-y-1 pl-5 text-sm text-ink-600 dark:text-ink-300">
        <li>Empty the scale and press ZERO on it.</li>
        <li>Put an item of known weight on it (a sealed 1 kg bag of sugar works) and type that weight below.</li>
        <li>{scale.adapter === 'keyboard' ? 'Click the box below and press the scale\'s send/print key.' : scale.adapter === 'simulator' ? 'The simulator answers by itself.' : 'Press Read the scale on the till PC with the device bridge.'}</li>
      </ol>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Test weight (kg)"><Input inputMode="decimal" value={expected} onChange={(e) => setExpected(e.target.value)} /></Field>
        {scale.adapter === 'bridge-serial' && <div className="pt-6"><Button variant="secondary" loading={busy} disabled={!bridgeConfigured()} onClick={read}>Read the scale</Button>{!bridgeConfigured() && <div className="mt-1 text-xs text-amber-700">This computer is not paired with the device bridge (Hardware → This computer).</div>}</div>}
        {scale.adapter === 'keyboard' && <Field label="Weight from the scale"><Input autoFocus value={typed} onChange={(e) => { setTyped(e.target.value); setReading(parseTypedWeight(e.target.value)); }} placeholder="The scale types here" /></Field>}
      </div>
      {reading && <ReadingView reading={reading} />}
    </Modal>
  );
}

function SendPricesModal({ scale, onClose }: { scale: any; onClose: () => void }) {
  const toast = useToast();
  const jobs = useQuery({ queryKey: ['scale-jobs', scale._id], queryFn: () => api<{ data: any[] }>(`/scales/${scale._id}/jobs`).then((r) => r.data), refetchInterval: 3000 });
  const preview = useQuery({ queryKey: ['plu-preview', scale._id], queryFn: () => api<{ data: any[] }>(`/scales/${scale._id}/plu-preview`).then((r) => r.data) });
  const [error, setError] = useState<unknown>(null);
  const act = async (fn: () => Promise<unknown>, ok?: string) => { setError(null); try { await fn(); if (ok) toast.success(ok); jobs.refetch(); } catch (e) { setError(e); } };
  const direct = scale.adapterInfo?.pluSync === 'direct';
  return (
    <Modal open onClose={onClose} size="lg" title={`Prices on ${scale.name}`} footer={<Button onClick={() => act(() => api(`/scales/${scale._id}/sync`, { body: {} }), direct ? 'Sending to the scale' : 'PLU file ready')}>{direct ? 'Send now' : 'Prepare PLU file'}</Button>}>
      <ErrorBox error={error} />
      <p className="mb-2 text-sm text-ink-600">{preview.data?.length ?? '…'} products with a PLU and a price. {direct ? 'The scale confirms each send; failed sends retry on their own.' : 'Download the file, import it with the scale maker\'s PLU software, check a price on the scale, then press Confirm import.'}</p>
      <div className="max-h-40 overflow-auto rounded border border-ink-100 text-xs dark:border-ink-800">
        <table className="w-full"><tbody>{(preview.data ?? []).slice(0, 50).map((i) => <tr key={i.plu} className="border-b border-ink-50 dark:border-ink-900"><td className="px-2 py-1 font-mono">{i.plu}</td><td className="px-2">{i.name}</td><td className="px-2 text-right">{(i.priceCents / 100).toFixed(2)} / {i.unit}</td></tr>)}</tbody></table>
      </div>
      <div className="mt-3 space-y-2">
        {(jobs.data ?? []).map((j) => (
          <div key={j._id} className="flex flex-wrap items-center gap-2 rounded border border-ink-100 p-2 text-sm dark:border-ink-800" data-testid="scale-job">
            <b>v{j.version}</b><Badge tone={JOB_TONE[j.status] ?? 'gray'}>{j.status.replace('_', ' ')}</Badge>
            <span className="text-xs text-ink-500">{date(j.createdAt)} · {j.log?.at(-1)?.message}</span>
            <span className="flex-1" />
            {j.status === 'awaiting_import' && <>
              <Button size="sm" variant="secondary" onClick={() => act(() => download(`/scale-jobs/${j._id}/file`, `plu-v${j.version}.csv`))}><Icon name="download" className="h-4 w-4" />PLU file</Button>
              <Button size="sm" onClick={() => act(() => api(`/scale-jobs/${j._id}/confirm`, { body: {} }), 'Import confirmed')}>Confirm import</Button>
            </>}
            {j.status === 'failed' && <Button size="sm" variant="secondary" onClick={() => act(() => api(`/scale-jobs/${j._id}/retry`, { body: {} }), 'Retrying')}>Retry</Button>}
          </div>
        ))}
      </div>
    </Modal>
  );
}

/** Layouts of the barcodes printed by label scales, read at checkout. */
function ScaleBarcodesCard() {
  const toast = useToast();
  const q = useQuery({ queryKey: ['scale-barcodes'], queryFn: () => api<{ data: { formats: ScaleBarcodeFormat[]; configured: boolean; internalPrefix: string } }>('/settings/scale-barcodes').then((r) => r.data) });
  const [formats, setFormats] = useState<ScaleBarcodeFormat[] | null>(null);
  const list = formats ?? q.data?.formats ?? [];
  const problems = validateScaleFormats(list);
  const upd = (i: number, patch: Partial<ScaleBarcodeFormat>) => setFormats(list.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const num = (v: string) => Math.max(0, Math.min(13, Number(v) || 0));
  const save = async () => {
    try {
      await api('/settings/scale-barcodes', { method: 'PUT', body: { formats: list } });
      toast.success('Scale barcode layouts saved');
      setFormats(null);
      q.refetch();
    } catch (e) { toast.error(e); }
  };
  return (
    <Card className="mt-4" title="Scale label barcodes" actions={<Button size="sm" disabled={!formats || problems.length > 0} onClick={save}>Save</Button>}>
      <p className="mb-2 text-xs text-ink-500">How the till reads barcodes printed by your label scales. Positions count from 0. Copy the layout from the scale's barcode settings.{q.data && !q.data.configured && list.length > 0 ? ' Showing the older single layout from Business settings.' : ''}</p>
      {list.map((f, i) => (
        <div key={f.id} className="mb-2 grid items-end gap-2 rounded border border-ink-100 p-2 text-sm sm:grid-cols-8 dark:border-ink-800">
          <Field label="Name" className="sm:col-span-2"><Input value={f.name} onChange={(e) => upd(i, { name: e.target.value })} /></Field>
          <Field label="Starts with"><Input value={f.prefix} onChange={(e) => upd(i, { prefix: e.target.value.replace(/\D/g, '').slice(0, 3) })} /></Field>
          <Field label="Item from / digits"><div className="flex gap-1"><Input value={f.itemStart} onChange={(e) => upd(i, { itemStart: num(e.target.value) })} /><Input value={f.itemLength} onChange={(e) => upd(i, { itemLength: num(e.target.value) })} /></div></Field>
          <Field label="Value from / digits"><div className="flex gap-1"><Input value={f.valueStart} onChange={(e) => upd(i, { valueStart: num(e.target.value) })} /><Input value={f.valueLength} onChange={(e) => upd(i, { valueLength: num(e.target.value) })} /></div></Field>
          <Field label="Value is"><Select value={f.valueType} onChange={(e) => upd(i, { valueType: e.target.value as 'weight' | 'price' })} options={[{ value: 'weight', label: 'Weight' }, { value: 'price', label: 'Price' }]} /></Field>
          <Field label="Decimals"><Input value={f.valueDecimals} onChange={(e) => upd(i, { valueDecimals: Math.min(3, num(e.target.value)) })} /></Field>
          <div className="flex items-center gap-2 pb-2"><Checkbox label="On" checked={f.enabled} onChange={(v) => upd(i, { enabled: v })} /><Button size="sm" variant="ghost" aria-label="Remove layout" onClick={() => setFormats(list.filter((_, j) => j !== i))}><Icon name="x" className="h-4 w-4" /></Button></div>
        </div>
      ))}
      {problems.map((p) => <div key={p} className="text-sm text-red-600">{p}</div>)}
      <div className="mt-2 flex flex-wrap gap-2">
        {SCALE_FORMAT_PRESETS.map((p) => <Button key={p.name} size="sm" variant="secondary" onClick={() => setFormats([...list, { ...p, id: `f${Date.now()}` }])}>+ {p.name}</Button>)}
      </div>
    </Card>
  );
}
