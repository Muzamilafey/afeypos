import { Router } from 'express';
import { z } from 'zod';
import { MODULES, PAYMENT_PROVIDER_INFO, PAYMENT_PROVIDERS, TENANT_ROLES, type ModuleKey, type PaymentProviderKey } from '@afeypos/shared';
import {
  AuditLog, Branch, IntegrationConfig, NotificationLog, NotificationTemplate, Tenant, Till, User, Warehouse, Expense, RepairTicket, Shift,
} from '../../models/index.js';
import { idParam, objectId, pagination, parse, positiveCents } from '../../http/validate.js';
import { requireModule, requirePermission } from '../../http/auth.js';
import { AppError, badRequest, forbidden, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { hashPassword } from '../../lib/crypto.js';
import { runAsPlatform } from '../../lib/context.js';
import { nextNumber } from '../../lib/numbering.js';
import { env } from '../../config/env.js';
import { revokeAllSessions } from '../auth/service.js';
import { passwordSchema } from '../tenants/provisioning.js';
import { capabilitiesFor } from '../tenants/capabilities.js';
import { openSecrets, presentConfig, sealSecrets } from '../integrations/configs.js';
import { gatewayCallbackUrl, paymentGatewayFor } from '../payments/gateways.js';
import { createSmsProvider } from '../../integrations/sms/index.js';
import { createEmailProvider } from '../../integrations/email/index.js';
import { callbackUrls, gatewayFor } from '../payments/mpesa.js';
import { notify } from '../notifications/service.js';
import { DEFAULT_TEMPLATES } from '../notifications/templates.js';
import { CashMovement } from '../../models/index.js';

const router = Router();

// ---------- business settings & modules ----------
const settingsSchema = z.object({
  name: z.string().trim().min(2).max(120),
  contact: z.object({ email: z.string().email().optional(), phone: z.string().max(30).optional(), address: z.string().max(300).optional() }),
  settings: z
    .object({
      currency: z.string().length(3),
      timezone: z.string().max(60),
      locale: z.string().max(20),
      taxPin: z.string().max(40),
      defaultTaxRateBp: z.number().int().min(0).max(10000),
      pricesIncludeTax: z.boolean(),
      allowNegativeStock: z.boolean(),
      requireOpenShift: z.boolean(),
      cashierDiscountLimitBp: z.number().int().min(0).max(10000),
      receiptHeader: z.string().max(200),
      receiptFooter: z.string().max(300),
      stkPendingTimeoutSeconds: z.number().int().min(60).max(900),
      variableWeight: z.object({ enabled: z.boolean(), prefixes: z.array(z.string().regex(/^\d{2}$/)), itemCodeLength: z.number().int().min(4).max(6), valueLength: z.number().int().min(4).max(6), valueType: z.enum(['weight', 'price']), valueDecimals: z.number().int().min(0).max(3) }).partial(),
      loyalty: z.object({ pointsPerUnitCents: z.number().int().positive(), pointValueCents: z.number().int().positive() }).partial(),
      restrictedSaleHours: z.object({ start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).or(z.literal('')), end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).or(z.literal('')) }).partial(),
      dailyReportEmails: z.array(z.string().email()).max(5),
      logoFileId: z.string().regex(/^[a-f0-9]{32}\.(png|jpg|webp)$/).or(z.literal('')),
      tagline: z.string().max(120),
      creditReminders: z.object({ enabled: z.boolean(), overdueDays: z.number().int().min(1).max(180) }).partial(),
      returns: z.object({ windowDays: z.number().int().min(0).max(365), approvalAboveCents: z.number().int().min(0), restockByDefault: z.boolean() }).partial(),
    })
    .partial(),
}).partial();

