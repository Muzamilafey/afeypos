#!/usr/bin/env node
// Runs the Afey POS web app on this computer against an online API server (e.g. a VPS):
//
//   npm run web:remote -- --api https://pos.afey.co.ke      first time (the address is remembered)
//   npm run web:remote                                       next times
//
//   --port 9999     port to open in the browser (http://localhost:9999, or http://<this PC's IP>:9999 from other tills)
//   --dev           development server with hot reload instead of the built app
//   --no-build      reuse the last build (starts faster)
//
// The browser talks only to this local app; it forwards /api and live updates to the server over HTTPS.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = path.join(root, 'web');
const saved = path.join(web, '.remote-api.json');
const isWin = process.platform === 'win32';
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i === -1 ? undefined : args[i + 1]; };
const flag = (n) => args.includes(`--${n}`);
const fail = (m) => { console.error(`\x1b[31mERROR:\x1b[0m ${m}`); process.exit(1); };

let api = opt('api');
if (!api) { try { api = JSON.parse(fs.readFileSync(saved, 'utf8')).api; } catch { /* first run */ } }
if (!api) fail('Give the server address once: npm run web:remote -- --api https://pos.afey.co.ke');
api = api.replace(/\/+$/, '');
if (!/^https?:\/\/[^/]+$/.test(api)) fail(`"${api}" is not a server address like https://pos.afey.co.ke`);
fs.writeFileSync(saved, JSON.stringify({ api }, null, 2));
const port = opt('port') ?? '9999';

console.log(`\x1b[32m==>\x1b[0m Checking ${api}`);
try {
  const r = await fetch(`${api}/health`, { signal: AbortSignal.timeout(10000) });
  const h = await r.json().catch(() => ({}));
  if (!r.ok || h.status !== 'ok') console.warn(`    The server answered but is not healthy (${r.status} ${h.status ?? ''}). Check it on the VPS: afeypos status`);
  else console.log(`    Server OK (${h.mode}, database ${h.database?.connected ? 'connected' : 'not connected'})`);
} catch (e) {
  console.warn(`    Cannot reach ${api}/health (${e.message}). Check the address, DNS and that the server is running; starting anyway.`);
}

const env = { ...process.env, VITE_API_TARGET: api, VITE_API_REMOTE: '1', WEB_PORT: port };
const run = (cmd, a, cwd = root) => {
  const r = spawnSync(cmd, a, { cwd, stdio: 'inherit', shell: isWin, env });
  if (r.status !== 0) fail(`"${cmd} ${a.join(' ')}" failed`);
};
if (!fs.existsSync(path.join(root, 'node_modules'))) { console.log('\x1b[32m==>\x1b[0m Installing (first run)'); run('npm', ['install', '--no-audit', '--no-fund']); }
run('npm', ['run', 'build:shared']);
if (!flag('dev') && (!flag('no-build') || !fs.existsSync(path.join(web, 'dist', 'index.html')))) {
  console.log('\x1b[32m==>\x1b[0m Building the web app');
  run('npx', ['vite', 'build', '--logLevel', 'warn'], web);
}

const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
console.log(`\x1b[32m==>\x1b[0m Afey POS: http://localhost:${port}${lan ? `   (other tills: http://${lan}:${port})` : ''}   API: ${api}`);
const child = spawn('npx', ['vite', flag('dev') ? 'dev' : 'preview', '--port', port, '--strictPort'], { cwd: web, stdio: 'inherit', shell: isWin, env });
child.on('exit', (code) => process.exit(code ?? 0));
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => child.kill(s));
