import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MODULE_INFO, MODULES, PAYMENT_PROVIDER_INFO, PAYMENT_PROVIDERS, ROLE_LABELS, TENANT_ROLES, type ModuleKey, type PaymentProviderKey } from '@afeypos/shared';
import { api, download } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useLocations } from '../../lib/hooks';
import { dateTime, money } from '../../lib/format';
import { getWorkstation, setWorkstation } from '../../lib/workstation';
import { DataTable } from '../../components/DataTable';
import { Badge, Button, Card, Checkbox, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, StatusBadge, Tabs, useConfirm, useToast } from '../../components/ui';
import { Icon } from '../../components/icons';

export function BusinessSettingsPage() {
  const { me, reload } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['business-settings'], queryFn: () => api<{ data: any }>('/settings/business').then((r) => r.data) });
  const [f, setF] = useState<any>(null);
  const [tab, setTab] = useState('general');
  useEffect(() => { if (q.data) setF({ name: q.data.name, contact: q.data.contact ?? {}, settings: q.data.settings }); }, [q.data]);
  if (!q.data || !f) return <Loading />;
  const s = f.settings;
  const setS = (k: string, v: any) => setF({ ...f, settings: { ...s, [k]: v } });
  const save = async () => {
    try {
      await api('/settings/business', { method: 'PATCH', body: { name: f.name, contact: { email: f.contact.email || undefined, phone: f.contact.phone || undefined, address: f.contact.address || undefined }, settings: { currency: s.currency, timezone: s.timezone, locale: s.locale, taxPin: s.taxPin ?? '', defaultTaxRateBp: s.defaultTaxRateBp, pricesIncludeTax: s.pricesIncludeTax, allowNegativeStock: s.allowNegativeStock, requireOpenShift: s.requireOpenShift, cashierDiscountLimitBp: s.cashierDiscountLimitBp, receiptHeader: s.receiptHeader ?? '', receiptFooter: s.receiptFooter ?? '', logoFileId: s.logoFileId ?? '', tagline: s.tagline ?? '', stkPendingTimeoutSeconds: s.stkPendingTimeoutSeconds, variableWeight: s.variableWeight, loyalty: s.loyalty, restrictedSaleHours: { start: s.restrictedSaleHours?.start ?? '', end: s.restrictedSaleHours?.end ?? '' }, dailyReportEmails: s.dailyReportEmails ?? [], creditReminders: s.creditReminders } } });
      await reload();
      toast.success('Settings saved');
    } catch (e) { toast.error(e); }
  };
  const enabled = new Set<ModuleKey>(me!.capabilities.modules);
  const toggleModule = async (m: ModuleKey, on: boolean) => {
    if (!on && !(await confirm({ title: `Hide ${MODULE_INFO[m].label}?`, message: 'The module is hidden from menus and its API is disabled. Existing data is kept and returns when you enable it again.', confirmLabel: 'Hide module' }))) return;
    const en = new Set<ModuleKey>((q.data.enabledModules ?? []) as ModuleKey[]);
    const dis = new Set<ModuleKey>((q.data.disabledModules ?? []) as ModuleKey[]);
    if (on) { en.add(m); dis.delete(m); } else { en.delete(m); dis.add(m); }
    try { await api('/settings/modules', { method: 'PUT', body: { enabled: [...en], disabled: [...dis] } }); await q.refetch(); await reload(); } catch (e) { toast.error(e); }
  };
  return (
    <div className="max-w-5xl">
      <PageHeader title="Business settings" subtitle={`${q.data.slug} · ${q.data.businessType}${q.data.plan ? ` · ${q.data.plan.name} plan` : ''}`} actions={tab !== 'modules' && <Button onClick={save}>Save</Button>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'general', label: 'General' }, { key: 'sales', label: 'Sales & tax' }, { key: 'modules', label: 'Modules' }, { key: 'workstation', label: 'This device' }, { key: 'data', label: 'Backups & support' }]} />
      {tab === 'general' && (
        <Card><div className="grid gap-3 sm:grid-cols-2">
          <Field label="Business name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="KRA PIN / tax registration"><Input value={s.taxPin ?? ''} onChange={(e) => setS('taxPin', e.target.value)} /></Field>
          <Field label="Phone"><Input value={f.contact.phone ?? ''} onChange={(e) => setF({ ...f, contact: { ...f.contact, phone: e.target.value } })} /></Field>
          <Field label="Email"><Input value={f.contact.email ?? ''} onChange={(e) => setF({ ...f, contact: { ...f.contact, email: e.target.value } })} /></Field>
          <Field label="Address" className="sm:col-span-2"><Input value={f.contact.address ?? ''} onChange={(e) => setF({ ...f, contact: { ...f.contact, address: e.target.value } })} /></Field>
          <Field label="Currency"><Input value={s.currency} maxLength={3} onChange={(e) => setS('currency', e.target.value.toUpperCase())} /></Field>
          <Field label="Timezone" hint="Used for reports and receipts"><Input value={s.timezone} onChange={(e) => setS('timezone', e.target.value)} /></Field>
          <Field label="Receipt header"><Input value={s.receiptHeader ?? ''} onChange={(e) => setS('receiptHeader', e.target.value)} /></Field>
          <Field label="Receipt footer"><Input value={s.receiptFooter ?? ''} onChange={(e) => setS('receiptFooter', e.target.value)} /></Field>
          <Field label="Tagline" hint="Shown under your name on the sign-in page"><Input maxLength={120} value={s.tagline ?? ''} onChange={(e) => setS('tagline', e.target.value)} placeholder="e.g. Quality building materials since 2005" /></Field>
          <div className="sm:col-span-2"><BusinessLogoField fileId={s.logoFileId} onChange={(id) => setS('logoFileId', id)} /></div>
        </div></Card>
      )}
      {tab === 'sales' && (
        <Card><div className="grid gap-4 sm:grid-cols-2">
          <Field label="Default tax rate %"><Input inputMode="decimal" value={s.defaultTaxRateBp / 100} onChange={(e) => setS('defaultTaxRateBp', Math.round(Number(e.target.value) * 100))} /></Field>
          <Field label="Cashier discount limit %" hint="Larger discounts need a supervisor"><Input inputMode="decimal" value={s.cashierDiscountLimitBp / 100} onChange={(e) => setS('cashierDiscountLimitBp', Math.round(Number(e.target.value) * 100))} /></Field>
          <Checkbox label="Prices include tax" checked={s.pricesIncludeTax} onChange={(v) => setS('pricesIncludeTax', v)} />
          <Checkbox label="Require an open shift to sell" checked={s.requireOpenShift} onChange={(v) => setS('requireOpenShift', v)} />
          <Checkbox label="Allow selling below zero stock (not recommended)" checked={s.allowNegativeStock} onChange={(v) => setS('allowNegativeStock', v)} />
          <Field label="M-Pesa wait time (seconds)"><Input type="number" value={s.stkPendingTimeoutSeconds} onChange={(e) => setS('stkPendingTimeoutSeconds', Number(e.target.value))} /></Field>
          {enabled.has('weighedItems') && (
            <div className="sm:col-span-2 rounded-lg border border-ink-200 p-3 dark:border-ink-700">
              <Checkbox label="Read scale (variable-weight) barcodes" checked={s.variableWeight?.enabled} onChange={(v) => setS('variableWeight', { ...s.variableWeight, enabled: v })} />
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                <Field label="Value type"><Select value={s.variableWeight?.valueType} onChange={(e) => setS('variableWeight', { ...s.variableWeight, valueType: e.target.value })} options={[{ value: 'weight', label: 'Weight' }, { value: 'price', label: 'Price' }]} /></Field>
                <Field label="Decimals"><Input type="number" value={s.variableWeight?.valueDecimals} onChange={(e) => setS('variableWeight', { ...s.variableWeight, valueDecimals: Number(e.target.value) })} /></Field>
                <Field label="Prefixes"><Input value={(s.variableWeight?.prefixes ?? []).join(',')} onChange={(e) => setS('variableWeight', { ...s.variableWeight, prefixes: e.target.value.split(',').map((x: string) => x.trim()).filter(Boolean) })} /></Field>
              </div>
            </div>
          )}
          <Field label="Daily sales summary emails" hint="Comma separated; sent at 21:00 local time" className="sm:col-span-2"><Input value={(s.dailyReportEmails ?? []).join(', ')} onChange={(e) => setS('dailyReportEmails', e.target.value.split(',').map((x: string) => x.trim()).filter(Boolean))} /></Field>
          {enabled.has('customerCredit') && (
            <div className="flex flex-wrap items-end gap-3 sm:col-span-2">
              <Checkbox label="SMS reminders for overdue customer balances (09:00, weekly per customer)" checked={Boolean(s.creditReminders?.enabled)} onChange={(v) => setS('creditReminders', { ...s.creditReminders, enabled: v })} />
              <Field label="Days overdue"><Input type="number" className="w-24" value={s.creditReminders?.overdueDays ?? 7} onChange={(e) => setS('creditReminders', { ...s.creditReminders, overdueDays: Number(e.target.value) })} /></Field>
            </div>
          )}
          {enabled.has('ageVerification') && (
            <div className="grid gap-2 sm:col-span-2 sm:grid-cols-2">
              <Field label="Licensed sale hours: from" hint="Age-restricted products only (leave blank for no limit)"><Input type="time" value={s.restrictedSaleHours?.start ?? ''} onChange={(e) => setS('restrictedSaleHours', { ...s.restrictedSaleHours, start: e.target.value })} /></Field>
              <Field label="Licensed sale hours: until"><Input type="time" value={s.restrictedSaleHours?.end ?? ''} onChange={(e) => setS('restrictedSaleHours', { ...s.restrictedSaleHours, end: e.target.value })} /></Field>
            </div>
          )}
          {enabled.has('loyalty') && (
            <div className="sm:col-span-2 grid gap-2 sm:grid-cols-2">
              <Field label="Spend per point" hint="e.g. 100 = 1 point per KES 100"><Input inputMode="decimal" value={(s.loyalty?.pointsPerUnitCents ?? 10000) / 100} onChange={(e) => setS('loyalty', { ...s.loyalty, pointsPerUnitCents: Math.round(Number(e.target.value) * 100) })} /></Field>
              <Field label="Value of one point"><Input inputMode="decimal" value={(s.loyalty?.pointValueCents ?? 100) / 100} onChange={(e) => setS('loyalty', { ...s.loyalty, pointValueCents: Math.round(Number(e.target.value) * 100) })} /></Field>
            </div>
          )}
        </div></Card>
      )}
      {tab === 'modules' && (
        <Card>
          <p className="mb-3 text-sm text-ink-500">Your business type sets sensible defaults. Turn modules on or off at any time; data is never deleted.</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {MODULES.map((m) => (
              <label key={m} className="flex items-start gap-3 rounded-lg border border-ink-200 p-3 dark:border-ink-700">
                <input type="checkbox" className="mt-1 h-4 w-4" checked={enabled.has(m)} disabled={m === 'pos' || m === 'inventory'} onChange={(e) => toggleModule(m, e.target.checked)} />
                <span><span className="font-medium">{MODULE_INFO[m].label}</span><span className="block text-xs text-ink-500">{MODULE_INFO[m].description}</span></span>
              </label>
            ))}
          </div>
        </Card>
      )}
      {tab === 'workstation' && <WorkstationSettings />}
      {tab === 'data' && <DataSettings />}
    </div>
  );
}