router.get('/settings/business', requirePermission('settings.manage'), async (req, res) => {
  const t = await runAsPlatform(() => Tenant.findById(req.tenant!._id).lean());
  res.json({ data: { id: t!._id, name: t!.name, slug: t!.slug, businessType: req.capabilities!.businessType, status: t!.status, deploymentMode: env().DEPLOYMENT_MODE, contact: t!.contact, settings: t!.settings, enabledModules: t!.enabledModules, disabledModules: t!.disabledModules, capabilities: req.capabilities, callbackUrls: callbackUrls(t!._id, t!.callbackToken) } });
});

router.patch('/settings/business', requirePermission('settings.manage'), async (req, res) => {
  const body = parse(settingsSchema, req.body);
  const set: Record<string, unknown> = {};
  if (body.name) set.name = body.name;
  if (body.contact) for (const [k, v] of Object.entries(body.contact)) set[`contact.${k}`] = v;
  if (body.settings) {
    for (const [k, v] of Object.entries(body.settings)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k2, v2] of Object.entries(v)) set[`settings.${k}.${k2}`] = v2;
      else set[`settings.${k}`] = v;
    }
  }
  const t = await runAsPlatform(() => Tenant.findByIdAndUpdate(req.tenant!._id, { $set: set }, { new: true, runValidators: true }).lean());
  await audit(req, { action: 'settings.updated', entity: 'Tenant', entityId: req.tenant!._id, details: { fields: Object.keys(set) } });
  res.json({ data: t });
});

/** Enable or hide modules. Disabling never deletes data. */
router.put('/settings/modules', requirePermission('settings.manage'), async (req, res) => {
  const body = parse(z.object({ enabled: z.array(z.enum(MODULES)).default([]), disabled: z.array(z.enum(MODULES)).default([]) }), req.body);
  if (!req.auth!.roles.includes('tenant_owner') && !req.auth!.roles.includes('business_admin')) throw forbidden('Only owners and administrators can change modules');
  const disabled = body.disabled.filter((m) => m !== 'pos' && m !== 'inventory' && !body.enabled.includes(m));
  const t = await runAsPlatform(() => Tenant.findByIdAndUpdate(req.tenant!._id, { $set: { enabledModules: body.enabled, disabledModules: disabled } }, { new: true }));
  await audit(req, { action: 'settings.modules_changed', entity: 'Tenant', entityId: req.tenant!._id, details: { enabled: body.enabled, disabled } });
  res.json({ data: capabilitiesFor(t!) });
});

// ---------- users ----------
const userSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().max(30).optional(),
  roles: z.array(z.enum(TENANT_ROLES as [string, ...string[]])).min(1),
  branchIds: z.array(objectId).default([]),
  commissionRateBp: z.number().int().min(0).max(5000).default(0),
  employeeNo: z.string().max(30).optional(),
});

function present(u: any) {
  const { passwordHash: _p, pinHash, twoFactor, ...rest } = u;
  return { ...rest, hasPin: Boolean(pinHash), twoFactorEnabled: Boolean(twoFactor?.enabled) };
}

router.get('/settings/users', requirePermission('users.manage'), async (_req, res) => {
  res.json({ data: (await User.find({}).sort({ name: 1 }).lean()).map(present) });
});

router.post('/settings/users', requirePermission('users.manage'), async (req, res) => {
  const body = parse(userSchema.extend({ password: passwordSchema, pin: z.string().regex(/^\d{4,8}$/).optional() }), req.body);
  if (body.roles.includes('tenant_owner') && !req.auth!.roles.includes('tenant_owner')) throw forbidden('Only owners can create owners');
  const u = await User.create({ ...body, passwordHash: await hashPassword(body.password), pinHash: body.pin ? await hashPassword(body.pin) : undefined });
  await audit(req, { action: 'user.created', entity: 'User', entityId: u._id, details: { roles: body.roles } });
  res.status(201).json({ data: present(u.toObject()) });
});

