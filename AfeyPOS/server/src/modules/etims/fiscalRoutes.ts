/**
 * Fiscal devices and transactions (Settings → Tax & Fiscalization): device health and capabilities, the fiscal
 * transaction monitor, reconciliation of uncertain invoices, and fiscal reports. Keys are never returned.
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { FiscalDeviceState, FiscalTransaction, IntegrationConfig, Sale, SaleReturn } from '../../models/index.js';
import { idParam, objectId, parse } from '../../http/validate.js';
import { requirePermission } from '../../http/auth.js';
import { badRequest, notFound, unprocessable } from '../../lib/errors.js';
import { audit, auditOrigin } from '../../lib/audit.js';
import { enqueue } from '../../jobs/queue.js';
import { env } from '../../config/env.js';
import { FISCAL_NEEDS_ATTENTION, FISCAL_OPEN, FISCAL_STATUSES, type FiscalSignature } from '../../integrations/fiscal/adapter.js';
import { period } from '../reports/routes.js';
import { fiscalCapabilities, fiscalAdapter, fiscalKind, KIND_LABEL } from './adapters.js';
import { logFiscal, recordHealth } from './fiscal.js';
import { fiscalModel, signedFields, taxType } from './service.js';

const router = Router();
const VIEW = requirePermission('reports.financial');
const MANAGE = requirePermission('integrations.manage');

/** green: working; yellow: working with invoices waiting; red: offline or invoices need a person; grey: off or not known. */
function colour(state: string | undefined, enabled: boolean, waiting: number, attention: number) {
  if (!enabled) return 'grey';
  if (state === 'offline' || attention > 0) return 'red';
  if (waiting > 0) return 'yellow';
  return state === 'online' ? 'green' : 'grey';
}

async function queueCounts() {
  const rows = await Promise.all([Sale, SaleReturn].map((m) => (m as typeof Sale).aggregate([{ $match: { 'etims.status': { $exists: true } } }, { $group: { _id: { c: '$etims.configId', s: '$etims.status' }, n: { $sum: 1 } } }])));
  const by = new Map<string, Record<string, number>>();
  for (const r of rows.flat()) {
    const k = String(r._id.c);
    const m = by.get(k) ?? {};
    m[r._id.s] = (m[r._id.s] ?? 0) + r.n;
    by.set(k, m);
  }
  return by;
}

router.get('/fiscal/devices', VIEW, async (_req, res) => {
  const [configs, states, counts] = await Promise.all([IntegrationConfig.find({ kind: 'etims' }).sort({ createdAt: 1 }), FiscalDeviceState.find({}).lean(), queueCounts()]);
  // Two servers numbering invoices for one device would clash at KRA: warn.
  const origins = await FiscalTransaction.aggregate([{ $match: { operation: { $in: ['invoice', 'credit_note'] } } }, { $group: { _id: '$configId', origins: { $addToSet: '$origin' } } }]);
  const originsBy = new Map(origins.map((o) => [String(o._id), o.origins as string[]]));
  const here = auditOrigin();
  const hq = env().DEPLOYMENT_MODE === 'hq';
  const data = await Promise.all(configs.map(async (c) => {
    const adapter = fiscalAdapter(c);
    const st = states.find((s) => String(s.configId) === String(c._id) && s.origin === here) ?? states.find((s) => String(s.configId) === String(c._id));
    const q = counts.get(String(c._id)) ?? {};
    const waiting = FISCAL_OPEN.reduce((a, s) => a + (q[s] ?? 0), 0);
    const attention = FISCAL_NEEDS_ATTENTION.reduce((a, s) => a + (q[s] ?? 0), 0);
    const caps = fiscalCapabilities(c);
    const warnings = [...adapter.validateConfiguration()];
    if ((originsBy.get(String(c._id))?.length ?? 0) > 1) warnings.push(`Invoices for this device were numbered on more than one server (${originsBy.get(String(c._id))!.join(', ')}). Give each server its own device or KRA branch id, or numbers may clash.`);
    if (hq && caps.localOnly) warnings.push('This device is reached from the shop computer: its state here comes from the branch server.');
    return {
      id: c._id, name: c.name, provider: c.provider, kind: fiscalKind(c), kindLabel: KIND_LABEL[fiscalKind(c)], environment: c.environment, enabled: c.enabled,
      branchIds: c.branchIds, tillIds: c.tillIds, info: await adapter.getDeviceInfo(), capabilities: caps,
      health: st ? { state: st.state, message: st.message, lastCheckAt: st.lastCheckAt, lastSuccessAt: st.lastSuccessAt, lastFailureAt: st.lastFailureAt, lastError: st.lastError, consecutiveFailures: st.consecutiveFailures, downSince: st.downSince, origin: st.origin } : null,
      queue: { ...q, waiting, attention }, colour: colour(st?.state, c.enabled, waiting, attention), warnings,
    };
  }));
  res.json({ data, statuses: FISCAL_STATUSES });
});