function WorkstationSettings() {
  const locs = useLocations();
  const [w, setW] = useState(getWorkstation());
  const update = (patch: any) => setW(setWorkstation(patch));
  return (
    <Card title="This computer">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Till"><Select value={w.tillId ?? ''} onChange={(e) => update({ tillId: e.target.value || undefined })} placeholder="Not set" options={(locs.data?.tills ?? []).map((t) => ({ value: t._id, label: t.name }))} /></Field>
        <Field label="Receipt width (characters)"><Select value={String(w.receiptWidth ?? 42)} onChange={(e) => update({ receiptWidth: Number(e.target.value) })} options={[{ value: '32', label: '58 mm (32)' }, { value: '42', label: '80 mm (42)' }, { value: '48', label: '80 mm (48)' }]} /></Field>
        <Checkbox label="Print receipt automatically after each sale" checked={Boolean(w.autoPrint)} onChange={(v) => update({ autoPrint: v })} />
      </div>
      <p className="mt-3 text-xs text-ink-500">USB/keyboard-wedge barcode scanners work in the checkout search box without configuration. Receipt printers are configured under Hardware.</p>
    </Card>
  );
}

function DataSettings() {
  const { me } = useAuth();
  const toast = useToast();
  const backups = useQuery({ queryKey: ['backups'], queryFn: () => api<{ data: any[] }>('/backups').then((r) => r.data) });
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-4">
      <Card title="Backups of this installation" actions={<Button size="sm" loading={busy} onClick={async () => { setBusy(true); try { await api('/backups', { body: {} }); backups.refetch(); toast.success('Backup created'); } catch (e) { toast.error(e); } finally { setBusy(false); } }}>Back up now</Button>}>
        <DataTable rows={backups.data} loading={backups.isLoading} empty="No backups yet" columns={[
          { key: 'd', header: 'Started', render: (r: any) => dateTime(r.startedAt) }, { key: 's', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
          { key: 'n', header: 'Records', className: 'num', render: (r: any) => r.documents ?? '' }, { key: 'z', header: 'Size', className: 'num', render: (r: any) => (r.sizeBytes ? `${(r.sizeBytes / 1024 / 1024).toFixed(2)} MB` : '') },
          { key: 'h', header: 'SHA-256', render: (r: any) => <code className="text-[10px]">{r.sha256?.slice(0, 16)}</code> },
          { key: 'a', header: '', render: (r: any) => r.status === 'completed' && <Button size="sm" variant="secondary" onClick={() => download(`/backups/${r._id}/download`, `afeypos-backup-${r._id}.ndjson.gz`)}>Download</Button> },
        ]} />
        <p className="mt-2 text-xs text-ink-500">Automatic backups run on the schedule set in the server configuration{me!.deploymentMode === 'branch' ? '; this branch also syncs to head office' : ''}. Copy backups to an external drive or cloud storage regularly. See docs/BACKUP.md for restoring.</p>
      </Card>
    </div>
  );
}

