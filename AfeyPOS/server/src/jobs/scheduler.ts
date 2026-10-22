import { Types } from 'mongoose';
import { env } from '../config/env.js';
import { PaymentIntent, Tenant } from '../models/index.js';
import { enqueue, registerJob } from './queue.js';
import { runAsPlatform, runInTenant } from '../lib/context.js';
import { logger } from '../lib/logger.js';
import { createBackup, pruneBackups } from '../modules/backups/service.js';
import './tenantTasks.js';

/** Enqueues recurring maintenance jobs. dedupeKeys make this safe with several server processes. */
export async function scheduleRecurring(now = new Date()) {
  const e = env();
  const minute = now.toISOString().slice(0, 16);
  await enqueue('mpesa.sweep', {}, { tenantId: null, dedupeKey: `mpesa.sweep:${minute.slice(0, 15)}` });
  await enqueue('tenants.dailyTasks', {}, { tenantId: null, dedupeKey: `daily-tasks:${minute.slice(0, 13)}` });
  if (e.SYNC_ENABLED && e.DEPLOYMENT_MODE === 'local') {
    const tenant = await Tenant.findOne().sort({ createdAt: 1 }).lean();
    if (tenant) await enqueue('sync.push', {}, { tenantId: tenant._id, dedupeKey: `sync.push:${minute}` });
  }
  if (e.DEPLOYMENT_MODE === 'cloud') await enqueue('tenants.billingCheck', {}, { tenantId: null, dedupeKey: `billing:${minute.slice(0, 13)}` });
  if (e.DEPLOYMENT_MODE === 'local' && e.BACKUP_INTERVAL_HOURS > 0) {
    const bucket = Math.floor(now.getTime() / (e.BACKUP_INTERVAL_HOURS * 3600_000));
    await enqueue('backup.scheduled', {}, { tenantId: null, dedupeKey: `backup:${bucket}`, maxAttempts: 3 });
  }
}

registerJob('mpesa.sweep', async () => {
  // Safety net for intents whose check jobs were lost: re-enqueue a final status check.
  // Link (hosted checkout) intents get longer; their own final check expires them.
  const stale = await PaymentIntent.find({ status: 'pending', createdAt: { $lt: new Date(Date.now() - 15 * 60_000) }, $or: [{ source: { $ne: 'link' } }, { createdAt: { $lt: new Date(Date.now() - 24 * 3600_000) } }] }, { _id: 1, tenantId: 1, provider: 1 }).limit(200).lean();
  for (const i of stale) {
    const job = (i.provider ?? 'mpesa') === 'mpesa' ? 'mpesa.checkIntent' : 'payments.checkIntent';
    await runInTenant(i.tenantId as Types.ObjectId, () => enqueue(job, { intentId: String(i._id), final: true }, { dedupeKey: `${job}:${i._id}:sweep` }));
  }
});

registerJob('tenants.billingCheck', async () => {
  const now = new Date();
  const trialExpired = await Tenant.updateMany({ status: 'trial', trialEndsAt: { $lt: now } }, { $set: { status: 'past_due' } });
  const grace = new Date(now.getTime() - 7 * 86400_000);
  const overdue = await Tenant.updateMany(
    { status: 'past_due', $or: [{ currentPeriodEnd: { $lt: grace } }, { currentPeriodEnd: null, trialEndsAt: { $lt: grace } }] },
    { $set: { status: 'suspended', suspendedReason: 'Subscription overdue' } },
  );
  const renewed = await Tenant.updateMany({ status: 'past_due', currentPeriodEnd: { $gt: now } }, { $set: { status: 'active' } });
  if (trialExpired.modifiedCount || overdue.modifiedCount) logger.info({ trialExpired: trialExpired.modifiedCount, suspended: overdue.modifiedCount, renewed: renewed.modifiedCount }, 'billing check');
});

registerJob('backup.scheduled', async () => {
  await createBackup({ scope: 'full', trigger: 'scheduled' });
  await pruneBackups();
});

let timer: NodeJS.Timeout | null = null;
export function startScheduler() {
  const tick = () => runAsPlatform(() => scheduleRecurring()).catch((err) => logger.error({ err }, 'scheduler error'));
  tick();
  timer = setInterval(tick, 60_000);
  timer.unref();
}
export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
