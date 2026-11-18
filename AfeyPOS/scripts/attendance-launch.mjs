import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appUrl = 'http://127.0.0.1:5175/';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function requireSupportedNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (process.platform !== 'win32') throw new Error('This attendance launcher is for Windows.');
  if (major < 22 || (major === 22 && minor < 9)) throw new Error(`Node.js 22.9 or newer is required (found ${process.versions.node}).`);
  const npm = spawnSync('npm.cmd', ['--version'], { cwd: root, stdio: 'ignore', shell: true, windowsHide: true });
  if (npm.error || npm.status !== 0) throw new Error('npm is required. Install or repair the Afey POS dependencies on this computer first.');
}

function buildAttendanceIfMissing() {
  if (fs.existsSync(path.join(root, 'attendance', 'dist', 'index.html'))) return;
  console.log('Building the Afey attendance terminal…');
  const result = spawnSync('npm.cmd', ['run', 'build', '-w', '@afeypos/attendance'], { cwd: root, stdio: 'inherit', shell: true, windowsHide: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Attendance build failed. Fix the build error above, then run this launcher again.');
}

async function isAttendanceReady() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(appUrl, { signal: controller.signal, redirect: 'manual' });
    if (!response.ok) return false;
    return (await response.text()).includes('<title>Afey POS Attendance</title>');
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function startAttendanceServer() {
  const child = spawn('npm.cmd', ['run', 'preview', '-w', '@afeypos/attendance', '--', '--host', '127.0.0.1', '--port', '5175', '--strictPort'], { cwd: root, shell: true, windowsHide: false, stdio: 'inherit' });
  child.once('error', (error) => console.error(`Could not start the attendance terminal: ${error.message}`));
  return child;
}

async function waitUntilReady(server) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await isAttendanceReady()) return;
    if (server.exitCode !== null) throw new Error(`The attendance server stopped with exit code ${server.exitCode}.`);
    await pause(1000);
  }
  throw new Error('Attendance did not become ready on port 5175. Check the attendance server window and make sure this port is free.');
}

function buildLaunchUrl() {
  const url = new URL(appUrl);
  const configPath = path.join(root, 'bridge', 'config.json');
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (typeof config.pairingToken === 'string' && config.pairingToken.length >= 24 && Number.isInteger(config.port)) {
      url.hash = new URLSearchParams({ bridgeUrl: `http://127.0.0.1:${config.port}`, bridgeToken: config.pairingToken }).toString();
    } else {
      console.log('Bridge config has no usable pairing token. Set it in the attendance terminal settings to enable fingerprint attendance.');
    }
  } catch {
    console.log('No bridge/config.json found. You can pair the bridge from the attendance terminal settings.');
  }
  return url.href;
}

function openBrowser(url) {
  const opener = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, windowsHide: true, stdio: 'ignore' });
  opener.once('error', () => console.log(`Open this address in your browser: ${appUrl}`));
  opener.unref();
}

async function main() {
  requireSupportedNode();
  buildAttendanceIfMissing();
  let server;
  let serverExit;
  if (!(await isAttendanceReady())) {
    console.log('Starting Afey POS Attendance…');
    server = startAttendanceServer();
    serverExit = new Promise((resolve) => server.once('exit', resolve));
    await waitUntilReady(server);
  }
  openBrowser(buildLaunchUrl());
  console.log(`Attendance is ready at ${appUrl}`);
  if (server) {
    console.log('Leave this command window open while the attendance terminal is in use. Close it to stop the local app.');
    await serverExit;
  }
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
