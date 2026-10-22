import { Types } from 'mongoose';
import { Job } from '../models/index.js';
import { currentContext, runAsPlatform, runInTenant } from '../lib/context.js';
import { logger } from '../lib/logger.js';

export type JobHandler = (payload: any, job: { id: Types.ObjectId; attempts: number; tenantId?: Types.ObjectId }) => Promise<void>;

const handlers = new Map<string, JobHandler>();

export function registerJob(type: string, handler: JobHandler) {
  handlers.set(type, handler);
}

export interface EnqueueOptions {
  runAt?: Date;
  dedupeKey?: string;
  maxAttempts?: number;
  /** Defaults to the tenant in the current context. Pass null for platform jobs. */
  tenantId?: Types.ObjectId | null;
}

/**
 * Enqueues a durable job. When called inside a transaction the job is committed atomically with
 * the business change (outbox pattern). Duplicate dedupeKeys are ignored.
 */
export async function enqueue(type: string, payload: unknown, opts: EnqueueOptions = {}): Promise<void> {
  const tenantId = opts.tenantId === null ? undefined : (opts.tenantId ?? currentContext()?.tenantId);
  try {
    await Job.create({ type, payload, tenantId, runAt: opts.runAt ?? new Date(), dedupeKey: opts.dedupeKey, maxAttempts: opts.maxAttempts ?? 5 });
  } catch (err: any) {
    if (err?.code === 11000) return;
    throw err;
  }
}

const LOCK_MS = 60_000;

/** Claims and runs one due job. Returns false when the queue is empty. */
export async function runNextJob(now = new Date()): Promise<boolean> {
  const job = await Job.findOneAndUpdate(
    {
      $or: [
        { status: 'queued', runAt: { $lte: now } },
        { status: 'running', lockedUntil: { $lt: now } },
      ],
    },
    { $set: { status: 'running', lockedUntil: new Date(now.getTime() + LOCK_MS) }, $inc: { attempts: 1 } },
    { sort: { runAt: 1 }, new: true },
  );
  if (!job) return false;
  const handler = handlers.get(job.type);
  try {
    if (!handler) throw new Error(`No handler registered for job type ${job.type}`);
    const exec = () => handler(job.payload, { id: job._id, attempts: job.attempts, tenantId: job.tenantId ?? undefined });
    await (job.tenantId ? runInTenant(job.tenantId, exec) : runAsPlatform(exec));
    await Job.updateOne({ _id: job._id }, { $set: { status: 'completed', completedAt: new Date(), lastError: null }, $unset: { lockedUntil: 1 } });
  } catch (err: any) {
    const dead = job.attempts >= job.maxAttempts;
    const backoffMs = Math.min(30 * 60_000, 2 ** job.attempts * 5_000);
    logger.warn({ err: err?.message, type: job.type, attempts: job.attempts, dead }, 'job failed');
    await Job.updateOne(
      { _id: job._id },
      { $set: { status: dead ? 'dead' : 'queued', lastError: String(err?.message ?? err).slice(0, 2000), runAt: new Date(Date.now() + backoffMs) }, $unset: { lockedUntil: 1 } },
    );
  }
  return true;
}

/** Drains due jobs (used by tests and the worker loop). */
export async function drainJobs(max = 100): Promise<number> {
  let n = 0;
  while (n < max && (await runNextJob())) n++;
  return n;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startWorker(intervalMs = 1000) {
  if (timer) return;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await drainJobs(50);
    } catch (err) {
      logger.error({ err }, 'job worker error');
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
}

export function stopWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}
