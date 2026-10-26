/**
 * Head-office side of branch sync. Branch servers authenticate with their branch's sync token
 * (`Authorization: Sync <token>`) and can only send records that belong to their own branch.
 * Bodies are Extended JSON so ids and dates survive exactly.
 */
import crypto from 'node:crypto';
import express, { Router, type Request, type RequestHandler } from 'express';
import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { Branch, MpesaEvent, SyncTombstone, Tenant, Till, Warehouse } from '../../models/index.js';
import { AppError, badRequest, forbidden, unauthorized } from '../../lib/errors.js';
import { safeEqual, sha256 } from '../../lib/crypto.js';
import { runAsPlatform } from '../../lib/context.js';
import { afterTransferReplicated, applyRecord, EJSON, recomputeBalances, toWire } from './apply.js';
import { STOCK_REPLICA_MODELS, specFor, type BranchScope } from './spec.js';

export const SYNC_PROTOCOL = 1;

/** Short fingerprint of ENCRYPTION_KEY: branches must use the same key as HQ to read synced secrets. */
export function keyFingerprint() {
  return crypto.createHash('sha256').update(env().ENCRYPTION_KEY).digest('hex').slice(0, 16);
}

const settleMs = () => Number(process.env.SYNC_SETTLE_MS ?? 5000);

declare module 'express-serve-static-core' {
  interface Request {
    syncBranch?: BranchScope;
  }
}

const syncAuth: RequestHandler = async (req, _res, next) => {
  if (env().DEPLOYMENT_MODE !== 'hq') throw new AppError(409, 'NOT_HQ', 'This server is not a head-office server');
  const h = req.get('authorization') ?? '';
  const token = h.startsWith('Sync ') ? h.slice(5).trim() : '';
  if (!token) throw unauthorized('Sync token required');
  const hash = sha256(token);
  const b = await Branch.findOne({ syncTokenHash: hash, hasServer: true }).select('+syncTokenHash').lean();
  if (!b || !safeEqual(hash, b.syncTokenHash ?? '')) throw unauthorized('Invalid sync token');
  if (!b.active) throw forbidden('This branch is deactivated');
  const [warehouses, tills] = await Promise.all([Warehouse.find({ branchId: b._id }, { _id: 1 }).lean(), Till.find({ branchId: b._id }, { _id: 1 }).lean()]);
  req.syncBranch = { branchId: String(b._id), code: b.code, warehouseIds: new Set(warehouses.map((w) => String(w._id))), tillIds: new Set(tills.map((t) => String(t._id))) };
  await Branch.updateOne({ _id: b._id }, { $set: { 'sync.lastSeenAt': new Date() } }, { timestamps: false });
  next();
};

/** Request bodies arrive as Extended JSON already parsed by express.json(); restore ids and dates. */
const readWire = <T>(body: unknown): T => EJSON.deserialize((body ?? {}) as any, { relaxed: true }) as T;
const send = (res: express.Response, body: unknown) => res.type('application/json').send(toWire(body));

export const hqSyncRoutes = Router();
hqSyncRoutes.use(syncAuth);

/** First contact and every run: the business record, this branch, and the encryption key fingerprint. */
hqSyncRoutes.get('/hello', async (req, res) => {
  const b = req.syncBranch!;
  const business = await runAsPlatform(() => Tenant.collection.findOne({ _id: req.tenant!._id }));
  send(res, { protocol: SYNC_PROTOCOL, business, branch: { id: new Types.ObjectId(b.branchId), code: b.code }, keyFingerprint: keyFingerprint(), serverTime: new Date() });
});

/** Branch -> HQ: a page of one collection. */
hqSyncRoutes.post('/push', async (req, res) => {
  const b = req.syncBranch!;
  const body = readWire<{ collection: string; docs: any[] }>(req.body);
  const spec = specFor(body.collection);
  if (!spec || spec.dir === 'down') throw badRequest(`${body.collection} is not accepted from branches`);
  if (!Array.isArray(body.docs) || body.docs.length > 500) throw badRequest('Send 1-500 records per request');
  const tenantId = String(req.tenant!._id);
  const results: { id: string; outcome: string }[] = [];
  const parties: { type: 'customer' | 'supplier'; id: string }[] = [];
  for (const doc of body.docs) {
    if (String(doc.tenantId) !== tenantId) {
      results.push({ id: String(doc._id), outcome: 'rejected_business' });
      continue;
    }
    if (spec.owner && !spec.owner(doc, b)) {
      results.push({ id: String(doc._id), outcome: 'rejected_not_owner' });
      continue;
    }
    const r = await applyRecord(spec, doc, 'hq', b.code);
    results.push({ id: String(doc._id), outcome: r.outcome });
    if (r.outcome !== 'applied') continue;
    if (body.collection === 'stocktransfers') await afterTransferReplicated(r.previous, doc);
    if (body.collection === 'ledgerentries') parties.push({ type: doc.partyType, id: String(doc.partyId) });
    if (body.collection === 'customers') parties.push({ type: 'customer', id: String(doc._id) });
  }
  if (parties.length) await recomputeBalances(parties);
  await Branch.updateOne({ _id: b.branchId }, { $set: { 'sync.lastPushAt': new Date() } }, { timestamps: false });
  send(res, { results });
});

