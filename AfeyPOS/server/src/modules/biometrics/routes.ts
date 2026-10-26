/**
 * Optional fingerprint integration. Matching is performed by the vendor SDK inside the Afey device bridge
 * running on the till PC (ZKTeco ZKFinger / SecuGen FDx SDK). The server:
 *  - stores vendor *templates* (never images) encrypted with AES-256-GCM, bound to the user id;
 *  - issues single-use nonces; the bridge returns an HMAC-signed assertion using its device key;
 *  - converts a valid assertion into a login, a supervisor override token or an attendance record.
 * The POS works fully without biometrics (PIN/password fallback).
 */
import { Router } from 'express';
import { z } from 'zod';
import type { Permission } from '@afeypos/shared';
import { userPermissions } from '../../lib/access.js';
import { AttendanceRecord, BiometricChallenge, BiometricDevice, BiometricTemplate, User } from '../../models/index.js';
import { idParam, objectId, parse } from '../../http/validate.js';
import { requirePermission, signShortToken } from '../../http/auth.js';
import { decrypt, encrypt, hmacSha256, randomToken, safeEqual } from '../../lib/crypto.js';
import { forbidden, notFound, unauthorized } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { recordTombstone } from '../sync/hq.js';
import { clockInOut } from '../auth/routes.js';

const router = Router();

/** Endpoints called by the device bridge itself (HMAC-authenticated, no user session). */
export const biometricBridgeRoutes = Router();

router.get('/biometrics/devices', requirePermission('hardware.manage'), async (_req, res) => {
  res.json({ data: (await BiometricDevice.find({}).lean()).map(({ keyEnc: _k, ...d }) => d) });
});

/** Registers a bridge device; the returned key is shown once and configured in the bridge. */
router.post('/biometrics/devices', requirePermission('hardware.manage'), async (req, res) => {
  const body = parse(z.object({ name: z.string().trim().min(2).max(80), vendor: z.enum(['zkteco', 'secugen', 'simulator']), model: z.string().max(60).optional(), branchId: objectId.optional(), tillId: objectId.optional() }), req.body);
  const key = randomToken(32);
  const d = new BiometricDevice({ ...body, keyEnc: 'pending' });
  d.keyEnc = encrypt(key, String(d._id));
  await d.save();
  await audit(req, { action: 'biometrics.device_registered', entity: 'BiometricDevice', entityId: d._id, details: { vendor: body.vendor } });
  res.status(201).json({ data: { id: d._id, name: d.name, vendor: d.vendor, deviceKey: key } });
});

async function deviceKey(deviceId: unknown) {
  const d = await BiometricDevice.findOne({ _id: deviceId, active: true });
  if (!d) throw notFound('Biometric device');
  return { device: d, key: decrypt(d.keyEnc, String(d._id)) };
}

/** Enrollment: the bridge captures and extracts a template, signs it, and an authorised manager submits it. */
router.post('/biometrics/enroll', requirePermission('biometrics.enroll'), async (req, res) => {
  const body = parse(z.object({ userId: objectId, deviceId: objectId, finger: z.string().max(20).default('right_index'), format: z.string().max(40), template: z.string().min(16).max(20000), signature: z.string().length(64) }), req.body);
  const user = await User.findById(body.userId);
  if (!user) throw notFound('User');
  const { device, key } = await deviceKey(body.deviceId);
  if (!safeEqual(hmacSha256(key, `enroll:${body.userId}:${body.finger}:${body.template}`), body.signature)) throw unauthorized('Invalid device signature');
  await BiometricTemplate.findOneAndUpdate(
    { userId: user._id, finger: body.finger },
    { $set: { vendor: device.vendor, format: body.format, templateEnc: encrypt(body.template, String(user._id)), enrolledBy: req.auth!.userId, deviceId: device._id } },
    { upsert: true },
  );
  await audit(req, { action: 'biometrics.enrolled', entity: 'User', entityId: user._id, details: { finger: body.finger, device: device.name } });
  res.status(201).json({ ok: true });
});

/** Which fingers each user has enrolled (no template data). */
router.get('/biometrics/enrolled', requirePermission('biometrics.enroll'), async (_req, res) => {
  const rows = await BiometricTemplate.aggregate([{ $group: { _id: '$userId', fingers: { $addToSet: '$finger' }, updatedAt: { $max: '$updatedAt' } } }]);
  res.json({ data: rows.map((r) => ({ userId: r._id, fingers: r.fingers, updatedAt: r.updatedAt })) });
});

router.delete('/biometrics/templates/:userId', requirePermission('biometrics.enroll'), async (req, res) => {
  const doomed = await BiometricTemplate.find({ userId: idParam(req.params.userId) }, { _id: 1 }).lean();
  const r = await BiometricTemplate.deleteMany({ userId: idParam(req.params.userId) });
  for (const d of doomed) await recordTombstone(BiometricTemplate.collection.collectionName, d._id);
  await audit(req, { action: 'biometrics.templates_deleted', entity: 'User', entityId: req.params.userId, details: { count: r.deletedCount } });
  res.json({ ok: true, deleted: r.deletedCount });
});

/** Most templates handed to a reader for 1:N identification (staff of one shop or branch). */
const MAX_IDENTIFY_TEMPLATES = 500;

/**
 * Starts a verification and returns a single-use nonce with the templates, decrypted for the bridge.
 *  - with an email: 1:1 verification against that user's fingers;
 *  - without: 1:N identification ("just touch the reader") against the active staff allowed at the reader's branch.
 * The bridge authenticates this call with its device HMAC, so templates only leave the server to registered devices.
 */
