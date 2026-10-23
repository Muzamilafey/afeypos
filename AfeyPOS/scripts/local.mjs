// One command to run Afey POS on this computer: `npm run local`
//
// 1. Installs dependencies if needed.
// 2. Creates server/.env with fresh secrets if it does not exist (or still has placeholder secrets).
// 3. Uses the MongoDB in server/.env if it is a reachable replica set; otherwise starts a private
//    single-node replica set in ./data/mongo on port 27018 (data is kept between runs). If `mongod` is
//    not installed, a MongoDB binary is downloaded once by mongodb-memory-server.
// 4. Starts the API (PORT in server/.env, default 4000) and the web app (http://localhost:5173).
// Ctrl+C stops everything, including the database this script started.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const log = (msg) => console.log(`\x1b[36m[afeypos]\x1b[0m ${msg}`);
const fail = (msg) => {
  console.error(`\x1b[31m[afeypos]\x1b[0m ${msg}`);
  process.exit(1);
};

// ---- 1. Node and dependencies ----
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 9)) fail(`Node.js 22.9 or newer is required (you have ${process.versions.node}). Install it from https://nodejs.org`);

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: isWin });
  if (r.status !== 0) fail(`"${cmd} ${args.join(' ')}" failed`);
};
if (!fs.existsSync(path.join(root, 'node_modules', 'mongodb-memory-server'))) {
  log('Installing dependencies (first run only)…');
  run('npm', ['install']);
}

// ---- 2. server/.env ----
const envPath = path.join(root, 'server', '.env');
let envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : fs.readFileSync(path.join(root, 'server', '.env.example'), 'utf8');
const getEnv = (key) => envText.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim() ?? '';
const setEnv = (key, value) => {
  envText = new RegExp(`^${key}=`, 'm').test(envText) ? envText.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`) : `${envText.trimEnd()}\n${key}=${value}\n`;
};
let envChanged = !fs.existsSync(envPath);
if (!getEnv('JWT_ACCESS_SECRET') || getEnv('JWT_ACCESS_SECRET').startsWith('change-me')) {
  setEnv('JWT_ACCESS_SECRET', crypto.randomBytes(48).toString('base64url'));
  envChanged = true;
}
if (!getEnv('ENCRYPTION_KEY') || getEnv('ENCRYPTION_KEY').startsWith('REPLACE')) {
  setEnv('ENCRYPTION_KEY', crypto.randomBytes(32).toString('base64'));
  envChanged = true;
}
// Keep the local API URL (used for payment callbacks) on the same port as the server.
const apiPort = getEnv('PORT') || '4000';
const apiUrl = getEnv('API_PUBLIC_URL');
if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(apiUrl) && !apiUrl.replace(/\/$/, '').endsWith(`:${apiPort}`)) {
  setEnv('API_PUBLIC_URL', `http://localhost:${apiPort}`);
  envChanged = true;
}
if (envChanged) {
  fs.writeFileSync(envPath, envText);
  log(fs.existsSync(envPath) ? 'Updated server/.env.' : 'Created server/.env with new secrets. Back up ENCRYPTION_KEY: stored integration secrets depend on it.');
}

// ---- 3. MongoDB replica set ----
const require = createRequire(path.join(root, 'server', 'package.json'));
const { MongoClient } = require('mongodb');

async function isReplicaSet(uri) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2500 });
  try {
    await client.connect();
    const hello = await client.db('admin').command({ hello: 1 });
    return Boolean(hello.setName);
  } catch {
    return false;
  } finally {
    await client.close().catch(() => undefined);
  }
}

let mongod = null;
let stopping = false;
let mongoUri = getEnv('MONGODB_URI');
if (mongoUri && (await isReplicaSet(mongoUri))) {
  log(`Using MongoDB from server/.env (${mongoUri.replace(/\/\/[^@]*@/, '//***@')})`);
} else {
  const port = 27018;
  const dbPath = path.join(root, 'data', 'mongo');
  fs.mkdirSync(dbPath, { recursive: true });
  mongoUri = `mongodb://127.0.0.1:${port}/afeypos?replicaSet=rs0`;
  if (!(await isReplicaSet(mongoUri))) {
    let bin = 'mongod';
    if (spawnSync(bin, ['--version'], { shell: isWin }).status !== 0) {
      log('MongoDB is not installed; using a private MongoDB 7 binary (downloaded once, on the first run)…');
      const { MongoBinary } = require('mongodb-memory-server');
      bin = await MongoBinary.getPath({ version: process.env.MONGOMS_VERSION ?? '7.0.14' });
    }
    log(`Starting MongoDB replica set on port ${port} (data in data/mongo)…`);
    mongod = spawn(bin, ['--replSet', 'rs0', '--dbpath', dbPath, '--port', String(port), '--bind_ip', '127.0.0.1', '--logpath', path.join(dbPath, 'mongod.log'), '--logappend'], { stdio: 'ignore', detached: !isWin });
    mongod.on('exit', (code) => {
      if (code && !stopping) fail(`MongoDB exited with code ${code}; see data/mongo/mongod.log`);
    });
    const direct = new MongoClient(`mongodb://127.0.0.1:${port}/?directConnection=true`, { serverSelectionTimeoutMS: 30_000 });
    await direct.connect();
    try {
      await direct.db('admin').command({ replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: `127.0.0.1:${port}` }] } });
    } catch (err) {
      if (err?.codeName !== 'AlreadyInitialized') throw err;
    }
    for (let i = 0; i < 60; i++) {
      const hello = await direct.db('admin').command({ hello: 1 });
      if (hello.isWritablePrimary) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    await direct.close();
  } else {
    log(`Using the MongoDB already running on port ${port}`);
  }
}

// ---- 4. API + web ----
run('npm', ['run', 'build:shared', '--silent']);
const env = { ...process.env, MONGODB_URI: mongoUri };
const procs = [
  spawn('npm', ['run', 'dev', '-w', '@afeypos/server'], { cwd: root, stdio: 'inherit', shell: isWin, env, detached: !isWin }),
  spawn('npm', ['run', 'dev', '-w', '@afeypos/web'], { cwd: root, stdio: 'inherit', shell: isWin, env, detached: !isWin }),
];
setTimeout(() => log(`API on port ${apiPort}. Open http://localhost:5173 in your browser (first visit: set up your business). Ctrl+C to stop.`), 4000);

// Children run in their own process groups (non-Windows) so npm's grandchildren (vite, tsx) stop too.
const kill = (p) => {
  if (!p?.pid || p.exitCode !== null) return;
  try {
    if (isWin) spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-p.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
};
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  procs.forEach(kill);
  // Give the API a moment to close its connections before MongoDB shuts down cleanly.
  setTimeout(() => kill(mongod), 1000);
  setTimeout(() => process.exit(code), 2500);
};
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
for (const p of procs) p.on('exit', (code) => code && stop(code));