/** HQ -> branch: the next page of one collection after the branch's cursor. */
hqSyncRoutes.get('/pull', async (req, res) => {
  const b = req.syncBranch!;
  const collection = String(req.query.collection ?? '');
  const seed = req.query.seed === 'own';
  const spec = specFor(collection);
  const replica = STOCK_REPLICA_MODELS.find((m) => m.collection.collectionName === collection);
  if (!spec || (spec.dir === 'up' && !replica)) throw badRequest(`${collection} is not sent to branches`);
  const t = req.query.t ? new Date(String(req.query.t)) : new Date(0);
  const id = req.query.id ? new Types.ObjectId(String(req.query.id)) : null;
  const limit = Math.min(Number(req.query.limit ?? 300), 1000);
  const f = spec.field;
  const own = [...b.warehouseIds].map((x) => new Types.ObjectId(x));
  // Records younger than the settle window may still belong to an open transaction; they go next time.
  const conditions: Record<string, unknown>[] = [
    collection === 'tenants' ? { _id: req.tenant!._id } : { tenantId: req.tenant!._id },
    { [f]: { $lte: new Date(Date.now() - settleMs()) } },
    id ? { $or: [{ [f]: { $gt: t } }, { [f]: t, _id: { $gt: id } }] } : { [f]: { $gte: t } },
  ];
  if (replica) conditions.push({ warehouseId: seed ? { $in: own } : { $nin: own } });
  else if (spec.downFilter) conditions.push(spec.downFilter(b));
  const filter = { $and: conditions };
  // Branch sync token hashes never leave head office.
  const projection = collection === 'branches' ? { syncTokenHash: 0 } : undefined;
  const docs = await spec.model.collection.find(filter, { projection }).sort({ [f]: 1, _id: 1 }).limit(limit).toArray();
  const last = docs.at(-1);
  await Branch.updateOne({ _id: b.branchId }, { $set: { 'sync.lastPullAt': new Date() } }, { timestamps: false });
  send(res, { docs, next: last ? { t: last[f], id: last._id } : null, more: docs.length === limit });
});

/**
 * M-Pesa results Safaricom sent to HQ for requests a branch made (STK prompts, receipt checks, payouts):
 * HQ did not recognise them, so the branch processes them itself. Events a branch logged while processing
 * relayed results (ip "hq-relay") come back up by sync and are never relayed again.
 */
hqSyncRoutes.get('/mpesa-relay', async (req, res) => {
  const t = req.query.t ? new Date(String(req.query.t)) : new Date(Date.now() - 24 * 3600_000);
  const docs = await MpesaEvent.find({ kind: { $in: ['stk_callback', 'txn_status', 'b2c_result'] }, outcome: { $in: ['unknown_checkout_request', 'unknown_request', 'unknown_payout'] }, ip: { $ne: 'hq-relay' }, at: { $gt: t } }).sort({ at: 1 }).limit(500).lean();
  send(res, { docs: docs.map((d) => ({ kind: d.kind, payload: d.payload, at: d.at })), next: docs.at(-1)?.at ?? null });
});

/** Deletions to mirror (e.g. a removed customer price). */
hqSyncRoutes.get('/tombstones', async (req, res) => {
  const t = req.query.t ? new Date(String(req.query.t)) : new Date(0);
  const docs = await SyncTombstone.find({ at: { $gt: t, $lte: new Date(Date.now() - settleMs()) } }).sort({ at: 1 }).limit(1000).lean();
  send(res, { docs, next: docs.at(-1)?.at ?? null });
});

/** Branch health, shown at head office. */
hqSyncRoutes.post('/report', express.json(), async (req: Request, res) => {
  const b = req.syncBranch!;
  const body = req.body ?? {};
  await Branch.updateOne({ _id: b.branchId }, { $set: { 'sync.pendingUp': Number(body.pendingUp) || 0, 'sync.lastError': body.lastError ? String(body.lastError).slice(0, 300) : '', 'sync.serverVersion': String(body.version ?? '').slice(0, 40) } }, { timestamps: false });
  res.json({ ok: true });
});

/** Records a deletion of a replicated record so branches remove it too. */
export async function recordTombstone(collectionName: string, docId: Types.ObjectId | string) {
  if (env().DEPLOYMENT_MODE !== 'hq') return;
  await SyncTombstone.create({ collectionName, docId });
}

