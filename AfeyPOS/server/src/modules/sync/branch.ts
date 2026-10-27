/**
 * Branch server side of sync. Runs every SYNC_INTERVAL_SECONDS while online (and on demand):
 *
 *  1. hello: check the HQ address, branch code and encryption key; on first contact store the business record.
 *  2. seed: once, download this branch's own stock as it was at HQ when the branch got its server.
 *  3. push: send everything this branch changed since the last push, collection by collection.
 *  4. pull: download what HQ changed since the last pull, newest wins.
 *  5. tombstones: delete records HQ deleted. 6. report: pending count and last error for the HQ dashboard.
 *
 * Every step resumes from a stored cursor, so an interrupted run or a week offline simply continues later.
 */
import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { PaymentIntent, SyncCursor, Tenant } from '../../models/index.js';
import { runInTenant, runAsPlatform } from '../../lib/context.js';
import { logger } from '../../lib/logger.js';
import { invalidateOwnership } from './ownership.js';
import { afterTransferReplicated, applyRecord, fromWire, mergePartyBalance, toWire } from './apply.js';
import { STOCK_REPLICA_MODELS, downSpecs, specFor, upSpecs, type SyncSpec } from './spec.js';
import { keyFingerprint, SYNC_PROTOCOL } from './hq.js';

const PAGE = 200;
const settleMs = () => Number(process.env.SYNC_SETTLE_MS ?? 5000);

export interface SyncRunReport {
  startedAt: Date;
  finishedAt?: Date;
  ok: boolean;
  pushed: Record<string, number>;
  pulled: Record<string, number>;
  error?: string;
}

const state: { running: boolean; last?: SyncRunReport; lastSuccessAt?: Date; online: boolean } = { running: false, online: false };
export const syncState = () => ({ ...state });

function hqUrl() {
  const e = env();
  return (e.SYNC_HQ_URL || e.SYNC_CLOUD_URL || '').replace(/\/$/, '');
}

