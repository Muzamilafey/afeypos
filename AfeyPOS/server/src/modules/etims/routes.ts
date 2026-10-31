import { Router } from 'express';
import { z } from 'zod';
import { IntegrationConfig, Product, Sale, SaleReturn, Till } from '../../models/index.js';
import { idParam, objectId, parse } from '../../http/validate.js';
import { requirePermission } from '../../http/auth.js';
import { notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { enqueue } from '../../jobs/queue.js';
import { etimsDevicesForTill } from './service.js';
import { openSecrets, sealSecrets } from '../integrations/configs.js';
import { etimsGateway, queueItemRegistration } from './service.js';

const router = Router();

/** Device initialisation: KRA returns the SCU id, MRC number and the communication key used on every call. */
router.post('/settings/integrations/:id/etims/initialize', requirePermission('integrations.manage'), async (req, res) => {
  const cfg = await IntegrationConfig.findOne({ _id: idParam(req.params.id), kind: 'etims' });
  if (!cfg) throw notFound('eTIMS configuration');
  const info = await etimsGateway(cfg).initialize();
  cfg.settings = { ...(cfg.settings ?? {}), sdcId: info.sdcId, mrcNo: info.mrcNo, registeredName: info.taxprNm, branchName: info.bhfNm, initializedAt: new Date().toISOString() };
  cfg.markModified('settings');
  if (info.cmcKey) cfg.secretsEnc = sealSecrets(cfg._id, { ...openSecrets(cfg), cmcKey: info.cmcKey });
  cfg.lastTest = { at: new Date(), ok: true, message: `Initialised: SCU ${info.sdcId ?? '?'}` } as any;
  await cfg.save();
  await audit(req, { action: 'etims.initialized', entity: 'IntegrationConfig', entityId: cfg._id, details: { sdcId: info.sdcId, mrcNo: info.mrcNo } });
  res.json({ data: { sdcId: info.sdcId, mrcNo: info.mrcNo, taxpayer: info.taxprNm, branch: info.bhfNm } });
});

/** The KRA ETR devices this till may sign with, so it can be chosen when a shop has more than one. */
router.get('/etims/devices', requirePermission('sales.create'), async (req, res) => {
  const q = parse(z.object({ tillId: objectId.optional() }), req.query);
  const till = q.tillId ? await Till.findById(q.tillId).lean() : null;
  const devices = await etimsDevicesForTill(till?.branchId, till?._id);
  res.json({
    data: devices.map((c, i) => ({
      id: c._id, name: c.name, mode: c.provider === 'vscu' ? 'vscu' : 'oscu', environment: c.environment, isDefault: i === 0,
      tin: c.settings?.tin ?? '', bhfId: c.settings?.bhfId ?? '00', serial: c.settings?.dvcSrlNo ?? '', initialised: Boolean(c.settings?.sdcId),
    })),
  });
});

router.get('/etims/status', requirePermission('reports.financial'), async (_req, res) => {
  const [configs, sales, returns, failedSales, failedReturns, pendingSales, unregistered] = await Promise.all([
    IntegrationConfig.find({ kind: 'etims' }).lean(),
    Sale.aggregate([{ $match: { 'etims.status': { $exists: true } } }, { $group: { _id: '$etims.status', n: { $sum: 1 } } }]),
    SaleReturn.aggregate([{ $match: { 'etims.status': { $exists: true } } }, { $group: { _id: '$etims.status', n: { $sum: 1 } } }]),
    Sale.find({ 'etims.status': 'failed' }, { number: 1, totalCents: 1, completedAt: 1, etims: 1 }).sort({ completedAt: -1 }).limit(100).lean(),
    SaleReturn.find({ 'etims.status': 'failed' }, { number: 1, refundCents: 1, createdAt: 1, etims: 1 }).sort({ createdAt: -1 }).limit(100).lean(),
    Sale.find({ 'etims.status': 'pending' }, { number: 1, totalCents: 1, completedAt: 1, etims: 1 }).sort({ completedAt: 1 }).limit(100).lean(),
    Product.countDocuments({ active: true, 'etims.registeredAt': { $exists: false } }),
  ]);
  res.json({
    data: {
      configs: configs.map((c) => ({ id: c._id, name: c.name, provider: c.provider, environment: c.environment, branchIds: c.branchIds, tin: c.settings?.tin, bhfId: c.settings?.bhfId, sdcId: c.settings?.sdcId, mrcNo: c.settings?.mrcNo, initializedAt: c.settings?.initializedAt, enabled: c.enabled })),
      sales: Object.fromEntries(sales.map((s) => [s._id, s.n])),
      returns: Object.fromEntries(returns.map((s) => [s._id, s.n])),
      failed: [...failedSales.map((s) => ({ kind: 'sale', ...s })), ...failedReturns.map((s) => ({ kind: 'return', ...s }))],
      pending: pendingSales,
      unregisteredProducts: unregistered,
    },
  });
});

/** Re-submit a failed invoice (after fixing e.g. an item classification). */
router.post('/etims/retry', requirePermission('reports.financial'), async (req, res) => {
  const body = parse(z.object({ kind: z.enum(['sale', 'return']), id: objectId }), req.body);
  const model = body.kind === 'sale' ? Sale : SaleReturn;
  const r = await (model as typeof Sale).updateOne({ _id: body.id, 'etims.status': { $in: ['failed', 'pending'] } }, { $set: { 'etims.status': 'pending' }, $unset: { 'etims.error': 1 } });
  if (!r.matchedCount) throw notFound('Unsigned invoice');
  await enqueue('etims.submit', { kind: body.kind, id: String(body.id) }, { maxAttempts: 60, dedupeKey: `etims:${body.kind}:${body.id}:retry:${Date.now()}` });
  await audit(req, { action: 'etims.retry', details: body });
  res.json({ data: { queued: true } });
});

/** Register every active product as an eTIMS item (first setup, or after adding a device). */
router.post('/etims/items/register-all', requirePermission('integrations.manage'), async (req, res) => {
  const ids = await Product.find({ active: true }, { _id: 1 }).lean();
  for (const p of ids) await queueItemRegistration(p._id, req.capabilities!);
  res.json({ data: { queued: ids.length } });
});

export const etimsRoutes = router;
