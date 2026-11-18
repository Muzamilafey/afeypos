/**
 * Fiscal device runtime: the per-device lease (one worker talks to a device at a time, however many tills share
 * it), the transaction log, and device health.
 */
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { FiscalDeviceState, FiscalTransaction, IntegrationConfig } from '../../models/index.js';
import { auditOrigin } from '../../lib/audit.js';
import { IntegrationError } from '../../integrations/http.js';
import { sanitizeForLog } from '../../integrations/fiscal/adapter.js';
import { fiscalKind } from './adapters.js';

type Cfg = InstanceType<typeof IntegrationConfig>;

const HOLDER = `${process.pid}:${randomUUID().slice(0, 8)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ensureState(configId: Types.ObjectId) {
  const origin = auditOrigin();
  try {
    await FiscalDeviceState.updateOne({ configId, origin }, { $setOnInsert: { state: 'unknown' } }, { upsert: true });
  } catch (err: any) {
    if (err?.code !== 11000) throw err;
  }
  return origin;
}

/**
 * Runs fn while holding this device's lease. Another worker (another till's job, another process) waits up to
 * waitMs, then the job is retried later. The lease expires on its own if a process dies holding it.
 */
export async function withDeviceLock<T>(configId: Types.ObjectId, leaseMs: number, fn: () => Promise<T>, waitMs = 15_000): Promise<T> {
  const origin = await ensureState(configId);
  const token = `${HOLDER}:${randomUUID().slice(0, 8)}`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const now = new Date();
    const got = await FiscalDeviceState.findOneAndUpdate(
      { configId, origin, $or: [{ lockUntil: null }, { lockUntil: { $lt: now } }] },
      { $set: { lockUntil: new Date(now.getTime() + leaseMs), lockHolder: token } },
      { new: true },
    );
    if (got) break;
    if (Date.now() > deadline) throw new IntegrationError('The fiscal device is busy with another till\'s invoice; this one follows', 423);
    await sleep(150);
  }
  try {
    return await fn();
  } finally {
    await FiscalDeviceState.updateOne({ configId, origin, lockHolder: token }, { $unset: { lockUntil: 1, lockHolder: 1 } });
  }
}

export interface FiscalLogInput {
  cfg: Cfg;
  operation: 'invoice' | 'credit_note' | 'status_query' | 'reconcile' | 'test' | 'health';
  doc?: { kind: 'sale' | 'return'; id: unknown; number?: string; invcNo?: number | null; branchId?: unknown; attempt?: number };
  outcome?: string;
  ok: boolean;
  error?: string;
  request?: unknown;
  response?: unknown;
  durationMs?: number;
  userId?: unknown;
  note?: string;
}

export async function logFiscal(i: FiscalLogInput) {
  await FiscalTransaction.create({
    configId: i.cfg._id, deviceName: i.cfg.name, deviceKind: fiscalKind(i.cfg), origin: auditOrigin(), branchId: i.doc?.branchId ?? undefined,
    operation: i.operation, docKind: i.doc?.kind, docId: i.doc?.id, docNumber: i.doc?.number, invcNo: i.doc?.invcNo ?? undefined, attempt: i.doc?.attempt,
    outcome: i.outcome, ok: i.ok, error: i.error?.slice(0, 500), request: sanitizeForLog(i.request), response: sanitizeForLog(i.response), durationMs: i.durationMs,
    userId: i.userId ?? undefined, note: i.note?.slice(0, 500),
  });
}

/**
 * Records what was just seen of a device (a submission, a status check, a health poll). Going offline opens an
 * outage, coming back closes it; returns whether it just came back (so waiting invoices can go at once).
 */
export async function recordHealth(configId: Types.ObjectId, ok: boolean, message: string, state: 'online' | 'offline' | 'unknown' = ok ? 'online' : 'offline') {
  const origin = await ensureState(configId);
  const now = new Date();
  const prev = await FiscalDeviceState.findOne({ configId, origin }).lean();
  if (state === 'unknown') {
    await FiscalDeviceState.updateOne({ configId, origin }, { $set: { lastCheckAt: now, message } });
    return false;
  }
  if (ok) {
    const outages: { from: Date; to: Date }[] = (prev?.outages ?? []).map((o: any) => ({ from: o.from, to: o.to }));
    if (prev?.downSince) outages.push({ from: prev.downSince, to: now });
    await FiscalDeviceState.updateOne({ configId, origin }, { $set: { state: 'online', message, lastCheckAt: now, lastSuccessAt: now, consecutiveFailures: 0, outages: outages.slice(-100) }, $unset: { downSince: 1 } });
    return prev?.state === 'offline';
  }
  await FiscalDeviceState.updateOne({ configId, origin }, {
    $set: { state: 'offline', message, lastCheckAt: now, lastFailureAt: now, lastError: message.slice(0, 300), ...(prev?.downSince ? {} : { downSince: now }) },
    $inc: { consecutiveFailures: 1 },
  });
  return false;
}
