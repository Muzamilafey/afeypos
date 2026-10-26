import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';

/** API port from server/.env (PORT=...), so changing the server port needs no other edits. */
function serverPort(): string {
  try {
    const env = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../server/.env'), 'utf8');
    return env.match(/^PORT=\s*(\d+)/m)?.[1] ?? '9999';
  } catch {
    return '9999';
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

/**
 * Where /api and /socket.io go. Local API by default; VITE_API_TARGET=https://pos.afey.co.ke runs this web app on
 * the till PC against an online server (npm run web:remote). The browser only ever talks to this local app,
 * so sign-in cookies stay first-party.
 */
const remote = process.env.VITE_API_REMOTE === '1' || /^https:\/\//.test(api) || !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(api);
const proxyTo = (ws = false): ProxyOptions => ({
  target: api,
  ws,
  // An online server is reached by its own name (TLS certificate, virtual host); the local API keeps the Host.
  changeOrigin: remote,
  secure: true,
  configure: remote
    ? (proxy) => {
        // The app here is plain http (localhost or the shop LAN): a "Secure" cookie from the HTTPS server would
        // be dropped by the browser on a LAN address, so it is passed on without the flag. It never leaves this PC
        // except to the server, over HTTPS.
        proxy.on('proxyRes', (res) => {
          const c = res.headers['set-cookie'];
          if (c) res.headers['set-cookie'] = c.map((v) => v.replace(/;\s*Secure/gi, ''));
        });
      }
    : undefined,
});
const proxy = { '/api': proxyTo(), '/socket.io': proxyTo(true), '/health': proxyTo() };

export default defineConfig({
  plugins: [react(), stampServiceWorker()],
  server: { port: 5173, host: true, proxy },
  // `vite preview` serves the built app (fast, like production) with the same forwarding.
  preview: { port: Number(process.env.WEB_PORT ?? 5173), host: true, strictPort: true, proxy },
  build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 900 },
});
