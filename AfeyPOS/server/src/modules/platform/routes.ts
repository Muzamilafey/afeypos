/** Platform owner portal (SaaS operator). Never exposes tenant business data except through audited support grants. */
import { Router } from 'express';
import { z } from 'zod';
import { BUSINESS_TYPES, MODULES } from '@afeypos/shared';
import {
  BackupRecord, IntegrationConfig, Job, NotificationLog, Plan, PlatformAuditLog, PlatformUser, Product, Sale, SupportGrant, Tenant, User,
} from '../../models/index.js';
import { escapeRegex, idParam, objectId, pagination, parse } from '../../http/validate.js';
import { authenticatePlatform } from '../../http/auth.js';
import { decrypt, hashPassword, verifyTotp } from '../../lib/crypto.js';
import { AppError, badRequest, forbidden, notFound, unauthorized } from '../../lib/errors.js';
import { platformAudit } from '../../lib/audit.js';
import { runInTenant } from '../../lib/context.js';
import { dbStatus, pingDatabase } from '../../db/connection.js';
import { invalidatePlanCache } from '../tenants/plans.js';
import { provisionTenant, registrationSchema, passwordSchema } from '../tenants/provisioning.js';
import { authLimiter, tenantAppUrl } from '../auth/routes.js';
import { PLATFORM_REFRESH_COOKIE, checkCredentials, clearRefreshCookie, issueSession, revokeSession, rotateRefresh, setRefreshCookie } from '../auth/service.js';
import { signShortToken, verifyShortToken } from '../../http/auth.js';
import { createBackup } from '../backups/service.js';

const router = Router();

// ---- auth ----
router.post('/auth/login', authLimiter, async (req, res) => {
  const body = parse(z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1), code: z.string().optional() }), req.body);
  const user = await PlatformUser.findOne({ email: body.email });
  const u = await checkCredentials(PlatformUser as any, user as any, body.password);
  const pu = user!;
  if (pu.twoFactor?.enabled) {
    if (!body.code) {
      res.json({ mfaRequired: true });
      return;
    }
    if (!verifyTotp(decrypt(pu.twoFactor.secretEnc!, String(pu._id)), body.code)) throw unauthorized('Invalid verification code');
  }
  const s = await issueSession({ userType: 'platform', userId: u._id, req });
  await platformAudit({ ...req, auth: { kind: 'platform', userId: u._id, name: pu.name } } as any, 'platform.login');
  setRefreshCookie(res, PLATFORM_REFRESH_COOKIE, s.refreshToken);
  res.json({ accessToken: s.accessToken, expiresIn: s.expiresIn });
});

router.post('/auth/refresh', async (req, res) => {
  const s = await rotateRefresh(req.cookies?.[PLATFORM_REFRESH_COOKIE], 'platform');
  setRefreshCookie(res, PLATFORM_REFRESH_COOKIE, s.refreshToken);
  res.json({ accessToken: s.accessToken, expiresIn: s.expiresIn });
});

router.post('/auth/logout', async (req, res) => {
  const sid = (req.cookies?.[PLATFORM_REFRESH_COOKIE] as string | undefined)?.split('.')[0];
  if (sid && /^[a-f0-9]{24}$/.test(sid)) await revokeSession(sid, 'logout');
  clearRefreshCookie(res, PLATFORM_REFRESH_COOKIE);
  res.json({ ok: true });
});

router.use(authenticatePlatform);

const owner = (req: any) => {
  if (!req.auth.roles.includes('platform_owner')) throw forbidden('Platform owner role required');
};

router.get('/me', (req, res) => {
  res.json({ user: { id: req.auth!.userId, name: req.auth!.name, email: req.auth!.email, roles: req.auth!.roles }, permissions: [...req.auth!.permissions] });
});