export function UsersPage() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const locs = useLocations();
  const list = useQuery({ queryKey: ['users'], queryFn: () => api<{ data: any[] }>('/settings/users').then((r) => r.data) });
  const [edit, setEdit] = useState<any>(null);
  const [error, setError] = useState<unknown>(null);
  const roles = TENANT_ROLES.filter((r) => r !== 'tenant_owner' || me!.user.roles.includes('tenant_owner'));
  const save = async () => {
    setError(null);
    try {
      const body: any = { name: edit.name, email: edit.email, phone: edit.phone || undefined, roles: edit.roles, branchIds: edit.branchIds ?? [], commissionRateBp: Number(edit.commissionRateBp ?? 0), employeeNo: edit.employeeNo || undefined };
      if (edit.password) body.password = edit.password;
      if (edit.pin) body.pin = edit.pin;
      if (edit._id) await api(`/settings/users/${edit._id}`, { method: 'PATCH', body: { ...body, pin: undefined } });
      else await api('/settings/users', { body });
      setEdit(null);
      qc.invalidateQueries({ queryKey: ['users'] });
      toast.success('User saved');
    } catch (e) { setError(e); }
  };
  return (
    <div>
      <PageHeader title="Users & roles" actions={<Button onClick={() => setEdit({ name: '', email: '', roles: ['cashier'], branchIds: [] })}><Icon name="plus" className="h-4 w-4" />Add user</Button>} />
      <div className="card"><DataTable rows={list.data} loading={list.isLoading} error={list.error} onRowClick={(r: any) => setEdit({ ...r })} columns={[
        { key: 'n', header: 'Name', render: (r: any) => <div><div className="font-medium">{r.name}</div><div className="text-xs text-ink-500">{r.email}</div></div> },
        { key: 'r', header: 'Roles', render: (r: any) => <div className="flex flex-wrap gap-1">{r.roles.map((x: string) => <Badge key={x}>{ROLE_LABELS[x as keyof typeof ROLE_LABELS] ?? x}</Badge>)}</div> },
        { key: 'b', header: 'Branches', render: (r: any) => (r.branchIds?.length ? r.branchIds.map((b: string) => locs.data?.branches.find((x) => x._id === b)?.name).join(', ') : 'All') },
        { key: 'sec', header: 'Security', render: (r: any) => <div className="flex gap-1">{r.twoFactorEnabled && <Badge tone="green">2FA</Badge>}{r.hasPin && <Badge>PIN</Badge>}</div> },
        { key: 'l', header: 'Last sign-in', render: (r: any) => dateTime(r.lastLoginAt) },
        { key: 's', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
      ]} /></div>
      {edit && (
        <Modal open onClose={() => setEdit(null)} title={edit._id ? `Edit ${edit.name}` : 'Add user'} size="lg" footer={<>
          {edit._id && edit._id !== me!.user.id && <Button variant={edit.status === 'disabled' ? 'secondary' : 'danger'} onClick={async () => { try { await api(`/settings/users/${edit._id}`, { method: 'PATCH', body: { status: edit.status === 'disabled' ? 'active' : 'disabled' } }); setEdit(null); qc.invalidateQueries({ queryKey: ['users'] }); } catch (e) { setError(e); } }}>{edit.status === 'disabled' ? 'Enable' : 'Disable'} user</Button>}
          <Button onClick={save}>Save</Button></>}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Email"><Input value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>
            <Field label="Phone"><Input value={edit.phone ?? ''} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></Field>
            <Field label="Employee number"><Input value={edit.employeeNo ?? ''} onChange={(e) => setEdit({ ...edit, employeeNo: e.target.value })} /></Field>
            <Field label={edit._id ? 'New password (optional)' : 'Password'}><Input type="password" value={edit.password ?? ''} onChange={(e) => setEdit({ ...edit, password: e.target.value })} /></Field>
            {!edit._id && <Field label="Till PIN (optional, 4-8 digits)"><Input inputMode="numeric" value={edit.pin ?? ''} onChange={(e) => setEdit({ ...edit, pin: e.target.value })} /></Field>}
            {me!.capabilities.modules.includes('salesReps') && <Field label="Commission %"><Input inputMode="decimal" value={(edit.commissionRateBp ?? 0) / 100} onChange={(e) => setEdit({ ...edit, commissionRateBp: Math.round(Number(e.target.value) * 100) })} /></Field>}
          </div>
          <div className="mt-4"><div className="label">Roles</div><div className="grid gap-2 sm:grid-cols-3">{roles.map((r) => <Checkbox key={r} label={ROLE_LABELS[r]} checked={edit.roles.includes(r)} onChange={(v) => setEdit({ ...edit, roles: v ? [...edit.roles, r] : edit.roles.filter((x: string) => x !== r) })} />)}</div></div>
          {(locs.data?.branches.length ?? 0) > 1 && <div className="mt-4"><div className="label">Branch access (none selected = all)</div><div className="flex flex-wrap gap-3">{locs.data!.branches.map((b) => <Checkbox key={b._id} label={b.name} checked={(edit.branchIds ?? []).includes(b._id)} onChange={(v) => setEdit({ ...edit, branchIds: v ? [...(edit.branchIds ?? []), b._id] : edit.branchIds.filter((x: string) => x !== b._id) })} />)}</div></div>}
          <div className="mt-3"><ErrorBox error={error} /></div>
        </Modal>
      )}
    </div>
  );
}