async function hq<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${hqUrl()}/api/v1/sync${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Sync ${env().SYNC_TOKEN}`, Accept: 'application/json', ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: init.body !== undefined ? toWire(init.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = `HQ answered ${res.status}`;
    try {
      msg = JSON.parse(text)?.error?.message ?? msg;
    } catch {
      /* not JSON */
    }
    throw new Error(msg);
  }
  return fromWire<T>(text);
}

/**
 * Takes a Paybill/Till payment that head office received without a branch (one M-Pesa for all branches) for
 * this branch, and stores HQ's copy here. HQ hands each payment to one branch only, so it cannot be used twice.
 */
export async function claimMpesaFromHq(receipt: string): Promise<{ claimed: boolean; reason?: string }> {
  const r = await hq<{ doc: any; reason?: string }>('/mpesa-claim', { method: 'POST', body: { receipt } });
  if (!r.doc) return { claimed: false, reason: r.reason };
  await applyRecord(specFor('paymentintents')!, r.doc, 'branch', env().BRANCH_CODE);
  return { claimed: true };
}

async function cursor(key: string) {
  return (await SyncCursor.findOne({ key }).lean()) ?? { key, t: new Date(0), id: null as Types.ObjectId | null };
}
async function saveCursor(key: string, t: Date, id: Types.ObjectId | null) {
  await SyncCursor.updateOne({ key }, { $set: { t, id, updatedAt: new Date() } }, { upsert: true });
}

async function push(spec: SyncSpec, tenantId: Types.ObjectId, report: SyncRunReport) {
  const name = spec.model.collection.collectionName;
  const key = `up:${name}`;
  const f = spec.field;
  for (;;) {
    const c = await cursor(key);
    const docs = await spec.model.collection
      .find({ $and: [{ tenantId }, { [f]: { $lte: new Date(Date.now() - settleMs()) } }, c.id ? { $or: [{ [f]: { $gt: c.t } }, { [f]: c.t, _id: { $gt: c.id } }] } : { [f]: { $gte: c.t } }] })
      .sort({ [f]: 1, _id: 1 })
      .limit(PAGE)
      .toArray();
    if (!docs.length) return;
    const r = await hq<{ results: { id: string; outcome: string }[] }>('/push', { method: 'POST', body: { collection: name, docs } });
    logger.debug({ collection: name, sent: docs.length }, 'sync push page');
    const rejected = r.results.filter((x) => x.outcome.startsWith('rejected'));
    if (rejected.length) logger.warn({ collection: name, rejected: rejected.length }, 'HQ rejected records from this branch');
    report.pushed[name] = (report.pushed[name] ?? 0) + docs.length;
    const last = docs.at(-1)!;
    await saveCursor(key, last[f], last._id);
    if (docs.length < PAGE) return;
  }
}

async function pull(spec: SyncSpec, report: SyncRunReport, opts: { key?: string; seed?: boolean } = {}) {
  const name = spec.model.collection.collectionName;
  const key = opts.key ?? `down:${name}${spec.cursorVersion ? `:v${spec.cursorVersion}` : ''}`;
  for (;;) {
    const c = await cursor(key);
    const q = new URLSearchParams({ collection: name, t: c.t.toISOString(), limit: String(PAGE * 2), ...(c.id ? { id: String(c.id) } : {}), ...(opts.seed ? { seed: 'own' } : {}) });
    const page = await hq<{ docs: any[]; next: { t: Date; id: Types.ObjectId } | null; more: boolean }>(`/pull?${q}`);
    logger.debug({ collection: name, key, received: page.docs.length, more: page.more }, 'sync pull page');
    const ledgerSent = (await cursor('up:ledgerentries')).t;
    for (let doc of page.docs) {
      if (name === 'customers' || name === 'suppliers') {
        const prev = await spec.model.collection.findOne({ _id: doc._id });
        doc = await mergePartyBalance(name, doc, prev, ledgerSent);
      }
      const r = await applyRecord(spec, doc, 'branch', env().BRANCH_CODE);
      if (r.outcome === 'applied' && name === 'stocktransfers') await afterTransferReplicated(r.previous, doc);
    }
    report.pulled[name] = (report.pulled[name] ?? 0) + page.docs.length;
    if (page.next) await saveCursor(key, page.next.t, page.next.id);
    if (!page.more) return;
  }
}

async function tombstones() {
  const c = await cursor('down:tombstones');
  const r = await hq<{ docs: { collectionName: string; docId: Types.ObjectId; at: Date }[]; next: Date | null }>(`/tombstones?t=${c.t.toISOString()}`);
  for (const t of r.docs) {
    const spec = specFor(t.collectionName);
    if (spec) await spec.model.collection.deleteOne({ _id: t.docId });
  }
  if (r.next) await saveCursor('down:tombstones', r.next, null);
}

/** M-Pesa callbacks for this branch's requests arrive at HQ (public address) and are processed here. */
async function mpesaRelay(tenantId: Types.ObjectId) {
  const c = await cursor('down:mpesa-relay');
  const since = c.t.getTime() > 0 ? c.t : new Date(Date.now() - 24 * 3600_000);
  const r = await hq<{ docs: { kind: string; payload: any; at: Date }[]; next: Date | null }>(`/mpesa-relay?t=${since.toISOString()}`);
  const { handleStkCallback, handleStatusResult } = await import('../payments/mpesa.js');
  const { handleB2CResult } = await import('../payments/payouts.js');
  for (const ev of r.docs) {
    if (ev.kind === 'stk_callback') await handleStkCallback(tenantId, ev.payload, 'hq-relay');
    else if (ev.kind === 'txn_status') await handleStatusResult(tenantId, ev.payload, 'hq-relay');
    else if (ev.kind === 'b2c_result') await handleB2CResult(tenantId, ev.payload, 'hq-relay');
  }
  if (r.next) await saveCursor('down:mpesa-relay', r.next, null);
}

async function pendingUp(tenantId: Types.ObjectId) {
  let n = 0;
  for (const spec of upSpecs()) {
    const c = await cursor(`up:${spec.model.collection.collectionName}`);
    n += await spec.model.collection.countDocuments({ tenantId, [spec.field]: { $gt: c.t } });
  }
  return n;
}

let current: Promise<SyncRunReport> | null = null;

/** One full sync round. A call while a round is running waits for that round instead of starting another. */
export function syncOnce(): Promise<SyncRunReport> {
  current ??= runRound().finally(() => {
    current = null;
  });
  return current;
}

async function runRound(): Promise<SyncRunReport> {
  const e = env();
  if (e.DEPLOYMENT_MODE !== 'branch') throw new Error('Only branch servers sync with head office');
  if (!hqUrl() || !e.SYNC_TOKEN) throw new Error('Set SYNC_HQ_URL and SYNC_TOKEN in server/.env');
  state.running = true;
  const report: SyncRunReport = { startedAt: new Date(), ok: false, pushed: {}, pulled: {} };
  try {
    const hello = await hq<{ protocol: number; business: any; branch: { id: Types.ObjectId; code: string }; keyFingerprint: string }>('/hello');
    state.online = true;
    if (hello.protocol !== SYNC_PROTOCOL) throw new Error(`HQ uses sync protocol ${hello.protocol}; update this server`);
    if (hello.keyFingerprint !== keyFingerprint()) throw new Error('ENCRYPTION_KEY differs from head office; copy HQ’s ENCRYPTION_KEY into this server’s .env');
    if (e.BRANCH_CODE && hello.branch.code.toUpperCase() !== e.BRANCH_CODE.toUpperCase()) throw new Error(`This sync token belongs to branch ${hello.branch.code}, but BRANCH_CODE is ${e.BRANCH_CODE}`);
    const local = await runAsPlatform(() => Tenant.collection.findOne({}));
    if (local && String(local._id) !== String(hello.business._id)) throw new Error('This server holds a different business; use an empty database for a branch server');
    if (!local) await runAsPlatform(() => Tenant.collection.insertOne(hello.business));
    const tenantId = hello.business._id as Types.ObjectId;
    await runInTenant(tenantId, async () => {
      for (const spec of downSpecs().filter((s) => s.dir === 'down')) await pull(spec, report);
      invalidateOwnership();
      const seeded = await SyncCursor.exists({ key: 'seed:own-stock' });
      if (!seeded) {
        for (const m of STOCK_REPLICA_MODELS) await pull(specFor(m.collection.collectionName)!, report, { key: `seed:${m.collection.collectionName}`, seed: true });
        await saveCursor('seed:own-stock', new Date(), null);
      }
      for (const spec of upSpecs()) await push(spec, tenantId, report);
      for (const spec of downSpecs().filter((s) => s.dir === 'both')) await pull(spec, report);
      for (const m of STOCK_REPLICA_MODELS) await pull(specFor(m.collection.collectionName)!, report, { key: `replica:${m.collection.collectionName}` });
      await tombstones();
      await mpesaRelay(tenantId);
      await hq('/report', { method: 'POST', body: { pendingUp: await pendingUp(tenantId), lastError: '', version: process.env.npm_package_version ?? '' } }).catch(() => undefined);
    });
    report.ok = true;
    state.lastSuccessAt = new Date();
  } catch (err: any) {
    const cause = err?.cause ? ` ${err.cause.code ?? ''} ${err.cause.message ?? ''}`.trimEnd() : '';
    report.error = /fetch failed|timeout|ECONN|ENOTFOUND|EAI_AGAIN/i.test(`${err?.message}${cause}`) ? `Head office unreachable at ${hqUrl()} (${err?.message}${cause})` : String(err?.message ?? err);
    if (/unreachable/.test(report.error)) state.online = false;
    logger.warn({ err: report.error }, 'branch sync failed');
  } finally {
    report.finishedAt = new Date();
    state.last = report;
    state.running = false;
  }
  return report;
}

export async function resetCursors(scope: 'all' | 'up' | 'down') {
  const filter = scope === 'all' ? {} : { key: new RegExp(`^${scope}:`) };
  await SyncCursor.deleteMany(filter);
}

let timer: NodeJS.Timeout | null = null;
export function startBranchSync() {
  const e = env();
  if (e.DEPLOYMENT_MODE !== 'branch' || !e.SYNC_ENABLED || timer) return;
  const every = Math.max(5, Number(process.env.SYNC_INTERVAL_SECONDS ?? 20)) * 1000;
  const tick = () => void syncOnce().catch(() => undefined);
  setTimeout(tick, 2000);
  timer = setInterval(tick, every);
  // While a till waits for an M-Pesa payment (Paybill/Till or a prompt), sync every few seconds: Safaricom
  // confirms at head office, and the till should see it quickly. Ends by itself when nothing is waiting.
  fastTimer = setInterval(() => {
    if (current) return;
    void PaymentIntent.collection.countDocuments({ status: 'pending', source: { $in: ['c2b', 'stk'] } }, { limit: 1 })
      .then((n) => (n ? syncOnce() : undefined))
      .catch(() => undefined);
  }, 5000);
}
let fastTimer: NodeJS.Timeout | null = null;
export function stopBranchSync() {
  if (timer) clearInterval(timer);
  if (fastTimer) clearInterval(fastTimer);
  timer = null;
  fastTimer = null;
}