router.patch('/settings/users/:id', requirePermission('users.manage'), async (req, res) => {
  const id = idParam(req.params.id);
  const body = parse(userSchema.partial().extend({ status: z.enum(['active', 'disabled']).optional(), password: passwordSchema.optional() }), req.body);
  const target = await User.findById(id);
  if (!target) throw notFound('User');
  const touchesOwner = target.roles.includes('tenant_owner') || body.roles?.includes('tenant_owner');
  if (touchesOwner && !req.auth!.roles.includes('tenant_owner')) throw forbidden('Only owners can modify owner accounts');
  if (String(id) === String(req.auth!.userId) && (body.status === 'disabled' || (body.roles && !body.roles.includes('tenant_owner') && target.roles.includes('tenant_owner')))) {
    throw badRequest('You cannot disable or demote your own owner account');
  }
  const { password, ...rest } = body;
  Object.assign(target, rest);
  if (password) target.passwordHash = await hashPassword(password);
  await target.save();
  if (body.status === 'disabled' || password || body.roles) await revokeAllSessions(target._id);
  await audit(req, { action: 'user.updated', entity: 'User', entityId: id, details: { fields: Object.keys(body).filter((k) => k !== 'password'), passwordReset: Boolean(password) } });
  res.json({ data: present(target.toObject()) });
});

// ---------- branches, warehouses, tills ----------
router.get('/settings/locations', async (_req, res) => {
  // Readable by every signed-in user: needed to pick a till/warehouse.
  const [branches, warehouses, tills] = await Promise.all([Branch.find({}).lean(), Warehouse.find({}).lean(), Till.find({}).lean()]);
  res.json({ data: { branches, warehouses, tills } });
});

router.post('/settings/branches', requirePermission('branches.manage'), async (req, res) => {
  const body = parse(z.object({ name: z.string().trim().min(2).max(80), code: z.string().trim().min(1).max(10).regex(/^[A-Za-z0-9]+$/), address: z.string().max(200).optional(), phone: z.string().max(30).optional() }), req.body);
  if ((await Branch.countDocuments({})) >= 1 && !req.capabilities!.modules.includes('multiBranch')) throw new AppError(403, 'MODULE_DISABLED', 'Enable the multi-branch module to add branches');
  const b = await Branch.create(body);
  const w = await Warehouse.create({ branchId: b._id, name: `${b.name} store`, code: b.code, isDefault: true });
  await audit(req, { action: 'branch.created', entity: 'Branch', entityId: b._id });
  res.status(201).json({ data: { branch: b, warehouse: w } });
});

router.patch('/settings/branches/:id', requirePermission('branches.manage'), async (req, res) => {
  const body = parse(z.object({ name: z.string().trim().min(2).max(80), address: z.string().max(200), phone: z.string().max(30), active: z.boolean() }).partial(), req.body);
  const b = await Branch.findOneAndUpdate({ _id: idParam(req.params.id) }, { $set: body }, { new: true });
  if (!b) throw notFound('Branch');
  res.json({ data: b });
});

router.post('/settings/warehouses', requirePermission('branches.manage'), async (req, res) => {
  const body = parse(z.object({ branchId: objectId, name: z.string().trim().min(2).max(80), code: z.string().trim().min(1).max(10).regex(/^[A-Za-z0-9]+$/) }), req.body);
  if (!(await Branch.exists({ _id: body.branchId }))) throw notFound('Branch');
  const w = await Warehouse.create(body);
  await audit(req, { action: 'warehouse.created', entity: 'Warehouse', entityId: w._id });
  res.status(201).json({ data: w });
});

router.post('/settings/tills', requirePermission('branches.manage'), async (req, res) => {
  const body = parse(z.object({ branchId: objectId, warehouseId: objectId, name: z.string().trim().min(1).max(40), code: z.string().trim().min(1).max(10).regex(/^[A-Za-z0-9]+$/) }), req.body);
  const w = await Warehouse.findOne({ _id: body.warehouseId, branchId: body.branchId });
  if (!w) throw badRequest('Warehouse must belong to the branch');
  if ((await Till.countDocuments({ branchId: body.branchId, active: true })) >= 1 && !req.capabilities!.modules.includes('multiTill')) throw new AppError(403, 'MODULE_DISABLED', 'Enable the multiple tills module to add tills');
  const t = await Till.create(body);
  await audit(req, { action: 'till.created', entity: 'Till', entityId: t._id });
  res.status(201).json({ data: t });
});

