import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { CASHIER_PAGE_OPTIONS, PAYMENT_METHOD_OPTIONS, MODULES, PAYMENT_PROVIDER_INFO, RECEIPT_TEMPLATES, mergeCheckoutRules, mergeReceipt, PAYMENT_PROVIDERS, PERMISSIONS, TENANT_ROLES, type ModuleKey, type PaymentProviderKey } from '@afeypos/shared';
import {
  AuditLog, Branch, IntegrationConfig, NotificationLog, NotificationTemplate, Tenant, Till, User, Warehouse, Expense, RepairTicket, Shift,
} from '../../models/index.js';
import { idParam, objectId, pagination, parse, positiveCents } from '../../http/validate.js';
import { requireModule, requirePermission, signedIn } from '../../http/auth.js';
import { AppError, badRequest, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { hashPassword } from '../../lib/crypto.js';
import { runAsPlatform } from '../../lib/context.js';
import { nextNumber } from '../../lib/numbering.js';
import { env } from '../../config/env.js';
import { revokeAllSessions } from '../auth/service.js';
import { passwordSchema } from '../tenants/provisioning.js';
import { nextEmployeeNo } from '../staff/cards.js';
import { capabilitiesFor } from '../tenants/capabilities.js';
import { openSecrets, presentConfig, sealSecrets } from '../integrations/configs.js';
import { gatewayCallbackUrl, paymentGatewayFor } from '../payments/gateways.js';
import { createSmsProvider } from '../../integrations/sms/index.js';
import { createEmailProvider } from '../../integrations/email/index.js';
import { callbackUrlProblems, callbackUrls, gatewayFor, handleC2B } from '../payments/mpesa.js';
import { explainC2BError } from '../../integrations/mpesa/daraja.js';
import { notify } from '../notifications/service.js';
import { DEFAULT_TEMPLATES } from '../notifications/templates.js';
import { receiptContext, renderReceiptHtml, renderReceiptText, sampleSale } from '../hardware/receipt.js';
import { CashMovement, PaymentIntent, Sale } from '../../models/index.js';
import { checkUserAccessChange, roleRoutes } from './roles.js';

const showKeys = ['logo', 'tagline', 'address', 'phone', 'email', 'taxPin', 'cashier', 'till', 'branch', 'customer', 'sku', 'unitPrice', 'itemCount', 'taxSummary', 'savings', 'loyalty', 'barcode', 'qr', 'poweredBy'] as const;
const receiptSchema = z.object({
  template: z.enum(RECEIPT_TEMPLATES),
  paper: z.enum(['80mm', '58mm']),
  fontSize: z.enum(['small', 'normal', 'large']),
  title: z.string().trim().max(40),
  show: z.object(Object.fromEntries(showKeys.map((k) => [k, z.boolean()])) as Record<(typeof showKeys)[number], z.ZodBoolean>).partial(),
  customFields: z.array(z.object({ label: z.string().trim().max(30), value: z.string().trim().max(80), position: z.enum(['top', 'bottom']) })).max(12),
  message: z.string().max(300),
  returnPolicy: z.string().max(400),
}).partial();

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
      appIcon: z.object({ source: z.string().regex(/^[a-f0-9]{32}\.(png|jpg|webp)$/), i192: z.string().regex(/^[a-f0-9]{32}\.png$/), i512: z.string().regex(/^[a-f0-9]{32}\.png$/), m512: z.string().regex(/^[a-f0-9]{32}\.png$/) }).nullable(),
      tagline: z.string().max(120),
      creditReminders: z.object({ enabled: z.boolean(), overdueDays: z.number().int().min(1).max(180) }).partial(),
      staffLogin: z.object({ cardRequiresPin: z.boolean() }).partial(),
      store: z.object({ enabled: z.boolean(), branchId: objectId.nullable(), warehouseId: objectId.nullable(), pickup: z.boolean(), delivery: z.boolean(), deliveryAreas: z.array(z.object({ name: z.string().trim().min(1).max(60), feeCents: z.number().int().min(0) })).max(50), deliveryFeeCents: z.number().int().min(0), freeDeliveryAboveCents: z.number().int().min(0), minOrderCents: z.number().int().min(0), payOnDelivery: z.boolean(), mpesa: z.boolean(), notifyPhone: z.string().max(20), contactPhone: z.string().max(20), announcement: z.string().max(200), hours: z.string().max(120), mpesaConfigId: objectId.nullable(), gatewayConfigId: objectId.nullable(), publicUrl: z.string().trim().url().max(200).or(z.literal('')) }).partial(),
      crm: z.object({ tiers: z.array(z.object({ name: z.string().trim().min(1).max(30), minSpendCents: z.number().int().min(0) })).min(1).max(8), birthdayGreeting: z.object({ enabled: z.boolean(), channel: z.enum(['sms', 'email']), offer: z.string().max(200) }).partial() }).partial(),
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

// ---------- receipts ----------
const receiptBody = z.object({ receipt: receiptSchema, receiptHeader: z.string().max(200).optional(), receiptFooter: z.string().max(300).optional() });

router.get('/settings/receipt', requirePermission('settings.manage'), async (req, res) => {
  const t = await runAsPlatform(() => Tenant.findById(req.tenant!._id).lean());
  res.json({ data: { receipt: mergeReceipt(t!.settings?.receipt), receiptHeader: t!.settings?.receiptHeader ?? '', receiptFooter: t!.settings?.receiptFooter ?? '' } });
});

router.put('/settings/receipt', requirePermission('settings.manage'), async (req, res) => {
  const body = parse(receiptBody, req.body);
  const receipt = mergeReceipt(body.receipt);
  const set: Record<string, unknown> = { 'settings.receipt': receipt };
  if (body.receiptHeader !== undefined) set['settings.receiptHeader'] = body.receiptHeader;
  if (body.receiptFooter !== undefined) set['settings.receiptFooter'] = body.receiptFooter;
  const t = await runAsPlatform(() => Tenant.findByIdAndUpdate(req.tenant!._id, { $set: set }, { new: true }).lean());
  await audit(req, { action: 'settings.receipt_updated', entity: 'Tenant', entityId: req.tenant!._id, details: { template: receipt.template, paper: receipt.paper } });
  res.json({ data: { receipt: mergeReceipt(t!.settings?.receipt), receiptHeader: t!.settings?.receiptHeader ?? '', receiptFooter: t!.settings?.receiptFooter ?? '' } });
});

/** Renders unsaved receipt settings on a sample sale (or a real one), exactly as it will print. */
router.post('/settings/receipt/preview', requirePermission('settings.manage'), async (req, res) => {
  const body = parse(receiptBody.extend({ format: z.enum(['html', 'text']).default('html'), sample: z.enum(['sample', 'latest']).default('sample') }), req.body);
  const tenant: any = await runAsPlatform(() => Tenant.findById(req.tenant!._id).lean());
  const t = { ...tenant, settings: { ...tenant.settings, receiptHeader: body.receiptHeader ?? tenant.settings?.receiptHeader, receiptFooter: body.receiptFooter ?? tenant.settings?.receiptFooter } };
  const real = body.sample === 'latest' ? await Sale.findOne({ status: { $ne: 'voided' } }).sort({ completedAt: -1 }).lean() : null;
  const sale: any = real ?? sampleSale();
  const ctx = real ? await receiptContext(tenant, real) : { ...(await receiptContext(tenant, {})), cashierName: 'Jane W.', tillName: 'Till 1 (T1)', branchName: 'Main branch', customer: { name: 'Peter Otieno', phone: '0712 345 678', points: 248 } };
  const opts = { ...ctx, settings: mergeReceipt(body.receipt) };
  if (body.format === 'text') res.type('text').send(renderReceiptText(t, sale, opts));
  else res.type('html').send(renderReceiptHtml(t, sale, opts));
});

// ---------- checkout rules and card terminals ----------
const bp = z.number().int().min(0).max(10000);
const rulesSchema = z.object({
  items: z.object({ removeNeedsApproval: z.boolean(), reduceQtyNeedsApproval: z.boolean(), clearNeedsApproval: z.boolean(), holdAllowed: z.boolean() }).partial(),
  discounts: z.object({ allowed: z.boolean(), lineLimitBp: bp, saleLimitBp: bp, maxAmountCents: positiveCents }).partial(),
  shifts: z.object({ required: z.boolean(), minOpeningFloatCents: positiveCents, blindClose: z.boolean(), closeNeedsApproval: z.boolean(), maxCashInDrawerCents: positiveCents, oneOpenShiftPerCashier: z.boolean() }).partial(),
  cashierPages: z.array(z.enum(CASHIER_PAGE_OPTIONS.map((p) => p.key) as [string, ...string[]])).max(CASHIER_PAGE_OPTIONS.length),
  paymentMethods: z.array(z.enum(PAYMENT_METHOD_OPTIONS.map((p) => p.key) as [string, ...string[]])).min(1, 'Keep at least one way to pay').max(PAYMENT_METHOD_OPTIONS.length),
}).partial();
const terminalsSchema = z.array(z.object({ name: z.string().trim().min(1).max(40), bank: z.string().trim().max(40), terminalId: z.string().trim().max(40) })).max(30);
const presentRules = (t: any) => ({ rules: mergeCheckoutRules(t.settings?.checkoutRules, t.settings ?? {}), cardTerminals: t.settings?.cardTerminals ?? [] });

router.get('/settings/checkout-rules', requirePermission('settings.manage'), async (req, res) => {
  const t = await runAsPlatform(() => Tenant.findById(req.tenant!._id).lean());
  res.json({ data: presentRules(t) });
});

router.put('/settings/checkout-rules', requirePermission('settings.manage'), async (req, res) => {
  const body = parse(z.object({ rules: rulesSchema, cardTerminals: terminalsSchema.optional() }), req.body);
  const current = mergeCheckoutRules(req.tenant!.settings?.checkoutRules, req.tenant!.settings ?? {});
  const rules = mergeCheckoutRules({ ...current, ...body.rules, items: { ...current.items, ...body.rules.items }, discounts: { ...current.discounts, ...body.rules.discounts }, shifts: { ...current.shifts, ...body.rules.shifts } });
  // The older single settings stay in step for anything that still reads them.
  const set: Record<string, unknown> = { 'settings.checkoutRules': rules, 'settings.requireOpenShift': rules.shifts.required, 'settings.cashierDiscountLimitBp': rules.discounts.saleLimitBp };
  if (body.cardTerminals) set['settings.cardTerminals'] = body.cardTerminals;
  const t = await runAsPlatform(() => Tenant.findByIdAndUpdate(req.tenant!._id, { $set: set }, { new: true }).lean());
  await audit(req, { action: 'settings.checkout_rules_updated', entity: 'Tenant', entityId: req.tenant!._id, details: { rules } });
  res.json({ data: presentRules(t) });
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
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{2,29}$/, 'Username: 3-30 letters, digits, dots, dashes or underscores').or(z.literal('')).optional(),
  phone: z.string().max(30).optional(),
  roles: z.array(z.enum(TENANT_ROLES as [string, ...string[]]).or(z.string().regex(/^custom:[a-z0-9-]{2,40}$/))).min(1).max(10),
  extraPermissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length).default([]),
  deniedPermissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length).default([]),
  branchIds: z.array(objectId).default([]),
  commissionRateBp: z.number().int().min(0).max(5000).default(0),
  jobTitle: z.string().trim().max(80).optional(),
  photoFileId: z.string().regex(/^[a-f0-9]{32}\.(png|jpg|webp)$/).or(z.literal('')).optional(),
  employeeNo: z.string().max(30).optional(),
});

