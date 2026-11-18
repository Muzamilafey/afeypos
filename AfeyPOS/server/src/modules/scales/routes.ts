import { Router } from 'express';
import { z } from 'zod';
import { SCALE_ADAPTER_KEYS, SCALE_ADAPTERS, SCALE_BRANDS, pluCsv, roundKg, type ScaleAdapterKey } from '@afeypos/shared';
import { Branch, ScaleSyncJob, Till, WeighingScale } from '../../models/index.js';
import { idParam, objectId, parse } from '../../http/validate.js';
import { requirePermission } from '../../http/auth.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { enqueue } from '../../jobs/queue.js';
import { adapterInfo, canSendDirect, confirmManualImport, createSyncJob, pluItemsFor, pluStatus } from './service.js';

const router = Router();

const scaleBody = z.object({
  name: z.string().trim().min(1).max(60),
  brand: z.string().refine((b) => SCALE_BRANDS.some((x) => x.key === b), 'Unknown brand'),
  model: z.string().trim().max(60).optional(),
  adapter: z.enum(SCALE_ADAPTER_KEYS as [ScaleAdapterKey, ...ScaleAdapterKey[]]),
  role: z.enum(['counter', 'label', 'both']).default('counter'),
  branchId: objectId,
  tillIds: z.array(objectId).max(50).default([]),
  settings: z.object({
    port: z.string().trim().max(60).optional(),
    baud: z.number().int().min(1200).max(115200).optional(),
    tareCommand: z.string().max(20).optional(),
    maxKg: z.number().positive().max(10000).optional(),
    minKg: z.number().min(0).max(100).optional(),
    syncAll: z.boolean().optional(),
    simulateFailures: z.number().int().min(0).max(10).optional(),
  }).default({}),
});

/** Brand/adapter pairing must make sense: a weight-only adapter cannot be a label scale and the reverse. */
function checkPairing(b: { brand: string; adapter: ScaleAdapterKey; role: string }) {
  const brand = SCALE_BRANDS.find((x) => x.key === b.brand)!;
  if (!brand.adapters.includes(b.adapter)) throw badRequest(`${brand.name} scales are not supported with "${SCALE_ADAPTERS[b.adapter].label}"`);
  const a = SCALE_ADAPTERS[b.adapter];
  if (b.role !== 'label' && !a.readWeight) throw badRequest(`${a.label} cannot send live weight to the till: choose the Label role`);
  if (b.role !== 'counter' && a.pluSync === 'none') throw badRequest(`${a.label} cannot hold a PLU list: choose the Counter role`);
  if (b.role !== 'counter' && !brand.labelScales) throw badRequest(`${brand.name} scales here are weight-only (no PLU list)`);
}

async function present(s: InstanceType<typeof WeighingScale>) {
  return { ...s.toObject(), adapterInfo: adapterInfo(s.adapter), pluStatus: await pluStatus(s), lastJob: await ScaleSyncJob.findOne({ scaleId: s._id }).sort({ version: -1 }).select('-items').lean() };
}

router.get('/scales/catalog', requirePermission('hardware.manage'), (_req, res) => {
  res.json({ data: { brands: SCALE_BRANDS, adapters: SCALE_ADAPTERS } });
});

router.get('/scales', requirePermission('products.read'), async (req, res) => {
  const filter: Record<string, unknown> = { active: true };
  if (req.query.tillId) filter.tillIds = idParam(String(req.query.tillId));
  const rows = await WeighingScale.find(filter).sort({ name: 1 });
  res.json({ data: await Promise.all(rows.map(present)) });
});

