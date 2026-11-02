import { Types } from 'mongoose';
import { SCALE_ADAPTERS, pluListHash, type PluItem, type ScaleAdapterKey } from '@afeypos/shared';
import { Product, ScaleSyncJob, WeighingScale } from '../../models/index.js';
import { enqueue, registerJob } from '../../jobs/queue.js';
import { logger } from '../../lib/logger.js';

type ScaleDoc = InstanceType<typeof WeighingScale>;

export interface SendResult { confirmed: boolean; message: string }

/**
 * Adapters that can send a PLU list straight to a scale and get an acknowledgement back. Only the simulator does
 * this today: no manufacturer's PLU protocol is implemented, so real label scales use the file export instead.
 */
const DIRECT_SENDERS: Partial<Record<ScaleAdapterKey, (scale: ScaleDoc, items: PluItem[], attempt: number) => Promise<SendResult>>> = {
  simulator: async (scale, items, attempt) => {
    const failures = scale.settings?.simulateFailures ?? 0;
    if (attempt <= failures) throw new Error(`Simulated send failure ${attempt} of ${failures}`);
    return { confirmed: true, message: `Simulator accepted ${items.length} PLUs` };
  },
};

export const canSendDirect = (adapter: string) => Boolean(DIRECT_SENDERS[adapter as ScaleAdapterKey]);

/** The PLU list a label scale should hold now: weighed or counted products with a PLU and a price. */
export async function pluItemsFor(scale: ScaleDoc): Promise<PluItem[]> {
  const filter: Record<string, unknown> = { active: true, plu: { $type: 'string' } };
  if (scale.settings?.syncAll === false) filter.scaleIds = scale._id;
  const rows = await Product.find(filter, { name: 1, plu: 1, prices: 1, branchPrices: 1, soldByWeight: 1, baseUnit: 1 }).sort({ plu: 1 }).limit(5000).lean();
  return rows
    .map((p) => {
      const branch = (p.branchPrices ?? []).find((b) => String(b.branchId) === String(scale.branchId));
      const price = typeof branch?.retail === 'number' ? branch.retail : p.prices?.retail ?? 0;
      const weighed = p.soldByWeight || p.baseUnit === 'kg';
      return { plu: p.plu!, name: p.name, priceCents: price, unit: weighed ? 'kg' : 'pc', productId: String(p._id) } as PluItem;
    })
    .filter((i) => i.priceCents > 0);
}

/** Starts a PLU send. Earlier unfinished jobs for the scale are superseded so only the newest list is pending. */
export async function createSyncJob(scale: ScaleDoc, userId?: Types.ObjectId) {
  const items = await pluItemsFor(scale);
  const hash = pluListHash(items);
  await ScaleSyncJob.updateMany({ scaleId: scale._id, status: { $in: ['queued', 'sending', 'awaiting_import', 'failed'] } }, { $set: { status: 'superseded' }, $push: { log: { at: new Date(), message: 'Replaced by a newer send' } } });
  const last = await ScaleSyncJob.findOne({ scaleId: scale._id }).sort({ version: -1 }).lean();
  const direct = canSendDirect(scale.adapter);
  const job = await ScaleSyncJob.create({
    scaleId: scale._id, branchId: scale.branchId, version: (last?.version ?? 0) + 1, hash,
    items: items.map((i) => ({ ...i, productId: i.productId ? new Types.ObjectId(i.productId) : undefined })),
    status: direct ? 'queued' : 'awaiting_import', createdBy: userId,
    log: [{ at: new Date(), message: direct ? `Queued ${items.length} PLUs` : `${items.length} PLUs ready: download the file, import it with the scale's software, then confirm` }],
  });
  if (direct) await enqueue('scales.send', { jobId: String(job._id) }, { dedupeKey: `scales.send:${job._id}`, maxAttempts: job.maxAttempts });
  return job;
}

/** Marks the scale's PLU list as current after a confirmed send or import. */
async function markConfirmed(jobId: Types.ObjectId, how: 'device' | 'manual', userId?: Types.ObjectId) {
  const job = await ScaleSyncJob.findOneAndUpdate({ _id: jobId, status: { $in: ['sending', 'awaiting_import', 'queued', 'failed'] } }, {
    $set: { status: 'succeeded', confirmation: how, confirmedAt: new Date(), confirmedBy: userId, error: undefined },
    $push: { log: { at: new Date(), message: how === 'device' ? 'Scale confirmed the PLU list' : 'Import confirmed by a person' } },
  }, { new: true });
  if (!job) return null;
  const scale = await WeighingScale.findById(job.scaleId);
  if (scale) {
    scale.plu = { version: job.version, hash: job.hash, count: job.items.length, confirmedAt: new Date() };
    // A label scale counts as verified once a PLU list is confirmed on it.
    if (scale.role !== 'counter' && scale.status !== 'disabled') scale.status = 'verified';
    await scale.save();
  }
  return job;
}

export const confirmManualImport = (jobId: Types.ObjectId, userId: Types.ObjectId) => markConfirmed(jobId, 'manual', userId);

registerJob('scales.send', async (payload: { jobId: string }, ctx) => {
  const job = await ScaleSyncJob.findById(payload.jobId);
  if (!job || !['queued', 'sending', 'failed'].includes(job.status)) return;
  const scale = await WeighingScale.findById(job.scaleId);
  const sender = scale && DIRECT_SENDERS[scale.adapter as ScaleAdapterKey];
  if (!scale || !sender || !scale.active) {
    await ScaleSyncJob.updateOne({ _id: job._id }, { $set: { status: 'failed', error: 'Scale removed or cannot receive PLUs directly' } });
    return;
  }
  job.status = 'sending';
  job.attempts = ctx.attempts;
  await job.save();
  try {
    const r = await sender(scale, job.items.map((i) => ({ plu: i.plu!, name: i.name!, priceCents: i.priceCents!, unit: i.unit as 'kg' | 'pc' })), ctx.attempts);
    if (!r.confirmed) throw new Error(r.message || 'The scale did not confirm the PLU list');
    await ScaleSyncJob.updateOne({ _id: job._id }, { $push: { log: { at: new Date(), message: r.message } } });
    await markConfirmed(job._id, 'device');
  } catch (err) {
    const message = (err as Error).message;
    const dead = ctx.attempts >= job.maxAttempts;
    await ScaleSyncJob.updateOne({ _id: job._id }, {
      $set: { status: dead ? 'failed' : 'queued', error: message, nextAttemptAt: dead ? undefined : new Date(Date.now() + Math.min(30 * 60_000, 2 ** ctx.attempts * 5_000)) },
      $push: { log: { at: new Date(), message: `Attempt ${ctx.attempts} failed: ${message}${dead ? ' (giving up; press Retry)' : ''}` } },
    });
    logger.warn({ jobId: String(job._id), attempts: ctx.attempts }, 'scale PLU send failed');
    if (!dead) throw err;
  }
});

/** Whether a scale's PLU list differs from what the catalogue says it should hold now. */
export async function pluStatus(scale: ScaleDoc) {
  if (scale.role === 'counter') return { applies: false as const };
  const items = await pluItemsFor(scale);
  const hash = pluListHash(items);
  return { applies: true as const, count: items.length, upToDate: scale.plu?.hash === hash, confirmedVersion: scale.plu?.version ?? 0, confirmedAt: scale.plu?.confirmedAt ?? null };
}

export const adapterInfo = (key: string) => SCALE_ADAPTERS[key as ScaleAdapterKey];
