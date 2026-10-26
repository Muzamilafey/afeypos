import { Router } from 'express';
import { userPermissions } from '../../lib/access.js';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { navigationFor, type Permission } from '@afeypos/shared';
import { AttendanceRecord, Session, User, IdempotencyRecord } from '../../models/index.js';
import { authenticateCard } from '../staff/cards.js';
import { parse, idParam } from '../../http/validate.js';
import { authenticate, signedIn, signShortToken, verifyShortToken } from '../../http/auth.js';
import { decrypt, encrypt, generateTotpSecret, hashPassword, verifyPassword, verifyTotp } from '../../lib/crypto.js';
import { AppError, badRequest, forbidden, notFound, unauthorized } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { env } from '../../config/env.js';
import { notify } from '../notifications/service.js';
import { passwordSchema } from '../tenants/provisioning.js';
import {
  REFRESH_COOKIE, checkCredentials, clearRefreshCookie, consumeAuthToken, createAuthToken, issueSession,
  revokeAllSessions, revokeSession, rotateRefresh, setRefreshCookie,
} from './service.js';

export const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: () => (env().NODE_ENV === 'test' ? 100_000 : 30), standardHeaders: 'draft-7', legacyHeaders: false, message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts, please try again later' } } });

const router = Router();

const loginSchema = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(200) });

router.post('/login', authLimiter, async (req, res) => {
  const body = parse(loginSchema, req.body);
  const user = await User.findOne({ email: body.email });
  const u = await checkCredentials(User, user, body.password);
  if (u.twoFactor?.enabled) {
    const mfaToken = signShortToken({ sub: String(u._id), tid: String(req.tenant!._id) }, 'mfa', 300);
    res.json({ mfaRequired: true, mfaToken });
    return;
  }
  const s = await issueSession({ userType: 'tenant', userId: u._id, tenantId: req.tenant!._id, req });
  await audit(req, { action: 'auth.login', entity: 'User', entityId: u._id, details: { method: 'password' } });
  setRefreshCookie(res, REFRESH_COOKIE, s.refreshToken);
  res.json({ accessToken: s.accessToken, expiresIn: s.expiresIn });
});

router.post('/mfa', authLimiter, async (req, res) => {
  const body = parse(z.object({ mfaToken: z.string(), code: z.string().trim() }), req.body);
  const claims = verifyShortToken<{ sub: string; tid: string }>(body.mfaToken, 'mfa');
  if (claims.tid !== String(req.tenant!._id)) throw unauthorized();
  const u = await User.findOne({ _id: claims.sub, status: 'active' });
  if (!u?.twoFactor?.enabled || !u.twoFactor.secretEnc) throw unauthorized();
  if (!verifyTotp(decrypt(u.twoFactor.secretEnc, String(u._id)), body.code)) throw unauthorized('Invalid verification code');
  const s = await issueSession({ userType: 'tenant', userId: u._id, tenantId: req.tenant!._id, req });
  await audit(req, { action: 'auth.login', entity: 'User', entityId: u._id, details: { method: 'password+totp' } });
  setRefreshCookie(res, REFRESH_COOKIE, s.refreshToken);
  res.json({ accessToken: s.accessToken, expiresIn: s.expiresIn });
});

/** Quick PIN sign-in for cashiers on a shared till. PIN users cannot have 2FA bypassed: users with 2FA must use password. */
router.post('/pin-login', authLimiter, async (req, res) => {
  const body = parse(z.object({ email: z.string().trim().toLowerCase().email(), pin: z.string().regex(/^\d{4,8}$/) }), req.body);
  const u = await User.findOne({ email: body.email, status: 'active' });
  if (u?.lockedUntil && u.lockedUntil > new Date()) throw new AppError(423, 'ACCOUNT_LOCKED', 'Account temporarily locked');
  if (!u || !u.pinHash || u.twoFactor?.enabled || !(await verifyPassword(body.pin, u.pinHash))) {
    if (u) await User.updateOne({ _id: u._id }, { $inc: { failedLogins: 1 } });
    throw unauthorized('Invalid email or PIN');
  }
  await User.updateOne({ _id: u._id }, { $set: { failedLogins: 0, lastLoginAt: new Date() } });
  const s = await issueSession({ userType: 'tenant', userId: u._id, tenantId: req.tenant!._id, req, expiresAt: new Date(Date.now() + 16 * 3600_000) });
  await audit(req, { action: 'auth.login', entity: 'User', entityId: u._id, details: { method: 'pin' } });
  setRefreshCookie(res, REFRESH_COOKIE, s.refreshToken);
  res.json({ accessToken: s.accessToken, expiresIn: s.expiresIn });
});

