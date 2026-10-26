import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { effectivePermissions, type Permission } from '@afeypos/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Badge, Button, cx, ErrorBox, Field, Input, Loading, PageHeader, useConfirm, useToast } from '../../components/ui';
import { Icon } from '../../components/icons';

/**
 * Roles & permissions. Built-in roles are fixed; custom roles are this business's own sets of permissions.
 * The server refuses anything that gives out more than the person editing has, so permissions you do not
 * hold are shown but cannot be ticked.
 */

export interface RoleCatalog {
  builtIn: { key: string; name: string; permissions: Permission[]; users: number }[];
  custom: { key: string; name: string; description?: string; permissions: Permission[]; users: number }[];
  permissions: { key: Permission; label: string; group: string; sensitive?: boolean }[];
  groups: string[];
}

export function useRoleCatalog(enabled = true) {
  return useQuery({ queryKey: ['roles'], queryFn: () => api<{ data: RoleCatalog }>('/settings/roles').then((r) => r.data), enabled });
}

export function roleName(cat: RoleCatalog | undefined, key: string) {
  return cat?.builtIn.find((r) => r.key === key)?.name ?? cat?.custom.find((r) => r.key === key)?.name ?? key.replace(/^custom:/, '');
}

/** Grouped checklist of permissions. `mode` decides what a click does. */
function PermissionGrid({ cat, value, onToggle, readOnly, mine, owner, render }: {
  cat: RoleCatalog; value: Set<Permission>; onToggle?: (p: Permission, on: boolean) => void; readOnly?: boolean; mine: Set<string>; owner: boolean;
  render?: (p: RoleCatalog['permissions'][number]) => React.ReactNode;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {cat.groups.map((g) => {
        const perms = cat.permissions.filter((p) => p.group === g);
        if (!perms.length) return null;
        return (
          <fieldset key={g} className="rounded-sm border border-[#e3e6ea] p-3 dark:border-ink-700">
            <legend className="px-1 text-xs font-bold uppercase tracking-wide text-ink-500">{g} <span className="font-normal normal-case">({perms.filter((p) => value.has(p.key)).length}/{perms.length})</span></legend>
            <ul className="space-y-1.5">
              {perms.map((p) => {
                const allowedToGive = owner || mine.has(p.key);
                return (
                  <li key={p.key} className="flex items-center gap-2 text-sm">
                    {render ? render(p) : (
                      <label className={cx('flex flex-1 items-center gap-2', (readOnly || !allowedToGive) && 'cursor-not-allowed opacity-70')} title={!allowedToGive ? 'You do not have this permission, so you cannot give it' : undefined}>
                        <input type="checkbox" checked={value.has(p.key)} disabled={readOnly || !allowedToGive} onChange={(e) => onToggle?.(p.key, e.target.checked)} aria-label={p.label} />
                        <span className="flex-1">{p.label}</span>
                      </label>
                    )}
                    {p.sensitive && <Badge tone="amber">sensitive</Badge>}
                  </li>
                );
              })}
            </ul>
          </fieldset>
        );
      })}
    </div>
  );
}

