import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
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

/** Stamps the service worker with a build id, so each release installs a new one and clears old caches. */
function stampServiceWorker(): Plugin {
  let outDir = 'dist';
  return {
    name: 'afey-stamp-sw',
    apply: 'build',
    configResolved(c) {
      outDir = path.resolve(c.root, c.build.outDir);
    },
    closeBundle() {
      const file = path.join(outDir, 'sw.js');
      if (fs.existsSync(file)) fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('__BUILD_ID__', Date.now().toString(36)));
    },
  };
}

export default defineConfig({
  plugins: [react(), stampServiceWorker()],
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
