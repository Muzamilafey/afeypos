/**
 * Bank card terminals: self-service onboarding (Settings → Payments → Bank card terminals), the merchant
 * dashboard, and the till's card payments. All records are tenant-scoped and branch-scoped by the models;
 * credentials never leave the server.
 */
import { Router } from 'express';
import { z } from 'zod';
import { TERMINAL_CONNECTIONS, TERMINAL_PROVIDER_INFO, TERMINAL_PROVIDERS, terminalTxnOpen, type TerminalProviderKey } from '@afeypos/shared';
import { Branch, PaymentTerminal, TerminalTransaction, Till, Tenant } from '../../models/index.js';
import { idParam, objectId, parse, positiveCents } from '../../http/validate.js';
import { assertBranchAccess, requireAnyPermission, requirePermission } from '../../http/auth.js';
import { AppError, badRequest, conflict, notFound, unprocessable } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { runInTenant } from '../../lib/context.js';
import { logger } from '../../lib/logger.js';
import { TerminalError } from './adapter.js';
import { adapterFor, providerAvailability, simulatorAllowed } from './registry.js';
import { forceSimulatedOutcome, setSimulatedDevice } from './simulator.js';
import {
  cancelTerminalPayment, checkTerminalHealth, contextOf, loadTerminal, openTerminalSecrets, presentTerminal, presentTxn, recordHealth, refreshTransaction,
  refundTerminalPayment, resolveAsNotCharged, sealTerminalSecrets, startTerminalPayment, terminalErrorMessage,
} from './service.js';

const router = Router();
const P = '/payment-terminals';

const terminalError = (err: unknown) => {
  if (err instanceof TerminalError) return new AppError(409, `TERMINAL_${err.code}`, terminalErrorMessage(err));
  return err;
};

/** Providers, with what works on this installation. Unsupported connection methods are never offered. */
router.get(`${P}/providers`, requireAnyPermission('terminals.manage', 'terminals.reconcile'), (_req, res) => {
  res.json({
    data: TERMINAL_PROVIDERS.map((k) => {
      const info = TERMINAL_PROVIDER_INFO[k];
      return { ...info, availability: providerAvailability(k) };
    }).filter((p) => p.availability !== 'disabled_here'),
  });
});

// ---------------- terminals (setup & dashboard) ----------------

router.get(P, requireAnyPermission('terminals.manage', 'terminals.reconcile'), async (_req, res) => {
  const list = await PaymentTerminal.find({ removedAt: { $exists: false } }).sort({ createdAt: 1 }).lean();
  const open = await TerminalTransaction.aggregate([
    { $match: { status: { $in: ['created', 'connecting', 'awaiting_card', 'awaiting_pin', 'processing', 'unknown'] } } },
    { $group: { _id: '$terminalId', n: { $sum: 1 } } },
  ]);
  const unlinked = await TerminalTransaction.aggregate([
    { $match: { kind: 'sale', status: 'approved', saleId: { $exists: false } } },
    { $group: { _id: '$terminalId', n: { $sum: 1 } } },
  ]);
  const count = (rows: { _id: unknown; n: number }[], id: unknown) => rows.find((r) => String(r._id) === String(id))?.n ?? 0;
  res.json({ data: list.map((t) => ({ ...presentTerminal(t), openTransactions: count(open, t._id), approvedNotLinked: count(unlinked, t._id) })) });
});

router.get(`${P}/:id`, requireAnyPermission('terminals.manage', 'terminals.reconcile'), async (req, res) => {
  const t = await loadTerminal(idParam(req.params.id));
  res.json({ data: presentTerminal(t.toObject()) });
});

router.post(P, requirePermission('terminals.manage'), async (req, res) => {
  const body = parse(z.object({ name: z.string().trim().min(1).max(60), provider: z.enum(TERMINAL_PROVIDERS), connection: z.enum(TERMINAL_CONNECTIONS), branchId: objectId }), req.body);
  const info = TERMINAL_PROVIDER_INFO[body.provider as TerminalProviderKey];
  adapterFor(body.provider); // refuses providers that are not supported here
  if (!info.connections.includes(body.connection)) throw unprocessable(`${info.label} does not support ${body.connection} connections`, 'TERMINAL_CONNECTION_NOT_SUPPORTED');
  const branch = await Branch.findById(body.branchId);
  if (!branch) throw notFound('Branch');
  assertBranchAccess(req, branch._id);
  const t = await PaymentTerminal.create({
    name: body.name, provider: body.provider, connection: body.connection, branchId: branch._id, mode: 'sandbox', createdBy: req.auth!.userId,
    integrationVersion: info.integrationVersion,
    // Nothing to install for the simulator; real providers confirm installation of the official app/driver.
    checks: body.provider === 'simulator' ? { installed: { at: new Date(), ok: true, message: 'Nothing to install' } } : {},
  });
  await audit(req, { action: 'terminal.created', entity: 'PaymentTerminal', entityId: t._id, details: { name: t.name, provider: t.provider, branch: branch.code } });
  res.status(201).json({ data: presentTerminal(t.toObject()) });
});