/** Test connection: never sends a fiscal invoice. */
router.post('/fiscal/devices/:id/test', MANAGE, async (req, res) => {
  const cfg = await IntegrationConfig.findOne({ _id: idParam(req.params.id), kind: 'etims' });
  if (!cfg) throw notFound('Fiscal device');
  const adapter = fiscalAdapter(cfg);
  const t0 = Date.now();
  let st;
  try {
    st = await adapter.testConnection();
  } catch (err: any) {
    st = { state: 'offline' as const, message: String(err?.message ?? err) };
  }
  const problems = adapter.validateConfiguration();
  await recordHealth(cfg._id, st.state === 'online', st.message, st.state);
  await logFiscal({ cfg, operation: 'test', ok: st.state !== 'offline', outcome: st.state, error: st.state === 'offline' ? st.message : undefined, durationMs: Date.now() - t0, userId: req.auth!.userId });
  await audit(req, { action: 'fiscal.device_tested', entity: 'IntegrationConfig', entityId: cfg._id, details: { state: st.state } });
  res.json({ data: { ...st, problems, capabilities: adapter.getCapabilities() } });
});

const listQuery = z.object({
  status: z.enum([...FISCAL_STATUSES, 'open', 'attention']).optional(),
  kind: z.enum(['sale', 'return']).optional(),
  configId: objectId.optional(),
  q: z.string().trim().max(60).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  branchId: objectId.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

function statusFilter(s?: string) {
  if (!s) return { $exists: true };
  if (s === 'open') return { $in: FISCAL_OPEN };
  if (s === 'attention') return { $in: FISCAL_NEEDS_ATTENTION };
  return s;
}

/** The fiscal transaction monitor: sales and credit notes with their fiscal state. */
router.get('/fiscal/transactions', VIEW, async (req, res) => {
  const q = parse(listQuery, req.query);
  const p = q.from || q.to ? period(req) : null;
  const rows: any[] = [];
  for (const kind of q.kind ? [q.kind] : (['sale', 'return'] as const)) {
    const at = kind === 'sale' ? 'completedAt' : 'createdAt';
    const m: Record<string, unknown> = { 'etims.status': statusFilter(q.status) };
    if (q.configId) m['etims.configId'] = q.configId;
    if (p) m[at] = { $gte: p.start, $lt: p.end };
    if (q.branchId) m.branchId = q.branchId;
    if (q.q) {
      const n = Number(q.q);
      m.$or = [{ number: { $regex: q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }, ...(Number.isInteger(n) ? [{ 'etims.invcNo': n }] : []), { 'etims.cuInvoiceNo': q.q }, { 'etims.rcptSign': q.q }];
    }
    const docs = await fiscalModel(kind).find(m, { number: 1, totalCents: 1, refundCents: 1, completedAt: 1, createdAt: 1, branchId: 1, tillId: 1, etims: 1 }).sort({ [at]: -1 }).limit(q.limit).lean();
    for (const d of docs as any[]) rows.push({ kind, id: d._id, number: d.number, at: d[at], amountCents: kind === 'sale' ? d.totalCents : d.refundCents, branchId: d.branchId, tillId: d.tillId, etims: { ...d.etims, claimUntil: undefined } });
  }
  rows.sort((a, b) => +new Date(b.at) - +new Date(a.at));
  const names = new Map((await IntegrationConfig.find({ kind: 'etims' }, { name: 1 }).lean()).map((c) => [String(c._id), c.name]));
  res.json({ data: rows.slice(0, q.limit).map((r) => ({ ...r, deviceName: names.get(String(r.etims.configId)) ?? '' })) });
});

async function loadDoc(kind: 'sale' | 'return', id: Types.ObjectId) {
  const doc: any = await fiscalModel(kind).findById(id).lean();
  if (!doc?.etims) throw notFound('Fiscal document');
  return doc;
}

/** One document: its fiscal state and every attempt, with what was sent and what came back. */
router.get('/fiscal/transactions/:kind/:id', VIEW, async (req, res) => {
  const kind = z.enum(['sale', 'return']).parse(req.params.kind);
  const doc = await loadDoc(kind, idParam(req.params.id));
  const cfg = await IntegrationConfig.findById(doc.etims.configId);
  const log = await FiscalTransaction.find({ docId: doc._id }).sort({ at: 1 }).limit(200).lean();
  res.json({
    data: {
      kind, id: doc._id, number: doc.number, amountCents: kind === 'sale' ? doc.totalCents : doc.refundCents, at: kind === 'sale' ? doc.completedAt : doc.createdAt, etims: doc.etims,
      device: cfg ? { id: cfg._id, name: cfg.name, kind: fiscalKind(cfg), capabilities: fiscalCapabilities(cfg) } : null, log,
    },
  });
});

const reconcileBody = z.discriminatedUnion('action', [
  // Ask the device again (only where it can be asked).
  z.object({ action: z.literal('check') }),
  // The person checked the device journal / KRA and the invoice is NOT there: send it again with the same number.
  z.object({ action: z.literal('resend'), note: z.string().trim().min(5).max(500) }),
  // The person found the signed invoice on the device or at KRA: record what it shows.
  z.object({
    action: z.literal('record'), note: z.string().trim().min(5).max(500),
    cuInvoiceNo: z.string().trim().min(4).max(60).optional(), cuSerial: z.string().trim().max(60).optional(),
    rcptSign: z.string().trim().min(4).max(120).optional(), rcptNo: z.coerce.number().int().min(0).optional(), intrlData: z.string().trim().max(200).optional(),
    sdcDateTime: z.string().trim().max(40).optional(), qrUrl: z.string().trim().url().max(500).optional(),
  }),
  // Give up on it (e.g. a test sale): it stays unfiscalized and is listed as such.
  z.object({ action: z.literal('mark_failed'), note: z.string().trim().min(5).max(500) }),
]);

router.post('/fiscal/transactions/:kind/:id/reconcile', MANAGE, async (req, res) => {
  const kind = z.enum(['sale', 'return']).parse(req.params.kind);
  const body = parse(reconcileBody, req.body);
  const doc = await loadDoc(kind, idParam(req.params.id));
  const cfg = await IntegrationConfig.findById(doc.etims.configId);
  if (!cfg) throw unprocessable('The fiscal device for this invoice was removed', 'FISCAL_DEVICE_REMOVED');
  if (doc.etims.status === 'signed') throw unprocessable('This invoice is already fiscalized', 'FISCAL_ALREADY_SIGNED');
  if (doc.etims.status === 'processing' && doc.etims.claimUntil && new Date(doc.etims.claimUntil) > new Date()) throw unprocessable('This invoice is being sent right now; wait a moment', 'FISCAL_BUSY');
  const model = fiscalModel(kind);
  const ref = { kind, id: doc._id, number: doc.number, invcNo: doc.etims.invcNo, branchId: doc.branchId };
  const now = new Date();
  let outcome: string;
  if (body.action === 'check') {
    if (!fiscalCapabilities(cfg).transactionStatus) throw unprocessable('This device cannot be asked for an invoice\'s status. Check its journal, then record the signature or confirm it was not signed.', 'FISCAL_NO_STATUS_QUERY');
    await model.updateOne({ _id: doc._id }, { $set: { 'etims.status': 'awaiting_confirmation', 'etims.statusChangedAt': now } });
    outcome = 'awaiting_confirmation';
  } else if (body.action === 'resend') {
    await model.updateOne({ _id: doc._id }, { $set: { 'etims.status': 'pending', 'etims.resendConfirmedBy': req.auth!.userId, 'etims.statusChangedAt': now, 'etims.reconcileNote': body.note }, $unset: { 'etims.error': 1 } });
    outcome = 'pending';
  } else if (body.action === 'record') {
    const etr = cfg.provider === 'etr';
    if (etr && !body.cuInvoiceNo) throw badRequest('Enter the CU invoice number shown by the ETR device');
    if (!etr && !body.rcptSign) throw badRequest('Enter the receipt signature shown by KRA eTIMS');
    const sig: FiscalSignature = {
      curRcptNo: body.rcptNo ?? 0, totRcptNo: body.rcptNo ?? 0, intrlData: body.intrlData ?? '', rcptSign: body.rcptSign ?? body.cuInvoiceNo!, sdcDateTime: body.sdcDateTime ?? '',
      sdcId: body.cuSerial, ...(etr ? { cuInvoiceNo: body.cuInvoiceNo, cuSerial: body.cuSerial ?? cfg.settings?.cuSerial ?? '', qrUrl: body.qrUrl } : {}),
    };
    await model.updateOne({ _id: doc._id }, { $set: { ...signedFields(cfg, sig, 'manual'), 'etims.reconciledBy': req.auth!.userId, 'etims.reconciledAt': now, 'etims.reconcileNote': body.note }, $unset: { 'etims.error': 1, 'etims.claimUntil': 1 } });
    outcome = 'signed';
  } else {
    await model.updateOne({ _id: doc._id }, { $set: { 'etims.status': 'failed', 'etims.error': `Marked as not fiscalized: ${body.note}`, 'etims.reconciledBy': req.auth!.userId, 'etims.reconciledAt': now, 'etims.reconcileNote': body.note, 'etims.statusChangedAt': now }, $unset: { 'etims.claimUntil': 1 } });
    outcome = 'failed';
  }
  if (outcome === 'pending' || outcome === 'awaiting_confirmation') {
    await enqueue('etims.submit', { kind, id: String(doc._id) }, { maxAttempts: 60, dedupeKey: `etims:${kind}:${doc._id}:reconcile:${now.getTime()}` });
  }
  await logFiscal({ cfg, operation: 'reconcile', doc: ref, outcome, ok: true, userId: req.auth!.userId, note: 'note' in body ? body.note : undefined, request: { ...body } });
  await audit(req, { action: `fiscal.reconcile_${body.action}`, entity: kind === 'sale' ? 'Sale' : 'SaleReturn', entityId: doc._id, details: { number: doc.number, invcNo: doc.etims.invcNo, from: doc.etims.status, to: outcome, note: 'note' in body ? body.note : undefined } });
  res.json({ data: { status: outcome } });
});

/** The raw fiscal log (every attempt, status query, test and reconciliation). */
router.get('/fiscal/log', VIEW, async (req, res) => {
  const q = parse(z.object({ configId: objectId.optional(), operation: z.string().max(20).optional(), ok: z.enum(['true', 'false']).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
  const m: Record<string, unknown> = {};
  if (q.configId) m.configId = q.configId;
  if (q.operation) m.operation = q.operation;
  if (q.ok) m.ok = q.ok === 'true';
  if (req.auth!.branchIds.length) m.branchId = { $in: req.auth!.branchIds };
  res.json({ data: await FiscalTransaction.find(m).sort({ at: -1 }).limit(q.limit).lean() });
});

/** Fiscal report for a period: what was fiscalized, what was not, VAT by tax type, device reliability, reconciliation. */
router.get('/fiscal/reports', VIEW, async (req: Request, res) => {
  const p = period(req);
  const branch = p.branchIds ? { branchId: { $in: p.branchIds } } : {};
  const saleM = { completedAt: { $gte: p.start, $lt: p.end }, ...branch };
  const retM = { createdAt: { $gte: p.start, $lt: p.end }, ...branch };
  const [saleStatus, retStatus, unfiscal, vat, daily, attempts, dupes] = await Promise.all([
    Sale.aggregate([{ $match: { ...saleM, 'etims.status': { $exists: true } } }, { $group: { _id: '$etims.status', n: { $sum: 1 }, cents: { $sum: '$totalCents' } } }]),
    SaleReturn.aggregate([{ $match: { ...retM, 'etims.status': { $exists: true } } }, { $group: { _id: '$etims.status', n: { $sum: 1 }, cents: { $sum: '$refundCents' } } }]),
    Sale.aggregate([{ $match: { ...saleM, 'etims.status': { $exists: false }, status: { $ne: 'voided' } } }, { $group: { _id: null, n: { $sum: 1 }, cents: { $sum: '$totalCents' } } }]),
    Sale.aggregate([{ $match: { ...saleM, 'etims.status': 'signed' } }, { $unwind: '$lines' }, { $group: { _id: '$lines.taxRateBp', total: { $sum: '$lines.totalCents' }, tax: { $sum: '$lines.taxCents' } } }]),
    Sale.aggregate([
      { $match: { ...saleM, status: { $ne: 'voided' } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$completedAt', timezone: p.tz } }, sales: { $sum: '$totalCents' }, fiscalized: { $sum: { $cond: [{ $eq: ['$etims.status', 'signed'] }, '$totalCents', 0] } }, n: { $sum: 1 }, signed: { $sum: { $cond: [{ $eq: ['$etims.status', 'signed'] }, 1, 0] } } } },
      { $sort: { _id: 1 } },
    ]),
    FiscalTransaction.aggregate([{ $match: { at: { $gte: p.start, $lt: p.end }, operation: { $in: ['invoice', 'credit_note'] }, ...branch } }, { $group: { _id: '$configId', n: { $sum: 1 }, ok: { $sum: { $cond: ['$ok', 1, 0] } }, ms: { $avg: '$durationMs' } } }]),
    // The same invoice number used twice for one device (two servers numbering for one device).
    Sale.aggregate([
      { $match: { 'etims.invcNo': { $type: 'number' }, ...branch } },
      { $project: { c: '$etims.configId', n: '$etims.invcNo', number: 1 } },
      { $unionWith: { coll: SaleReturn.collection.name, pipeline: [{ $match: { tenantId: req.tenant!._id, 'etims.invcNo': { $type: 'number' }, ...branch } }, { $project: { c: '$etims.configId', n: '$etims.invcNo', number: 1 } }] } },
      { $group: { _id: { c: '$c', n: '$n' }, docs: { $push: '$number' }, k: { $sum: 1 } } },
      { $match: { k: { $gt: 1 } } },
      { $limit: 50 },
    ]),
  ]);
  const by = (rows: any[]) => Object.fromEntries(rows.map((r) => [r._id, { n: r.n, cents: r.cents }]));
  const s = by(saleStatus);
  const r = by(retStatus);
  const vatBy: Record<string, { rate: number; taxableCents: number; taxCents: number }> = {};
  for (const v of vat) {
    const t = taxType(v._id);
    const row = (vatBy[t] ??= { rate: v._id == null ? 0 : v._id / 100, taxableCents: 0, taxCents: 0 });
    row.taxableCents += v.total - v.tax;
    row.taxCents += v.tax;
  }
  // Downtime: outages (and an outage still going on) overlapping the period, per device and server.
  const [configs, states] = await Promise.all([IntegrationConfig.find({ kind: 'etims' }, { name: 1, provider: 1, settings: 1 }).lean(), FiscalDeviceState.find({}).lean()]);
  const overlap = (a: Date, b: Date) => Math.max(0, Math.min(+b, +p.end, Date.now()) - Math.max(+a, +p.start));
  const devices = configs.map((c) => {
    const st = states.filter((x) => String(x.configId) === String(c._id));
    const downMs = st.reduce((a, x) => a + (x.outages ?? []).reduce((b: number, o: any) => b + overlap(o.from, o.to), 0) + (x.downSince ? overlap(x.downSince, new Date()) : 0), 0);
    const at = attempts.find((x) => String(x._id) === String(c._id));
    return { id: c._id, name: c.name, kind: fiscalKind(c), attempts: at?.n ?? 0, succeeded: at?.ok ?? 0, successRate: at?.n ? Math.round((at.ok / at.n) * 1000) / 10 : null, avgMs: at?.ms ? Math.round(at.ms) : null, downtimeMinutes: Math.round(downMs / 60_000) };
  });
  const sum = (o: Record<string, { n: number; cents: number }>, keys: readonly string[]) => keys.reduce((a, k) => ({ n: a.n + (o[k]?.n ?? 0), cents: a.cents + (o[k]?.cents ?? 0) }), { n: 0, cents: 0 });
  res.json({
    data: {
      from: p.from, to: p.to,
      sales: { byStatus: s, fiscalized: s.signed ?? { n: 0, cents: 0 }, open: sum(s, FISCAL_OPEN), attention: sum(s, FISCAL_NEEDS_ATTENTION), withoutFiscal: unfiscal[0] ? { n: unfiscal[0].n, cents: unfiscal[0].cents } : { n: 0, cents: 0 } },
      creditNotes: { byStatus: r, fiscalized: r.signed ?? { n: 0, cents: 0 }, open: sum(r, FISCAL_OPEN), attention: sum(r, FISCAL_NEEDS_ATTENTION) },
      netFiscalizedCents: (s.signed?.cents ?? 0) - (r.signed?.cents ?? 0),
      vat: Object.entries(vatBy).sort(([a], [b]) => a.localeCompare(b)).map(([taxType, v]) => ({ taxType, ...v })),
      daily: daily.map((d) => ({ date: d._id, salesCents: d.sales, fiscalizedCents: d.fiscalized, receipts: d.n, fiscalizedReceipts: d.signed, gapCents: d.sales - d.fiscalized })),
      devices,
      duplicateInvoiceNumbers: dupes.map((d) => ({ configId: d._id.c, invcNo: d._id.n, documents: d.docs })),
    },
  });
});

export const fiscalRoutes = router;
