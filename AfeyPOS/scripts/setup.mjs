#!/usr/bin/env node
// Configures and builds Afey POS for running as a server: `npm run setup -- [options]`.
// The one-line installers (installer/install.sh, installer/windows/install-online.ps1) download Node.js and
// MongoDB, then run this. Safe to run again: existing secrets and settings are kept, so it also upgrades.
//
//   --mode standalone|hq|branch   one shop (default), head office online, or branch server
//   --port 4000                   port of the web app and API
//   --mongo-uri <uri>             default mongodb://127.0.0.1:27017/afeypos?replicaSet=rs0
//   --public-url <url>            address staff use (default http://<this computer's LAN IP>:<port>)
//   --data-dir <dir>              uploads and backups (default ./data next to the app)
//   --app-dir <dir>               stable path of the app if this copy is one of several versions
//   --shop-host <name>            serve the online shop for this host name (e.g. shop.myshop.co.ke)
//   --hq-url <url> --sync-token <token> --branch-code <code>   branch servers: where and how to sync
//   --no-install --no-build --no-db   skip steps
//   --print-env                   print the resulting configuration (secrets masked) and exit
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const log = (m) => console.log(`\x1b[32m==>\x1b[0m ${m}`);
const info = (m) => console.log(`    ${m}`);
const fail = (m) => {
  console.error(`\x1b[31mERROR:\x1b[0m ${m}`);
  process.exit(1);
};

// ---------- options ----------
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  if (!v || v.startsWith('--')) fail(`--${name} needs a value`);
  return v;
};
const port = opt('port', '');
if (port && !/^\d{2,5}$/.test(port)) fail('--port must be a number');

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 9)) fail(`Node.js 22.9 or newer is required (found ${process.versions.node}).`);

const run = (cmd, cmdArgs, cwd = root) => {
  const r = spawnSync(cmd, cmdArgs, { cwd, stdio: 'inherit', shell: isWin, env: { ...process.env, NODE_ENV: undefined } });
  if (r.status !== 0) fail(`"${cmd} ${cmdArgs.join(' ')}" failed`);
};

function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) return a.address;
  }
  return 'localhost';
}

// ---------- 1. configuration (server/.env) ----------
const envPath = path.join(root, 'server', '.env');
const existed = fs.existsSync(envPath);
let text = fs.readFileSync(existed ? envPath : path.join(root, 'server', '.env.example'), 'utf8');
const get = (k) => text.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim() ?? '';
const set = (k, v) => {
  const line = `${k}=${v}`;
  text = new RegExp(`^${k}=`, 'm').test(text) ? text.replace(new RegExp(`^${k}=.*$`, 'm'), line) : `${text.trimEnd()}\n${line}\n`;
};
/** Only fills a value when it is empty or still the example placeholder, so re-runs keep your edits. */
const setDefault = (k, v, placeholder = /^$/) => {
  if (placeholder.test(get(k))) set(k, v);
};

// Re-runs keep the existing mode unless --mode is given.
const mode = opt('mode', existed && get('DEPLOYMENT_MODE') ? get('DEPLOYMENT_MODE') : 'standalone');
if (!['standalone', 'hq', 'branch'].includes(mode)) fail('--mode must be standalone, hq or branch');
log(existed ? 'Updating server/.env (existing values kept)' : 'Creating server/.env');
setDefault('JWT_ACCESS_SECRET', crypto.randomBytes(48).toString('base64url'), /^(|change-me.*)$/);
setDefault('ENCRYPTION_KEY', crypto.randomBytes(32).toString('base64'), /^(|REPLACE.*)$/);
// This script prepares a server; development uses `npm run local` instead.
set('NODE_ENV', 'production');
set('DEPLOYMENT_MODE', mode);
if (port) set('PORT', port);
const p = get('PORT') || '4000';
if (opt('mongo-uri')) set('MONGODB_URI', opt('mongo-uri'));
const dataDir = path.resolve(opt('data-dir', get('UPLOAD_DIR') && path.isAbsolute(get('UPLOAD_DIR')) ? path.dirname(get('UPLOAD_DIR')) : path.join(root, 'data')));
fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'backups'), { recursive: true });
set('UPLOAD_DIR', path.join(dataDir, 'uploads'));
set('BACKUP_DIR', path.join(dataDir, 'backups'));
// The server also serves the built web app and (for its own host name) the online shop. The installer passes the
// stable path of the current version (--app-dir /opt/afeypos/app), so switching versions needs no config change.
const appDir = path.resolve(opt('app-dir', root));
set('WEB_DIST_DIR', path.join(appDir, 'web', 'dist'));
set('SHOP_DIST_DIR', path.join(appDir, 'shop', 'dist'));
if (opt('shop-host')) set('SHOP_HOSTNAMES', opt('shop-host'));