const editable = async (req: any) => {
  const t = await loadTerminal(idParam(req.params.id));
  assertBranchAccess(req, t.branchId);
  return t;
};

router.post(`${P}/:id/installed`, requirePermission('terminals.manage'), async (req, res) => {
  const t = await editable(req);
  t.set('checks.installed', { at: new Date(), ok: true, message: 'Official application / driver installed (confirmed by the merchant)' });
  await t.save();
  res.json({ data: presentTerminal(t.toObject()) });
});

router.get(`${P}/:id/discover`, requirePermission('terminals.manage'), async (req, res) => {
  const t = await editable(req);
  const a = adapterFor(t.provider);
  if (!a.discover || !a.capabilities.discovery) {
    res.json({ data: [], supported: false });
    return;
  }
  try {
    res.json({ data: await a.discover(contextOf(t)), supported: true });
  } catch (err) {
    throw terminalError(err);
  }
});

router.post(`${P}/:id/register`, requirePermission('terminals.manage'), async (req, res) => {
  const body = parse(z.object({ deviceId: z.string().trim().max(80).optional(), host: z.string().trim().max(120).optional(), port: z.number().int().min(1).max(65535).optional(), comPort: z.string().trim().max(20).optional() }), req.body);
  const t = await editable(req);
  if (!t.checks?.installed?.ok) throw conflict('Install the provider’s terminal application or driver first', 'TERMINAL_NOT_INSTALLED');
  const settings = { ...(t.connectionSettings as object), ...(body.host ? { host: body.host } : {}), ...(body.port ? { port: body.port } : {}), ...(body.comPort ? { comPort: body.comPort } : {}) };
  t.connectionSettings = settings;
  let r;
  try {
    r = await adapterFor(t.provider).register(contextOf(t), { deviceId: body.deviceId });
  } catch (err) {
    t.set('checks.registered', { at: new Date(), ok: false, message: terminalErrorMessage(err) });
    await t.save();
    throw terminalError(err);
  }
  t.device = r.device as any;
  // Re-registering resets pairing: a different device must never inherit the old trust.
  t.set('checks.registered', { at: new Date(), ok: true, message: `${r.device.model ?? 'Terminal'} ${r.device.serialNumber ?? ''}`.trim() });
  t.set('checks.paired', undefined);
  t.set('checks.connectivity', undefined);
  t.set('checks.test', undefined);
  t.secretsEnc = undefined;
  t.status = 'registered';
  await t.save();
  await audit(req, { action: 'terminal.registered', entity: 'PaymentTerminal', entityId: t._id, details: { model: r.device.model, serial: r.device.serialNumber } });
  res.json({ data: presentTerminal(t.toObject()), pairingHint: r.pairingHint, simulatedScreen: t.provider === 'simulator' ? r.simulatedScreen : undefined });
});

router.post(`${P}/:id/pair`, requirePermission('terminals.manage'), async (req, res) => {
  const body = parse(z.object({ pairingCode: z.string().trim().min(1).max(40) }), req.body);
  const t = await editable(req);
  if (!t.checks?.registered?.ok) throw conflict('Register the terminal first', 'TERMINAL_NOT_REGISTERED');
  try {
    const r = await adapterFor(t.provider).pair(contextOf(t), { pairingCode: body.pairingCode });
    t.secretsEnc = sealTerminalSecrets(t._id, r.secrets);
    t.set('checks.paired', { at: new Date(), ok: true, message: 'Paired and authorised' });
    t.status = 'paired';
    await t.save();
  } catch (err) {
    t.set('checks.paired', { at: new Date(), ok: false, message: terminalErrorMessage(err) });
    await t.save();
    await audit(req, { action: 'terminal.pairing_failed', entity: 'PaymentTerminal', entityId: t._id, details: { reason: terminalErrorMessage(err) } });
    throw terminalError(err);
  }
  await audit(req, { action: 'terminal.paired', entity: 'PaymentTerminal', entityId: t._id });
  res.json({ data: presentTerminal(t.toObject()) });
});