router.patch('/settings/tills/:id', requirePermission('branches.manage'), async (req, res) => {
  const body = parse(z.object({ name: z.string().trim().min(1).max(40), active: z.boolean(), warehouseId: objectId, receiptPrinterId: objectId.nullable() }).partial(), req.body);
  if (body.active === false && (await Shift.exists({ tillId: idParam(req.params.id), status: 'open' }))) throw badRequest('Close the open shift before deactivating this till');
  const t = await Till.findOneAndUpdate({ _id: idParam(req.params.id) }, { $set: body }, { new: true });
  if (!t) throw notFound('Till');
  res.json({ data: t });
});

// ---------- integrations (secrets never returned) ----------
const integrationSchema = z.object({
  kind: z.enum(['mpesa', 'payment', 'etims', 'sms', 'email']),
  provider: z.string().min(2).max(40),
  name: z.string().trim().min(2).max(80),
  enabled: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  environment: z.enum(['sandbox', 'production']).default('sandbox'),
  branchIds: z.array(objectId).default([]),
  settings: z.record(z.string(), z.union([z.string().max(300), z.number(), z.boolean()])).default({}),
  secrets: z.record(z.string(), z.string().max(4000)).optional(),
});

const PROVIDERS: Record<string, string[]> = {
  mpesa: ['daraja', 'mock'],
  payment: PAYMENT_PROVIDERS.filter((p) => PAYMENT_PROVIDER_INFO[p].availability === 'available'),
  etims: ['oscu', 'vscu', 'mock'],
  sms: ['talksasa', 'africastalking', 'console'],
  email: ['smtp', 'console'],
};

const isSimulator = (c: { provider: string }) => c.provider === 'mock' || c.provider === 'simulator';

/** Checks a payment gateway config has every required field (secrets may already be stored). */
function assertGatewayFields(provider: string, settings: Record<string, unknown>, secrets: Record<string, unknown>) {
  const info = PAYMENT_PROVIDER_INFO[provider as PaymentProviderKey];
  const missing = info.fields.filter((f) => f.required && !(f.secret ? secrets[f.key] : settings[f.key])).map((f) => f.label);
  if (missing.length) throw badRequest(`${info.label}: missing ${missing.join(', ')}`);
}

router.get('/settings/integrations', requirePermission('integrations.manage'), async (req, res) => {
  const rows = await IntegrationConfig.find({}).sort({ kind: 1, createdAt: 1 });
  const t = await runAsPlatform(() => Tenant.findById(req.tenant!._id).lean());
  res.json({
    data: rows.map((c) => ({ ...presentConfig(c), ...(c.kind === 'payment' ? { webhookUrl: gatewayCallbackUrl(t!._id, t!.callbackToken, c._id) } : {}) })),
    providers: PROVIDERS,
    callbackUrls: callbackUrls(t!._id, t!.callbackToken),
  });
});

router.post('/settings/integrations', requirePermission('integrations.manage'), async (req, res) => {
  const body = parse(integrationSchema, req.body);
  if (!PROVIDERS[body.kind].includes(body.provider)) throw badRequest(`Unknown ${body.kind} provider`);
  if (isSimulator(body) && body.environment === 'production') throw badRequest('The simulator cannot be used in production mode');
  if (body.kind === 'payment') assertGatewayFields(body.provider, body.settings, body.secrets ?? {});
  if (body.kind === 'etims') {
    if (!/^[AP]\d{9}[A-Z]$/.test(String(body.settings.tin ?? '').toUpperCase())) throw badRequest('eTIMS: enter the KRA PIN, e.g. P051234567X');
    if (!/^\d{2}$/.test(String(body.settings.bhfId ?? ''))) throw badRequest('eTIMS: branch id is two digits, "00" for head office');
    if (body.provider === 'vscu' && !body.settings.baseUrl) throw badRequest('eTIMS: enter the VSCU address on your network');
    body.settings.tin = String(body.settings.tin).toUpperCase();
  }
  const { secrets, ...rest } = body;
  const cfg = new IntegrationConfig(rest);
  if (secrets) cfg.secretsEnc = sealSecrets(cfg._id, secrets);
  await cfg.save();
  await audit(req, { action: 'integration.created', entity: 'IntegrationConfig', entityId: cfg._id, details: { kind: body.kind, provider: body.provider, secretKeys: Object.keys(secrets ?? {}) } });
  res.status(201).json({ data: presentConfig(cfg) });
});