router.post('/scales', requirePermission('hardware.manage'), async (req, res) => {
  const body = parse(scaleBody, req.body);
  checkPairing(body);
  if (!(await Branch.exists({ _id: body.branchId }))) throw notFound('Branch');
  if (body.tillIds.length && (await Till.countDocuments({ _id: { $in: body.tillIds }, branchId: body.branchId })) !== body.tillIds.length) throw badRequest('Tills must belong to the scale\'s branch');
  const s = await WeighingScale.create({ ...body, simulated: body.adapter === 'simulator', status: 'unverified', createdBy: req.auth!.userId });
  await audit(req, { action: 'scale.created', entity: 'WeighingScale', entityId: s._id, details: { name: s.name, brand: s.brand, adapter: s.adapter } });
  res.status(201).json({ data: await present(s) });
});

router.patch('/scales/:id', requirePermission('hardware.manage'), async (req, res) => {
  const s = await WeighingScale.findOne({ _id: idParam(req.params.id), active: true });
  if (!s) throw notFound('Scale');
  const body = parse(scaleBody.partial(), req.body);
  const next = { brand: body.brand ?? s.brand, adapter: (body.adapter ?? s.adapter) as ScaleAdapterKey, role: body.role ?? s.role };
  checkPairing(next);
  const connectionChanged = ['brand', 'adapter', 'role'].some((k) => k in body && (body as Record<string, unknown>)[k] !== (s as unknown as Record<string, unknown>)[k])
    || (body.settings && (body.settings.port !== s.settings?.port || body.settings.baud !== s.settings?.baud));
  s.set({ ...body, settings: { ...(s.settings ?? {}), ...(body.settings ?? {}) }, simulated: next.adapter === 'simulator' });
  // A different connection has to be tested again before it is trusted.
  if (connectionChanged && s.status === 'verified') s.status = 'unverified';
  await s.save();
  await audit(req, { action: 'scale.updated', entity: 'WeighingScale', entityId: s._id, details: { fields: Object.keys(body) } });
  res.json({ data: await present(s) });
});

router.delete('/scales/:id', requirePermission('hardware.manage'), async (req, res) => {
  const s = await WeighingScale.findOneAndUpdate({ _id: idParam(req.params.id), active: true }, { $set: { active: false, status: 'disabled' } }, { new: true });
  if (!s) throw notFound('Scale');
  await audit(req, { action: 'scale.removed', entity: 'WeighingScale', entityId: s._id, details: { name: s.name } });
  res.json({ ok: true });
});

const readingSchema = z.object({ grossKg: z.number(), tareKg: z.number().default(0), netKg: z.number(), stable: z.boolean(), raw: z.string().max(200).optional() });

/**
 * Verification with a known test weight. Counter scales: the till reads the scale (bridge or keyboard) and sends
 * the reading here with the weight that was placed on it; it passes only when the reading is stable and within
 * 1% (at least 5 g). The simulator answers on its own and stays marked as simulated.
 */
router.post('/scales/:id/verify', requirePermission('hardware.manage'), async (req, res) => {
  const s = await WeighingScale.findOne({ _id: idParam(req.params.id), active: true });
  if (!s) throw notFound('Scale');
  const body = parse(z.object({ expectedKg: z.number().positive().max(10000), reading: readingSchema.optional() }), req.body);
  let reading = body.reading;
  if (s.adapter === 'simulator') reading = { grossKg: body.expectedKg, tareKg: 0, netKg: body.expectedKg, stable: true, raw: 'SIMULATED' };
  if (s.adapter === 'file-export') throw new AppError(409, 'VERIFY_BY_IMPORT', 'Label scales are verified by importing a PLU file and confirming it (Send prices)');
  if (!reading) throw badRequest('Read the scale first: no reading was sent');
  const net = roundKg(reading.netKg);
  const tolerance = Math.max(0.005, body.expectedKg * 0.01);
  const ok = reading.stable && Math.abs(net - body.expectedKg) <= tolerance;
  const message = !reading.stable ? 'The reading never settled (unstable)' : ok ? `Read ${net.toFixed(3)} kg for a ${body.expectedKg.toFixed(3)} kg test weight` : `Read ${net.toFixed(3)} kg but the test weight is ${body.expectedKg.toFixed(3)} kg`;
  s.lastCheck = { at: new Date(), ok, message: s.simulated ? `${message} (simulated)` : message, reading: { ...reading, netKg: net }, by: req.auth!.userId };
  s.status = ok ? 'verified' : 'failed';
  await s.save();
  await audit(req, { action: ok ? 'scale.verified' : 'scale.verify_failed', entity: 'WeighingScale', entityId: s._id, details: { expectedKg: body.expectedKg, netKg: net, simulated: s.simulated } });
  res.status(ok ? 200 : 422).json(ok ? { data: await present(s) } : { error: { code: 'SCALE_VERIFY_FAILED', message } });
});