/** Connectivity and readiness (also "Reconnect" on the dashboard). */
router.post(`${P}/:id/check`, requirePermission('terminals.manage'), async (req, res) => {
  const t = await editable(req);
  if (!t.checks?.paired?.ok) throw conflict('Pair the terminal first', 'TERMINAL_NOT_PAIRED');
  const r = await checkTerminalHealth(t);
  const ok = r.ok && r.status.ready;
  await PaymentTerminal.updateOne({ _id: t._id }, { $set: { 'checks.connectivity': { at: new Date(), ok, message: r.ok ? (r.status.ready ? 'Connected and ready' : r.status.busy ? 'Connected, but busy with a transaction' : 'Connected, not ready') : terminalErrorMessage(r.error) } } });
  res.json({ data: presentTerminal((await loadTerminal(t._id)).toObject()) });
});

router.put(`${P}/:id/tills`, requirePermission('terminals.manage'), async (req, res) => {
  const body = parse(z.object({ tillIds: z.array(objectId).max(50) }), req.body);
  const t = await editable(req);
  const tills = await Till.find({ _id: { $in: body.tillIds }, active: true });
  if (tills.length !== body.tillIds.length || tills.some((x) => String(x.branchId) !== String(t.branchId))) throw badRequest('Choose active tills of the terminal’s branch');
  t.tillIds = tills.map((x) => x._id);
  t.set('checks.tills', { at: new Date(), ok: tills.length > 0, message: tills.length ? `${tills.length} till${tills.length > 1 ? 's' : ''}: ${tills.map((x) => x.name).join(', ')}` : 'No till chosen' });
  await t.save();
  await audit(req, { action: 'terminal.tills_assigned', entity: 'PaymentTerminal', entityId: t._id, details: { tills: tills.map((x) => x.name) } });
  res.json({ data: presentTerminal(t.toObject()) });
});

/** Setup test: a small authorised test (simulator / sandbox) payment that never links to a sale. */
router.post(`${P}/:id/test`, requirePermission('terminals.manage'), async (req, res) => {
  const body = parse(z.object({ clientRequestId: z.string().min(8).max(100), amountCents: positiveCents.max(100_000).default(100) }), req.body);
  const t = await editable(req);
  if (t.mode === 'live') throw unprocessable('Live terminals are tested with the provider’s certified test procedure, not from here', 'TERMINAL_TEST_LIVE');
  try {
    const r = await startTerminalPayment(req, { terminalId: String(t._id), amountCents: body.amountCents, clientRequestId: body.clientRequestId, kind: 'test' });
    res.status(r.replay ? 200 : 201).json({ data: presentTxn(r.txn.toObject()) });
  } catch (err) {
    throw terminalError(err);
  }
});

/** Enabling for payments needs every check to have passed (and live mode needs a certified provider). */
router.post(`${P}/:id/enable`, requirePermission('terminals.manage'), async (req, res) => {
  const t = await editable(req);
  const c = t.checks ?? ({} as any);
  const missing = [
    !c.installed?.ok && 'install the terminal application',
    !c.registered?.ok && 'register the device',
    !c.paired?.ok && 'pair it',
    !(c.connectivity?.ok && c.connectivity.at && Date.now() - new Date(c.connectivity.at).getTime() < 15 * 60_000) && 'pass the connection test (in the last 15 minutes)',
    !(c.tills?.ok && t.tillIds.length) && 'choose its tills',
    !c.test?.ok && 'complete a test payment',
  ].filter(Boolean);
  if (missing.length) throw unprocessable(`Before enabling: ${missing.join(', ')}.`, 'TERMINAL_CHECKS_INCOMPLETE', { missing });
  if (t.mode === 'live' && providerAvailability(t.provider as TerminalProviderKey) !== 'available') throw unprocessable('This provider is not certified for live payments', 'TERMINAL_PROVIDER_NOT_LIVE');
  t.status = 'enabled';
  t.enabledAt = new Date();
  t.enabledBy = req.auth!.userId;
  await t.save();
  await audit(req, { action: 'terminal.enabled', entity: 'PaymentTerminal', entityId: t._id, details: { mode: t.mode } });
  res.json({ data: presentTerminal(t.toObject()) });
});

router.post(`${P}/:id/disable`, requirePermission('terminals.manage'), async (req, res) => {
  const t = await editable(req);
  t.status = 'disabled';
  await t.save();
  await audit(req, { action: 'terminal.disabled', entity: 'PaymentTerminal', entityId: t._id });
  res.json({ data: presentTerminal(t.toObject()) });
});