export function LocationsPage() {
  const locs = useLocations();
  const qc = useQueryClient();
  const toast = useToast();
  const [modal, setModal] = useState<null | 'branch' | 'warehouse' | 'till'>(null);
  const [f, setF] = useState<any>({});
  const [error, setError] = useState<unknown>(null);
  if (!locs.data) return <Loading />;
  const { branches, warehouses, tills } = locs.data;
  const submit = async () => {
    try {
      await api(`/settings/${modal === 'branch' ? 'branches' : modal === 'warehouse' ? 'warehouses' : 'tills'}`, { body: f });
      setModal(null); setF({}); qc.invalidateQueries({ queryKey: ['locations'] }); toast.success('Saved');
    } catch (e) { setError(e); }
  };
  return (
    <div className="max-w-5xl">
      <PageHeader title="Branches, stores & tills" actions={<><Button variant="secondary" onClick={() => { setF({}); setModal('branch'); }}>Add branch</Button><Button variant="secondary" onClick={() => { setF({ branchId: branches[0]?._id }); setModal('warehouse'); }}>Add store</Button><Button onClick={() => { setF({ branchId: branches[0]?._id, warehouseId: warehouses[0]?._id }); setModal('till'); }}>Add till</Button></>} />
      <div className="space-y-4">{branches.map((b) => (
        <Card key={b._id} title={`${b.name} (${b.code})`}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div><div className="label">Stock locations</div>{warehouses.filter((w) => w.branchId === b._id).map((w) => <div key={w._id} className="text-sm">{w.name} {w.isDefault && <Badge>default</Badge>}</div>)}</div>
            <div><div className="label">Tills</div>{tills.filter((t) => t.branchId === b._id).map((t) => <div key={t._id} className="flex items-center gap-2 text-sm">{t.name} ({t.code}) {!t.active && <Badge tone="red">inactive</Badge>}</div>)}</div>
          </div>
        </Card>
      ))}</div>
      <Modal open={Boolean(modal)} onClose={() => setModal(null)} title={`Add ${modal}`} footer={<Button onClick={submit}>Save</Button>}>
        <div className="grid gap-3">
          {modal !== 'branch' && <Field label="Branch"><Select value={f.branchId ?? ''} onChange={(e) => setF({ ...f, branchId: e.target.value })} options={branches.map((b) => ({ value: b._id, label: b.name }))} /></Field>}
          {modal === 'till' && <Field label="Sells from"><Select value={f.warehouseId ?? ''} onChange={(e) => setF({ ...f, warehouseId: e.target.value })} options={warehouses.filter((w) => w.branchId === f.branchId).map((w) => ({ value: w._id, label: w.name }))} /></Field>}
          <Field label="Name"><Input value={f.name ?? ''} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Code" hint="Short letters/numbers, e.g. T2"><Input value={f.code ?? ''} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
          <ErrorBox error={error} />
        </div>
      </Modal>
    </div>
  );
}

