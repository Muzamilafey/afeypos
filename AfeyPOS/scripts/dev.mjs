// Runs the API server, POS, shop and local attendance terminal together. Requires MongoDB (replica set) and server/.env.
import { spawn } from 'node:child_process';

const procs = [
  spawn('npm', ['run', 'dev', '-w', '@afeypos/server'], { stdio: 'inherit', shell: process.platform === 'win32' }),
  spawn('npm', ['run', 'dev', '-w', '@afeypos/web'], { stdio: 'inherit', shell: process.platform === 'win32' }),
  spawn('npm', ['run', 'dev', '-w', '@afeypos/shop'], { stdio: 'inherit', shell: process.platform === 'win32' }),
  spawn('npm', ['run', 'dev', '-w', '@afeypos/attendance'], { stdio: 'inherit', shell: process.platform === 'win32' }),
];
const stop = () => procs.forEach((p) => p.kill('SIGTERM'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
procs.forEach((p) => p.on('exit', (code) => { if (code) { stop(); process.exit(code); } }));
