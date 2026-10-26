/**
 * Roles & permissions: built-in roles (read-only), custom roles defined by the business, and the rules that stop
 * anyone giving out more access than they have themselves.
 *
 * Rules for everyone except owners:
 *  - you can only grant permissions you hold (in roles, custom roles or a user's own grants);
 *  - you cannot change a user who can do things you cannot;
 *  - if you are limited to some branches, the users you manage are too (to the same or fewer branches);
 *  - nobody changes their own roles, permissions or branches.
 * Only owners create or change owners; the last active owner cannot be removed or disabled.
 */
import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { CUSTOM_ROLE_PREFIX, PERMISSION_GROUPS, PERMISSION_INFO, PERMISSIONS, ROLE_LABELS, ROLE_PERMISSIONS, ROLES, effectivePermissions, isCustomRole, type Permission } from '@afeypos/shared';
import { CustomRole, User } from '../../models/index.js';
import { parse } from '../../http/validate.js';
import { requirePermission } from '../../http/auth.js';
import { badRequest, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { userPermissions } from '../../lib/access.js';

const isOwner = (req: Request) => req.auth!.roles.includes('tenant_owner');

/** Permissions the actor may hand out. Owners may hand out everything. */
function assertCanGrant(req: Request, perms: Iterable<string>, what = 'grant') {
  if (isOwner(req)) return;
  const missing = [...perms].filter((p) => !req.auth!.permissions.has(p as Permission));
  if (missing.length) throw forbidden(`You cannot ${what} permissions you do not have yourself: ${missing.map((p) => PERMISSION_INFO[p as Permission]?.label ?? p).join(', ')}`);
}

export interface AccessChange {
  roles: string[];
  extraPermissions: string[];
  deniedPermissions: string[];
  branchIds: string[];
  status?: 'active' | 'disabled';
}

/**
 * Checks a user create (target null) or update. `next` is the state after the change.
 * Throws when the change would let the actor escalate access or lock the business out.
 */
export async function checkUserAccessChange(req: Request, target: { _id: unknown; roles: string[]; extraPermissions?: string[]; deniedPermissions?: string[]; branchIds?: unknown[]; status?: string } | null, next: AccessChange) {
  const actorId = String(req.auth!.userId);
  const same = (a: unknown[] = [], b: unknown[] = []) => a.length === b.length && a.map(String).sort().join() === b.map(String).sort().join();
  if (target && String(target._id) === actorId) {
    const changed = !same(target.roles, next.roles) || !same(target.extraPermissions, next.extraPermissions) || !same(target.deniedPermissions, next.deniedPermissions) || !same(target.branchIds, next.branchIds);
    if (changed) throw forbidden('You cannot change your own roles, permissions or branches. Ask another administrator.');
    if (next.status === 'disabled') throw badRequest('You cannot disable your own account');
  }
  const touchesOwner = target?.roles.includes('tenant_owner') || next.roles.includes('tenant_owner');
  if (touchesOwner && !isOwner(req)) throw forbidden('Only owners can create or change owner accounts');

  // Custom roles must exist.
  const keys = next.roles.filter(isCustomRole);
  const custom = keys.length ? await CustomRole.find({ key: { $in: keys } }, { key: 1, permissions: 1 }).lean() : [];
  if (custom.length !== new Set(keys).size) throw badRequest('A selected role does not exist');
  for (const r of next.roles) if (!isCustomRole(r) && !(ROLES as readonly string[]).includes(r)) throw badRequest(`Unknown role ${r}`);

  if (!isOwner(req)) {
    // Not over someone more powerful...
    if (target) {
      const current = await userPermissions(target as any);
      const beyond = [...current].filter((p) => !req.auth!.permissions.has(p));
      if (beyond.length) throw forbidden('This user can do things you cannot, so you cannot change their account');
    }
    // ...and not into more than the actor has.
    const after = effectivePermissions({ roles: next.roles, customRoles: custom as any, extraPermissions: next.extraPermissions, deniedPermissions: next.deniedPermissions });
    assertCanGrant(req, after, 'give');
  }

  // Branch-limited managers only manage users limited to (some of) their branches.
  const mine = req.auth!.branchIds.map(String);
  if (mine.length) {
    const within = (ids: unknown[] = []) => ids.length > 0 && ids.every((b) => mine.includes(String(b)));
    if (target && !within(target.branchIds)) throw forbidden('This user works in branches you do not manage');
    if (!within(next.branchIds)) throw forbidden('Choose only branches you manage; you cannot give access to all branches');
  }

  // Keep at least one active owner.
  if (target?.roles.includes('tenant_owner') && (!next.roles.includes('tenant_owner') || next.status === 'disabled')) {
    const others = await User.countDocuments({ _id: { $ne: target._id }, roles: 'tenant_owner', status: 'active' });
    if (!others) throw unprocessable('The business needs at least one active owner', 'LAST_OWNER');
  }
}

const roleBody = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(300).optional(),
  permissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length),
});

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'role';