biometricBridgeRoutes.post('/biometrics/challenge', async (req, res) => {
  const body = parse(z.object({ deviceId: objectId, email: z.string().email().optional(), purpose: z.enum(['login', 'override', 'attendance']), ts: z.number().int(), signature: z.string().length(64) }), req.body);
  const { device, key } = await deviceKey(body.deviceId);
  if (Math.abs(Date.now() - body.ts) > 60_000) throw unauthorized('Stale request');
  const email = body.email?.toLowerCase() ?? '';
  if (!safeEqual(hmacSha256(key, `challenge:${email}:${body.purpose}:${body.ts}`), body.signature)) throw unauthorized('Invalid device signature');
  const nonce = randomToken(16);
  let users;
  if (email) {
    const user = await User.findOne({ email, status: 'active' });
    if (!user) throw notFound('User');
    users = [user];
  } else {
    users = await User.find({ status: 'active', ...(device.branchId ? { $or: [{ branchIds: { $size: 0 } }, { branchIds: device.branchId }] } : {}) }, { _id: 1, name: 1 }).lean();
  }
  const templates = await BiometricTemplate.find({ userId: { $in: users.map((u) => u._id) } }).limit(MAX_IDENTIFY_TEMPLATES).lean();
  if (!templates.length) throw notFound('Enrolled fingerprint');
  await BiometricChallenge.create({ nonce, userId: email ? users[0]._id : undefined, candidates: email ? undefined : [...new Set(templates.map((t) => String(t.userId)))], purpose: body.purpose, deviceId: device._id, expiresAt: new Date(Date.now() + 60_000) });
  device.lastSeenAt = new Date();
  await device.save();
  res.json({ data: { nonce, mode: email ? 'verify' : 'identify', userId: email ? users[0]._id : undefined, templates: templates.map((t) => ({ userId: String(t.userId), finger: t.finger, format: t.format, template: decrypt(t.templateEnc, String(t.userId)) })) } });
});

/** Completes verification with the bridge's signed match result. */
biometricBridgeRoutes.post('/biometrics/verify', async (req, res) => {
  const body = parse(z.object({ deviceId: objectId, nonce: z.string(), matched: z.boolean(), userId: objectId.optional(), score: z.number().optional(), permission: z.string().optional(), forUserId: objectId.optional(), signature: z.string().length(64) }), req.body);
  const { device, key } = await deviceKey(body.deviceId);
  // Identification results name the matched user, and the signature covers it.
  const signed = body.userId ? `verify:${body.nonce}:${body.matched ? 1 : 0}:${body.userId}` : `verify:${body.nonce}:${body.matched ? 1 : 0}`;
  if (!safeEqual(hmacSha256(key, signed), body.signature)) throw unauthorized('Invalid device signature');
  const ch = await BiometricChallenge.findOneAndUpdate({ nonce: body.nonce, deviceId: device._id, usedAt: null, expiresAt: { $gt: new Date() } }, { $set: { usedAt: new Date(), result: body.matched ? 'match' : 'no_match' } }, { new: true });
  if (!ch) throw unauthorized('Challenge expired or already used');
  let userId = ch.userId;
  if (!userId && body.matched) {
    if (!body.userId || !(ch.candidates ?? []).some((c) => String(c) === String(body.userId))) throw unauthorized('Fingerprint matched nobody enrolled here');
    userId = body.userId;
  }
  const user = userId ? await User.findOne({ _id: userId, status: 'active' }) : null;
  await audit(null, { action: body.matched ? 'biometrics.verified' : 'biometrics.verification_failed', entity: 'User', entityId: userId ?? undefined, details: { purpose: ch.purpose, mode: ch.userId ? 'verify' : 'identify', device: device.name, score: body.score } });
  if (!body.matched || !user) throw unauthorized('Fingerprint not recognised');
  if (ch.purpose === 'attendance') {
    const rec = await clockInOut(user._id, 'fingerprint', { deviceId: device._id, branchId: device.branchId });
    res.json({ data: { attendance: rec, user: { id: user._id, name: user.name } } });
    return;
  }
  if (ch.purpose === 'override') {
    if (!body.permission || !body.forUserId) throw forbidden('Override needs a permission and the requesting user');
    if (!(await userPermissions(user)).has(body.permission as Permission)) throw forbidden('Supervisor lacks the required permission');
    const token = signShortToken({ sub: String(user._id), tid: String(req.tenant!._id), perm: body.permission, for: String(body.forUserId), jti: crypto.randomUUID() }, 'override', 120);
    res.json({ data: { overrideToken: token, supervisor: { id: user._id, name: user.name } } });
    return;
  }
  // login: short-lived token the till exchanges at /auth/biometric-login
  res.json({ data: { loginToken: signShortToken({ sub: String(user._id), tid: String(req.tenant!._id), jti: crypto.randomUUID() }, 'bio-login', 60), user: { id: user._id, name: user.name } } });
});

router.get('/attendance', requirePermission('users.manage'), async (req, res) => {
  const q = parse(z.object({ userId: objectId.optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional() }), req.query);
  const filter: Record<string, unknown> = {};
  if (q.userId) filter.userId = q.userId;
  if (q.from || q.to) filter.at = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  res.json({ data: await AttendanceRecord.find(filter).sort({ at: -1 }).limit(1000).populate('userId', 'name').lean() });
});

export const biometricRoutes = router;