/** Send the current PLU list (prices) to a label scale: directly where supported, else as a file to import. */
router.post('/scales/:id/sync', requirePermission('hardware.manage'), async (req, res) => {
  const s = await WeighingScale.findOne({ _id: idParam(req.params.id), active: true });
  if (!s) throw notFound('Scale');
  if (s.role === 'counter') throw badRequest('This scale only weighs at the till; it holds no PLU list');
  const job = await createSyncJob(s, req.auth!.userId);
  await audit(req, { action: 'scale.sync_started', entity: 'WeighingScale', entityId: s._id, details: { version: job.version, items: job.items.length, direct: canSendDirect(s.adapter) } });
  res.status(201).json({ data: job });
});

router.get('/scales/:id/jobs', requirePermission('hardware.manage'), async (req, res) => {
  const rows = await ScaleSyncJob.find({ scaleId: idParam(req.params.id) }).sort({ version: -1 }).limit(20).select('-items').lean();
  res.json({ data: rows });
});

router.get('/scales/:id/plu-preview', requirePermission('hardware.manage'), async (req, res) => {
  const s = await WeighingScale.findOne({ _id: idParam(req.params.id), active: true });
  if (!s) throw notFound('Scale');
  res.json({ data: await pluItemsFor(s) });
});

router.get('/scale-jobs/:id/file', requirePermission('hardware.manage'), async (req, res) => {
  const job = await ScaleSyncJob.findById(idParam(req.params.id)).lean();
  if (!job) throw notFound('Sync job');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="plu-v${job.version}.csv"`);
  res.send(pluCsv(job.items.map((i) => ({ plu: i.plu!, name: i.name!, priceCents: i.priceCents!, unit: i.unit as 'kg' | 'pc' }))));
});

/** A person confirms the PLU file was imported and the scale shows the new prices. */
router.post('/scale-jobs/:id/confirm', requirePermission('hardware.manage'), async (req, res) => {
  const job = await ScaleSyncJob.findById(idParam(req.params.id));
  if (!job) throw notFound('Sync job');
  if (job.status !== 'awaiting_import') throw new AppError(409, 'NOT_AWAITING_IMPORT', job.status === 'superseded' ? 'A newer price list replaced this one: import that one instead' : `This send is ${job.status}`);
  const done = await confirmManualImport(job._id, req.auth!.userId);
  await audit(req, { action: 'scale.import_confirmed', entity: 'ScaleSyncJob', entityId: job._id, details: { version: job.version, items: job.items.length } });
  res.json({ data: done });
});

router.post('/scale-jobs/:id/retry', requirePermission('hardware.manage'), async (req, res) => {
  const job = await ScaleSyncJob.findById(idParam(req.params.id));
  if (!job) throw notFound('Sync job');
  if (job.status !== 'failed') throw new AppError(409, 'NOT_FAILED', 'Only a failed send can be retried');
  job.status = 'queued';
  job.error = undefined;
  job.log.push({ at: new Date(), message: 'Retry requested' });
  await job.save();
  await enqueue('scales.send', { jobId: String(job._id) }, { dedupeKey: `scales.send:${job._id}:${Date.now()}`, maxAttempts: job.maxAttempts });
  res.json({ data: job });
});

export const scaleRoutes = router;