export const roleRoutes = Router();

roleRoutes.get('/settings/roles', requirePermission('users.manage'), async (_req, res) => {
  const [custom, counts] = await Promise.all([
    CustomRole.find({}).sort({ name: 1 }).lean(),
    User.aggregate([{ $unwind: '$roles' }, { $group: { _id: '$roles', n: { $sum: 1 } } }]),
  ]);
  const users = new Map(counts.map((c) => [c._id, c.n]));
  res.json({
    data: {
      builtIn: ROLES.map((r) => ({ key: r, name: ROLE_LABELS[r], permissions: ROLE_PERMISSIONS[r], users: users.get(r) ?? 0 })),
      custom: custom.map((c) => ({ key: c.key, name: c.name, description: c.description, permissions: c.permissions, users: users.get(c.key) ?? 0, updatedAt: c.updatedAt })),
      permissions: PERMISSIONS.map((p) => ({ key: p, ...PERMISSION_INFO[p] })),
      groups: PERMISSION_GROUPS,
    },
  });
});

roleRoutes.post('/settings/roles', requirePermission('users.manage'), async (req, res) => {
  const body = parse(roleBody, req.body);
  assertCanGrant(req, body.permissions);
  let key = `${CUSTOM_ROLE_PREFIX}${slug(body.name)}`;
  for (let i = 2; await CustomRole.exists({ key }); i++) key = `${CUSTOM_ROLE_PREFIX}${slug(body.name)}-${i}`;
  const role = await CustomRole.create({ ...body, key, createdBy: req.auth!.userId });
  await audit(req, { action: 'role.created', entity: 'CustomRole', entityId: role._id, details: { key, permissions: body.permissions } });
  res.status(201).json({ data: role });
});

roleRoutes.put('/settings/roles/:key', requirePermission('users.manage'), async (req, res) => {
  const body = parse(roleBody, req.body);
  const role = await CustomRole.findOne({ key: String(req.params.key) });
  if (!role) throw notFound('Role');
  // Changing a role changes everyone who has it: the actor must hold both the old and the new permissions.
  assertCanGrant(req, new Set([...role.permissions, ...body.permissions]), 'change');
  const before = [...role.permissions];
  Object.assign(role, body, { updatedBy: req.auth!.userId });
  await role.save();
  await audit(req, { action: 'role.updated', entity: 'CustomRole', entityId: role._id, details: { key: role.key, added: body.permissions.filter((p) => !before.includes(p)), removed: before.filter((p) => !body.permissions.includes(p as Permission)) } });
  res.json({ data: role });
});

roleRoutes.delete('/settings/roles/:key', requirePermission('users.manage'), async (req, res) => {
  const role = await CustomRole.findOne({ key: String(req.params.key) });
  if (!role) throw notFound('Role');
  assertCanGrant(req, role.permissions, 'remove');
  const inUse = await User.countDocuments({ roles: role.key });
  if (inUse) throw unprocessable(`${inUse} user(s) still have this role. Give them another role first.`, 'ROLE_IN_USE');
  await role.deleteOne();
  await audit(req, { action: 'role.deleted', entity: 'CustomRole', entityId: role._id, details: { key: role.key } });
  res.json({ data: { deleted: true } });
});

/** What a user can do and why (which role or grant gives each permission). */
roleRoutes.get('/settings/users/:id/access', requirePermission('users.manage'), async (req, res) => {
  const u = await User.findById(String(req.params.id)).lean();
  if (!u) throw notFound('User');
  const keys = (u.roles as string[]).filter(isCustomRole);
  const custom = keys.length ? await CustomRole.find({ key: { $in: keys } }).lean() : [];
  const effective = await userPermissions(u);
  const sources = PERMISSIONS.map((p) => ({
    permission: p,
    allowed: effective.has(p),
    from: [
      ...(u.roles as string[]).filter((r) => (ROLE_PERMISSIONS as Record<string, readonly string[]>)[r]?.includes(p)).map((r) => ROLE_LABELS[r as keyof typeof ROLE_LABELS]),
      ...custom.filter((c) => c.permissions.includes(p)).map((c) => c.name),
      ...((u.extraPermissions ?? []).includes(p) ? ['granted to this user'] : []),
    ],
    denied: (u.deniedPermissions ?? []).includes(p) && !(u.roles as string[]).includes('tenant_owner'),
  }));
  res.json({ data: { userId: u._id, owner: (u.roles as string[]).includes('tenant_owner'), branchIds: u.branchIds ?? [], permissions: sources } });
});