/** Staff card sign-in: scan the card barcode, then the PIN (unless the business allows card only). */
router.post('/card-login', authLimiter, async (req, res) => {
  const body = parse(z.object({ code: z.string().trim().min(4).max(40), pin: z.string().regex(/^\d{4,8}$/).optional() }), req.body);
  const u = await authenticateCard(req, body.code, body.pin);
  if (u.twoFactor?.enabled) throw new AppError(403, 'TWO_FACTOR_REQUIRED', 'This account uses two-step verification; sign in with email and password');
  await User.updateOne({ _id: u._id }, { $set: { failedLogins: 0, lastLoginAt: new Date() } });
  const s = await issueSession({ userType: 'tenant', userId: u._id, tenantId: req.tenant!._id, req, expiresAt: new Date(Date.now() + 16 * 3600_000) });
  await audit(req, { action: 'auth.login', entity: 'User', entityId: u._id, details: { method: body.pin ? 'card+pin' : 'card' } });
  setRefreshCookie(res, REFRESH_COOKIE, s.refreshToken);
  res.json({ accessToken: s.accessToken, expiresIn: s.expiresIn });
});

/** Clock in / out at the till with the staff card (the fingerprint equivalent goes through the device bridge). */
router.post('/clock', authLimiter, async (req, res) => {
  const body = parse(z.object({ code: z.string().trim().min(4).max(40), pin: z.string().regex(/^\d{4,8}$/).optional(), branchId: z.string().regex(/^[a-f0-9]{24}$/).optional() }), req.body);
  const u = await authenticateCard(req, body.code, body.pin);
  await User.updateOne({ _id: u._id }, { $set: { failedLogins: 0 } });
  const rec = await clockInOut(u._id, 'card', { branchId: body.branchId });
  res.json({ data: { name: u.name, kind: rec.kind, at: rec.at } });
});

router.post('/refresh', async (req, res) => {
  const s = await rotateRefresh(req.cookies?.[REFRESH_COOKIE], req.tenant!._id);
  setRefreshCookie(res, REFRESH_COOKIE, s.refreshToken);
  res.json({ accessToken: s.accessToken, expiresIn: s.expiresIn });
});

router.post('/logout', async (req, res) => {
  const raw = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  const sid = raw?.split('.')[0];
  if (sid && /^[a-f0-9]{24}$/.test(sid)) await revokeSession(sid, 'logout');
  clearRefreshCookie(res, REFRESH_COOKIE);
  res.json({ ok: true });
});

/**
 * Manager override: a supervisor authorises a restricted action on the cashier's screen.
 * Returns a single-use token valid for 2 minutes carrying the approved permission.
 */
// Any signed-in cashier may ask; the supervisor's own permissions decide.
router.post('/override', authLimiter, authenticate, signedIn('asks a supervisor to approve'), async (req, res) => {
  const body = parse(
    z.object({ email: z.string().trim().toLowerCase().email().optional(), cardCode: z.string().trim().max(40).optional(), password: z.string().optional(), pin: z.string().optional(), permission: z.string() }),
    req.body,
  );
  let sup;
  if (body.cardCode) {
    // A supervisor's card (plus PIN when the business requires it).
    sup = await authenticateCard(req, body.cardCode, body.pin).catch(() => null);
    if (!sup) throw unauthorized('Supervisor card or PIN is invalid');
  } else {
    sup = body.email ? await User.findOne({ email: body.email, status: 'active' }) : null;
    const secretOk = sup && (body.password ? await verifyPassword(body.password, sup.passwordHash) : body.pin && sup.pinHash ? await verifyPassword(body.pin, sup.pinHash) : false);
    if (!sup || !secretOk) throw unauthorized('Supervisor credentials are invalid');
  }
  // Same effective permissions as a sign-in: custom roles count and per-user denials apply.
  if (!(await userPermissions(sup)).has(body.permission as Permission)) throw forbidden('Supervisor lacks the required permission');
  const token = signShortToken({ sub: String(sup._id), tid: String(req.tenant!._id), perm: body.permission, for: String(req.auth!.userId), jti: crypto.randomUUID() }, 'override', 120);
  await audit(req, { action: 'auth.override_granted', entity: 'User', entityId: sup._id, details: { permission: body.permission, forUser: String(req.auth!.userId) } });
  res.json({ overrideToken: token, supervisor: { id: sup._id, name: sup.name } });
});

