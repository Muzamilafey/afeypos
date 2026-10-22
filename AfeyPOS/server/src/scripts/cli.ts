import { loadEnv } from '../config/env.js';
import { connectDatabase, disconnectDatabase } from '../db/connection.js';
import { runAsPlatform } from '../lib/context.js';
import '../models/index.js';

/** Runs a maintenance task with a database connection in platform scope. */
export async function withDb(fn: () => Promise<void>) {
  const e = loadEnv();
  await connectDatabase(e.MONGODB_URI, { requireReplicaSet: e.MONGODB_REQUIRE_REPLICA_SET });
  try {
    await runAsPlatform(fn);
  } catch (err: any) {
    console.error(`ERROR: ${err?.message ?? err}`);
    process.exitCode = 1;
  } finally {
    await disconnectDatabase();
  }
}
