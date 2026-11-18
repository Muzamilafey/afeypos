import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const dir = path.dirname(fileURLToPath(import.meta.url));
function serverPort() {
  try {
    const env = fs.readFileSync(path.resolve(dir, '../server/.env'), 'utf8');
    return env.match(/^PORT=\s*(\d+)/m)?.[1] ?? '9999';
  } catch {
    return '9999';
  }
}

const api = process.env.VITE_API_TARGET ?? `http://127.0.0.1:${serverPort()}`;
const proxy = { target: api, changeOrigin: !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(api), secure: true };

export default defineConfig({
  root: dir,
  // Relative assets let this same build run at / on the local kiosk and under
  // /attendance-terminal/ on the main POS web server.
  base: './',
  publicDir: path.resolve(dir, '../web/public'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5175, strictPort: true, proxy: { '/api': proxy } },
  preview: { host: '127.0.0.1', port: 5175, strictPort: true, proxy: { '/api': proxy } },
  build: { outDir: 'dist', sourcemap: true },
});