async function assertUsernameFree(username: string | undefined, self: unknown) {
  if (!username) return;
  if (await User.exists({ username, _id: { $ne: self } })) throw new AppError(409, 'USERNAME_TAKEN', `The username "${username}" is already used`);
}

function present(u: any) {
  const { passwordHash: _p, pinHash, twoFactor, card, ...rest } = u;
  const cardInfo = card?.codeHash && !card.revokedAt ? { last4: card.last4, issuedAt: card.issuedAt } : null;
  return { ...rest, hasPin: Boolean(pinHash), twoFactorEnabled: Boolean(twoFactor?.enabled), card: cardInfo };
}

router.get('/settings/users', requirePermission('users.manage'), async (_req, res) => {
  res.json({ data: (await User.find({}).sort({ name: 1 }).lean()).map(present) });
});

router.post('/settings/users', requirePermission('users.manage'), async (req, res) => {
  const body = parse(userSchema.extend({ password: passwordSchema, pin: z.string().regex(/^\d{4,8}$/).optional() }), req.body);
  await checkUserAccessChange(req, null, { roles: body.roles, extraPermissions: body.extraPermissions, deniedPermissions: body.deniedPermissions, branchIds: body.branchIds.map(String) });
  await assertUsernameFree(body.username, null);
  const u = await User.create({ ...body, username: body.username || undefined, employeeNo: body.employeeNo || (await nextEmployeeNo()), passwordHash: await hashPassword(body.password), pinHash: body.pin ? await hashPassword(body.pin) : undefined });
  await audit(req, { action: 'user.created', entity: 'User', entityId: u._id, details: { roles: body.roles, extraPermissions: body.extraPermissions, deniedPermissions: body.deniedPermissions, branchIds: body.branchIds } });
  res.status(201).json({ data: present(u.toObject()) });
});

