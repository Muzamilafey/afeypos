import type { Request, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import type { ModuleKey, Permission } from '@afeypos/shared';
import { userPermissions, userWarehouses } from '../lib/access.js';
import { env } from '../config/env.js';
import { Session, User } from '../models/index.js';
import { AppError, forbidden, unauthorized } from '../lib/errors.js';
import { currentContext } from '../lib/context.js';
import type { AuthInfo } from './types.js';

export interface AccessClaims {
  sub: string;
  /** Staff session of the business (kept as "tenant" so existing tokens stay valid). */
  typ: 'tenant';
  tid?: string;
  sid: string;
}

const ISSUER = 'afeypos';

export function signAccessToken(claims: AccessClaims): string {
  return jwt.sign(claims, env().JWT_ACCESS_SECRET, { algorithm: 'HS256', expiresIn: env().JWT_ACCESS_TTL_SECONDS, issuer: ISSUER, audience: claims.typ });
}

export function signShortToken(claims: Record<string, unknown>, audience: string, seconds: number): string {
  return jwt.sign(claims, env().JWT_ACCESS_SECRET, { algorithm: 'HS256', expiresIn: seconds, issuer: ISSUER, audience });
}

export function verifyShortToken<T>(token: string, audience: string): T {
  try {
    return jwt.verify(token, env().JWT_ACCESS_SECRET, { algorithms: ['HS256'], issuer: ISSUER, audience }) as T;
  } catch {
    throw unauthorized('Invalid or expired token');
  }
}

export function verifyAccessToken(token: string): AccessClaims {
  try {
    return jwt.verify(token, env().JWT_ACCESS_SECRET, { algorithms: ['HS256'], issuer: ISSUER, audience: 'tenant' }) as AccessClaims;
  } catch {
    throw unauthorized('Session expired or invalid');
  }
}

export async function resolveAuth(token: string, tenantId?: Types.ObjectId): Promise<AuthInfo> {
  const claims = verifyAccessToken(token);
  const session = await Session.findOne({ _id: claims.sid, revokedAt: null, expiresAt: { $gt: new Date() } }).lean();
  if (!session || String(session.userId) !== claims.sub) throw unauthorized('Session has been revoked');
  if (!tenantId || claims.tid !== String(tenantId) || String(session.tenantId) !== String(tenantId)) throw unauthorized('Session expired');

  const u = await User.findOne({ _id: claims.sub, status: 'active' }).lean();
  if (!u) throw unauthorized('Account is disabled');
  // Recomputed on every request, so role and permission changes apply at once.
  const [permissions, warehouseIds] = await Promise.all([userPermissions(u), userWarehouses(u)]);
  return {
    kind: 'tenant', userId: u._id, name: u.name, email: u.email, roles: u.roles as string[], permissions,
    sessionId: session._id, tenantId, branchIds: (u.branchIds ?? []) as Types.ObjectId[], warehouseIds,
  };
}

function bearer(req: Request): string | null {
  const h = req.get('authorization');
  return h?.startsWith('Bearer ') ? h.slice(7) : null;
}

export const authenticate: RequestHandler = async (req, _res, next) => {
  const token = bearer(req);
  if (!token) throw unauthorized();
  req.auth = await resolveAuth(token, req.tenant?._id);
  const ctx = currentContext();
  if (ctx) {
    ctx.userId = req.auth.userId;
    // Branch-restricted users only see and write their branches' records (db/branchScopePlugin).
    if (req.auth.branchIds.length) ctx.branchScope = { branchIds: req.auth.branchIds, warehouseIds: req.auth.warehouseIds };
  }
  next();
};

/** Marks a handler as an access check, so the route audit (tests/permissions-audit) can see every route is guarded. */
export const GUARD = Symbol('afey.guard');
export function markGuard<T extends RequestHandler>(fn: T, description: string): T {
  return Object.assign(fn, { [GUARD]: description });
}

export function requirePermission(...perms: Permission[]): RequestHandler {
  return markGuard((req, _res, next) => {
    const a = req.auth;
    if (!a) throw unauthorized();
    for (const p of perms) if (!a.permissions.has(p)) throw forbidden(`Missing permission: ${p}`);
    next();
  }, perms.join('+'));
}

/** Passes with at least one of the permissions. */
export function requireAnyPermission(...perms: Permission[]): RequestHandler {
  return markGuard((req, _res, next) => {
    const a = req.auth;
    if (!a) throw unauthorized();
    if (!perms.some((p) => a.permissions.has(p))) throw forbidden(`Missing permission: ${perms.join(' or ')}`);
    next();
  }, perms.join('|'));
}

/** Passes for users holding one of the built-in roles (for actions reserved to owners/administrators). */
export function requireRole(...roles: string[]): RequestHandler {
  return markGuard((req, _res, next) => {
    if (!req.auth) throw unauthorized();
    if (!roles.some((r) => req.auth!.roles.includes(r))) throw forbidden('Only owners and administrators can do this');
    next();
  }, `role:${roles.join('|')}`);
}

/**
 * Any signed-in user may use the route (their own account, or data every staff member needs). Must be stated
 * explicitly: the route audit test fails for signed-in routes without a guard.
 */
export function signedIn(reason: string): RequestHandler {
  return markGuard((req, _res, next) => {
    if (!req.auth) throw unauthorized();
    next();
  }, `signed-in: ${reason}`);
}

export function requireModule(...modules: ModuleKey[]): RequestHandler {
  return (req, _res, next) => {
    for (const m of modules) {
      if (!req.capabilities?.modules.includes(m)) throw new AppError(403, 'MODULE_DISABLED', `The ${m} module is not enabled for this business`);
    }
    next();
  };
}

/** Passes when at least one of the modules is enabled. */
export function requireAnyModule(...modules: ModuleKey[]): RequestHandler {
  return (req, _res, next) => {
    if (!modules.some((m) => req.capabilities?.modules.includes(m))) throw new AppError(403, 'MODULE_DISABLED', `Enable one of: ${modules.join(', ')}`);
    next();
  };
}

export function assertBranchAccess(req: Request, branchId: Types.ObjectId | string | undefined | null) {
  const a = req.auth;
  if (!a || !branchId || a.branchIds.length === 0) return;
  if (!a.branchIds.some((b) => String(b) === String(branchId))) throw forbidden('You do not have access to this branch');
}

/** For users limited to some branches: the warehouse must belong to one of them. */
export function assertWarehouseAccess(req: Request, warehouseId: Types.ObjectId | string | undefined | null) {
  const a = req.auth;
  if (!a || !warehouseId || a.branchIds.length === 0) return;
  if (!a.warehouseIds.some((w) => String(w) === String(warehouseId))) throw forbidden('You do not have access to this warehouse');
}

export function can(req: Request, p: Permission): boolean {
  return Boolean(req.auth?.permissions.has(p));
}
