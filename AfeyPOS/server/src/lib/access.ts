/**
 * Effective access of a user: permissions (built-in roles, custom roles, per-user grants and denials) and the
 * branches / warehouses they may work in. Used for every signed-in request and for supervisor approvals.
 */
import type { Types } from 'mongoose';
import { effectivePermissions, isCustomRole, type Permission } from '@afeypos/shared';
import { CustomRole, Warehouse } from '../models/index.js';

interface UserLike { roles?: string[] | null; extraPermissions?: string[] | null; deniedPermissions?: string[] | null; branchIds?: unknown[] | null }

export async function userPermissions(u: UserLike): Promise<Set<Permission>> {
  const roles = (u.roles ?? []) as string[];
  const keys = roles.filter(isCustomRole);
  const customRoles = keys.length ? await CustomRole.find({ key: { $in: keys } }, { key: 1, permissions: 1 }).lean() : [];
  return effectivePermissions({ roles, customRoles: customRoles as { key: string; permissions: string[] }[], extraPermissions: u.extraPermissions ?? [], deniedPermissions: u.deniedPermissions ?? [] });
}

/** Warehouses belonging to the user's branches (none when the user may work everywhere). */
export async function userWarehouses(u: UserLike): Promise<Types.ObjectId[]> {
  if (!u.branchIds?.length) return [];
  return (await Warehouse.find({ branchId: { $in: u.branchIds } }, { _id: 1 }).lean()).map((w) => w._id as Types.ObjectId);
}