export function RolesPage() {
  const { me } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const cat = useRoleCatalog();
  const [selected, setSelected] = useState<string>('cashier');
  const [draft, setDraft] = useState<{ key?: string; name: string; description: string; permissions: Set<Permission> } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const mine = useMemo(() => new Set(me!.permissions), [me]);
  const owner = me!.user.roles.includes('tenant_owner');
  if (!cat.data) return cat.error ? <ErrorBox error={cat.error} /> : <Loading />;
  const c = cat.data;
  const builtIn = c.builtIn.find((r) => r.key === selected);
  const custom = c.custom.find((r) => r.key === selected);
  const startNew = (from?: { name: string; permissions: Permission[] }) => {
    setError(null);
    setDraft({ name: from ? `${from.name} (custom)` : '', description: '', permissions: new Set((from?.permissions ?? []).filter((p) => owner || mine.has(p))) });
    setSelected('');
  };
  const edit = (r: RoleCatalog['custom'][number]) => {
    setError(null);
    setSelected(r.key);
    setDraft({ key: r.key, name: r.name, description: r.description ?? '', permissions: new Set(r.permissions) });
  };
  const save = async () => {
    if (!draft) return;
    setError(null);
    try {
      const body = { name: draft.name, description: draft.description || undefined, permissions: [...draft.permissions] };
      const r = draft.key ? await api<{ data: any }>(`/settings/roles/${draft.key}`, { method: 'PUT', body }) : await api<{ data: any }>('/settings/roles', { body });
      toast.success(`Role “${r.data.name}” saved`);
      await qc.invalidateQueries({ queryKey: ['roles'] });
      // Keep the saved role open.
      edit({ key: r.data.key, name: r.data.name, description: r.data.description, permissions: r.data.permissions, users: 0 });
    } catch (e) { setError(e); }
  };
  const remove = async (r: RoleCatalog['custom'][number]) => {
    if (!(await confirm({ title: `Delete “${r.name}”?`, message: 'Users must have another role first.', confirmLabel: 'Delete role', danger: true }))) return;
    try {
      await api(`/settings/roles/${r.key}`, { method: 'DELETE' });
      toast.success('Role deleted');
      setSelected('cashier');
      setDraft(null);
      qc.invalidateQueries({ queryKey: ['roles'] });
    } catch (e) { toast.error(e); }
  };
  const item = (key: string, name: string, users: number, onClick: () => void) => (
    <li key={key}><button type="button" onClick={onClick} className={cx('flex w-full items-center justify-between rounded-sm px-3 py-2 text-left text-sm', selected === key ? 'bg-brand-500 text-white' : 'hover:bg-[#f5f6f8] dark:hover:bg-ink-800')}>
      <span>{name}</span><span className={cx('text-xs', selected === key ? 'text-white/80' : 'text-ink-500')}>{users} {users === 1 ? 'user' : 'users'}</span>
    </button></li>
  );
  return (
    <div>
      <PageHeader title="Roles & permissions" subtitle="Who can do what. Changes apply straight away, without signing in again." actions={<Button onClick={() => startNew()}><Icon name="plus" className="h-4 w-4" />New role</Button>} />
      <div className="grid gap-3 lg:grid-cols-[260px_1fr]">
        <div className="card p-2">
          <div className="px-2 pb-1 pt-2 text-[11px] font-bold uppercase tracking-wide text-ink-500">Built-in roles</div>
          <ul>{c.builtIn.map((r) => item(r.key, r.name, r.users, () => { setSelected(r.key); setDraft(null); }))}</ul>
          <div className="px-2 pb-1 pt-4 text-[11px] font-bold uppercase tracking-wide text-ink-500">Your roles</div>
          <ul>{c.custom.map((r) => item(r.key, r.name, r.users, () => edit(r)))}</ul>
          {!c.custom.length && <p className="px-3 py-2 text-xs text-ink-500">None yet. Create one, or copy a built-in role and change it.</p>}
        </div>
        <div className="card p-4">
          {draft ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Role name"><Input value={draft.name} maxLength={60} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Shelf filler" /></Field>
                <Field label="Description (optional)"><Input value={draft.description} maxLength={300} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></Field>
              </div>
              <p className="text-sm text-ink-600">{draft.permissions.size} permission(s) selected. {!owner && 'You can only include permissions you have yourself.'}</p>
              <PermissionGrid cat={c} value={draft.permissions} mine={mine} owner={owner} onToggle={(p, on) => { const n = new Set(draft.permissions); if (on) n.add(p); else n.delete(p); setDraft({ ...draft, permissions: n }); }} />
              <ErrorBox error={error} />
              <div className="flex flex-wrap gap-2">
                <Button onClick={save} disabled={draft.name.trim().length < 2}>Save role</Button>
                <Button variant="secondary" onClick={() => { setDraft(null); if (!draft.key) setSelected('cashier'); }}>Cancel</Button>
                {custom && <Button variant="ghost" className="ml-auto text-red-600" onClick={() => remove(custom)}>Delete role</Button>}
              </div>
            </div>
          ) : builtIn ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div><h2 className="text-base font-bold">{builtIn.name}</h2><p className="text-sm text-ink-500">Built-in role: {builtIn.permissions.length} permissions. It cannot be changed; copy it to make your own version.</p></div>
                {builtIn.key !== 'tenant_owner' && <Button variant="secondary" onClick={() => startNew(builtIn)}><Icon name="layersStack" className="h-4 w-4" />Copy as new role</Button>}
              </div>
              <PermissionGrid cat={c} value={new Set(builtIn.permissions)} mine={mine} owner={owner} readOnly />
            </div>
          ) : custom ? (
            <Button variant="secondary" onClick={() => edit(custom)}>Edit {custom.name}</Button>
          ) : <p className="text-sm text-ink-500">Choose a role.</p>}
        </div>
      </div>
    </div>
  );
}