const PROVIDER_FIELDS: Record<string, { settings: [string, string][]; secrets: [string, string][] }> = {
  daraja: { settings: [['shortCode', 'Business short code'], ['type', 'Type (paybill or till)'], ['tillNumber', 'Till number (Buy Goods)']], secrets: [['consumerKey', 'Consumer key'], ['consumerSecret', 'Consumer secret'], ['passkey', 'Lipa na M-Pesa passkey']] },
  mock: { settings: [['shortCode', 'Short code'], ['type', 'Type']], secrets: [] },
  talksasa: { settings: [['senderId', 'Sender ID'], ['baseUrl', 'API base URL (optional)']], secrets: [['apiToken', 'API token']] },
  africastalking: { settings: [['username', 'Username'], ['senderId', 'Sender ID / short code']], secrets: [['apiKey', 'API key']] },
  smtp: { settings: [['host', 'SMTP host'], ['port', 'Port'], ['user', 'Username'], ['from', 'From address']], secrets: [['password', 'Password']] },
  console: { settings: [], secrets: [] },
};

const providerLabel = (kind: string, p: string) =>
  kind === 'payment' ? PAYMENT_PROVIDER_INFO[p as PaymentProviderKey]?.label ?? p : p === 'mock' ? 'Simulator (testing)' : p === 'console' ? 'Development log (no delivery)' : p === 'daraja' ? 'Safaricom Daraja' : p;

/** Provider chips (M-Pesa + gateways); "soon" providers are shown but cannot be configured yet. */
function PaymentProviderGrid({ onPick }: { onPick: (kind: 'mpesa' | 'payment', provider: string) => void }) {
  const chips = [{ key: 'mpesa', label: 'M-Pesa', soon: false }, ...PAYMENT_PROVIDERS.filter((p) => !PAYMENT_PROVIDER_INFO[p].devOnly).map((p) => ({ key: p, label: PAYMENT_PROVIDER_INFO[p].label, soon: PAYMENT_PROVIDER_INFO[p].availability === 'soon' }))];
  return (
    <div className="flex flex-wrap gap-2">
      {chips.map((c) => (
        <button key={c.key} type="button" disabled={c.soon} title={c.key === 'mpesa' ? 'Safaricom Daraja STK Push and C2B' : PAYMENT_PROVIDER_INFO[c.key as PaymentProviderKey].description}
          onClick={() => (c.key === 'mpesa' ? onPick('mpesa', 'daraja') : onPick('payment', c.key))}
          className="inline-flex items-center gap-2 rounded-full border border-ink-200 bg-white px-3.5 py-1.5 text-sm font-medium shadow-sm transition hover:border-brand-400 hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-ink-200 disabled:hover:bg-white dark:border-ink-700 dark:bg-ink-900 dark:hover:bg-ink-800">
          <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden style={c.soon ? { background: '#a9a7a2' } : undefined} />
          {c.label}
          {c.soon && <span className="rounded bg-ink-100 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-ink-500 dark:bg-ink-800">SOON</span>}
        </button>
      ))}
    </div>
  );
}