const defaultUrl = mode === 'hq' ? '' : `http://${lanIp()}:${p}`;
const publicUrl = (opt('public-url') || (/localhost:5173/.test(get('PUBLIC_APP_URL')) || !get('PUBLIC_APP_URL') ? defaultUrl : get('PUBLIC_APP_URL'))).replace(/\/$/, '');
if (!publicUrl) fail('Head office needs its public address: --public-url https://hq.myshop.co.ke');
set('PUBLIC_APP_URL', publicUrl);
set('API_PUBLIC_URL', publicUrl);
const origins = new Set([publicUrl, `http://localhost:${p}`, `http://127.0.0.1:${p}`, ...get('CORS_ORIGINS').split(',').map((s) => s.trim()).filter((s) => s && !/localhost:5173/.test(s))]);
set('CORS_ORIGINS', [...origins].join(','));
set('SHOP_FRAME_ANCESTORS', get('SHOP_FRAME_ANCESTORS') || publicUrl);
const https = publicUrl.startsWith('https://');
set('COOKIE_SECURE', String(https));
if (mode === 'branch') {
  if (opt('hq-url')) set('SYNC_HQ_URL', opt('hq-url'));
  if (opt('sync-token')) set('SYNC_TOKEN', opt('sync-token'));
  if (opt('branch-code')) set('BRANCH_CODE', opt('branch-code'));
  if (!get('SYNC_HQ_URL') || !get('SYNC_TOKEN') || !get('BRANCH_CODE')) fail('A branch server needs --hq-url, --sync-token and --branch-code (from head office: Administration > Branch sync).');
  set('SYNC_ENABLED', 'true');
}

if (flag('print-env')) {
  console.log(text.replace(/^((JWT_ACCESS_SECRET|ENCRYPTION_KEY|SYNC_TOKEN|SMTP_PASSWORD)=).+$/gm, '$1********'));
  process.exit(0);
}
fs.writeFileSync(envPath, text.endsWith('\n') ? text : `${text}\n`, { mode: 0o600 });
try {
  fs.chmodSync(envPath, 0o600);
} catch {
  /* Windows: the installer sets the file's access list */
}
if (!existed) info('BACK UP server/.env: without ENCRYPTION_KEY, saved credentials cannot be decrypted after a reinstall.');

// ---------- 2. dependencies and build ----------
if (!flag('no-install')) {
  log('Installing dependencies');
  run('npm', fs.existsSync(path.join(root, 'package-lock.json')) ? ['ci', '--no-audit', '--no-fund', '--loglevel=error'] : ['install', '--no-audit', '--no-fund']);
}
if (!flag('no-build')) {
  log('Building (shared code, server, web app, device bridge, online shop)');
  run('npm', ['run', 'build']);
}

// ---------- 3. database ----------
if (!flag('no-db')) {
  log('Checking the database');
  const uri = get('MONGODB_URI');
  const require = createRequire(path.join(root, 'server', 'package.json'));
  let mongodb;
  try {
    mongodb = require('mongodb');
  } catch {
    fail('The MongoDB driver is missing; run without --no-install.');
  }
  const local = /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri);
  const hostPort = uri.match(/^mongodb:\/\/([^/]+)\//)?.[1] ?? '127.0.0.1:27017';
  const direct = local ? `mongodb://${hostPort}/?directConnection=true` : uri;
  let ok = false;
  for (let i = 0; i < 30 && !ok; i++) {
    const client = new mongodb.MongoClient(direct, { serverSelectionTimeoutMS: 2000 });
    try {
      await client.connect();
      const admin = client.db('admin');
      let status = null;
      try {
        status = await admin.command({ replSetGetStatus: 1 });
      } catch (e) {
        // A local, fresh replica set: initialise it once.
        if (local && /no replset config|NotYetInitialized/i.test(`${e.codeName} ${e.message}`)) {
          info('Initialising the replica set (once)');
          await admin.command({ replSetInitiate: { _id: uri.match(/replicaSet=([^&]+)/)?.[1] ?? 'rs0', members: [{ _id: 0, host: hostPort }] } });
        } else if (!local) {
          ok = true; // Atlas and managed clusters: replSetGetStatus may be restricted.
        } else throw e;
      }
      if (status?.members?.some((m) => m.stateStr === 'PRIMARY')) ok = true;
    } catch (e) {
      if (i === 29) fail(`Cannot use the database at ${uri.replace(/\/\/[^@]*@/, '//***@')}: ${e.message}`);
    } finally {
      await client.close().catch(() => undefined);
    }
    if (!ok) await new Promise((r) => setTimeout(r, 2000));
  }
  info('Database ready (replica set with a primary)');
}

log('Setup complete');
info(`Start: npm start   (or the "afeypos" service the installer created)`);
info(`Then open ${publicUrl || `http://localhost:${p}`} and create the owner account.`);