router.patch('/settings/users/:id', requirePermission('users.manage'), async (req, res) => {
  const id = idParam(req.params.id);
  // .partial() keeps defaults out, so fields not sent stay as they are.
  const body = parse(userSchema.extend({ extraPermissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length), deniedPermissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length), branchIds: z.array(objectId) }).partial().extend({ status: z.enum(['active', 'disabled']).optional(), password: passwordSchema.optional(), pin: z.string().regex(/^\d{4,8}$/).or(z.literal('')).optional() }), req.body);
  const target = await User.findById(id);
  if (!target) throw notFound('User');
  // Any change to an account (even a password reset) needs authority over that account.
  await checkUserAccessChange(req, target.toObject() as any, {
    roles: body.roles ?? (target.roles as string[]), extraPermissions: body.extraPermissions ?? target.extraPermissions ?? [], deniedPermissions: body.deniedPermissions ?? target.deniedPermissions ?? [],
    branchIds: (body.branchIds ?? target.branchIds ?? []).map(String), status: body.status,
  });
  const { password, pin, username, ...rest } = body;
  Object.assign(target, rest);
  if (username !== undefined) {
    await assertUsernameFree(username, target._id);
    target.username = username || undefined;
  }
  if (password) target.passwordHash = await hashPassword(password);
  // Managers set or clear a till PIN (needed with the staff card); '' removes it.
  if (pin !== undefined) target.pinHash = pin ? await hashPassword(pin) : undefined;
  await target.save();
  if (body.status === 'disabled' || password) await revokeAllSessions(target._id);
  await audit(req, { action: 'user.updated', entity: 'User', entityId: id, details: { fields: Object.keys(body).filter((k) => k !== 'password' && k !== 'pin'), roles: body.roles, extraPermissions: body.extraPermissions, deniedPermissions: body.deniedPermissions, branchIds: body.branchIds, status: body.status, passwordReset: Boolean(password), pinChanged: pin !== undefined } });
  res.json({ data: present(target.toObject()) });
});

