import { useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { roleName, useRoleCatalog, UserPermissionsEditor } from './Roles';
import { MODULE_INFO, MODULES, PAYMENT_PROVIDER_INFO, PAYMENT_PROVIDERS, ROLE_LABELS, TENANT_ROLES, type ModuleKey, type PaymentProviderKey } from '@afeypos/shared';
import { api, download } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useLocations, type Locations } from '../../lib/hooks';
import { dateTime, money } from '../../lib/format';
import { getWorkstation, setWorkstation } from '../../lib/workstation';
import { DataTable } from '../../components/DataTable';
import { Badge, Button, Card, Checkbox, cx, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Stat, StatusBadge, Tabs, useConfirm, useToast } from '../../components/ui';
import { Icon } from '../../components/icons';
import { StaffAccessPanel } from './StaffAccess';
import { BridgePairingCard, FingerprintReadersCard, ReceiptPrinterCard } from './ThisComputer';
import { makeAppIcons } from '../../lib/appIcon';

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
      // The installed app's icon is made from the logo (once per logo).
      const appIcon = !s.logoFileId ? null : s.appIcon?.source === s.logoFileId ? s.appIcon : await makeAppIcons(s.logoFileId).catch(() => s.appIcon ?? null);
      if (appIcon !== (s.appIcon ?? null)) setS('appIcon', appIcon);
      await api('/settings/business', { method: 'PATCH', body: { name: f.name, contact: { email: f.contact.email || undefined, phone: f.contact.phone || undefined, address: f.contact.address || undefined }, settings: { currency: s.currency, timezone: s.timezone, locale: s.locale, taxPin: s.taxPin ?? '', defaultTaxRateBp: s.defaultTaxRateBp, pricesIncludeTax: s.pricesIncludeTax, allowNegativeStock: s.allowNegativeStock, logoFileId: s.logoFileId ?? '', appIcon, tagline: s.tagline ?? '', stkPendingTimeoutSeconds: s.stkPendingTimeoutSeconds, variableWeight: s.variableWeight, loyalty: s.loyalty, restrictedSaleHours: { start: s.restrictedSaleHours?.start ?? '', end: s.restrictedSaleHours?.end ?? '' }, dailyReportEmails: s.dailyReportEmails ?? [], creditReminders: s.creditReminders, returns: { windowDays: s.returns?.windowDays ?? 14, approvalAboveCents: s.returns?.approvalAboveCents ?? 0, restockByDefault: s.returns?.restockByDefault ?? true }, staffLogin: { cardRequiresPin: s.staffLogin?.cardRequiresPin ?? true }, ...(s.crm?.birthdayGreeting ? { crm: { birthdayGreeting: { enabled: Boolean(s.crm.birthdayGreeting.enabled), channel: s.crm.birthdayGreeting.channel ?? 'sms', offer: s.crm.birthdayGreeting.offer ?? '' } } } : {}) } } });
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
          <div className="rounded-md border border-dashed border-ink-200 p-3 text-sm dark:border-ink-700 sm:col-span-2"><Icon name="receipt" className="mr-1.5 inline h-4 w-4 text-ink-400" />Receipt header, footer, template and fields: <Link className="font-semibold text-brand-600 hover:underline" to="/settings/receipts">Settings &gt; Receipts</Link></div>
          <Field label="Tagline" hint="Shown under your name on the sign-in page"><Input maxLength={120} value={s.tagline ?? ''} onChange={(e) => setS('tagline', e.target.value)} placeholder="e.g. Quality building materials since 2005" /></Field>
          <div className="sm:col-span-2"><BusinessLogoField fileId={s.logoFileId} onChange={(id) => setS('logoFileId', id)} /></div>
        </div></Card>
      )}
      {tab === 'sales' && (
        <Card><div className="grid gap-4 sm:grid-cols-2">
          <Field label="Default tax rate %"><Input inputMode="decimal" value={s.defaultTaxRateBp / 100} onChange={(e) => setS('defaultTaxRateBp', Math.round(Number(e.target.value) * 100))} /></Field>
          <div className="text-sm text-ink-600 dark:text-ink-300">Discount limits, item removal and shift control: <Link className="font-semibold text-brand-600 hover:underline" to="/settings/checkout-rules">Checkout rules</Link></div>
          <Checkbox label="Prices include tax" checked={s.pricesIncludeTax} onChange={(v) => setS('pricesIncludeTax', v)} />
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
          <div className="flex flex-wrap items-end gap-3 sm:col-span-2">
            <Field label="Return window (days)" hint="Older sales need a manager; 0 = no limit"><Input type="number" min={0} className="w-28" value={s.returns?.windowDays ?? 14} onChange={(e) => setS('returns', { ...s.returns, windowDays: Math.max(0, Number(e.target.value) || 0) })} /></Field>
            <Field label="Manager approves refunds above (KES)" hint="0 = never"><Input inputMode="decimal" className="w-36" value={(s.returns?.approvalAboveCents ?? 0) / 100} onChange={(e) => setS('returns', { ...s.returns, approvalAboveCents: Math.max(0, Math.round(Number(e.target.value) * 100) || 0) })} /></Field>
          </div>
          <div className="flex flex-wrap items-end gap-3 sm:col-span-2">
            <Checkbox label="Send customers a birthday greeting (opted-in customers, 09:00)" checked={Boolean(s.crm?.birthdayGreeting?.enabled)} onChange={(v) => setS('crm', { ...s.crm, birthdayGreeting: { channel: 'sms', ...s.crm?.birthdayGreeting, enabled: v } })} />
            {s.crm?.birthdayGreeting?.enabled && <Field label="Birthday offer line"><Input className="w-80" value={s.crm?.birthdayGreeting?.offer ?? ''} placeholder="Show this SMS for 10% off today." onChange={(e) => setS('crm', { ...s.crm, birthdayGreeting: { ...s.crm?.birthdayGreeting, offer: e.target.value } })} /></Field>}

            <Checkbox label="Returned items go back to the shelf by default" checked={s.returns?.restockByDefault ?? true} onChange={(v) => setS('returns', { ...s.returns, restockByDefault: v })} />
          </div>
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
      </div>
      <p className="mt-3 text-xs text-ink-500">USB/keyboard-wedge barcode scanners work in the checkout search box without configuration. Receipt printing (straight to the printer, paper size, automatic printing) is set under <Link className="text-brand-600 hover:underline" to="/settings/hardware">Hardware</Link>.</p>
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
  const [showPerms, setShowPerms] = useState(false);
  const cat = useRoleCatalog();
  const roles = TENANT_ROLES.filter((r) => r !== 'tenant_owner' || me!.user.roles.includes('tenant_owner'));
  // Branch-limited managers can only give access to (some of) their own branches.
  const myBranches: string[] = me!.user.branchIds ?? [];
  const branchChoices = (locs.data?.branches ?? []).filter((b) => !myBranches.length || myBranches.includes(b._id));
  const self = edit?._id === me!.user.id;
  const save = async () => {
    setError(null);
    try {
      const body: any = { name: edit.name, email: edit.email, username: edit.username ?? '', phone: edit.phone || undefined, roles: edit.roles, extraPermissions: edit.extraPermissions ?? [], deniedPermissions: edit.deniedPermissions ?? [], branchIds: edit.branchIds ?? [], commissionRateBp: Number(edit.commissionRateBp ?? 0), employeeNo: edit.employeeNo || undefined, jobTitle: edit.jobTitle || undefined };
      if (edit.password) body.password = edit.password;
      if (edit.pin) body.pin = edit.pin;
      // Your own access is changed by someone else (the server refuses it too).
      if (self) { delete body.roles; delete body.extraPermissions; delete body.deniedPermissions; delete body.branchIds; }
      if (edit._id) await api(`/settings/users/${edit._id}`, { method: 'PATCH', body: { ...body, pin: undefined } });
      else await api('/settings/users', { body });
      setEdit(null);
      qc.invalidateQueries({ queryKey: ['users'] });
      toast.success('User saved');
    } catch (e) { setError(e); }
  };
  return (
    <div>
      <PageHeader title="Users" subtitle={<>Staff accounts. Define what each role may do under <Link className="text-brand-600 underline" to="/settings/roles">Roles &amp; permissions</Link>.</>} actions={<Button onClick={() => { setShowPerms(false); setEdit({ name: '', email: '', roles: ['cashier'], branchIds: myBranches.length === 1 ? [...myBranches] : [], extraPermissions: [], deniedPermissions: [] }); }}><Icon name="plus" className="h-4 w-4" />Add user</Button>} />
      <div className="card"><DataTable rows={list.data} loading={list.isLoading} error={list.error} onRowClick={(r: any) => { setShowPerms(false); setEdit({ ...r, extraPermissions: r.extraPermissions ?? [], deniedPermissions: r.deniedPermissions ?? [] }); }} columns={[
        { key: 'n', header: 'Name', render: (r: any) => <div><div className="font-medium">{r.name}</div><div className="text-xs text-ink-500">{r.email}</div></div> },
        { key: 'r', header: 'Roles', render: (r: any) => <div className="flex flex-wrap gap-1">{r.roles.map((x: string) => <Badge key={x} tone={x.startsWith('custom:') ? 'blue' : 'gray'}>{ROLE_LABELS[x as keyof typeof ROLE_LABELS] ?? roleName(cat.data, x)}</Badge>)}{(r.extraPermissions?.length > 0 || r.deniedPermissions?.length > 0) && <Badge tone="amber">adjusted</Badge>}</div> },
        { key: 'b', header: 'Branches', render: (r: any) => (r.branchIds?.length ? r.branchIds.map((b: string) => locs.data?.branches.find((x) => x._id === b)?.name).join(', ') : 'All') },
        { key: 'e', header: 'Employee no.', render: (r: any) => r.employeeNo ?? '—' },
        { key: 'sec', header: 'Sign-in', render: (r: any) => <div className="flex gap-1">{r.twoFactorEnabled && <Badge tone="green">2FA</Badge>}{r.hasPin && <Badge>PIN</Badge>}{r.card && <Badge tone="blue">Card</Badge>}</div> },
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
            <Field label="Username" hint="Optional short sign-in name for logging in and confirming, e.g. amina"><Input autoCapitalize="none" spellCheck={false} value={edit.username ?? ''} onChange={(e) => setEdit({ ...edit, username: e.target.value.toLowerCase().replace(/\s/g, '') })} /></Field>
            <Field label="Phone"><Input value={edit.phone ?? ''} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></Field>
            <Field label="Employee number" hint={edit._id ? undefined : 'Left empty, the next EMP- number is used'}><Input value={edit.employeeNo ?? ''} onChange={(e) => setEdit({ ...edit, employeeNo: e.target.value })} /></Field>
            <Field label="Job title (printed on the card)"><Input value={edit.jobTitle ?? ''} onChange={(e) => setEdit({ ...edit, jobTitle: e.target.value })} /></Field>
            <Field label={edit._id ? 'New password (optional)' : 'Password'}><Input type="password" value={edit.password ?? ''} onChange={(e) => setEdit({ ...edit, password: e.target.value })} /></Field>
            {!edit._id && <Field label="Till PIN (optional, 4-8 digits)"><Input inputMode="numeric" value={edit.pin ?? ''} onChange={(e) => setEdit({ ...edit, pin: e.target.value })} /></Field>}
            {me!.capabilities.modules.includes('salesReps') && <Field label="Commission %"><Input inputMode="decimal" value={(edit.commissionRateBp ?? 0) / 100} onChange={(e) => setEdit({ ...edit, commissionRateBp: Math.round(Number(e.target.value) * 100) })} /></Field>}
          </div>
          {self && <p className="mt-4 rounded-sm bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">You cannot change your own roles, permissions or branches. Ask another administrator.</p>}
          <fieldset disabled={self} className="disabled:opacity-60">
            <div className="mt-4"><div className="label">Roles</div><div className="grid gap-2 sm:grid-cols-3">
              {roles.map((r) => <Checkbox key={r} label={ROLE_LABELS[r]} checked={edit.roles.includes(r)} onChange={(v) => setEdit({ ...edit, roles: v ? [...edit.roles, r] : edit.roles.filter((x: string) => x !== r) })} />)}
              {(cat.data?.custom ?? []).map((r) => <Checkbox key={r.key} label={`${r.name} (custom)`} checked={edit.roles.includes(r.key)} onChange={(v) => setEdit({ ...edit, roles: v ? [...edit.roles, r.key] : edit.roles.filter((x: string) => x !== r.key) })} />)}
            </div></div>
            {(locs.data?.branches.length ?? 0) > 1 && <div className="mt-4"><div className="label">{myBranches.length ? 'Branch access (choose at least one of your branches)' : 'Branch access (none selected = all branches)'}</div><div className="flex flex-wrap gap-3">{branchChoices.map((b) => <Checkbox key={b._id} label={b.name} checked={(edit.branchIds ?? []).includes(b._id)} onChange={(v) => setEdit({ ...edit, branchIds: v ? [...(edit.branchIds ?? []), b._id] : edit.branchIds.filter((x: string) => x !== b._id) })} />)}</div></div>}
            {cat.data && (
              <div className="mt-4">
                <button type="button" className="flex items-center gap-1.5 text-sm font-semibold text-brand-600 hover:underline" onClick={() => setShowPerms(!showPerms)} aria-expanded={showPerms}>
                  <Icon name="chevron" className={cx('h-4 w-4 transition', showPerms && 'rotate-90')} />Adjust permissions for this user{(edit.extraPermissions?.length || edit.deniedPermissions?.length) ? ` (${edit.extraPermissions.length} added, ${edit.deniedPermissions.length} taken away)` : ''}
                </button>
                {showPerms && <div className="mt-3"><UserPermissionsEditor cat={cat.data} roles={edit.roles} extra={edit.extraPermissions ?? []} denied={edit.deniedPermissions ?? []} isOwnerTarget={edit.roles.includes('tenant_owner')} onChange={(extra, denied) => setEdit({ ...edit, extraPermissions: extra, deniedPermissions: denied })} /></div>}
              </div>
            )}
          </fieldset>
          {edit._id && <StaffAccessPanel user={list.data?.find((u: any) => u._id === edit._id) ?? edit} onChanged={() => qc.invalidateQueries({ queryKey: ['users'] })} />}
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
        <Card key={b._id} title={`${b.name} (${b.code})`} actions={b.hasServer ? <Badge tone="blue">own server</Badge> : undefined}>
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
  daraja: {
    settings: [['type', 'Account type'], ['shortCode', 'Paybill number, or store (head office) number for Buy Goods'], ['tillNumber', 'Till number (Buy Goods only)'], ['initiatorName', 'Initiator name (optional: code checks and payouts)'], ['b2cShortCode', 'B2C short code (optional: salary payouts)']],
    secrets: [['consumerKey', 'Consumer key'], ['consumerSecret', 'Consumer secret'], ['passkey', 'Lipa na M-Pesa passkey'], ['securityCredential', 'Initiator security credential (optional)']],
  },
  mock: { settings: [['type', 'Account type'], ['shortCode', 'Short code'], ['tillNumber', 'Till number (Buy Goods only)']], secrets: [] },
  talksasa: { settings: [['senderId', 'Sender ID'], ['baseUrl', 'API base URL (optional)']], secrets: [['apiToken', 'API token']] },
  africastalking: { settings: [['username', 'Username'], ['senderId', 'Sender ID / short code']], secrets: [['apiKey', 'API key']] },
  smtp: { settings: [['host', 'SMTP host'], ['port', 'Port'], ['user', 'Username'], ['from', 'From address']], secrets: [['password', 'Password']] },
  console: { settings: [], secrets: [] },
  oscu: { settings: [['tin', 'KRA PIN of the business'], ['bhfId', 'KRA branch id (00 = head office)'], ['dvcSrlNo', 'Device serial number (from KRA)']], secrets: [] },
  vscu: { settings: [['tin', 'KRA PIN of the business'], ['bhfId', 'KRA branch id (00 = head office)'], ['dvcSrlNo', 'Device serial number (from KRA)'], ['baseUrl', 'VSCU address on your network, e.g. http://192.168.1.5:8088']], secrets: [] },
};

const providerLabel = (kind: string, p: string) =>
  kind === 'payment' ? PAYMENT_PROVIDER_INFO[p as PaymentProviderKey]?.label ?? p : p === 'oscu' ? 'OSCU (online, KRA servers)' : p === 'vscu' ? 'VSCU (KRA software on your network)' : p === 'mock' ? 'Simulator (testing)' : p === 'console' ? 'Development log (no delivery)' : p === 'daraja' ? 'Safaricom Daraja' : p;

type IntegrationKind = 'mpesa' | 'payment' | 'etims' | 'sms' | 'email';
const KIND_INFO: Record<IntegrationKind, { label: string; icon: string; blurb: string }> = {
  mpesa: { label: 'M-Pesa', icon: 'phone', blurb: 'STK push at the till, Paybill and Till payments, payouts' },
  payment: { label: 'Payment gateways', icon: 'card', blurb: 'Cards and mobile money through Paystack, Flutterwave and others' },
  etims: { label: 'KRA eTIMS', icon: 'shield', blurb: 'Signs sales and credit notes with KRA' },
  sms: { label: 'SMS', icon: 'megaphone', blurb: 'Receipts, reminders and campaigns by text' },
  email: { label: 'Email', icon: 'mail', blurb: 'Receipts, statements, documents with PDFs' },
};
const CATEGORIES: { key: 'all' | 'payments' | IntegrationKind; label: string; kinds: IntegrationKind[] }[] = [
  { key: 'all', label: 'All', kinds: ['mpesa', 'payment', 'etims', 'sms', 'email'] },
  { key: 'payments', label: 'Payments', kinds: ['mpesa', 'payment'] },
  { key: 'etims', label: 'KRA eTIMS', kinds: ['etims'] },
  { key: 'sms', label: 'SMS', kinds: ['sms'] },
  { key: 'email', label: 'Email', kinds: ['email'] },
];
const OTHER_PROVIDERS: Record<string, string> = {
  daraja: 'Safaricom Daraja: STK push, Paybill / Buy Goods confirmations, B2C payouts.',
  oscu: 'Online signing with KRA servers. Needs internet at the till.',
  vscu: 'KRA software running on your shop network. Keeps signing when the internet is down.',
  talksasa: 'Kenyan SMS provider with sender IDs.',
  africastalking: "Africa's Talking SMS across Africa.",
  smtp: 'Any email account or service with SMTP (Gmail, Zoho, Mailgun, your host).',
  console: 'Writes messages to the server log instead of sending them (development).',
  mock: 'Simulator for training and testing; nothing is sent to KRA or Safaricom.',
};
const TILE_COLORS = ['#4a9be3', '#62b86f', '#9b7fd6', '#e8625b', '#f3c24c', '#3fb8b0'];
const NAMES: Record<string, string> = { talksasa: 'Talk Sasa', africastalking: "Africa's Talking", smtp: 'SMTP email (any mail service)' };
const providerTitle = (kind: IntegrationKind, p: string) => (NAMES[p] ? NAMES[p]! : kind === 'mpesa' ? (p === 'mock' ? 'M-Pesa simulator' : 'M-Pesa (Safaricom Daraja)') : kind === 'etims' && p === 'mock' ? 'KRA eTIMS simulator' : kind === 'sms' && p === 'console' ? 'SMS to the server log' : kind === 'email' && p === 'console' ? 'Email to the server log' : providerLabel(kind, p));

function ProviderAvatar({ name, size = 'md' }: { name: string; size?: 'md' | 'lg' }) {
  const color = TILE_COLORS[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % TILE_COLORS.length];
  const initials = name.replace(/\(.*\)/, '').split(/[\s'-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
  return <span className={cx('flex shrink-0 items-center justify-center rounded-lg font-bold text-white', size === 'lg' ? 'h-11 w-11 text-sm' : 'h-9 w-9 text-xs')} style={{ background: color }} aria-hidden="true">{initials}</span>;
}

function StatusPill({ tone, children }: { tone: 'green' | 'amber' | 'red' | 'gray' | 'blue'; children: ReactNode }) {
  const c = { green: 'bg-emerald-50 text-emerald-700 ring-emerald-200', amber: 'bg-amber-50 text-amber-700 ring-amber-200', red: 'bg-red-50 text-red-700 ring-red-200', gray: 'bg-ink-50 text-ink-600 ring-ink-200', blue: 'bg-sky-50 text-sky-700 ring-sky-200' }[tone];
  return <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset', c)}>{children}</span>;
}

function CopyField({ label, value }: { label: string; value: string }) {
  const toast = useToast();
  return (
    <div className="flex items-center gap-2 rounded-md border border-ink-100 bg-[#f7f8fa] px-3 py-2 dark:border-ink-800 dark:bg-ink-950/40">
      <div className="min-w-0 flex-1"><div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">{label}</div><div className="truncate font-mono text-xs text-ink-700 dark:text-ink-200" title={value}>{value}</div></div>
      <Button size="sm" variant="ghost" aria-label={`Copy ${label}`} onClick={() => navigator.clipboard.writeText(value).then(() => toast.success(`${label} copied`)).catch(() => toast.error('Copy failed'))}>Copy</Button>
    </div>
  );
}

/**
 * Registers the C2B confirmation and validation URLs with Safaricom for a saved M-Pesa configuration, shows
 * what will be registered and why Safaricom might refuse it, and proves it works with a test payment.
 */
function C2BPanel({ config, onChanged }: { config: any; onChanged?: () => void }) {
  const toast = useToast();
  const plan = useQuery({ queryKey: ['c2b-plan', config.id], queryFn: () => api<{ data: { shortCode: string; confirmationUrl: string; validationUrl: string; problems: string[]; blocking: string[]; registration: any } }>(`/settings/integrations/${config.id}/register-c2b`).then((r) => r.data) });
  const [shortCode, setShortCode] = useState<string | null>(null);
  const [busy, setBusy] = useState<'register' | 'test' | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  if (!plan.data) return <Loading />;
  const p = plan.data;
  const reg = p.registration;
  const code = shortCode ?? p.shortCode;
  const warnings = p.problems.filter((x) => !p.blocking.includes(x));
  const canTest = config.provider === 'mock' || config.environment !== 'production';
  const register = async () => {
    setBusy('register'); setResult(null);
    try {
      const r = await api<{ data: { message: string } }>(`/settings/integrations/${config.id}/register-c2b`, { body: code && code !== p.shortCode ? { shortCode: code } : {} });
      setResult({ ok: true, message: r.data.message }); toast.success('C2B URLs registered with Safaricom');
    } catch (e: any) {
      setResult({ ok: false, message: e?.message ?? 'Registration failed' });
    } finally { setBusy(null); plan.refetch(); onChanged?.(); }
  };
  const test = async () => {
    setBusy('test'); setResult(null);
    try {
      const r = await api<{ data: { message: string } }>(`/settings/integrations/${config.id}/test-c2b`, { body: { amount: 1 } });
      setResult({ ok: true, message: r.data.message });
      // Sandbox confirmations arrive a few seconds later.
      setTimeout(() => plan.refetch(), config.provider === 'mock' ? 0 : 8000);
    } catch (e: any) { setResult({ ok: false, message: e?.message ?? 'Test failed' }); } finally { setBusy(null); plan.refetch(); }
  };
  return (
    <section aria-label="C2B URL registration" className="space-y-3 rounded-lg border border-emerald-200 bg-emerald-50/40 p-4 dark:border-emerald-900 dark:bg-emerald-950/20">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold">Customers paying the Paybill / Till (C2B)</h3>
          <p className="text-xs text-ink-600 dark:text-ink-300">Safaricom sends every payment to these URLs, so sales complete by themselves. Uses the saved settings: save changes first.</p>
        </div>
        {reg ? <StatusPill tone={reg.ok ? 'green' : 'red'}>{reg.ok ? 'Registered' : 'Registration failed'} · {dateTime(reg.at)}</StatusPill> : <StatusPill tone="gray">Not registered yet</StatusPill>}
      </div>
      <div className="grid gap-2">
        <CopyField label="Confirmation URL" value={p.confirmationUrl} />
        <CopyField label="Validation URL" value={p.validationUrl} />
      </div>
      <div className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <Field label="Short code to register" hint={config.settings?.type === 'till' ? 'Buy Goods: the store (head office) number, not the till number.' : 'Your Paybill number.'}>
          <Input value={code} inputMode="numeric" onChange={(e) => setShortCode(e.target.value.replace(/\D/g, '').slice(0, 7))} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button loading={busy === 'register'} disabled={Boolean(busy) || p.blocking.length > 0 || !/^\d{5,7}$/.test(code)} onClick={register}><Icon name="plug" className="h-4 w-4" />Register C2B URLs</Button>
          {canTest && <Button variant="secondary" loading={busy === 'test'} disabled={Boolean(busy) || !reg?.ok} onClick={test} title={reg?.ok ? undefined : 'Register first'}>Send test payment</Button>}
        </div>
      </div>
      {p.blocking.map((m) => <p key={m} role="alert" className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-200">{m}</p>)}
      {warnings.map((m) => <p key={m} className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">{m}</p>)}
      {result && <p role="status" className={cx('rounded-md px-3 py-2 text-xs', result.ok ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200' : 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-200')}>{result.message}</p>}
      {reg && !result && <p className={cx('text-xs', reg.ok ? 'text-ink-600 dark:text-ink-300' : 'text-red-700 dark:text-red-300')}>{reg.message}</p>}
      <dl className="grid grid-cols-2 gap-2 text-xs">
        <div><dt className="text-ink-500">Registered short code</dt><dd className="font-medium">{reg?.shortCode ?? '—'}</dd></div>
        <div><dt className="text-ink-500">Last payment received</dt><dd className="font-medium">{reg?.lastConfirmationAt ? dateTime(reg.lastConfirmationAt) : canTest ? 'None yet: send a test payment' : 'None yet: pay KES 1 to check'}</dd></div>
      </dl>
    </section>
  );
}

export function IntegrationsPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['integrations'], queryFn: () => api<{ data: any[]; providers: Record<string, string[]>; callbackUrls: Record<string, string> }>('/settings/integrations') });
  const locs = useLocations();
  const [edit, setEdit] = useState<any>(null);
  const [testing, setTesting] = useState<any>(null);
  const [c2b, setC2b] = useState<any>(null);
  const [testTo, setTestTo] = useState('');
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]['key']>('all');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (!q.data) return <Loading />;
  const rows = q.data.data;
  const kinds = CATEGORIES.find((c) => c.key === category)!.kinds;
  const connected = rows.filter((r) => kinds.includes(r.kind));
  const startNew = (kind: IntegrationKind, provider: string) => {
    setError(null);
    setEdit({ kind, provider, name: kind === 'payment' ? PAYMENT_PROVIDER_INFO[provider as PaymentProviderKey].label : kind === 'etims' ? 'KRA eTIMS' : providerTitle(kind, provider), enabled: true, isDefault: !rows.some((r) => r.kind === kind), environment: 'sandbox', settings: kind === 'etims' ? { bhfId: '00' } : {}, secrets: {} });
  };
  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      // Who uses it (M-Pesa): every branch, chosen branches (all their tills), or chosen tills only.
      const scope = scopeOf(edit);
      // M-Pesa: whole business, chosen branches or chosen tills. Payment gateways (Pesapal…): whole business or chosen branches.
      const scoped = edit.kind === 'mpesa' || edit.kind === 'payment';
      const usedBy = scoped ? { branchIds: scope === 'branches' ? edit.branchIds ?? [] : [], tillIds: edit.kind === 'mpesa' && scope === 'tills' ? edit.tillIds ?? [] : [] } : {};
      if (scoped && scope === 'branches' && !usedBy.branchIds?.length) throw new Error('Choose at least one branch, or "All branches and tills"');
      if (edit.kind === 'mpesa' && scope === 'tills' && !usedBy.tillIds?.length) throw new Error('Choose at least one till, or "All branches and tills"');
      const body = { provider: edit.provider, name: edit.name, enabled: edit.enabled, isDefault: edit.isDefault, environment: edit.environment, settings: edit.settings, secrets: edit.secrets, ...usedBy };
      if (edit.id) await api(`/settings/integrations/${edit.id}`, { method: 'PATCH', body });
      else await api('/settings/integrations', { body: { kind: edit.kind, ...body } });
      setEdit(null); qc.invalidateQueries({ queryKey: ['integrations'] }); toast.success('Saved. Secrets are stored encrypted and never shown again.');
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const runTest = async () => {
    setBusy(true);
    try {
      const r = await api<{ data: any }>(`/settings/integrations/${testing.id}/test`, { body: { to: testTo || undefined } });
      if (r.data.ok) toast.success(r.data.message); else toast.error(r.data.message);
      setTesting(null); q.refetch();
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  const live = rows.filter((r) => r.enabled && r.environment === 'production').length;
  // A config never tested has an empty lastTest.
  const attention = rows.filter((r) => !r.enabled || (r.lastTest?.at && r.lastTest.ok === false)).length;
  // Catalog: everything that can be connected in the chosen category.
  interface Tile { kind: IntegrationKind; provider: string; title: string; text: string; soon: boolean }
  const catalog = kinds.flatMap((k): Tile[] => {
    if (k === 'payment') return PAYMENT_PROVIDERS.filter((p) => !PAYMENT_PROVIDER_INFO[p].devOnly).map((p) => ({ kind: k, provider: p, title: PAYMENT_PROVIDER_INFO[p].label, text: PAYMENT_PROVIDER_INFO[p].description, soon: PAYMENT_PROVIDER_INFO[p].availability === 'soon' }));
    return (q.data.providers[k] ?? []).map((p) => ({ kind: k, provider: p, title: providerTitle(k, p), text: OTHER_PROVIDERS[p] ?? '', soon: false }));
  });
  const info = edit?.kind === 'payment' ? PAYMENT_PROVIDER_INFO[edit.provider as PaymentProviderKey] : null;

  return (
    <div className="max-w-6xl">
      <PageHeader title="Integrations" subtitle="Connect payments, KRA eTIMS, SMS and email. Credentials are encrypted on the server and never shown again." />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Connected" value={rows.length} icon="plug" color="blue" />
        <Stat label="Live (real money / messages)" value={live} icon="check" color="green" />
        <Stat label="In test mode" value={rows.filter((r) => r.environment !== 'production').length} icon="flag" color="yellow" />
        <Stat label="Need attention" value={attention} icon="info" color={attention ? 'red' : 'teal'} hint={attention ? 'Disabled or failed the last test' : 'All good'} />
      </div>

      <div className="mb-4 flex flex-wrap gap-1.5" role="tablist" aria-label="Integration type">
        {CATEGORIES.map((c) => {
          const n = rows.filter((r) => c.kinds.includes(r.kind)).length;
          return (
            <button key={c.key} type="button" role="tab" aria-selected={category === c.key} onClick={() => setCategory(c.key)}
              className={cx('inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-sm font-semibold transition', category === c.key ? 'bg-brand-500 text-white shadow-sm' : 'bg-white text-ink-600 ring-1 ring-ink-200 hover:bg-ink-50 dark:bg-ink-900 dark:text-ink-300 dark:ring-ink-700')}>
              {c.label}{n > 0 && <span className={cx('rounded-full px-1.5 text-[11px]', category === c.key ? 'bg-white/25' : 'bg-ink-100 dark:bg-ink-800')}>{n}</span>}
            </button>
          );
        })}
      </div>

      <section className="mb-6" aria-labelledby="connected-h">
        <h2 id="connected-h" className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-500">Connected</h2>
        {connected.length === 0 ? (
          <div className="card flex items-center gap-3 p-5 text-sm text-ink-500"><Icon name="plug" className="h-5 w-5" />Nothing connected here yet. Pick a provider below.</div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {connected.map((r) => (
              <article key={r.id} className="card flex flex-col p-4" aria-label={r.name}>
                <div className="flex items-start gap-3">
                  <ProviderAvatar name={providerTitle(r.kind, r.provider)} size="lg" />
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-[15px] font-bold">{r.name}</h3>
                    <p className="truncate text-xs text-ink-500">{KIND_INFO[r.kind as IntegrationKind]?.label} · {providerTitle(r.kind, r.provider)}</p>
                  </div>
                  <div className="flex flex-wrap justify-end gap-1">
                    {!r.enabled ? <StatusPill tone="gray">Disabled</StatusPill> : r.environment === 'production' ? <StatusPill tone="green">● Live</StatusPill> : <StatusPill tone="amber">Test mode</StatusPill>}
                    {r.isDefault && <StatusPill tone="blue">Default</StatusPill>}
                  </div>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <div><dt className="text-ink-500">Credentials</dt><dd className="mt-0.5 font-medium">{r.secretsSet.length ? `${r.secretsSet.length} saved` : 'none needed'}</dd></div>
                  <div><dt className="text-ink-500">Last test</dt><dd className="mt-0.5">{r.lastTest?.at ? <StatusPill tone={r.lastTest.ok ? 'green' : 'red'}>{r.lastTest.ok ? 'Passed' : 'Failed'}{r.lastTest.at ? ` · ${dateTime(r.lastTest.at)}` : ''}</StatusPill> : <span className="text-ink-400">Not tested yet</span>}</dd></div>
                </dl>
                {(r.kind === 'mpesa' || r.kind === 'payment') && <p className="mt-2 text-xs text-ink-500" data-testid={`${r.kind}-used-by`}>Used by: <b>{usedByText(r, locs.data)}</b></p>}
                {r.kind === 'mpesa' && (
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-500">C2B URLs: {r.c2bRegistration ? <StatusPill tone={r.c2bRegistration.ok ? 'green' : 'red'}>{r.c2bRegistration.ok ? `Registered (${r.c2bRegistration.shortCode})` : 'Registration failed'}</StatusPill> : <StatusPill tone="amber">Not registered</StatusPill>}</p>
                )}
                {r.lastTest?.at && !r.lastTest.ok && r.lastTest.message && <p className="mt-2 rounded-md bg-red-50 px-2.5 py-1.5 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-200">{r.lastTest.message}</p>}
                <div className="mt-4 flex flex-wrap gap-1.5 border-t border-ink-100 pt-3 dark:border-ink-800">
                  <Button size="sm" onClick={() => { setTestTo(''); setTesting(r); }}><Icon name="check" className="h-3.5 w-3.5" />Test</Button>
                  <Button size="sm" variant="secondary" onClick={() => { setError(null); setEdit({ ...r, secrets: {} }); }}>Configure</Button>
                  {r.kind === 'mpesa' && <Button size="sm" variant="secondary" onClick={() => setC2b(r)}>Register C2B URLs</Button>}
                  {r.kind === 'etims' && <Button size="sm" variant="secondary" onClick={() => api<{ data: any }>(`/settings/integrations/${r.id}/etims/initialize`, { body: {} }).then((x) => { toast.success(`eTIMS device initialised: SCU ${x.data.sdcId}`); q.refetch(); }).catch(toast.error)}>Initialise device</Button>}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="mb-6" aria-labelledby="catalog-h">
        <h2 id="catalog-h" className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-500">Add an integration</h2>
        {kinds.map((k) => {
          const tiles = catalog.filter((c) => c.kind === k);
          if (!tiles.length) return null;
          return (
            <div key={k} className="mb-4">
              <div className="mb-2 flex items-center gap-2 text-sm"><Icon name={KIND_INFO[k].icon} className="h-4 w-4 text-ink-400" /><span className="font-semibold">{KIND_INFO[k].label}</span><span className="text-xs text-ink-500">{KIND_INFO[k].blurb}</span></div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {tiles.map((t) => (
                  <button key={`${t.kind}-${t.provider}`} type="button" disabled={t.soon} onClick={() => startNew(t.kind, t.provider)} aria-label={`${t.title}${t.soon ? ' (coming soon)' : ': connect'}`}
                    className="group flex items-start gap-3 rounded-lg border border-ink-100 bg-white p-3 text-left transition hover:-translate-y-px hover:border-brand-300 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:translate-y-0 disabled:hover:border-ink-100 disabled:hover:shadow-none dark:border-ink-800 dark:bg-ink-900">
                    <ProviderAvatar name={t.title} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-sm font-semibold">{t.title}{t.soon && <StatusPill tone="gray">Soon</StatusPill>}</span>
                      {t.text && <span className="mt-0.5 line-clamp-2 block text-xs text-ink-500">{t.text}</span>}
                    </span>
                    {!t.soon && <span className="mt-1 text-xs font-semibold text-brand-600 opacity-0 transition group-hover:opacity-100">Connect →</span>}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        {kinds.includes('payment') && <button type="button" className="text-xs text-ink-500 underline hover:text-brand-600" onClick={() => startNew('payment', 'simulator')}>Add the payment simulator (training and testing; never moves money)</button>}
      </section>

      {kinds.includes('mpesa') && (
        <details className="card mb-4 p-4">
          <summary className="cursor-pointer text-sm font-semibold">M-Pesa callback URLs <span className="font-normal text-ink-500">(register these with Safaricom)</span></summary>
          <div className="mt-3 grid gap-2 md:grid-cols-2">{Object.entries(q.data.callbackUrls).map(([k, v]) => <CopyField key={k} label={k} value={v} />)}</div>
          <p className="mt-2 text-xs text-ink-500">These URLs contain a secret token. They must be public HTTPS addresses Safaricom can reach.</p>
        </details>
      )}

      {testing && (
        <Modal open onClose={() => setTesting(null)} title={`Test ${testing.name}`} icon="check" size="sm"
          subtitle={testing.kind === 'sms' || testing.kind === 'email' ? 'Sends a real test message.' : 'Checks the connection and credentials with the provider.'}
          footer={<><Button variant="secondary" onClick={() => setTesting(null)}>Cancel</Button><Button loading={busy} onClick={runTest}>Run test</Button></>}>
          {testing.kind === 'sms' || testing.kind === 'email'
            ? <Field label={testing.kind === 'sms' ? 'Send the test SMS to' : 'Send the test email to'}><Input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder={testing.kind === 'sms' ? '07XX XXX XXX' : 'you@example.com'} /></Field>
            : <p className="text-sm text-ink-600 dark:text-ink-300">Nothing is charged and nothing is sent to customers.</p>}
        </Modal>
      )}

      {c2b && (
        <Modal open onClose={() => setC2b(null)} title={`Register C2B URLs · ${c2b.name}`} icon="plug" size="lg" subtitle="Lets payments made straight to your Paybill/Till reach Afey POS."
          footer={<Button variant="secondary" onClick={() => setC2b(null)}>Close</Button>}>
          <C2BPanel config={c2b} onChanged={() => q.refetch()} />
        </Modal>
      )}

      {edit && (
        <Modal open variant="drawer" size="lg" onClose={() => setEdit(null)} icon={KIND_INFO[edit.kind as IntegrationKind]?.icon}
          title={`${edit.id ? 'Configure' : 'Connect'} ${edit.kind === 'payment' ? providerLabel('payment', edit.provider) : providerTitle(edit.kind, edit.provider)}`}
          subtitle={info ? info.description : OTHER_PROVIDERS[edit.provider] ?? KIND_INFO[edit.kind as IntegrationKind]?.blurb}
          footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button loading={busy} onClick={save}>Save</Button></>}>
          <div className="space-y-5">
            <fieldset className="space-y-3">
              <legend className="mb-1 text-xs font-bold uppercase tracking-wide text-ink-500">General</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Provider"><Select value={edit.provider} disabled={Boolean(edit.id)} onChange={(e) => setEdit({ ...edit, provider: e.target.value })} options={(edit.kind === 'payment' ? [edit.provider] : q.data.providers[edit.kind]).map((p: string) => ({ value: p, label: providerTitle(edit.kind, p) }))} /></Field>
                <Field label="Name"><Input value={edit.name} placeholder="Shown to staff, e.g. Main Paybill" onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
              </div>
              <div role="radiogroup" aria-label="Environment" className="grid gap-2 sm:grid-cols-2">
                {[{ v: 'sandbox', t: 'Test mode', d: 'Sandbox credentials, no real money or messages' }, { v: 'production', t: 'Live', d: 'Real payments, real messages' }].map((o) => (
                  <button key={o.v} type="button" role="radio" aria-checked={edit.environment === o.v} onClick={() => setEdit({ ...edit, environment: o.v })}
                    className={cx('rounded-lg border p-3 text-left transition', edit.environment === o.v ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500 dark:bg-brand-500/10' : 'border-ink-200 hover:border-ink-300 dark:border-ink-700')}>
                    <span className="block text-sm font-semibold">{o.t}</span><span className="block text-xs text-ink-500">{o.d}</span>
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap gap-5"><Checkbox label="Enabled" checked={edit.enabled} onChange={(v) => setEdit({ ...edit, enabled: v })} /><Checkbox label="Default" checked={edit.isDefault} onChange={(v) => setEdit({ ...edit, isDefault: v })} /></div>
            </fieldset>
            {edit.kind === 'mpesa' && locs.data && (locs.data.branches.length > 1 || locs.data.tills.length > 1) && <MpesaUsedBy edit={edit} setEdit={setEdit} locs={locs.data} />}
            {edit.kind === 'payment' && locs.data && locs.data.branches.length > 1 && <MpesaUsedBy edit={edit} setEdit={setEdit} locs={locs.data} branchesOnly />}
            <fieldset className="space-y-3">
              <legend className="mb-1 text-xs font-bold uppercase tracking-wide text-ink-500">Account details</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {edit.kind === 'payment' && info?.fields.filter((f) => !f.secret).map((f) => f.options ? (
                  <Field key={f.key} label={`${f.label}${f.required ? ' *' : ''}`} hint={f.help}><Select value={edit.settings?.[f.key] ?? ''} onChange={(e) => setEdit({ ...edit, settings: { ...edit.settings, [f.key]: e.target.value } })} options={[{ value: '', label: 'Select…' }, ...f.options]} /></Field>
                ) : (
                  <Field key={f.key} label={`${f.label}${f.required ? ' *' : ''}`} hint={f.help}><Input value={edit.settings?.[f.key] ?? ''} placeholder={f.placeholder} onChange={(e) => setEdit({ ...edit, settings: { ...edit.settings, [f.key]: e.target.value } })} /></Field>
                ))}
                {(PROVIDER_FIELDS[edit.provider]?.settings ?? []).map(([k, l]) => k === 'type' && edit.kind === 'mpesa' ? (
                  <Field key={k} label={l}><Select value={edit.settings?.type ?? 'paybill'} onChange={(e) => setEdit({ ...edit, settings: { ...edit.settings, type: e.target.value } })} options={[{ value: 'paybill', label: 'Paybill (customers enter an account number)' }, { value: 'till', label: 'Buy Goods / Till number' }]} /></Field>
                ) : (k === 'tillNumber' && edit.kind === 'mpesa' && (edit.settings?.type ?? 'paybill') !== 'till') ? null : (
                  <Field key={k} label={l}><Input value={edit.settings?.[k] ?? ''} onChange={(e) => setEdit({ ...edit, settings: { ...edit.settings, [k]: k === 'port' ? Number(e.target.value) : e.target.value } })} /></Field>
                ))}
              </div>
              {edit.kind === 'mpesa' && edit.provider === 'daraja' && <Checkbox label="Double-check every callback with an STK status query" checked={Boolean(edit.settings?.verifyCallbacksWithQuery)} onChange={(v) => setEdit({ ...edit, settings: { ...edit.settings, verifyCallbacksWithQuery: v } })} />}
            </fieldset>
            {((edit.kind === 'payment' && info?.fields.some((f) => f.secret)) || (PROVIDER_FIELDS[edit.provider]?.secrets ?? []).length > 0) && (
              <fieldset className="space-y-3 rounded-lg border border-amber-200 bg-amber-50/50 p-4 dark:border-amber-900 dark:bg-amber-950/20">
                <legend className="px-1 text-xs font-bold uppercase tracking-wide text-amber-700 dark:text-amber-300"><Icon name="shield" className="mr-1 inline h-3.5 w-3.5" />Secret credentials</legend>
                <p className="text-xs text-ink-600 dark:text-ink-300">Encrypted on the server and never shown again. Leave a saved field blank to keep it.</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {edit.kind === 'payment' && info?.fields.filter((f) => f.secret).map((f) => (
                    <Field key={f.key} label={`${f.label}${f.required ? ' *' : ''}`} hint={edit.secretsSet?.includes(f.key) ? 'Saved. Leave blank to keep.' : f.help}><Input type="password" autoComplete="new-password" value={edit.secrets?.[f.key] ?? ''} onChange={(e) => setEdit({ ...edit, secrets: { ...edit.secrets, [f.key]: e.target.value } })} /></Field>
                  ))}
                  {(PROVIDER_FIELDS[edit.provider]?.secrets ?? []).map(([k, l]) => <Field key={k} label={l} hint={edit.secretsSet?.includes(k) ? 'Saved. Leave blank to keep.' : undefined}><Input type="password" autoComplete="new-password" value={edit.secrets?.[k] ?? ''} onChange={(e) => setEdit({ ...edit, secrets: { ...edit.secrets, [k]: e.target.value } })} /></Field>)}
                </div>
              </fieldset>
            )}
            {edit.kind === 'mpesa' && (edit.id
              ? <C2BPanel config={rows.find((r) => r.id === edit.id) ?? edit} onChanged={() => q.refetch()} />
              : <p className="rounded-lg border border-dashed border-ink-200 p-3 text-xs text-ink-500 dark:border-ink-700">Save first, then register the C2B URLs here so payments made straight to your Paybill/Till reach Afey POS.</p>)}
            {edit.kind === 'payment' && edit.webhookUrl && (
              <div><CopyField label="Webhook / callback URL" value={edit.webhookUrl} /><p className="mt-1 text-xs text-ink-500">Set this in the provider dashboard if asked. It contains a secret token.</p></div>
            )}
            {info?.docsUrl && <a className="inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:underline" href={info.docsUrl} target="_blank" rel="noreferrer">Provider API documentation ↗</a>}
            <ErrorBox error={error} />
          </div>
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
      <ReceiptPrinterCard />
      <BridgePairingCard />
      <FingerprintReadersCard />
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
      <p className="mt-1 text-xs text-ink-500">Shown on the sign-in page, documents and receipts, and used as the icon of the installed app (desktop, taskbar, phone). A square image of at least 512 × 512 pixels looks best.</p>
    </div>
  );
}

type Scope = 'all' | 'branches' | 'tills';
const scopeOf = (c: any): Scope => c.scope ?? (c.tillIds?.length ? 'tills' : c.branchIds?.length ? 'branches' : 'all');

/** "Used by" line on an M-Pesa card. */
function usedByText(c: any, locs?: Locations) {
  const scope = scopeOf(c);
  if (scope === 'all') return 'all branches and tills';
  if (scope === 'branches') return `${c.branchIds.map((id: string) => locs?.branches.find((b) => b._id === id)?.name ?? '?').join(', ')} (all tills)`;
  return c.tillIds.map((id: string) => {
    const t = locs?.tills.find((x) => x._id === id);
    return t ? `${t.name} (${locs?.branches.find((b) => b._id === t.branchId)?.name ?? ''})` : '?';
  }).join(', ');
}

/**
 * Which branches and tills use this M-Pesa account. A till uses an M-Pesa set up for that till, else its branch's
 * (shared by all the branch's tills), else the one for all branches.
 */
function MpesaUsedBy({ edit, setEdit, locs, branchesOnly = false }: { edit: any; setEdit: (e: any) => void; locs: Locations; branchesOnly?: boolean }) {
  const scope = scopeOf(edit);
  const toggle = (key: 'branchIds' | 'tillIds', id: string, on: boolean) => setEdit({ ...edit, scope, [key]: on ? [...(edit[key] ?? []), id] : (edit[key] ?? []).filter((x: string) => x !== id) });
  const options: { v: Scope; t: string; d: string }[] = branchesOnly
    ? [{ v: 'all', t: 'All branches', d: 'Every branch can take payments with it' }, { v: 'branches', t: 'Chosen branches', d: 'Only these branches show it at checkout' }]
    : [
      { v: 'all', t: 'All branches and tills', d: 'One M-Pesa account for the whole business' },
      { v: 'branches', t: 'Chosen branches', d: 'Every till in these branches uses this account' },
      { v: 'tills', t: 'Chosen tills only', d: 'For a separate Till number per counter' },
    ];
  return (
    <fieldset className="space-y-3">
      <legend className="mb-1 text-xs font-bold uppercase tracking-wide text-ink-500">Used by</legend>
      <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Used by">
        {options.map((o) => (
          <button key={o.v} type="button" role="radio" aria-checked={scope === o.v} onClick={() => setEdit({ ...edit, scope: o.v })}
            className={cx('rounded-lg border p-3 text-left transition', scope === o.v ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500 dark:bg-brand-500/10' : 'border-ink-200 hover:border-ink-300 dark:border-ink-700')}>
            <span className="block text-sm font-semibold">{o.t}</span><span className="block text-xs text-ink-500">{o.d}</span>
          </button>
        ))}
      </div>
      {scope === 'branches' && (
        <div className="flex flex-wrap gap-4">{locs.branches.filter((b) => b.active).map((b) => <Checkbox key={b._id} label={b.name} checked={(edit.branchIds ?? []).includes(b._id)} onChange={(v) => toggle('branchIds', b._id, v)} />)}</div>
      )}
      {scope === 'tills' && (
        <div className="space-y-2">
          {locs.branches.filter((b) => b.active).map((b) => {
            const tills = locs.tills.filter((t) => t.active && t.branchId === b._id);
            if (!tills.length) return null;
            return (
              <div key={b._id}>
                <div className="text-xs font-semibold text-ink-500">{b.name}</div>
                <div className="mt-1 flex flex-wrap gap-4">{tills.map((t) => <Checkbox key={t._id} label={`${t.name} (${t.code})`} checked={(edit.tillIds ?? []).includes(t._id)} onChange={(v) => toggle('tillIds', t._id, v)} />)}</div>
              </div>
            );
          })}
        </div>
      )}
      <p className="text-xs text-ink-500">{branchesOnly ? 'Tills of the chosen branches offer this payment method at checkout.' : 'Each till uses the M-Pesa set up for that till, otherwise its branch’s, otherwise the one for all branches. Register the C2B URLs for each account (button on its card).'}</p>
    </fieldset>
  );
}