router.delete(`${P}/:id`, requirePermission('terminals.manage'), async (req, res) => {
  const t = await editable(req);
  if (await TerminalTransaction.exists({ terminalId: t._id, lockKey: t._id })) throw conflict('This terminal has an unfinished card payment: reconcile it before removing the terminal', 'TERMINAL_HAS_OPEN_PAYMENT');
  t.removedAt = new Date();
  t.status = 'disabled';
  t.secretsEnc = undefined;
  t.tillIds = [];
  await t.save();
  await audit(req, { action: 'terminal.removed', entity: 'PaymentTerminal', entityId: t._id, details: { name: t.name } });
  res.json({ ok: true });
});

// ---------------- simulator panel (test only) ----------------

router.post(`${P}/:id/simulator`, requirePermission('terminals.manage'), async (req, res) => {
  const t = await editable(req);
  if (t.provider !== 'simulator' || !simulatorAllowed()) throw notFound('Simulator');
  const body = parse(z.object({ poweredOff: z.boolean().optional(), disconnected: z.boolean().optional(), credentialsExpired: z.boolean().optional(), busy: z.boolean().optional() }), req.body);
  await setSimulatedDevice({ terminalId: String(t._id) }, body);
  res.json({ ok: true });
});

router.post(`${P}/transactions/:id/simulate`, requireAnyPermission('terminals.manage', 'sales.create'), async (req, res) => {
  const body = parse(z.object({ outcome: z.enum(['approved', 'declined', 'cancelled']) }), req.body);
  const x = await TerminalTransaction.findById(idParam(req.params.id));
  if (!x || x.provider !== 'simulator' || !simulatorAllowed()) throw notFound('Simulated payment');
  assertBranchAccess(req, x.branchId);
  await forceSimulatedOutcome({ terminalId: String(x.terminalId) }, x.reference, body.outcome);
  res.json({ data: presentTxn((await refreshTransaction(x)).toObject()) });
});

// ---------------- the till ----------------

/** Terminals this till can use, with live health (no secrets). */
router.get(`${P}/for-till/:tillId`, requirePermission('sales.create'), async (req, res) => {
  const till = await Till.findById(idParam(req.params.tillId));
  if (!till) throw notFound('Till');
  assertBranchAccess(req, till.branchId);
  const list = await PaymentTerminal.find({ status: 'enabled', tillIds: till._id, removedAt: { $exists: false } }).lean();
  res.json({ data: list.map((t) => ({ id: t._id, name: t.name, provider: t.provider, mode: t.mode, health: t.health ?? {}, device: { model: t.device?.model } })) });
});

/**
 * What the till must deal with before charging again: payments still open or unknown on its terminals, and
 * approved payments not yet linked to a sale (e.g. after the till restarted mid-payment).
 */
router.get(`${P}/transactions/open-for-till/:tillId`, requirePermission('sales.create'), async (req, res) => {
  const till = await Till.findById(idParam(req.params.tillId));
  if (!till) throw notFound('Till');
  assertBranchAccess(req, till.branchId);
  const terminalIds = (await PaymentTerminal.find({ tillIds: till._id }, { _id: 1 }).lean()).map((t) => t._id);
  const rows = await TerminalTransaction.find({
    kind: 'sale',
    $or: [
      { terminalId: { $in: terminalIds }, lockKey: { $exists: true } },
      { tillId: till._id, status: 'approved', saleId: { $exists: false } },
    ],
  }).sort({ createdAt: -1 }).limit(20).lean();
  res.json({ data: rows.map(presentTxn) });
});

router.post(`${P}/transactions`, requirePermission('sales.create'), async (req, res) => {
  const body = parse(z.object({ terminalId: objectId, tillId: objectId, amountCents: positiveCents.min(1), clientRequestId: z.string().min(8).max(100) }), req.body);
  try {
    const r = await startTerminalPayment(req, { ...body, kind: 'sale' });
    res.status(r.replay ? 200 : 201).json({ data: presentTxn(r.txn.toObject()) });
  } catch (err) {
    throw terminalError(err);
  }
});

const loadTxn = async (req: any) => {
  const x = await TerminalTransaction.findById(idParam(req.params.id));
  if (!x) throw notFound('Card payment');
  // Tenant and branch scoping: other businesses' payments do not exist here; other branches' are refused.
  assertBranchAccess(req, x.branchId);
  return x;
};

