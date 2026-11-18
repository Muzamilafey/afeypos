import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function requireSupportedNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (process.platform !== 'win32') throw new Error('This attendance installer is for Windows.');
  if (major < 22 || (major === 22 && minor < 9)) throw new Error(`Node.js 22.9 or newer is required (found ${process.versions.node}).`);
  const npm = spawnSync('npm.cmd', ['--version'], { cwd: root, stdio: 'ignore', shell: true, windowsHide: true });
  if (npm.error || npm.status !== 0) throw new Error('npm is required. Repair the Afey POS installation on this computer first.');
}

function buildAttendanceIfMissing() {
  if (fs.existsSync(path.join(root, 'attendance', 'dist', 'index.html'))) return;
  console.log('Building the Afey attendance terminal…');
  const result = spawnSync('npm.cmd', ['run', 'build', '-w', '@afeypos/attendance'], { cwd: root, stdio: 'inherit', shell: true, windowsHide: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Attendance build failed. Fix the build error above, then run this command file again.');
}

function installAndStartService() {
  const script = path.join(root, 'installer', 'windows', 'install-attendance-service.ps1');
  if (!fs.existsSync(script)) throw new Error('The attendance startup installer is missing. Upgrade Afey POS on this computer first.');
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-InstallDir', root, '-NodePath', process.execPath,
  ], { cwd: root, stdio: 'inherit', windowsHide: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Could not install or start the attendance startup task.');
}

try {
  requireSupportedNode();
  buildAttendanceIfMissing();
  installAndStartService();
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
