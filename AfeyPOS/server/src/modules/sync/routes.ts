/**
 * Optional hybrid synchronisation (local installation -> cloud tenant).
 *
 * Design: the local server is the authority for its own sales and stock. Every sale is written to a
 * durable outbox in the same transaction (stable ObjectIds + idempotency key). A background job pushes
 * pending entries; the cloud ingests each key exactly once (SyncInbox unique index). Stock in the cloud
 * is updated by applying movement *deltas*, never by overwriting quantities. Anything that cannot be
 * applied (unknown product, etc.) is recorded as a conflict for review instead of being guessed.
 */
import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { Product, Sale, SyncInbox, SyncOutbox, Tenant } from '../../models/index.js';
import { parse } from '../../http/validate.js';
import { requirePermission } from '../../http/auth.js';
import { randomToken, safeEqual, sha256 } from '../../lib/crypto.js';
import { unauthorized, forbidden } from '../../lib/errors.js';
import { withTransaction } from '../../db/connection.js';
import { env } from '../../config/env.js';
import { runAsPlatform } from '../../lib/context.js';
import { registerJob } from '../../jobs/queue.js';
import { applyMovement } from '../inventory/stock.js';
import { logger } from '../../lib/logger.js';
import { audit } from '../../lib/audit.js';

const itemSchema = z.object({ idempotencyKey: z.string().min(4).max(200), entity: z.enum(['sale', 'stock_movement', 'customer_payment']), payload: z.record(z.string(), z.any()) });

export const syncIngestRoutes = Router();

syncIngestRoutes.post('/ingest', async (req, res) => {
  const tenant = req.tenant!;
  const header = req.get('authorization') ?? '';
  const token = header.startsWith('Sync ') ? header.slice(5) : '';
  const t = await runAsPlatform(() => Tenant.findById(tenant._id).lean());
  if (!t?.sync?.enabled || !t.sync.tokenHash || !token || !safeEqual(sha256(token), t.sync.tokenHash)) throw unauthorized('Invalid sync credentials');
  const { items } = parse(z.object({ items: z.array(itemSchema).min(1).max(200) }), req.body);
  const results = [];
  for (const item of items) results.push({ idempotencyKey: item.idempotencyKey, ...(await ingestOne(item)) });
  res.json({ data: results });
});

async function ingestOne(item: z.infer<typeof itemSchema>): Promise<{ outcome: 'applied' | 'duplicate' | 'conflict'; message?: string }> {
  if (await SyncInbox.exists({ idempotencyKey: item.idempotencyKey })) return { outcome: 'duplicate' };
  try {
    return await withTransaction(async () => {
      if (item.entity !== 'sale') {
        await SyncInbox.create([{ idempotencyKey: item.idempotencyKey, entity: item.entity, outcome: 'conflict', message: 'Entity type not yet supported for ingest' }]);
        return { outcome: 'conflict' as const, message: 'unsupported entity' };
      }
      const p = item.payload as any;
      if (await Sale.exists({ $or: [{ _id: p._id }, { clientRequestId: p.clientRequestId }] })) {
        await SyncInbox.create([{ idempotencyKey: item.idempotencyKey, entity: 'sale', outcome: 'duplicate' }]);
        return { outcome: 'duplicate' as const };
      }
      const productIds = (p.lines ?? []).map((l: any) => l.productId);
      const known = await Product.countDocuments({ _id: { $in: productIds } });
      if (known !== new Set(productIds.map(String)).size) {
        await SyncInbox.create([{ idempotencyKey: item.idempotencyKey, entity: 'sale', outcome: 'conflict', message: 'Sale references products unknown to the cloud' }]);
        return { outcome: 'conflict' as const, message: 'unknown products' };
      }
      const { tenantId: _t, __v, createdAt: _c, updatedAt: _u, ...rest } = p;
      const [sale] = await Sale.create([{ ...rest, _id: new Types.ObjectId(p._id), source: 'sync', sourceRef: item.idempotencyKey }]);
      for (const l of sale.lines) {
        // Mirror stock: apply the delta; the local server already enforced availability.
        await applyMovement({ productId: l.productId, warehouseId: sale.warehouseId, qty: -(l.baseQty ?? 0), type: 'sync', ref: { type: 'Sale', id: sale._id, number: sale.number }, serials: l.serials ?? undefined, allowNegative: true, reason: 'Synced from local installation' });
      }
      await SyncInbox.create([{ idempotencyKey: item.idempotencyKey, entity: 'sale', outcome: 'applied' }]);
      return { outcome: 'applied' as const };
    });
  } catch (err: any) {
    if (err?.code === 11000) return { outcome: 'duplicate' };
    logger.warn({ err: err?.message, key: item.idempotencyKey }, 'sync ingest conflict');
    try {
      await SyncInbox.create({ idempotencyKey: item.idempotencyKey, entity: item.entity, outcome: 'conflict', message: String(err?.message).slice(0, 300) });
    } catch {
      /* already recorded */
    }
    return { outcome: 'conflict', message: err?.message };
  }
}