/** Current status; `refresh=1` asks the terminal now (the till polls this as a fallback to live updates). */
router.get(`${P}/transactions/:id`, requireAnyPermission('sales.create', 'terminals.reconcile', 'terminals.manage'), async (req, res) => {
  let x = await loadTxn(req);
  if (req.query.refresh === '1' && terminalTxnOpen(x.status)) x = await refreshTransaction(x);
  res.json({ data: presentTxn(x.toObject()) });
});

router.post(`${P}/transactions/:id/cancel`, requireAnyPermission('sales.create', 'terminals.reconcile'), async (req, res) => {
  const x = await loadTxn(req);
  res.json({ data: presentTxn((await cancelTerminalPayment(req, x)).toObject()) });
});

/** Reconciliation: check again with the terminal now. */
router.post(`${P}/transactions/:id/reconcile`, requirePermission('terminals.reconcile'), async (req, res) => {
  const x = await loadTxn(req);
  const fresh = await refreshTransaction(x);
  await audit(req, { action: 'terminal.payment_rechecked', entity: 'TerminalTransaction', entityId: x._id, details: { reference: x.reference, status: fresh.status } });
  res.json({ data: presentTxn(fresh.toObject()) });
});

router.post(`${P}/transactions/:id/resolve`, requirePermission('terminals.reconcile'), async (req, res) => {
  const body = parse(z.object({ outcome: z.literal('not_charged'), note: z.string().trim().min(5).max(300) }), req.body);
  const x = await loadTxn(req);
  res.json({ data: presentTxn((await resolveAsNotCharged(req, x, body.note)).toObject()) });
});

router.post(`${P}/transactions/:id/refund`, requirePermission('terminals.refund'), async (req, res) => {
  const body = parse(z.object({ amountCents: positiveCents.min(1), clientRequestId: z.string().min(8).max(100), reason: z.string().trim().min(3).max(200) }), req.body);
  const x = await loadTxn(req);
  try {
    res.status(201).json({ data: presentTxn((await refundTerminalPayment(req, x, body)).toObject()) });
  } catch (err) {
    throw terminalError(err);
  }
});

/** Dashboard list: filter by terminal and status; `needsAttention` = open/unknown or approved but not on a sale. */
router.get(`${P}-transactions`, requireAnyPermission('terminals.reconcile', 'terminals.manage'), async (req, res) => {
  const q = parse(z.object({ terminalId: objectId.optional(), status: z.string().max(30).optional(), needsAttention: z.enum(['true', 'false']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
  const filter: Record<string, unknown> = {};
  if (q.terminalId) filter.terminalId = q.terminalId;
  if (q.status) filter.status = q.status;
  if (q.needsAttention === 'true') filter.$or = [{ lockKey: { $exists: true } }, { kind: 'sale', status: 'approved', saleId: { $exists: false } }];
  const rows = await TerminalTransaction.find(filter).sort({ createdAt: -1 }).limit(q.limit).lean();
  res.json({ data: rows.map(presentTxn) });
});

export const terminalRoutes = router;

// ---------------- provider notifications (public, authenticated by the adapter) ----------------

/**
 * POST /api/v1/hooks/terminal/:tenantId/:terminalId
 * The body is never trusted: the adapter authenticates it (e.g. HMAC with the pairing key), and then the
 * transaction is re-checked with a status query. Always answers 200 so the URL cannot be probed.
 */
export const terminalHookRoutes = Router();
terminalHookRoutes.post('/:tenantId/:terminalId', async (req, res) => {
  const { tenantId, terminalId } = req.params;
  if (!/^[a-f0-9]{24}$/.test(tenantId) || !/^[a-f0-9]{24}$/.test(terminalId)) {
    res.json({ received: true });
    return;
  }
  try {
    const tenant = await Tenant.findById(tenantId, { _id: 1 }).lean();
    if (tenant) {
      await runInTenant(tenant._id, async () => {
        const t = await PaymentTerminal.findById(terminalId).select('+secretsEnc');
        if (!t) return;
        const a = adapterFor(t.provider);
        const keys = a.verifyNotification?.({ ...contextOf(t), secrets: openTerminalSecrets(t) }, { rawBody: (req as any).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {})), headers: req.headers, body: req.body });
        if (!keys) {
          await audit(null, { action: 'terminal.notification_rejected', entity: 'PaymentTerminal', entityId: t._id, details: { ip: req.ip } });
          return;
        }
        const x = await TerminalTransaction.findOne({ terminalId: t._id, reference: keys.reference });
        if (x) await refreshTransaction(x, 'notification');
        await recordHealth(t, { ok: true });
      });
    }
  } catch (err) {
    logger.warn({ err }, 'terminal notification failed');
  }
  res.json({ received: true });
});