// ---- tenants ----
router.get('/tenants', async (req, res) => {
  const q = parse(pagination.extend({ status: z.string().optional(), businessType: z.enum(BUSINESS_TYPES).optional() }), req.query);
  const filter: Record<string, unknown> = {};
  if (q.status) filter.status = q.status;
  if (q.businessType) filter.businessType = q.businessType;
  if (q.q) filter.$or = [{ name: new RegExp(escapeRegex(q.q), 'i') }, { slug: q.q.toLowerCase() }];
  const [data, total] = await Promise.all([
    Tenant.find(filter, { callbackToken: 0, 'sync.tokenHash': 0 }).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    Tenant.countDocuments(filter),
  ]);
  res.json({ data, total, page: q.page, limit: q.limit });
});

router.post('/tenants', async (req, res) => {
  owner(req);
  const input = parse(registrationSchema, req.body);
  const { tenant } = await provisionTenant(input);
  await platformAudit(req, 'tenant.provisioned', { slug: tenant.slug }, tenant._id);
  res.status(201).json({ data: { id: tenant._id, slug: tenant.slug, url: tenantAppUrl(tenant.slug) } });
});

/** Metadata and usage only - counts, not business records. */
router.get('/tenants/:id', async (req, res) => {
  const t = await Tenant.findById(idParam(req.params.id), { callbackToken: 0, 'sync.tokenHash': 0 }).lean();
  if (!t) throw notFound('Tenant');
  const since = new Date(Date.now() - 30 * 86400_000);
  const usage = await runInTenant(t._id, async () => ({
    users: await User.countDocuments({ status: 'active' }),
    products: await Product.countDocuments({ active: true }),
    sales30d: await Sale.countDocuments({ completedAt: { $gte: since } }),
    integrations: (await IntegrationConfig.find({}, { kind: 1, provider: 1, enabled: 1, environment: 1, lastTest: 1 }).lean()),
  }));
  const [failedJobs, failedNotifications] = await Promise.all([
    Job.countDocuments({ tenantId: t._id, status: { $in: ['failed', 'dead'] } }),
    NotificationLog.countDocuments({ tenantId: t._id, status: 'failed' }),
  ]);
  res.json({ data: { ...t, usage: { ...usage, failedJobs, failedNotifications } } });
});