export function IntegrationsPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['integrations'], queryFn: () => api<{ data: any[]; providers: Record<string, string[]>; callbackUrls: Record<string, string> }>('/settings/integrations') });
  const [edit, setEdit] = useState<any>(null);
  const [testTo, setTestTo] = useState('');
  const [error, setError] = useState<unknown>(null);
  if (!q.data) return <Loading />;
  const save = async () => {
    setError(null);
    try {
      const body = { provider: edit.provider, name: edit.name, enabled: edit.enabled, isDefault: edit.isDefault, environment: edit.environment, settings: edit.settings, secrets: edit.secrets };
      if (edit.id) await api(`/settings/integrations/${edit.id}`, { method: 'PATCH', body });
      else await api('/settings/integrations', { body: { kind: edit.kind, ...body } });
      setEdit(null); qc.invalidateQueries({ queryKey: ['integrations'] }); toast.success('Saved. Secrets are stored encrypted and never shown again.');
    } catch (e) { setError(e); }
  };
  const test = async (id: string) => { try { const r = await api<{ data: any }>(`/settings/integrations/${id}/test`, { body: { to: testTo || undefined } }); if (r.data.ok) toast.success(r.data.message); else toast.error(r.data.message); q.refetch(); } catch (e) { toast.error(e); } };
  return (
    <div className="max-w-5xl">
      <PageHeader title="Integrations" subtitle="Payments, SMS and email. Credentials stay on the server." actions={<>{(['mpesa', 'sms', 'email'] as const).map((k) => <Button key={k} variant="secondary" onClick={() => setEdit({ kind: k, provider: q.data.providers[k][0], name: '', enabled: true, isDefault: true, environment: 'sandbox', settings: {}, secrets: {} })}>Add {k}</Button>)}</>} />
      <Card title="Payment methods" className="mb-4">
        <p className="mb-3 text-sm text-ink-600 dark:text-ink-300">Pick a provider to connect it. Payments are only accepted after the provider confirms them to the server.</p>
        <PaymentProviderGrid onPick={(kind, provider) => setEdit({ kind, provider, name: kind === 'mpesa' ? 'M-Pesa' : PAYMENT_PROVIDER_INFO[provider as PaymentProviderKey].label, enabled: true, isDefault: true, environment: 'sandbox', settings: {}, secrets: {} })} />
        <button type="button" className="mt-3 text-xs text-ink-500 underline" onClick={() => setEdit({ kind: 'payment', provider: 'simulator', name: 'Payment simulator', enabled: true, isDefault: false, environment: 'sandbox', settings: {}, secrets: {} })}>Add the payment simulator (training and testing; never moves money)</button>
      </Card>
      <Card title="M-Pesa callback URLs (register these with Safaricom)" className="mb-4">
        <dl className="space-y-1 text-xs">{Object.entries(q.data.callbackUrls).map(([k, v]) => <div key={k}><dt className="font-medium">{k}</dt><dd className="break-all font-mono text-ink-600">{v}</dd></div>)}</dl>
        <p className="mt-2 text-xs text-ink-500">These URLs contain a secret token. They must be public HTTPS addresses reachable by Safaricom.</p>
      </Card>
      <div className="mb-3 flex items-center gap-2"><Input className="max-w-xs" placeholder="Test recipient (phone or email)" value={testTo} onChange={(e) => setTestTo(e.target.value)} /></div>
      <div className="card"><DataTable rows={q.data.data} empty="No integrations yet" columns={[
        { key: 'k', header: 'Type', render: (r: any) => (r.kind === 'payment' ? 'payment gateway' : r.kind) }, { key: 'n', header: 'Name', render: (r: any) => <span>{r.name}{!r.enabled && <span className="ml-1"><Badge tone="gray">disabled</Badge></span>}</span> }, { key: 'p', header: 'Provider', render: (r: any) => providerLabel(r.kind, r.provider) },
        { key: 'e', header: 'Mode', render: (r: any) => <Badge tone={r.environment === 'production' ? 'green' : 'amber'}>{r.environment}</Badge> },
        { key: 's', header: 'Secrets', render: (r: any) => <span className="text-xs">{r.secretsSet.join(', ') || 'none'}</span> },
        { key: 't', header: 'Last test', render: (r: any) => (r.lastTest ? <Badge tone={r.lastTest.ok ? 'green' : 'red'}>{r.lastTest.ok ? 'ok' : 'failed'}</Badge> : '—') },
        { key: 'a', header: '', render: (r: any) => <div className="flex gap-1"><Button size="sm" variant="secondary" onClick={() => test(r.id)}>Test</Button><Button size="sm" variant="secondary" onClick={() => setEdit({ ...r, secrets: {} })}>Edit</Button>{r.kind === 'mpesa' && <Button size="sm" variant="secondary" onClick={() => api(`/settings/integrations/${r.id}/register-c2b`, { body: {} }).then(() => toast.success('C2B URLs registered')).catch(toast.error)}>Register C2B</Button>}</div> },
      ]} /></div>
      {edit && (
        <Modal open onClose={() => setEdit(null)} title={`${edit.id ? 'Edit' : 'Add'} ${edit.kind === 'payment' ? providerLabel('payment', edit.provider) : edit.kind} integration`} size="lg" footer={<Button onClick={save}>Save</Button>}>
          {edit.kind === 'payment' && (
            <p className="mb-3 text-sm text-ink-600 dark:text-ink-300">
              {PAYMENT_PROVIDER_INFO[edit.provider as PaymentProviderKey]?.description}{' '}
              {PAYMENT_PROVIDER_INFO[edit.provider as PaymentProviderKey]?.docsUrl && <a className="text-brand-700 underline dark:text-brand-200" href={PAYMENT_PROVIDER_INFO[edit.provider as PaymentProviderKey].docsUrl} target="_blank" rel="noreferrer">API docs</a>}
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Provider"><Select value={edit.provider} disabled={Boolean(edit.id)} onChange={(e) => setEdit({ ...edit, provider: e.target.value })} options={q.data.providers[edit.kind].map((p) => ({ value: p, label: providerLabel(edit.kind, p) }))} /></Field>
            <Field label="Name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Environment"><Select value={edit.environment} onChange={(e) => setEdit({ ...edit, environment: e.target.value })} options={[{ value: 'sandbox', label: 'Sandbox / test' }, { value: 'production', label: 'Production (live money)' }]} /></Field>
            <div className="flex items-end gap-4"><Checkbox label="Enabled" checked={edit.enabled} onChange={(v) => setEdit({ ...edit, enabled: v })} /><Checkbox label="Default" checked={edit.isDefault} onChange={(v) => setEdit({ ...edit, isDefault: v })} /></div>
            {edit.kind === 'payment' && PAYMENT_PROVIDER_INFO[edit.provider as PaymentProviderKey]?.fields.map((f) =>
              f.secret ? (
                <Field key={f.key} label={`${f.label}${f.required ? ' *' : ''}`} hint={edit.secretsSet?.includes(f.key) ? 'Saved. Leave blank to keep.' : f.help}><Input type="password" autoComplete="new-password" value={edit.secrets?.[f.key] ?? ''} onChange={(e) => setEdit({ ...edit, secrets: { ...edit.secrets, [f.key]: e.target.value } })} /></Field>
              ) : f.options ? (
                <Field key={f.key} label={`${f.label}${f.required ? ' *' : ''}`} hint={f.help}><Select value={edit.settings?.[f.key] ?? ''} onChange={(e) => setEdit({ ...edit, settings: { ...edit.settings, [f.key]: e.target.value } })} options={[{ value: '', label: 'Select…' }, ...f.options]} /></Field>
              ) : (
                <Field key={f.key} label={`${f.label}${f.required ? ' *' : ''}`} hint={f.help}><Input value={edit.settings?.[f.key] ?? ''} placeholder={f.placeholder} onChange={(e) => setEdit({ ...edit, settings: { ...edit.settings, [f.key]: e.target.value } })} /></Field>
              ),
            )}
            {edit.kind === 'payment' && edit.webhookUrl && (
              <div className="sm:col-span-2"><div className="label">Webhook / callback URL (set this in the provider dashboard if asked)</div><div className="break-all rounded bg-ink-50 p-2 font-mono text-xs dark:bg-ink-800">{edit.webhookUrl}</div><p className="mt-1 text-xs text-ink-500">Contains a secret token. Charges started from the till send it automatically where the provider supports per-request callbacks.</p></div>
            )}
            {(PROVIDER_FIELDS[edit.provider]?.settings ?? []).map(([k, l]) => <Field key={k} label={l}><Input value={edit.settings?.[k] ?? ''} onChange={(e) => setEdit({ ...edit, settings: { ...edit.settings, [k]: k === 'port' ? Number(e.target.value) : e.target.value } })} /></Field>)}
            {(PROVIDER_FIELDS[edit.provider]?.secrets ?? []).map(([k, l]) => <Field key={k} label={l} hint={edit.secretsSet?.includes(k) ? 'Saved. Leave blank to keep.' : undefined}><Input type="password" autoComplete="new-password" value={edit.secrets?.[k] ?? ''} onChange={(e) => setEdit({ ...edit, secrets: { ...edit.secrets, [k]: e.target.value } })} /></Field>)}
            {edit.kind === 'mpesa' && edit.provider === 'daraja' && <Checkbox label="Double-check every callback with an STK status query" checked={Boolean(edit.settings?.verifyCallbacksWithQuery)} onChange={(v) => setEdit({ ...edit, settings: { ...edit.settings, verifyCallbacksWithQuery: v } })} />}
          </div>
          <div className="mt-3"><ErrorBox error={error} /></div>
        </Modal>
      )}
    </div>
  );
}

export function HardwarePage() {
  const toast = useToast();
  const qc = useQueryClient();
  const locs = useLocations();
  const q = useQuery({ queryKey: ['devices'], queryFn: () => api<{ data: any[] }>('/hardware/devices').then((r) => r.data) });
  const [edit, setEdit] = useState<any>(null);
  return (
    <div className="max-w-5xl">
      <PageHeader title="Hardware" subtitle="Printers, cash drawers, scanners, scales and displays" actions={<Button onClick={() => setEdit({ kind: 'receipt_printer', name: '', connection: 'network', settings: { port: 9100, width: 42 } })}><Icon name="plus" className="h-4 w-4" />Add device</Button>} />
      <Card className="mb-4" title="Compatibility">
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink-600 dark:text-ink-300">
          <li>Barcode scanners: any USB/Bluetooth scanner in keyboard (HID) mode works in checkout. Configure the scanner to send Enter after each code.</li>
          <li>Receipt printers: ESC/POS thermal printers (58/80 mm). Network printers (port 9100) print directly from a local installation; USB printers print through the browser or the Afey device bridge.</li>
          <li>Cash drawers: connected to the receipt printer's DK port; opened by the ESC/POS kick command on cash sales.</li>
          <li>Label printers: browser labels (any printer) or ZPL/TSPL for Zebra/TSC-compatible printers.</li>
          <li>Scales, customer displays, RFID and fingerprint readers need the device bridge on the till PC; see docs/HARDWARE.md. Not every model has been tested.</li>
        </ul>
      </Card>
      <div className="card"><DataTable rows={q.data} loading={q.isLoading} empty="No devices configured" columns={[
        { key: 'k', header: 'Type', render: (r: any) => r.kind.replace(/_/g, ' ') }, { key: 'n', header: 'Name', render: (r: any) => r.name }, { key: 'c', header: 'Connection', render: (r: any) => `${r.connection}${r.settings?.host ? ` ${r.settings.host}:${r.settings.port ?? 9100}` : ''}` },
        { key: 't', header: 'Till', render: (r: any) => locs.data?.tills.find((t) => t._id === r.tillId)?.name ?? '—' },
        { key: 's', header: 'Status', render: (r: any) => (r.status?.lastCheckAt ? <Badge tone={r.status.ok ? 'green' : 'red'}>{r.status.ok ? 'ok' : 'error'}</Badge> : '—') },
        { key: 'a', header: '', render: (r: any) => <div className="flex gap-1"><Button size="sm" variant="secondary" onClick={() => api<{ data: any }>(`/hardware/devices/${r._id}/test`, { body: {} }).then((x) => { if (x.data.ok) toast.success(x.data.message); else toast.error(x.data.message); q.refetch(); })}>Test</Button><Button size="sm" variant="secondary" onClick={() => setEdit(r)}>Edit</Button></div> },
      ]} /></div>
      {edit && (
        <Modal open onClose={() => setEdit(null)} title="Device" footer={<Button onClick={async () => { try { const body = { kind: edit.kind, name: edit.name, connection: edit.connection, tillId: edit.tillId || undefined, settings: edit.settings }; if (edit._id) await api(`/hardware/devices/${edit._id}`, { method: 'PATCH', body }); else await api('/hardware/devices', { body }); setEdit(null); qc.invalidateQueries({ queryKey: ['devices'] }); } catch (e) { toast.error(e); } }}>Save</Button>}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Type"><Select value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })} options={['receipt_printer', 'label_printer', 'a4_printer', 'cash_drawer', 'customer_display', 'scale', 'barcode_scanner', 'rfid_reader', 'fingerprint_reader'].map((x) => ({ value: x, label: x.replace(/_/g, ' ') }))} /></Field>
            <Field label="Name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Connection"><Select value={edit.connection} onChange={(e) => setEdit({ ...edit, connection: e.target.value })} options={['network', 'usb', 'serial', 'bluetooth', 'bridge', 'browser', 'keyboard_wedge'].map((x) => ({ value: x, label: x.replace('_', ' ') }))} /></Field>
            <Field label="Till"><Select value={edit.tillId ?? ''} onChange={(e) => setEdit({ ...edit, tillId: e.target.value })} placeholder="Any" options={(locs.data?.tills ?? []).map((t) => ({ value: t._id, label: t.name }))} /></Field>
            {edit.connection === 'network' && <><Field label="IP address"><Input value={edit.settings?.host ?? ''} onChange={(e) => setEdit({ ...edit, settings: { ...edit.settings, host: e.target.value } })} placeholder="192.168.1.50" /></Field><Field label="Port"><Input type="number" value={edit.settings?.port ?? 9100} onChange={(e) => setEdit({ ...edit, settings: { ...edit.settings, port: Number(e.target.value) } })} /></Field></>}
            {edit.connection === 'bridge' && <Field label="Bridge URL" className="sm:col-span-2"><Input value={edit.settings?.bridgeUrl ?? ''} onChange={(e) => setEdit({ ...edit, settings: { ...edit.settings, bridgeUrl: e.target.value } })} placeholder="http://127.0.0.1:9123" /></Field>}
            {edit.kind === 'receipt_printer' && <Checkbox label="Open cash drawer on cash sales" checked={edit.settings?.openDrawerOnCash !== false} onChange={(v) => setEdit({ ...edit, settings: { ...edit.settings, openDrawerOnCash: v } })} />}
          </div>
        </Modal>
      )}
    </div>
  );
}

export function AccountPage() {
  const { me, reload } = useAuth();
  const toast = useToast();
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api<{ data: any[] }>('/auth/sessions').then((r) => r.data) });
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const [pin, setPin] = useState({ pin: '', password: '' });
  const [totp, setTotp] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  return (
    <div className="max-w-3xl space-y-4">
      <PageHeader title="My account" subtitle={`${me!.user.name} · ${me!.user.email}`} />
      <Card title="Change password"><div className="grid gap-3 sm:grid-cols-3"><Input type="password" placeholder="Current password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} /><Input type="password" placeholder="New password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} /><Button onClick={() => api('/auth/password/change', { body: pw }).then(() => { toast.success('Password changed. Other sessions were signed out.'); setPw({ currentPassword: '', newPassword: '' }); }).catch(toast.error)}>Change</Button></div></Card>
      <Card title="Till PIN" actions={me!.user.hasPin && <Badge tone="green">set</Badge>}><div className="grid gap-3 sm:grid-cols-3"><Input inputMode="numeric" placeholder="4-8 digit PIN" value={pin.pin} onChange={(e) => setPin({ ...pin, pin: e.target.value })} /><Input type="password" placeholder="Your password" value={pin.password} onChange={(e) => setPin({ ...pin, password: e.target.value })} /><Button onClick={() => api('/auth/pin', { body: pin }).then(() => { toast.success('PIN saved'); reload(); }).catch(toast.error)}>Save PIN</Button></div></Card>
      <Card title="Two-factor authentication" actions={me!.user.twoFactorEnabled && <Badge tone="green">on</Badge>}>
        {me!.user.twoFactorEnabled ? <p className="text-sm">Your account is protected with an authenticator app.</p> : totp ? (
          <div className="space-y-3 text-sm">
            <p>Add this key to Google Authenticator, Microsoft Authenticator or similar, then enter the 6-digit code.</p>
            <code className="block break-all rounded bg-ink-100 p-2 dark:bg-ink-800">{totp.secret}</code>
            <div className="flex gap-2"><Input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" /><Button onClick={() => api('/auth/2fa/enable', { body: { code } }).then(() => { toast.success('Two-factor enabled'); reload(); }).catch(toast.error)}>Enable</Button></div>
          </div>
        ) : <Button onClick={() => api<{ secret: string; otpauthUrl: string }>('/auth/2fa/setup', { body: {} }).then(setTotp).catch(toast.error)}>Set up</Button>}
      </Card>
      <Card title="Signed-in devices" actions={<Button size="sm" variant="secondary" onClick={() => api('/auth/logout-all', { body: {} }).then(() => (window.location.href = '/login'))}>Sign out everywhere</Button>}>
        <ul className="divide-y divide-ink-100 text-sm dark:divide-ink-800">{sessions.data?.map((s) => <li key={s.id} className="flex items-center justify-between py-2"><span>{s.userAgent?.slice(0, 60) ?? 'Unknown device'} · {s.ip} · {dateTime(s.lastUsedAt)} {s.current && <Badge tone="green">this device</Badge>}</span>{!s.current && <Button size="sm" variant="ghost" onClick={() => api(`/auth/sessions/${s.id}`, { method: 'DELETE' }).then(() => sessions.refetch())}>Revoke</Button>}</li>)}</ul>
      </Card>
    </div>
  );
}

