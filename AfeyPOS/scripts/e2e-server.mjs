// Starts an in-memory MongoDB replica set and the built Afey POS server (local mode, serving web/dist)
// for end-to-end tests. Usage: node scripts/e2e-server.mjs [port]
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'server', 'package.json'));
if (!process.env.MONGOMS_SYSTEM_BINARY && fs.existsSync('/opt/mongo/mongod-wrapper')) {
  process.env.MONGOMS_SYSTEM_BINARY = '/opt/mongo/mongod-wrapper';
  process.env.MONGOMS_VERSION ??= '7.0.34';
}
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const port = process.argv[2] ?? process.env.E2E_PORT ?? '4100';
// One fixed database folder, emptied at each start: the test runner may stop this process before the memory
// server deletes its temporary folder, and those folders (about 300 MB each) would otherwise pile up in /tmp.
const dbPath = path.join(root, '.e2e-mongo');
fs.rmSync(dbPath, { recursive: true, force: true });
fs.mkdirSync(dbPath, { recursive: true });
const rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, instanceOpts: [{ dbPath }] });
const uri = rs.getUri('afeypos_e2e');
const child = spawn(process.execPath, [path.join(root, 'server', 'dist', 'server.js')], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'development',
    DEPLOYMENT_MODE: process.env.E2E_MODE ?? 'local',
    PORT: port,
    HOST: '127.0.0.1',
    MONGODB_URI: uri,
    JWT_ACCESS_SECRET: 'e2e-secret-e2e-secret-e2e-secret-e2e-secret',
    ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
    WEB_DIST_DIR: path.join(root, 'web', 'dist'),
    SHOP_DIST_DIR: path.join(root, 'shop', 'dist'),
    SHOP_HOSTNAMES: 'shop.lan.test',
    SHOP_FRAME_ANCESTORS: `http://pos-server.lan.test:${port}`,
    PUBLIC_APP_URL: `http://127.0.0.1:${port}`,
    API_PUBLIC_URL: `http://127.0.0.1:${port}`,
    CORS_ORIGINS: `http://127.0.0.1:${port}`,
    BACKUP_DIR: path.join(root, '.e2e-backups'),
    LOG_LEVEL: 'warn',
  },
});
const stop = async () => {
  child.kill('SIGTERM');
  await rs.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', async (code) => {
  await rs.stop();
  process.exit(code ?? 0);
});