// ---------- branches, warehouses, tills ----------
router.get('/settings/locations', signedIn('needed to choose a till or warehouse'), async (_req, res) => {
  // Every signed-in user sees branch and warehouse names (stock transfers name the other side);
  // tills are branch-scoped, so restricted users only get their own branches' tills.
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
  tillIds: z.array(objectId).max(200).default([]),
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

/** A config limited to some tills also lists their branches, so each branch server receives it by sync. */
async function scopeToTills(body: { tillIds?: unknown[]; branchIds?: unknown[] }) {
  if (!body.tillIds?.length) return;
  const tills = await Till.find({ _id: { $in: body.tillIds } }, { branchId: 1 }).lean();
  if (tills.length !== new Set(body.tillIds.map(String)).size) throw badRequest('Choose existing tills');
  body.branchIds = [...new Set(tills.map((t) => String(t.branchId)))].map((id) => new Types.ObjectId(id));
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
  await scopeToTills(body);
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
  await scopeToTills(body);
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

/**
 * Turns an integration off (the default), or removes it for good with ?remove=true. Removing takes its stored
 * keys with it and is only for owners and administrators; payments already taken keep working, as each one
 * remembers what it was paid into.
 */
router.delete('/settings/integrations/:id', requirePermission('integrations.manage'), async (req, res) => {
  const id = idParam(req.params.id);
  if (req.query.remove === 'true') {
    if (!req.auth!.roles.includes('tenant_owner') && !req.auth!.roles.includes('business_admin')) throw forbidden('Only owners and administrators can remove an integration');
    const r = await IntegrationConfig.findById(id);
    if (!r) throw notFound('Integration');
    // M-Pesa with money still coming in: turn it off instead, so late payments are still recognised.
    if (r.kind === 'mpesa') {
      const waiting = await PaymentIntent.countDocuments({ configId: r._id, status: 'pending' });
      if (waiting) throw unprocessable(`${r.name} has ${waiting} payment${waiting === 1 ? '' : 's'} still waiting. Finish or cancel them first, or just disable it.`, 'INTEGRATION_IN_USE');
    }
    await IntegrationConfig.deleteOne({ _id: r._id });
    await audit(req, { action: 'integration.removed', entity: 'IntegrationConfig', entityId: r._id, details: { kind: r.kind, provider: r.provider, name: r.name } });
    res.json({ data: { id: r._id, removed: true } });
    return;
  }
  const r = await IntegrationConfig.findOneAndUpdate({ _id: id }, { $set: { enabled: false } }, { new: true });
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

/** What would be registered: the short code and URLs, plus anything that would make Safaricom refuse them. */
async function c2bPlan(req: any, cfg: InstanceType<typeof IntegrationConfig>, shortCodeOverride?: string) {
  const t = await runAsPlatform(() => Tenant.findById(req.tenant!._id).lean());
  const urls = callbackUrls(t!._id, t!.callbackToken);
  // Paybill: the Paybill number. Buy Goods: Safaricom registers URLs on the store (head office) number.
  const shortCode = String(shortCodeOverride || cfg.settings?.shortCode || cfg.settings?.tillNumber || '').trim();
  const environment = cfg.environment as 'sandbox' | 'production';
  const problems = cfg.provider === 'mock' ? [] : callbackUrlProblems(urls.c2bConfirmation, environment);
  // Plain http is only a warning in the sandbox; everything else stops the registration.
  const blocking = problems.filter((p) => environment === 'production' || !p.startsWith('Use an HTTPS address'));
  if (!/^\d{5,7}$/.test(shortCode)) blocking.unshift('Set the Paybill or store number (5-7 digits) in the M-Pesa configuration first.');
  return { tenant: t!, shortCode, confirmationUrl: urls.c2bConfirmation, validationUrl: urls.c2bValidation, problems, blocking };
}

router.get('/settings/integrations/:id/register-c2b', requirePermission('integrations.manage'), async (req, res) => {
  const cfg = await IntegrationConfig.findOne({ _id: idParam(req.params.id), kind: 'mpesa' });
  if (!cfg) throw notFound('Integration');
  const { tenant: _t, ...plan } = await c2bPlan(req, cfg);
  res.json({ data: { ...plan, registration: presentConfig(cfg).c2bRegistration ?? null } });
});

/** Registers this business's C2B confirmation and validation URLs with Safaricom for the short code. */
router.post('/settings/integrations/:id/register-c2b', requirePermission('integrations.manage'), async (req, res) => {
  const body = parse(z.object({ shortCode: z.string().trim().regex(/^\d{5,7}$/, 'Short codes are 5-7 digits').optional() }), req.body ?? {});
  const cfg = await IntegrationConfig.findOne({ _id: idParam(req.params.id), kind: 'mpesa' });
  if (!cfg) throw notFound('Integration');
  if (!cfg.enabled) throw badRequest('Enable this M-Pesa configuration first');
  const plan = await c2bPlan(req, cfg, body.shortCode);
  if (plan.blocking.length) throw new AppError(422, 'C2B_URL_INVALID', plan.blocking[0], { problems: plan.blocking });
  let ok = false;
  let message: string;
  let response: unknown;
  try {
    response = await gatewayFor(cfg).registerC2BUrls(plan.confirmationUrl, plan.validationUrl, plan.shortCode);
    ok = true;
    message = `Registered for short code ${plan.shortCode}${(response as any)?.ResponseDescription ? `: ${(response as any).ResponseDescription}` : ''}`;
  } catch (err) {
    message = explainC2BError(err, cfg.environment as 'sandbox' | 'production');
    response = (err as any)?.body;
  }
  // A new registration starts over: "Last payment received" then proves these URLs.
  const previous = cfg.c2bRegistration?.lastConfirmationAt;
  cfg.c2bRegistration = { lastConfirmationAt: ok ? undefined : previous, at: new Date(), ok, message, shortCode: plan.shortCode, confirmationUrl: plan.confirmationUrl, validationUrl: plan.validationUrl } as any;
  await cfg.save();
  await audit(req, { action: ok ? 'integration.c2b_registered' : 'integration.c2b_register_failed', entity: 'IntegrationConfig', entityId: cfg._id, details: { shortCode: plan.shortCode, message } });
  if (!ok) throw new AppError(422, 'C2B_REGISTER_FAILED', message, { response });
  res.json({ data: { ok, message, shortCode: plan.shortCode, confirmationUrl: plan.confirmationUrl, validationUrl: plan.validationUrl, warnings: plan.problems, registration: presentConfig(cfg).c2bRegistration } });
});

/**
 * Proves C2B end to end. Sandbox: Safaricom sends a test payment to the registered URLs. Simulator: the same
 * confirmation is processed directly. Live accounts cannot simulate: pay KES 1 to the Paybill/Till instead.
 */
router.post('/settings/integrations/:id/test-c2b', requirePermission('integrations.manage'), async (req, res) => {
  const body = parse(z.object({ amount: z.number().int().min(1).max(1000).default(1), phone: z.string().regex(/^2547\d{8}$|^2541\d{8}$/).default('254708374149') }), req.body ?? {});
  const cfg = await IntegrationConfig.findOne({ _id: idParam(req.params.id), kind: 'mpesa' });
  if (!cfg) throw notFound('Integration');
  if (cfg.environment === 'production' && cfg.provider !== 'mock') throw badRequest('Live accounts cannot simulate payments: pay KES 1 to your Paybill/Till and watch "Last payment received" update.');
  const plan = await c2bPlan(req, cfg);
  const buyGoods = cfg.settings?.type === 'till';
  const shortCode = buyGoods ? String(cfg.settings?.tillNumber || plan.shortCode) : plan.shortCode;
  if (cfg.provider === 'mock') {
    const receipt = `TST${Date.now().toString(36).toUpperCase()}`.slice(0, 10);
    await handleC2B(req.tenant!._id, { TransactionType: buyGoods ? 'Buy Goods' : 'Pay Bill', TransID: receipt, TransTime: '20261025120000', TransAmount: String(body.amount), BusinessShortCode: shortCode, BillRefNumber: 'TEST', MSISDN: body.phone, FirstName: 'TEST', LastName: 'PAYMENT' }, 'simulator');
    res.json({ data: { ok: true, message: `Test payment ${receipt} of KES ${body.amount} recorded. It appears under Payments as unallocated.` } });
    return;
  }
  try {
    const r = await gatewayFor(cfg).simulateC2B({ shortCode, amount: body.amount, phone: body.phone, billRef: 'TEST', buyGoods });
    res.json({ data: { ok: true, message: `Safaricom accepted the test payment (${r.ResponseDescription ?? 'accepted'}). When it reaches this server, "Last payment received" updates within a minute.` } });
  } catch (err) {
    throw new AppError(422, 'C2B_TEST_FAILED', explainC2BError(err, 'sandbox'));
  }
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

router.use(roleRoutes);
export const settingsRoutes = router;
export type { ModuleKey };