export { money };

/** Upload the business logo (PNG, JPEG or WEBP) shown on the sign-in and sign-up pages. Saved with the form. */
function BusinessLogoField({ fileId, onChange }: { fileId?: string; onChange: (id: string) => void }) {
  const toast = useToast();
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    setPreview(null);
    if (!fileId) return;
    api<Response>(`/files/${fileId}`, { raw: true })
      .then(async (r) => { if (r.ok) { url = URL.createObjectURL(await r.blob()); setPreview(url); } })
      .catch(() => undefined);
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [fileId]);
  const upload = async (file: File) => {
    if (file.size > 3 * 1024 * 1024) return toast.error('The logo must be smaller than 3 MB');
    const base64 = await new Promise<string>((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]); r.readAsDataURL(file); });
    try {
      const r = await api<{ data: { id: string } }>('/files', { body: { base64, purpose: 'attachment' } });
      onChange(r.data.id);
      toast.info('Logo uploaded. Press Save to apply it.');
    } catch (e) { toast.error(e); }
  };
  return (
    <div>
      <div className="label">Business logo</div>
      <div className="flex items-center gap-4">
        <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-full bg-white ring-1 ring-ink-200 dark:ring-ink-700">
          {preview ? <img src={preview} alt="Business logo" className="h-full w-full object-contain p-2" /> : <Icon name="store" className="h-8 w-8 text-ink-300" />}
        </div>
        <label className="cursor-pointer"><span className="inline-flex rounded-lg border border-ink-300 px-3 py-2 text-sm hover:bg-ink-50 dark:border-ink-700 dark:hover:bg-ink-800">Upload logo</span>
          <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        </label>
        {fileId && <Button variant="ghost" size="sm" onClick={() => onChange('')}>Remove</Button>}
      </div>
      <p className="mt-1 text-xs text-ink-500">Shown on the sign-in and sign-up pages. A square image of at least 256 × 256 pixels looks best.</p>
    </div>
  );
}