/** Exchanges a one-time fingerprint login token (from /biometrics/verify) for a session. */
router.post('/biometric-login', authLimiter, async (req, res) => {
  const body = parse(z.object({ loginToken: z.string() }), req.body);
  const c = verifyShortToken<{ sub: string; tid: string; jti: string }>(body.loginToken, 'bio-login');
  if (c.tid !== String(req.tenant!._id)) throw unauthorized();
  try {
    await IdempotencyRecord.create({ key: c.jti, scope: 'bio-login', status: 'completed' });
  } catch {
    throw unauthorized('Login token already used');
  }
  const u = await User.findOne({ _id: c.sub, status: 'active' });
  if (!u) throw unauthorized();
  const s = await issueSession({ userType: 'tenant', userId: u._id, tenantId: req.tenant!._id, req, expiresAt: new Date(Date.now() + 16 * 3600_000) });
  await audit(req, { action: 'auth.login', entity: 'User', entityId: u._id, details: { method: 'fingerprint' } });
  setRefreshCookie(res, REFRESH_COOKIE, s.refreshToken);
  res.json({ accessToken: s.accessToken, expiresIn: s.expiresIn });
});

router.use(authenticate);
// Below: the signed-in user's own account (profile, sessions, password, PIN, two-factor).
router.use(signedIn('own account'));

router.get('/me', async (req, res) => {
  const a = req.auth!;
  const t = req.tenant!;
  const caps = req.capabilities!;
  const u = await User.findById(a.userId).lean();
  const user = {
    id: a.userId, name: a.name, email: a.email, roles: a.roles, branchIds: a.branchIds, kind: a.kind,
    twoFactorEnabled: Boolean(u?.twoFactor?.enabled), emailVerified: Boolean(u?.emailVerifiedAt), hasPin: Boolean(u?.pinHash), phone: u?.phone,
  };
  res.json({
    user,
    tenant: { id: t._id, name: t.name, slug: t.slug, businessType: caps.businessType, status: t.status, settings: t.settings, enabledModules: t.enabledModules, disabledModules: t.disabledModules },
    deploymentMode: env().DEPLOYMENT_MODE,
    capabilities: caps,
    permissions: [...a.permissions],
    navigation: navigationFor(caps, a.permissions),
  });
});


router.get('/sessions', async (req, res) => {
  const rows = await Session.find({ userId: req.auth!.userId, tenantId: req.tenant!._id, revokedAt: null, expiresAt: { $gt: new Date() } }).sort({ lastUsedAt: -1 }).lean();
  res.json({ data: rows.map((s) => ({ id: s._id, ip: s.ip, userAgent: s.userAgent, lastUsedAt: s.lastUsedAt, createdAt: s.createdAt, current: String(s._id) === String(req.auth!.sessionId) })) });
});

router.delete('/sessions/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const r = await Session.updateOne({ _id: id, userId: req.auth!.userId, tenantId: req.tenant!._id, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: 'user_revoked' } });
  if (!r.modifiedCount) throw notFound('Session');
  res.json({ ok: true });
});

router.post('/logout-all', async (req, res) => {
  await revokeAllSessions(req.auth!.userId);
  clearRefreshCookie(res, REFRESH_COOKIE);
  res.json({ ok: true });
});

router.post('/password/change', async (req, res) => {
  const body = parse(z.object({ currentPassword: z.string(), newPassword: passwordSchema }), req.body);
  const u = await User.findById(req.auth!.userId);
  if (!u || !(await verifyPassword(body.currentPassword, u.passwordHash))) throw badRequest('Current password is incorrect');
  u.passwordHash = await hashPassword(body.newPassword);
  await u.save();
  await revokeAllSessions(u._id, req.auth!.sessionId);
  await audit(req, { action: 'auth.password_changed', entity: 'User', entityId: u._id });
  res.json({ ok: true });
});

router.post('/pin', async (req, res) => {
  const body = parse(z.object({ pin: z.string().regex(/^\d{4,8}$/, 'PIN must be 4-8 digits'), password: z.string() }), req.body);
  const u = await User.findById(req.auth!.userId);
  if (!u || !(await verifyPassword(body.password, u.passwordHash))) throw badRequest('Password is incorrect');
  u.pinHash = await hashPassword(body.pin);
  await u.save();
  await audit(req, { action: 'auth.pin_set', entity: 'User', entityId: u._id });
  res.json({ ok: true });
});

