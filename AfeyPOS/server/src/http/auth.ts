import type { Request, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { permissionsForRoles, type ModuleKey, type Permission, type Role } from '@afeypos/shared';
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
  return {
    kind: 'tenant', userId: u._id, name: u.name, email: u.email, roles: u.roles as Role[], permissions: permissionsForRoles(u.roles as Role[]),
    sessionId: session._id, tenantId, branchIds: (u.branchIds ?? []) as Types.ObjectId[],
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
  if (ctx) ctx.userId = req.auth.userId;
  next();
};

export function requirePermission(...perms: Permission[]): RequestHandler {
  return (req, _res, next) => {
    const a = req.auth;
    if (!a) throw unauthorized();
    for (const p of perms) if (!a.permissions.has(p)) throw forbidden(`Missing permission: ${p}`);
    next();
  };
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

export function can(req: Request, p: Permission): boolean {
  return Boolean(req.auth?.permissions.has(p));
}
