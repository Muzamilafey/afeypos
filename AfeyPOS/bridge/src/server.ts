import http from 'node:http';
import crypto from 'node:crypto';
import type { BridgeConfig } from './config.js';
import { DRAWER_KICK, printRaw } from './adapters/printer.js';
import { displayFrame, readScale, writeSerial } from './adapters/serial.js';
import { createFingerprintAdapter, type FingerprintAdapter } from './adapters/fingerprint.js';

export function hmac(key: string, data: string) {
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function readJson(req: http.IncomingMessage, limit = 2_000_000): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw Object.assign(new Error('Body too large'), { status: 413 });
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

export interface BridgeDeps {
  fingerprint?: FingerprintAdapter;
  fetchImpl?: typeof fetch;
}

/**
 * Localhost-only HTTP API. Every request must come from an allowed POS origin and carry the pairing token,
 * so other websites open in the same browser cannot drive the printer or fingerprint reader.
 */
export function createBridgeServer(cfg: BridgeConfig, deps: BridgeDeps = {}) {
  const fp = deps.fingerprint ?? createFingerprintAdapter(cfg.fingerprint?.vendor, cfg.fingerprint?.options);
  const doFetch = deps.fetchImpl ?? fetch;

  async function serverCall(path: string, body: unknown) {
    const res = await doFetch(`${cfg.server.url.replace(/\/$/, '')}/api/v1${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data?.error?.message ?? `Server returned ${res.status}`), { status: res.status });
    return data;
  }

  async function verifyOrIdentify(b: any) {
    const dev = cfg.biometricDevice;
    if (!dev?.deviceId) throw Object.assign(new Error('Register this reader in Afey POS first'), { status: 409 });
    const purpose = ['login', 'override', 'attendance'].includes(b.purpose) ? b.purpose : 'login';
    const email = b.email ? String(b.email).trim().toLowerCase() : '';
    const ts = Date.now();
    const ch = await serverCall('/biometrics/challenge', { deviceId: dev.deviceId, email: email || undefined, purpose, ts, signature: hmac(dev.deviceKey, `challenge:${email}:${purpose}:${ts}`) });
    const nonce = ch.data.nonce;
    const candidate = await fp.capture();
    const extra = { permission: b.permission, forUserId: b.forUserId };
    if (email) {
      const { matched, score } = await fp.match(candidate, ch.data.templates);
      return serverCall('/biometrics/verify', { deviceId: dev.deviceId, nonce, matched, score, ...extra, signature: hmac(dev.deviceKey, `verify:${nonce}:${matched ? 1 : 0}`) });
    }
    const { userId, score } = await fp.identify(candidate, ch.data.templates);
    const matched = Boolean(userId);
    return serverCall('/biometrics/verify', { deviceId: dev.deviceId, nonce, matched, userId: userId ?? undefined, score, ...extra, signature: hmac(dev.deviceKey, userId ? `verify:${nonce}:1:${userId}` : `verify:${nonce}:0`) });
  }

  const routes: Record<string, (body: any) => Promise<unknown>> = {
    'GET /status': async () => ({
      ok: true,
      printers: Object.keys(cfg.printers),
      display: Boolean(cfg.display),
      scale: Boolean(cfg.scale),
      fingerprint: { vendor: fp.vendor, ...(await fp.status()) },
      biometricDevicePaired: Boolean(cfg.biometricDevice?.deviceId),
    }),
    'POST /print/raw': async (b) => {
      const printer = cfg.printers[b.printer ?? 'receipt'];
      if (!printer) throw Object.assign(new Error('Printer not configured'), { status: 404 });
      await printRaw(printer, Buffer.from(String(b.base64), 'base64'));
      return { ok: true };
    },
    'POST /drawer/open': async (b) => {
      const printer = cfg.printers[b.printer ?? 'receipt'];
      if (!printer) throw Object.assign(new Error('Printer not configured'), { status: 404 });
      await printRaw(printer, DRAWER_KICK);
      return { ok: true };
    },
    'POST /display': async (b) => {
      if (!cfg.display) throw Object.assign(new Error('Customer display not configured'), { status: 404 });
      await writeSerial(cfg.display, displayFrame(String(b.line1 ?? ''), String(b.line2 ?? '')));
      return { ok: true };
    },
    'GET /scale/weight': async () => {
      if (!cfg.scale) throw Object.assign(new Error('Scale not configured'), { status: 404 });
      return readScale(cfg.scale);
    },
    /** Capture for enrolment: returns a signed template the manager submits to the server. */
    'POST /fingerprint/enroll-capture': async (b) => {
      const dev = cfg.biometricDevice;
      if (!dev?.deviceId) throw Object.assign(new Error('Register this reader in Afey POS first'), { status: 409 });
      const t = await fp.capture({ enroll: true });
      const finger = String(b.finger ?? 'right_index');
      return { deviceId: dev.deviceId, userId: b.userId, finger, format: t.format, template: t.template, signature: hmac(dev.deviceKey, `enroll:${b.userId}:${finger}:${t.template}`) };
    },
    /**
     * Challenge from the server, local capture and match, signed result back to the server.
     * With an email: 1:1 verification of that person. Without: 1:N identification ("touch the reader").
     */
    'POST /fingerprint/verify': (b) => verifyOrIdentify(b),
    'POST /fingerprint/identify': (b) => verifyOrIdentify({ ...b, email: undefined }),
  };

  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const allowed = !origin || cfg.allowedOrigins.includes(origin);
    if (origin && allowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Afey-Bridge-Token');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      // Chrome Private Network Access preflight for https pages calling localhost.
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(allowed ? 204 : 403).end();
      return;
    }
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (!allowed) return send(403, { error: 'Origin not allowed' });
    const token = String(req.headers['x-afey-bridge-token'] ?? '');
    if (!safeEqual(token, cfg.pairingToken)) return send(401, { error: 'Invalid pairing token' });
    const handler = routes[`${req.method} ${(req.url ?? '').split('?')[0]}`];
    if (!handler) return send(404, { error: 'Not found' });
    try {
      send(200, await handler(req.method === 'POST' ? await readJson(req) : {}));
    } catch (err: any) {
      send(err?.status ?? 500, { error: err?.message ?? 'Device error' });
    }
  });
}