router.post('/2fa/setup', async (req, res) => {
  const u = await User.findById(req.auth!.userId);
  if (!u) throw notFound('User');
  const secret = generateTotpSecret();
  u.twoFactor = { ...(u.twoFactor ?? {}), enabled: Boolean(u.twoFactor?.enabled), pendingSecretEnc: encrypt(secret, String(u._id)) } as any;
  await u.save();
  const label = encodeURIComponent(`Afey POS (${req.tenant!.slug}):${u.email}`);
  res.json({ secret, otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent('Afey POS')}&period=30&digits=6` });
});

router.post('/2fa/enable', async (req, res) => {
  const body = parse(z.object({ code: z.string().trim() }), req.body);
  const u = await User.findById(req.auth!.userId);
  if (!u?.twoFactor?.pendingSecretEnc) throw badRequest('Start two-factor setup first');
  const secret = decrypt(u.twoFactor.pendingSecretEnc, String(u._id));
  if (!verifyTotp(secret, body.code)) throw badRequest('Invalid verification code');
  u.twoFactor = { enabled: true, secretEnc: u.twoFactor.pendingSecretEnc } as any;
  await u.save();
  await audit(req, { action: 'auth.2fa_enabled', entity: 'User', entityId: u._id });
  res.json({ ok: true });
});

router.post('/2fa/disable', async (req, res) => {
  const body = parse(z.object({ password: z.string(), code: z.string().trim() }), req.body);
  const u = await User.findById(req.auth!.userId);
  if (!u?.twoFactor?.enabled || !u.twoFactor.secretEnc) throw badRequest('Two-factor authentication is not enabled');
  if (!(await verifyPassword(body.password, u.passwordHash)) || !verifyTotp(decrypt(u.twoFactor.secretEnc, String(u._id)), body.code)) throw badRequest('Invalid password or code');
  u.twoFactor = { enabled: false } as any;
  await u.save();
  await audit(req, { action: 'auth.2fa_disabled', entity: 'User', entityId: u._id });
  res.json({ ok: true });
});

router.post('/email/resend', async (req, res) => {
  const u = await User.findById(req.auth!.userId);
  if (!u || u.emailVerifiedAt) {
    res.json({ ok: true });
    return;
  }
  const token = await createAuthToken('email_verify', 'tenant', u._id, req.tenant!._id, 24 * 60);
  await notify({ channel: 'email', to: u.email, templateKey: 'email_verify', data: { name: u.name, link: `${appUrl()}/verify-email?token=${token}` } });
  res.json({ ok: true });
});

export const authRoutes = router;

/** Unauthenticated tenant account-recovery endpoints. */
export const recoveryRoutes = Router();

recoveryRoutes.post('/password/forgot', authLimiter, async (req, res) => {
  const body = parse(z.object({ email: z.string().trim().toLowerCase().email() }), req.body);
  const u = await User.findOne({ email: body.email, status: 'active' });
  if (u) {
    const token = await createAuthToken('password_reset', 'tenant', u._id, req.tenant!._id, 30);
    await notify({ channel: 'email', to: u.email, templateKey: 'password_reset', data: { name: u.name, link: `${appUrl()}/reset-password?token=${token}` } });
    await audit(req, { action: 'auth.password_reset_requested', entity: 'User', entityId: u._id });
  }
  // Same response whether or not the account exists.
  res.json({ ok: true });
});

recoveryRoutes.post('/password/reset', authLimiter, async (req, res) => {
  const body = parse(z.object({ token: z.string().min(10), password: passwordSchema }), req.body);
  const rec = await consumeAuthToken('password_reset', body.token, req.tenant!._id);
  const u = await User.findById(rec.userId);
  if (!u) throw notFound('User');
  u.passwordHash = await hashPassword(body.password);
  u.failedLogins = 0;
  u.lockedUntil = undefined;
  await u.save();
  await revokeAllSessions(u._id);
  await audit(req, { action: 'auth.password_reset', entity: 'User', entityId: u._id });
  res.json({ ok: true });
});

recoveryRoutes.post('/email/verify', async (req, res) => {
  const body = parse(z.object({ token: z.string().min(10) }), req.body);
  const rec = await consumeAuthToken('email_verify', body.token, req.tenant!._id);
  await User.updateOne({ _id: rec.userId }, { $set: { emailVerifiedAt: new Date() } });
  res.json({ ok: true });
});

/** Records the next attendance event for a user: clock in after a clock out (or first of all), otherwise clock out. */
export async function clockInOut(userId: unknown, method: 'card' | 'fingerprint' | 'pin', extra: { deviceId?: unknown; branchId?: unknown } = {}) {
  const last = await AttendanceRecord.findOne({ userId }).sort({ at: -1 }).lean();
  const kind = last?.kind === 'clock_in' ? 'clock_out' : 'clock_in';
  return AttendanceRecord.create({ userId, kind, method, ...extra });
}

/** Address of the web app, used in emailed links. */
export function appUrl(): string {
  return env().PUBLIC_APP_URL.replace(/\/$/, '');
}

/** Validates a manager override token for a permission and consumes it (single use). */
export async function consumeOverride(token: string | undefined, permission: Permission, tenantId: string, forUser: string): Promise<string | null> {
  if (!token) return null;
  const c = verifyShortToken<{ sub: string; tid: string; perm: string; for: string; jti: string }>(token, 'override');
  if (c.tid !== tenantId || c.perm !== permission || c.for !== forUser) throw forbidden('Override token does not match this action');
  try {
    await IdempotencyRecord.create({ key: c.jti, scope: 'override', status: 'completed' });
  } catch {
    throw forbidden('Override token has already been used');
  }
  return c.sub;
}