router.patch('/tenants/:id', async (req, res) => {
  owner(req);
  const body = parse(
    z.object({
      status: z.enum(['trial', 'active', 'past_due', 'suspended', 'cancelled']).optional(),
      reason: z.string().max(300).optional(),
      planCode: z.string().optional(),
      trialEndsAt: z.coerce.date().optional(),
      currentPeriodEnd: z.coerce.date().optional(),
      customDomains: z.array(z.string().toLowerCase().regex(/^(?=.{4,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/)).max(5).optional(),
    }),
    req.body,
  );
  if (body.status === 'suspended' && !body.reason) throw badRequest('Give a reason for suspension');
  if (body.planCode && !(await Plan.exists({ code: body.planCode }))) throw badRequest('Unknown plan');
  const set: Record<string, unknown> = { ...body };
  delete set.reason;
  if (body.status === 'suspended') set.suspendedReason = body.reason;
  if (body.status && body.status !== 'suspended') set.suspendedReason = null;
  const t = await Tenant.findByIdAndUpdate(idParam(req.params.id), { $set: set }, { new: true, projection: { callbackToken: 0 } });
  if (!t) throw notFound('Tenant');
  await platformAudit(req, 'tenant.updated', { changes: body }, t._id);
  res.json({ data: t });
});

// ---- plans & entitlements ----
router.get('/plans', async (_req, res) => {
  res.json({ data: await Plan.find({}).sort({ priceMonthlyCents: 1 }).lean() });
});
const planSchema = z.object({
  code: z.string().regex(/^[a-z0-9-]{2,30}$/),
  name: z.string().min(2).max(60),
  priceMonthlyCents: z.number().int().nonnegative(),
  currency: z.string().length(3).default('KES'),
  trialDays: z.number().int().min(0).max(90).default(14),
  limits: z.object({ branches: z.number().int().positive(), users: z.number().int().positive(), tills: z.number().int().positive(), products: z.number().int().positive(), smsPerMonth: z.number().int().nonnegative() }),
  modules: z.array(z.enum(MODULES)).optional(),
  active: z.boolean().default(true),
});
router.post('/plans', async (req, res) => {
  owner(req);
  const body = parse(planSchema, req.body);
  const p = await Plan.create(body);
  invalidatePlanCache();
  await platformAudit(req, 'plan.created', { code: body.code });
  res.status(201).json({ data: p });
});
router.patch('/plans/:code', async (req, res) => {
  owner(req);
  const body = parse(planSchema.partial().omit({ code: true }), req.body);
  const p = await Plan.findOneAndUpdate({ code: req.params.code }, { $set: body }, { new: true });
  if (!p) throw notFound('Plan');
  invalidatePlanCache();
  await platformAudit(req, 'plan.updated', { code: req.params.code, changes: body });
  res.json({ data: p });
});

// ---- support access (least privilege, audited, time-bound, tenant-approved) ----
router.get('/support/grants', async (_req, res) => {
  res.json({ data: await SupportGrant.find({}).sort({ createdAt: -1 }).limit(100).lean() });
});
router.post('/support/grants', async (req, res) => {
  if (!req.auth!.permissions.has('platform.support.access')) throw forbidden();
  const body = parse(z.object({ tenantId: objectId, reason: z.string().trim().min(10).max(500), durationMinutes: z.number().int().min(5).max(240).default(60) }), req.body);
  if (!(await Tenant.exists({ _id: body.tenantId }))) throw notFound('Tenant');
  const g = await SupportGrant.create({ ...body, requestedBy: req.auth!.userId });
  await platformAudit(req, 'support.requested', { grantId: String(g._id), reason: body.reason }, body.tenantId);
  res.status(201).json({ data: g });
});
/** Emergency approval by the platform owner (e.g. tenant locked out). Fully audited on both sides. */
router.post('/support/grants/:id/emergency-approve', async (req, res) => {
  owner(req);
  const body = parse(z.object({ justification: z.string().trim().min(10).max(500) }), req.body);
  const g = await SupportGrant.findOne({ _id: idParam(req.params.id), status: 'pending' });
  if (!g) throw notFound('Pending grant');
  g.status = 'approved';
  g.approvedBy = { kind: 'platform_owner', id: req.auth!.userId } as any;
  g.approvedAt = new Date();
  g.expiresAt = new Date(Date.now() + g.durationMinutes * 60_000);
  await g.save();
  await platformAudit(req, 'support.emergency_approved', { grantId: String(g._id), justification: body.justification }, g.tenantId);
  await runInTenant(g.tenantId, async () => {
    const { AuditLog } = await import('../../models/index.js');
    await AuditLog.create({ action: 'support_access.emergency_approved', entity: 'SupportGrant', entityId: String(g._id), actor: { kind: 'platform', id: req.auth!.userId, name: req.auth!.name }, details: { justification: body.justification } });
  });
  res.json({ data: g });
});
/** Exchanges an approved grant for a read-only, expiring support session at the tenant. */
router.post('/support/grants/:id/session', async (req, res) => {
  const g = await SupportGrant.findOne({ _id: idParam(req.params.id), status: 'approved', expiresAt: { $gt: new Date() } });
  if (!g || String(g.requestedBy) !== String(req.auth!.userId)) throw notFound('Active grant');
  const t = await Tenant.findById(g.tenantId).lean();
  const s = await issueSession({ userType: 'support', userId: req.auth!.userId, tenantId: g.tenantId, req, supportGrantId: g._id, expiresAt: g.expiresAt! });
  await platformAudit(req, 'support.session_started', { grantId: String(g._id) }, g.tenantId);
  res.json({ data: { accessToken: s.accessToken, expiresAt: g.expiresAt, tenantUrl: tenantAppUrl(t!.slug), readOnly: true } });
});

// ---- operations ----
router.get('/health', async (_req, res) => {
  const [jobs, notif, backups, failingIntegrations] = await Promise.all([
    Job.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    NotificationLog.aggregate([{ $match: { createdAt: { $gte: new Date(Date.now() - 86400_000) } } }, { $group: { _id: { channel: '$channel', status: '$status' }, n: { $sum: 1 } } }]),
    BackupRecord.find({}).sort({ startedAt: -1 }).limit(5).lean(),
    IntegrationConfig.collection.countDocuments({ enabled: true, 'lastTest.ok': false }),
  ]);
  res.json({ data: { database: { ...dbStatus(), ping: await pingDatabase() }, jobs, notifications24h: notif, recentBackups: backups, failingIntegrations, uptimeSeconds: Math.round(process.uptime()), memoryMb: Math.round(process.memoryUsage().rss / 1048576), node: process.version } });
});
router.get('/jobs', async (req, res) => {
  const q = parse(pagination.extend({ status: z.enum(['queued', 'running', 'completed', 'failed', 'dead']).optional() }), req.query);
  const filter = q.status ? { status: q.status } : { status: { $in: ['failed', 'dead'] } };
  const [data, total] = await Promise.all([Job.find(filter, { payload: 0 }).sort({ updatedAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), Job.countDocuments(filter)]);
  res.json({ data, total });
});
router.post('/jobs/:id/retry', async (req, res) => {
  owner(req);
  const j = await Job.findOneAndUpdate({ _id: idParam(req.params.id), status: { $in: ['failed', 'dead'] } }, { $set: { status: 'queued', runAt: new Date(), attempts: 0 } }, { new: true });
  if (!j) throw notFound('Failed job');
  await platformAudit(req, 'job.retried', { jobId: String(j._id), type: j.type }, j.tenantId);
  res.json({ data: { id: j._id, status: j.status } });
});
router.get('/notifications', async (req, res) => {
  const q = parse(pagination.extend({ status: z.string().optional() }), req.query);
  const filter = q.status ? { status: q.status } : {};
  // Bodies may contain personal data; the portal sees delivery metadata only.
  const data = await NotificationLog.find(filter, { body: 0, subject: 0 }).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean();
  res.json({ data });
});
router.get('/audit', async (req, res) => {
  const q = parse(pagination.extend({ tenantId: objectId.optional(), action: z.string().optional() }), req.query);
  const filter: Record<string, unknown> = {};
  if (q.tenantId) filter.tenantId = q.tenantId;
  if (q.action) filter.action = { $regex: `^${q.action.replace(/[^\w.]/g, '')}` };
  res.json({ data: await PlatformAuditLog.find(filter).sort({ at: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean() });
});
router.get('/backups', async (_req, res) => {
  res.json({ data: await BackupRecord.find({}).sort({ startedAt: -1 }).limit(100).lean() });
});
router.post('/backups', async (req, res) => {
  owner(req);
  const r = await createBackup({ scope: 'full' });
  await platformAudit(req, 'backup.full_created', { documents: r.documents, sha256: r.sha256 });
  res.status(201).json({ data: { id: r.id, documents: r.documents, sha256: r.sha256, sizeBytes: r.sizeBytes } });
});

// ---- platform users ----
router.get('/users', async (req, res) => {
  owner(req);
  res.json({ data: await PlatformUser.find({}, { passwordHash: 0, 'twoFactor.secretEnc': 0 }).lean() });
});
router.post('/users', async (req, res) => {
  owner(req);
  const body = parse(z.object({ email: z.string().email().toLowerCase(), name: z.string().min(2), password: passwordSchema, roles: z.array(z.enum(['platform_owner', 'platform_support'])).min(1) }), req.body);
  const u = await PlatformUser.create({ ...body, passwordHash: await hashPassword(body.password) });
  await platformAudit(req, 'platform_user.created', { email: body.email, roles: body.roles });
  res.status(201).json({ data: { id: u._id, email: u.email, roles: u.roles } });
});

export const platformRoutes = router;
export { AppError, signShortToken, verifyShortToken };