/** Tenant settings: enable sync and issue a sync token (shown once). Cloud side. */
export const syncSettingsRoutes = Router();
syncSettingsRoutes.post('/settings/sync/token', requirePermission('settings.manage'), async (req, res) => {
  if (!req.auth!.roles.includes('tenant_owner')) throw forbidden('Only the owner can issue sync credentials');
  const token = randomToken(32);
  await runAsPlatform(() => Tenant.updateOne({ _id: req.tenant!._id }, { $set: { 'sync.tokenHash': sha256(token), 'sync.enabled': true } }));
  await audit(req, { action: 'sync.token_issued' });
  res.json({ data: { token, ingestUrl: `${env().API_PUBLIC_URL.replace(/\/$/, '')}/api/v1/sync/ingest` } });
});
syncSettingsRoutes.get('/settings/sync/status', requirePermission('settings.manage'), async (_req, res) => {
  const counts = await SyncOutbox.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]);
  const inbox = await SyncInbox.aggregate([{ $group: { _id: '$outcome', n: { $sum: 1 } } }]);
  const conflicts = await SyncOutbox.find({ status: { $in: ['conflict', 'failed'] } }).sort({ updatedAt: -1 }).limit(50).lean();
  res.json({ data: { enabled: env().SYNC_ENABLED, outbox: counts, inbox, conflicts } });
});

/** Local side: pushes pending outbox entries. Network errors leave entries pending for the next run. */
registerJob('sync.push', async () => {
  const e = env();
  if (!e.SYNC_ENABLED || !e.SYNC_CLOUD_URL || !e.SYNC_TOKEN) return;
  const pending = await SyncOutbox.find({ status: { $in: ['pending', 'failed'] }, attempts: { $lt: 20 } }).sort({ createdAt: 1 }).limit(100);
  if (!pending.length) return;
  let resp: Response;
  try {
    resp = await fetch(`${e.SYNC_CLOUD_URL.replace(/\/$/, '')}/api/v1/sync/ingest`, {
      method: 'POST',
      headers: { Authorization: `Sync ${e.SYNC_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: pending.map((p) => ({ idempotencyKey: p.idempotencyKey, entity: p.entity, payload: p.payload })) }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err: any) {
    await SyncOutbox.updateMany({ _id: { $in: pending.map((p) => p._id) } }, { $inc: { attempts: 1 }, $set: { lastError: `offline: ${err?.message}` } });
    return;
  }
  if (!resp.ok) {
    await SyncOutbox.updateMany({ _id: { $in: pending.map((p) => p._id) } }, { $inc: { attempts: 1 }, $set: { status: 'failed', lastError: `HTTP ${resp.status}` } });
    return;
  }
  const { data } = (await resp.json()) as { data: { idempotencyKey: string; outcome: string; message?: string }[] };
  for (const r of data) {
    await SyncOutbox.updateOne({ idempotencyKey: r.idempotencyKey }, { $set: { status: r.outcome === 'conflict' ? 'conflict' : 'sent', sentAt: new Date(), lastError: r.message }, $inc: { attempts: 1 } });
  }
});

export { ingestOne };