router.patch('/settings/integrations/:id', requirePermission('integrations.manage'), async (req, res) => {
  const body = parse(integrationSchema.partial().omit({ kind: true }), req.body);
  const cfg = await IntegrationConfig.findById(idParam(req.params.id));
  if (!cfg) throw notFound('Integration');
  const { secrets, ...rest } = body;
  Object.assign(cfg, rest);
  if (isSimulator(cfg) && cfg.environment === 'production') throw badRequest('The simulator cannot be used in production mode');
  if (secrets) cfg.secretsEnc = sealSecrets(cfg._id, { ...openSecrets(cfg), ...Object.fromEntries(Object.entries(secrets).filter(([, v]) => v !== '')) });
  if (cfg.kind === 'payment') assertGatewayFields(cfg.provider, cfg.settings ?? {}, openSecrets(cfg));
  cfg.markModified('settings');
  await cfg.save();
  await audit(req, { action: 'integration.updated', entity: 'IntegrationConfig', entityId: cfg._id, details: { fields: Object.keys(rest), secretKeys: Object.keys(secrets ?? {}) } });
  res.json({ data: presentConfig(cfg) });
});

router.delete('/settings/integrations/:id', requirePermission('integrations.manage'), async (req, res) => {
  const r = await IntegrationConfig.findOneAndUpdate({ _id: idParam(req.params.id) }, { $set: { enabled: false } }, { new: true });
  if (!r) throw notFound('Integration');
  await audit(req, { action: 'integration.disabled', entity: 'IntegrationConfig', entityId: r._id });
  res.json({ data: presentConfig(r) });
});

/** Test connection: verifies credentials (and optionally sends a test message). */
router.post('/settings/integrations/:id/test', requirePermission('integrations.manage'), async (req, res) => {
  const body = parse(z.object({ to: z.string().max(120).optional() }), req.body ?? {});
  const cfg = await IntegrationConfig.findById(idParam(req.params.id));
  if (!cfg) throw notFound('Integration');
  let ok = false;
  let message = '';
  try {
    if (cfg.kind === 'mpesa') {
      await gatewayFor(cfg).testCredentials();
      message = 'Daraja OAuth token obtained';
    } else if (cfg.kind === 'payment') {
      message = await paymentGatewayFor(cfg).testCredentials();
    } else if (cfg.kind === 'etims') {
      if (!openSecrets(cfg).cmcKey) throw new Error('Not initialised yet: press Initialise device');
      message = `Initialised: SCU ${cfg.settings?.sdcId ?? '?'}, MRC ${cfg.settings?.mrcNo ?? '?'}`;
    } else if (cfg.kind === 'email') {
      await createEmailProvider(cfg.provider, cfg.settings ?? {}, openSecrets(cfg)).verify();
      message = 'SMTP connection verified';
      if (body.to) await notify({ channel: 'email', to: body.to, templateKey: 'test', data: { business: req.tenant!.name } });
    } else {
      createSmsProvider(cfg.provider, cfg.settings ?? {}, openSecrets(cfg), cfg.environment);
      if (!body.to) message = 'Configuration is complete; provide a phone number to send a test SMS';
      else {
        const r = await notify({ channel: 'sms', to: body.to, templateKey: 'test', data: { business: req.tenant!.name } });
        message = r.queued ? 'Test SMS queued; check delivery logs' : `Not queued: ${r.reason}`;
      }
    }
    ok = true;
  } catch (err: any) {
    message = err?.message ?? 'Test failed';
  }
  cfg.lastTest = { at: new Date(), ok, message } as any;
  await cfg.save();
  res.json({ data: { ok, message } });
});