/**
 * Per-user adjustments on top of their roles: allow extra permissions or deny ones the roles give.
 * Shows the result (what this user will be able to do).
 */
export function UserPermissionsEditor({ cat, roles, extra, denied, onChange, isOwnerTarget }: {
  cat: RoleCatalog; roles: string[]; extra: Permission[]; denied: Permission[]; onChange: (extra: Permission[], denied: Permission[]) => void; isOwnerTarget: boolean;
}) {
  const { me } = useAuth();
  const mine = useMemo(() => new Set(me!.permissions), [me]);
  const owner = me!.user.roles.includes('tenant_owner');
  const fromRoles = useMemo(() => effectivePermissions({ roles, customRoles: cat.custom }), [roles, cat.custom]);
  const result = useMemo(() => effectivePermissions({ roles, customRoles: cat.custom, extraPermissions: extra, deniedPermissions: denied }), [roles, cat.custom, extra, denied]);
  if (isOwnerTarget) return <p className="text-sm text-ink-500">Owners can always do everything.</p>;
  const set = (p: Permission, state: 'role' | 'allow' | 'deny') => onChange(state === 'allow' ? [...new Set([...extra, p])] : extra.filter((x) => x !== p), state === 'deny' ? [...new Set([...denied, p])] : denied.filter((x) => x !== p));
  return (
    <div className="space-y-2">
      <p className="text-sm text-ink-600">This user can do <strong>{result.size}</strong> of {cat.permissions.length} things{extra.length || denied.length ? ` (${extra.length} added, ${denied.length} taken away)` : ''}.</p>
      <PermissionGrid cat={cat} value={result} mine={mine} owner={owner} render={(p) => {
        const state = denied.includes(p.key) ? 'deny' : extra.includes(p.key) ? 'allow' : 'role';
        const canGive = owner || mine.has(p.key);
        return (
          <>
            <span className={cx('flex-1', result.has(p.key) ? 'text-ink-800 dark:text-ink-100' : 'text-ink-400 line-through')}>{p.label}</span>
            <select aria-label={`${p.label} for this user`} className="rounded-sm border border-[#d5d9de] bg-white px-1.5 py-0.5 text-xs dark:border-ink-700 dark:bg-ink-900" value={state} onChange={(e) => set(p.key, e.target.value as 'role')}>
              <option value="role">{fromRoles.has(p.key) ? 'Yes (role)' : 'No (role)'}</option>
              <option value="allow" disabled={!canGive || fromRoles.has(p.key)}>Allow</option>
              <option value="deny" disabled={!fromRoles.has(p.key)}>Deny</option>
            </select>
          </>
        );
      }} />
    </div>
  );
}
