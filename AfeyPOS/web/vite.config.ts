import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** API port from server/.env (PORT=...), so changing the server port needs no other edits. */
function serverPort(): string {
  try {
    const env = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../server/.env'), 'utf8');
    return env.match(/^PORT=\s*(\d+)/m)?.[1] ?? '4000';
  } catch {
    return '4000';
  }
}

// 127.0.0.1 rather than "localhost": on Windows "localhost" can resolve to IPv6 (::1) while the API listens on IPv4.
const api = process.env.VITE_API_TARGET ?? `http://127.0.0.1:${serverPort()}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': { target: api, changeOrigin: false },
      '/socket.io': { target: api, ws: true },
      '/health': { target: api },
    },
  },
  build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 900 },
});