router.post('/settings/integrations/:id/register-c2b', requirePermission('integrations.manage'), async (req, res) => {
  const cfg = await IntegrationConfig.findOne({ _id: idParam(req.params.id), kind: 'mpesa' });
  if (!cfg) throw notFound('Integration');
  const t = await runAsPlatform(() => Tenant.findById(req.tenant!._id).lean());
  const urls = callbackUrls(t!._id, t!.callbackToken);
  const result = await gatewayFor(cfg).registerC2BUrls(urls.c2bConfirmation, urls.c2bValidation, String(cfg.settings?.tillNumber ?? cfg.settings?.shortCode));
  await audit(req, { action: 'integration.c2b_registered', entity: 'IntegrationConfig', entityId: cfg._id });
  res.json({ data: result });
});

// ---------- notification templates & logs ----------
router.get('/settings/notifications/templates', requirePermission('integrations.manage'), async (_req, res) => {
  const overrides = await NotificationTemplate.find({}).lean();
  res.json({ data: { defaults: DEFAULT_TEMPLATES, overrides } });
});
router.put('/settings/notifications/templates', requirePermission('integrations.manage'), async (req, res) => {
  const body = parse(z.object({ key: z.enum(Object.keys(DEFAULT_TEMPLATES) as [string, ...string[]]), channel: z.enum(['sms', 'email']), subject: z.string().max(200).optional(), body: z.string().min(1).max(5000) }), req.body);
  const t = await NotificationTemplate.findOneAndUpdate({ key: body.key, channel: body.channel }, { $set: { subject: body.subject, body: body.body } }, { upsert: true, new: true });
  res.json({ data: t });
});
router.get('/settings/notifications/logs', requirePermission('integrations.manage'), async (req, res) => {
  const q = parse(pagination.extend({ status: z.string().optional(), channel: z.string().optional() }), req.query);
  const filter: Record<string, unknown> = { tenantId: req.tenant!._id };
  if (q.status) filter.status = q.status;
  if (q.channel) filter.channel = q.channel;
  const [data, total] = await Promise.all([NotificationLog.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), NotificationLog.countDocuments(filter)]);
  res.json({ data, total, page: q.page, limit: q.limit });
});

