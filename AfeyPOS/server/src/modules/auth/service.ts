import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { AuthToken, Session, User } from '../../models/index.js';
import { randomToken, safeEqual, sha256, verifyPassword } from '../../lib/crypto.js';
import { AppError, unauthorized } from '../../lib/errors.js';
import { signAccessToken } from '../../http/auth.js';

export const REFRESH_COOKIE = 'afey_rt';
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  sessionId: Types.ObjectId;
  expiresIn: number;
}

export async function issueSession(opts: {
  userType: 'tenant';
  userId: Types.ObjectId;
  tenantId?: Types.ObjectId;
  req: Request;
  expiresAt?: Date;
}): Promise<IssuedSession> {
  const secret = randomToken(32);
  const sessionId = new Types.ObjectId();
  await Session.create({
    _id: sessionId,
    userId: opts.userId,
    userType: opts.userType,
    tenantId: opts.tenantId,
    refreshHash: sha256(secret),
    expiresAt: opts.expiresAt ?? new Date(Date.now() + env().REFRESH_TTL_DAYS * 86400_000),
    ip: opts.req.ip,
    userAgent: opts.req.get('user-agent')?.slice(0, 300),
    lastUsedAt: new Date(),
  });
  const accessToken = signAccessToken({ sub: String(opts.userId), typ: opts.userType, tid: opts.tenantId ? String(opts.tenantId) : undefined, sid: String(sessionId) });
  return { accessToken, refreshToken: `${sessionId}.${secret}`, sessionId, expiresIn: env().JWT_ACCESS_TTL_SECONDS };
}

/**
 * Rotates a refresh token. Presenting an already-rotated token (outside a short grace window for
 * concurrent tabs) is treated as theft and revokes the whole session.
 */
export async function rotateRefresh(raw: string | undefined, tenantId?: Types.ObjectId): Promise<IssuedSession> {
  if (!raw || !raw.includes('.')) throw unauthorized('No refresh session');
  const [sid, secret] = raw.split('.');
  if (!Types.ObjectId.isValid(sid)) throw unauthorized('No refresh session');
  const session = await Session.findById(sid);
  if (!session || session.revokedAt || session.expiresAt < new Date()) throw unauthorized('Session expired');
  if (session.userType !== 'tenant' || String(session.tenantId) !== String(tenantId)) throw unauthorized('Session expired');
  const hash = sha256(secret);
  if (!safeEqual(hash, session.refreshHash)) {
    if (session.previousHash && safeEqual(hash, session.previousHash)) {
      const sinceRotation = Date.now() - (session.lastUsedAt?.getTime() ?? 0);
      if (sinceRotation > 30_000) {
        session.revokedAt = new Date();
        session.revokedReason = 'refresh_token_reuse';
        await session.save();
      }
    }
    throw unauthorized('Session expired');
  }
  const next = randomToken(32);
  // Conditional update so two concurrent refreshes cannot both succeed.
  const r = await Session.updateOne(
    { _id: session._id, refreshHash: session.refreshHash, revokedAt: null },
    { $set: { refreshHash: sha256(next), previousHash: session.refreshHash, lastUsedAt: new Date() } },
  );
  if (r.modifiedCount !== 1) throw unauthorized('Session expired');
  const accessToken = signAccessToken({ sub: String(session.userId), typ: session.userType as 'tenant', tid: session.tenantId ? String(session.tenantId) : undefined, sid: String(session._id) });
  return { accessToken, refreshToken: `${session._id}.${next}`, sessionId: session._id, expiresIn: env().JWT_ACCESS_TTL_SECONDS };
}

export function setRefreshCookie(res: Response, name: string, token: string) {
  res.cookie(name, token, {
    httpOnly: true,
    secure: env().COOKIE_SECURE,
    sameSite: 'strict',
    path: '/api/v1',
    maxAge: env().REFRESH_TTL_DAYS * 86400_000,
  });
}

export function clearRefreshCookie(res: Response, name: string) {
  res.clearCookie(name, { path: '/api/v1' });
}

export async function revokeSession(id: Types.ObjectId | string, reason: string) {
  await Session.updateOne({ _id: id, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: reason } });
}

export async function revokeAllSessions(userId: Types.ObjectId, except?: Types.ObjectId) {
  await Session.updateMany({ userId, revokedAt: null, ...(except ? { _id: { $ne: except } } : {}) }, { $set: { revokedAt: new Date(), revokedReason: 'revoke_all' } });
}

type Credentialed = { _id: Types.ObjectId; passwordHash: string; failedLogins: number; lockedUntil?: Date | null; status: string };

/** Verifies a password with lockout. Generic error messages prevent account enumeration. */
export async function checkCredentials<T extends Credentialed>(
  model: typeof User,
  user: T | null,
  password: string,
): Promise<T> {
  if (user?.lockedUntil && user.lockedUntil > new Date()) {
    throw new AppError(423, 'ACCOUNT_LOCKED', `Too many failed attempts. Try again after ${LOCK_MINUTES} minutes.`);
  }
  const ok = await verifyPassword(password, user?.passwordHash);
  if (!user || !ok || user.status !== 'active') {
    if (user) {
      const failed = (user.failedLogins ?? 0) + 1;
      await (model as typeof User).updateOne(
        { _id: user._id },
        { $set: { failedLogins: failed >= MAX_FAILED ? 0 : failed, ...(failed >= MAX_FAILED ? { lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) } : {}) } },
      );
    }
    throw unauthorized('Invalid email or password');
  }
  await (model as typeof User).updateOne({ _id: user._id }, { $set: { failedLogins: 0, lastLoginAt: new Date() }, $unset: { lockedUntil: 1 } });
  return user;
}

export async function createAuthToken(purpose: 'password_reset' | 'email_verify', userType: 'tenant', userId: Types.ObjectId, tenantId?: Types.ObjectId, minutes = 30) {
  const token = randomToken(32);
  await AuthToken.create({ purpose, userType, userId, tenantId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + minutes * 60_000) });
  return token;
}

export async function consumeAuthToken(purpose: 'password_reset' | 'email_verify', token: string, tenantId?: Types.ObjectId) {
  const rec = await AuthToken.findOneAndUpdate(
    { purpose, tokenHash: sha256(token), usedAt: null, expiresAt: { $gt: new Date() }, ...(tenantId ? { tenantId } : {}) },
    { $set: { usedAt: new Date() } },
    { new: true },
  );
  if (!rec) throw new AppError(400, 'TOKEN_INVALID', 'This link is invalid or has expired');
  return rec;
}
