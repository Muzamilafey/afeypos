import mongoose from 'mongoose';
import { logger } from '../lib/logger.js';

mongoose.set('strictQuery', true);
// Operations inside connection.transaction() automatically use the transaction session.
mongoose.set('transactionAsyncLocalStorage', true);

export interface DbStatus {
  connected: boolean;
  replicaSet: boolean;
  transactions: boolean;
  version?: string;
}

let status: DbStatus = { connected: false, replicaSet: false, transactions: false };

export async function connectDatabase(uri: string, opts: { requireReplicaSet: boolean }): Promise<DbStatus> {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000, autoIndex: true });
  const admin = mongoose.connection.db!.admin();
  const hello = (await admin.command({ hello: 1 })) as { setName?: string };
  const build = (await admin.command({ buildInfo: 1 })) as { version: string };
  status = { connected: true, replicaSet: Boolean(hello.setName), transactions: Boolean(hello.setName), version: build.version };
  if (!status.replicaSet) {
    const msg =
      'MongoDB is running as a standalone server. Afey POS requires a replica set (a single-node replica set is fine) ' +
      'so that checkout, stock and payment operations run in ACID transactions. See docs/DATABASE.md.';
    if (opts.requireReplicaSet) throw new Error(msg);
    logger.warn(msg + ' Continuing because MONGODB_REQUIRE_REPLICA_SET=false: multi-document operations are NOT atomic.');
  }
  await syncIndexes();
  logger.info({ version: status.version, replicaSet: status.replicaSet }, 'database connected');
  return status;
}

async function syncIndexes() {
  for (const model of Object.values(mongoose.models)) await model.init();
}

export function dbStatus(): DbStatus {
  return { ...status, connected: mongoose.connection.readyState === 1 };
}

export async function pingDatabase(): Promise<boolean> {
  try {
    await mongoose.connection.db!.admin().command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
  status = { connected: false, replicaSet: false, transactions: false };
}

/**
 * Runs fn in a MongoDB transaction (with automatic retry on transient errors).
 * When the deployment does not support transactions (standalone, explicitly allowed),
 * fn runs without one; callers rely on conditional atomic updates for stock invariants.
 */
export async function withTransaction<T>(fn: () => Promise<T>): Promise<T> {
  if (!status.transactions) return fn();
  let result: T;
  await mongoose.connection.transaction(async () => {
    result = await fn();
  });
  return result!;
}