// ---------- audit trail ----------
router.get('/audit', requirePermission('audit.read'), async (req, res) => {
  const q = parse(pagination.extend({ entity: z.string().optional(), entityId: z.string().optional(), action: z.string().optional(), userId: objectId.optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional() }), req.query);
  const filter: Record<string, unknown> = {};
  if (q.entity) filter.entity = q.entity;
  if (q.entityId) filter.entityId = q.entityId;
  if (q.action) filter.action = { $regex: `^${q.action.replace(/[^\w.]/g, '')}` };
  if (q.userId) filter['actor.id'] = q.userId;
  if (q.from || q.to) filter.at = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  const [data, total] = await Promise.all([AuditLog.find(filter).sort({ at: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), AuditLog.countDocuments(filter)]);
  res.json({ data, total, page: q.page, limit: q.limit });
});

// ---------- expenses ----------
router.get('/expenses', requirePermission('expenses.manage'), requireModule('expenses'), async (req, res) => {
  const q = parse(pagination.extend({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), category: z.string().optional() }), req.query);
  const filter: Record<string, unknown> = {};
  if (q.category) filter.category = q.category;
  if (q.from || q.to) filter.date = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  const [data, total] = await Promise.all([Expense.find(filter).sort({ date: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), Expense.countDocuments(filter)]);
  res.json({ data, total, page: q.page, limit: q.limit });
});
router.post('/expenses', requirePermission('expenses.manage'), requireModule('expenses'), async (req, res) => {
  const body = parse(z.object({ category: z.string().trim().min(2).max(60), amountCents: positiveCents.refine((v) => v > 0), taxCents: positiveCents.default(0), method: z.enum(['cash', 'mpesa', 'bank', 'card', 'other']).default('cash'), branchId: objectId.optional(), shiftId: objectId.optional(), payee: z.string().max(120).optional(), reference: z.string().max(80).optional(), notes: z.string().max(500).optional(), date: z.coerce.date().optional() }), req.body);
  const number = await nextNumber('expense', 'EXP');
  const e = await Expense.create({ ...body, number, userId: req.auth!.userId });
  if (body.method === 'cash' && body.shiftId) {
    const shift = await Shift.findOne({ _id: body.shiftId, status: 'open' });
    if (!shift) throw badRequest('Shift is not open');
    await CashMovement.create({ shiftId: shift._id, tillId: shift.tillId, type: 'expense', amountCents: -body.amountCents, reason: body.category, userId: req.auth!.userId, ref: { type: 'Expense', id: e._id, number } });
  }
  await audit(req, { action: 'expense.recorded', entity: 'Expense', entityId: e._id, details: { amountCents: body.amountCents, category: body.category } });
  res.status(201).json({ data: e });
});

// ---------- repairs (electronics) ----------
router.get('/repairs', requirePermission('sales.create'), requireModule('repairs'), async (req, res) => {
  const q = parse(pagination.extend({ status: z.string().optional() }), req.query);
  const filter: Record<string, unknown> = q.status ? { status: q.status } : {};
  if (q.q) filter.$or = [{ number: q.q }, { serial: q.q }, { customerPhone: q.q }];
  const [data, total] = await Promise.all([RepairTicket.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), RepairTicket.countDocuments(filter)]);
  res.json({ data, total, page: q.page, limit: q.limit });
});
router.post('/repairs', requirePermission('sales.create'), requireModule('repairs'), async (req, res) => {
  const body = parse(z.object({ customerId: objectId.optional(), customerName: z.string().max(120).optional(), customerPhone: z.string().max(30).optional(), productId: objectId.optional(), itemDescription: z.string().trim().min(2).max(300), serial: z.string().max(80).optional(), fault: z.string().max(1000).optional(), estimateCents: positiveCents.optional(), technician: z.string().max(80).optional() }), req.body);
  let underWarranty = false;
  if (body.serial) {
    const { SerialItem } = await import('../../models/index.js');
    const s = await SerialItem.findOne({ serial: body.serial }).lean();
    underWarranty = Boolean(s?.warrantyEndsAt && s.warrantyEndsAt > new Date());
  }
  const number = await nextNumber('repair', 'RPR');
  const r = await RepairTicket.create({ ...body, number, underWarranty, createdBy: req.auth!.userId });
  res.status(201).json({ data: r });
});
router.patch('/repairs/:id', requirePermission('sales.create'), requireModule('repairs'), async (req, res) => {
  const body = parse(z.object({ status: z.enum(['received', 'diagnosing', 'awaiting_parts', 'repairing', 'ready', 'collected', 'cancelled']).optional(), chargeCents: positiveCents.optional(), technician: z.string().max(80).optional(), note: z.string().max(1000).optional() }), req.body);
  const r = await RepairTicket.findById(idParam(req.params.id));
  if (!r) throw notFound('Repair');
  if (body.status) r.status = body.status;
  if (body.chargeCents !== undefined) r.chargeCents = body.chargeCents;
  if (body.technician) r.technician = body.technician;
  if (body.note) r.notes.push({ at: new Date(), by: req.auth!.userId, text: body.note });
  await r.save();
  res.json({ data: r });
});

export const settingsRoutes = router;
export type { ModuleKey };
