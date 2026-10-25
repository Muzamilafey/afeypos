import http from 'node:http';
import { loadEnv } from './config/env.js';
import { logger } from './lib/logger.js';
import { connectDatabase, disconnectDatabase } from './db/connection.js';
import { createApp } from './app.js';
import { attachRealtime, closeRealtime } from './realtime/socket.js';
import { startWorker, stopWorker } from './jobs/queue.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';
import { bootstrap } from './bootstrap.js';
import { startBranchSync, stopBranchSync } from './modules/sync/branch.js';

async function main() {
  const e = loadEnv();
  await connectDatabase(e.MONGODB_URI, { requireReplicaSet: e.MONGODB_REQUIRE_REPLICA_SET });
  await bootstrap();
  const app = createApp();
  const server = http.createServer(app);
  attachRealtime(server, e.CORS_ORIGINS.split(',').map((s) => s.trim()));
  if (e.JOBS_ENABLED) {
    startWorker();
    startScheduler();
  }
  startBranchSync();
  server.listen(e.PORT, e.HOST, () => logger.info({ port: e.PORT, host: e.HOST, mode: e.DEPLOYMENT_MODE }, 'Afey POS server listening'));

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    stopScheduler();
    stopWorker();
    stopBranchSync();
    closeRealtime();
    server.close();
    await disconnectDatabase();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err: err?.message ?? err }, 'failed to start');
  console.error(err?.message ?? err);
  process.exit(1);
});
