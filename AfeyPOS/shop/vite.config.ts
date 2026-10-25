import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** In development the shop talks to the local server (port from server/.env). In production set VITE_API_URL. */
function serverPort(): string {
  try {
    const env = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../server/.env'), 'utf8');
    return env.match(/^PORT=\s*(\d+)/m)?.[1] ?? '4000';
  } catch {
    return '4000';
  }
}
const api = process.env.VITE_API_TARGET ?? `http://127.0.0.1:${serverPort()}`;

export default defineConfig({
  plugins: [react()],
  server: { port: 5174, host: true, proxy: { '/api': { target: api, changeOrigin: false } } },
  build: { outDir: 'dist', sourcemap: true },
});
