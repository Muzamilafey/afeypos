import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { savePrinters, type BridgeConfig, type PrinterConfig } from './config.js';
import { DRAWER_KICK, listDevicePrinters, listSystemPrinters, printRaw } from './adapters/printer.js';
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
  /** Persists printer choices (config.json by default). */
  savePrinters?: (printers: Record<string, PrinterConfig>) => void;
}

/** A printer setting sent from the web app, checked before it is used or saved. */
function parsePrinter(p: any): PrinterConfig {
  if (p?.type === 'network' && typeof p.host === 'string' && /^[\w.-]{1,253}$/.test(p.host)) return { type: 'network', host: p.host, port: Number.isInteger(p.port) ? p.port : 9100 };
  if (p?.type === 'system' && typeof p.name === 'string' && p.name.length <= 120) return { type: 'system', name: p.name };
  if (p?.type === 'windows-share' && typeof p.share === 'string' && /^\\\\[\w.-]+\\[\w .$-]+$/.test(p.share)) return { type: 'windows-share', share: p.share };
  if (p?.type === 'device' && typeof p.path === 'string' && /^(\/dev\/(usb\/lp\d+|tty\w+|lp\d+)|\\\\\.\\(COM\d+|LPT\d))$/.test(p.path)) return { type: 'device', path: p.path };
  throw Object.assign(new Error('Invalid printer setting'), { status: 400 });
}

const TEST_PAGE = Buffer.concat([Buffer.from([0x1b, 0x40, 0x1b, 0x61, 0x01, 0x1b, 0x45, 0x01]), Buffer.from('Afey POS\n'), Buffer.from([0x1b, 0x45, 0x00]), Buffer.from(`Printer test OK\n${new Date().toLocaleString()}\n\n\n\n`), Buffer.from([0x1d, 0x56, 0x42, 0x00])]);

interface EtimsDiscovery {
  programs: { pid: number; name: string; path?: string; driver: 'kra-vscu' | 'tremol-zfplab' | 'tremol-fpcmd' | 'datecs' | 'unknown-fiscal'; listeners: { address: string; port: number }[] }[];
  serialPorts: { deviceId: string; name: string; pnpId?: string; family: 'tremol' | 'datecs' | 'unknown' }[];
  tremolServers?: { address: string; online: boolean; response?: string; error?: string }[];
  scannedAt: string;
}

/** Enumerates local fiscal software and ports; device commands are not sent during this process scan. */
function discoverEtimsOnWindows(): Promise<EtimsDiscovery> {
  if (process.platform !== 'win32') return Promise.reject(Object.assign(new Error('ETR program discovery is currently supported on Windows only'), { status: 501 }));
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$pattern='(?i)(etims|vscu|oscu|fiscal|(^|[^a-z])etr([^a-z]|$)|zfplab|fpcmd|ecr.?manager|datecs|tremol|fp.?700|wp.?25|fp.?24|g03)'",
    "$all=Get-CimInstance Win32_Process",
    "$matched=@($all | Where-Object { (($_.Name+' '+$_.ExecutablePath+' '+$_.CommandLine) -match $pattern) } | Select-Object ProcessId,Name,ExecutablePath,CommandLine)",
    "$ids=@($matched | ForEach-Object { [int]$_.ProcessId })",
    "$listeners=@(Get-NetTCPConnection -State Listen | Where-Object { $ids -contains [int]$_.OwningProcess } | Select-Object LocalAddress,LocalPort,OwningProcess)",
    "$serial=@(Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match '(?i)(COM[0-9]+|tremol|datecs|fiscal|etr|FP.?700|WP.?25|FP.?24|G03)' -or $_.PNPDeviceID -match '(?i)(VID_|USB|FTDI|SILABS|CH340)' } | Select-Object Name,PNPDeviceID,DeviceID)",
    "[pscustomobject]@{processes=$matched;listeners=$listeners;serialPorts=$serial} | ConvertTo-Json -Depth 4 -Compress",
  ].join(';');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10_000, maxBuffer: 1_000_000 }, (error, stdout) => {
      if (error) return reject(Object.assign(new Error('Could not scan this computer for ETR software. Check that Windows PowerShell is available, then try again.'), { status: 503 }));
      try {
        const raw = JSON.parse(stdout.trim() || '{}');
        const list = (v: unknown) => v == null ? [] : Array.isArray(v) ? v : [v];
        const listeners = list(raw.listeners);
        const programs = list(raw.processes).map((p: any) => {
          const description = `${p.Name ?? ''} ${p.ExecutablePath ?? ''} ${p.CommandLine ?? ''}`.toLowerCase();
          const driver: EtimsDiscovery['programs'][number]['driver'] = /zfplab/.test(description) ? 'tremol-zfplab'
            : /fpcmd|ecr.?manager/.test(description) ? 'tremol-fpcmd'
              : /datecs/.test(description) ? 'datecs'
                : /etims|vscu|oscu/.test(description) ? 'kra-vscu'
                  : 'unknown-fiscal';
          return {
          pid: Number(p.ProcessId), name: String(p.Name ?? 'ETR program'), path: typeof p.ExecutablePath === 'string' ? p.ExecutablePath : undefined, driver,
          listeners: listeners.filter((l: any) => Number(l.OwningProcess) === Number(p.ProcessId)).flatMap((l: any) => {
            const port = Number(l.LocalPort);
            const host = ['0.0.0.0', '::', '::0', '*'].includes(String(l.LocalAddress)) ? '127.0.0.1' : String(l.LocalAddress);
            return Number.isInteger(port) && port > 0 ? [{ address: `http://${host.includes(':') ? `[${host}]` : host}:${port}`, port }] : [];
          }),
          };
        });
        const serialPorts = list(raw.serialPorts).flatMap((p: any) => {
          const name = String(p.Name ?? '');
          const pnpId = String(p.PNPDeviceID ?? p.DeviceID ?? '');
          const description = `${name} ${pnpId}`.toLowerCase();
          const family: EtimsDiscovery['serialPorts'][number]['family'] = /tremol|fp.?24|g03|s25|m23/.test(description) ? 'tremol' : /datecs|wp.?25|fp.?700/.test(description) ? 'datecs' : 'unknown';
          const deviceId = name.match(/\((COM\d+)\)/i)?.[1] ?? name.match(/\b(COM\d+)\b/i)?.[1] ?? '';
          return deviceId ? [{ deviceId: deviceId.toUpperCase(), name, pnpId, family }] : [];
        });
        const zfplabPorts = [...new Set(programs.filter((p) => p.driver === 'tremol-zfplab').flatMap((p) => p.listeners.map((listener) => listener.port)))].slice(0, 5);
        // ZFPLabServer defaults to 4444, but an administrator can configure a different port.
        // Prefer the actual listener(s) from the matched process; only use the documented
        // default when Windows did not expose one.
        const tremolServers = (zfplabPorts.length ? zfplabPorts : programs.some((p) => p.driver === 'tremol-zfplab') ? [4444] : [])
          .map((port) => ({ address: `http://127.0.0.1:${port}`, online: false }));
        resolve({ programs, serialPorts, ...(tremolServers.length ? { tremolServers } : {}), scannedAt: new Date().toISOString() });
      } catch {
        reject(Object.assign(new Error('Windows returned an unreadable ETR discovery result. Try again.'), { status: 503 }));
      }
    });
  });
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

  async function findTremolDevice(discovery: EtimsDiscovery): Promise<EtimsDiscovery> {
    if (!discovery.tremolServers?.length) return discovery;
    const tremolServers = await Promise.all(discovery.tremolServers.map(async (server) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12_000);
      try {
        // This calls the ZFPLabServer finddevice discovery command on loopback only.
        const res = await doFetch(`${server.address}/finddevice`, { signal: controller.signal });
        const response = (await res.text()).slice(0, 4000);
        return { ...server, online: res.ok, response: response || `HTTP ${res.status}` };
      } catch (err: any) {
        return { ...server, online: false, error: err?.name === 'AbortError' ? 'Timed out asking ZFPLabServer to find a device.' : String(err?.message ?? err).slice(0, 300) };
      } finally { clearTimeout(timer); }
    }));
    return { ...discovery, tremolServers };
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
      // A configured printer by name, or (labels) any printer installed on this PC by its system name.
      const printer = b.systemPrinter ? parsePrinter({ type: 'system', name: String(b.systemPrinter) }) : cfg.printers[b.printer ?? 'receipt'];
      if (!printer) throw Object.assign(new Error('Printer not configured'), { status: 404 });
      await printRaw(printer, Buffer.from(String(b.base64), 'base64'));
      return { ok: true };
    },
    /** Printers this computer knows about, for picking the receipt printer in Afey POS. */
    'GET /printers': async () => ({ configured: cfg.printers, system: await listSystemPrinters(), devices: listDevicePrinters() }),
    /** Finds local fiscal software/ports and asks detected ZFPLabServer instances to locate a device; it never fiscalizes. */
    'GET /etims/discover': async () => ({ data: await findTremolDevice(await discoverEtimsOnWindows()) }),
    /** Sets a printer (e.g. "receipt") and saves it, so printing needs no dialog from then on. */
    'POST /printers/set': async (b) => {
      const name = String(b.name ?? 'receipt');
      if (!/^[a-z][\w-]{0,30}$/.test(name)) throw Object.assign(new Error('Invalid printer name'), { status: 400 });
      cfg.printers = { ...cfg.printers, [name]: parsePrinter(b.printer) };
      (deps.savePrinters ?? savePrinters)(cfg.printers);
      return { ok: true, printers: cfg.printers };
    },
    'POST /printers/test': async (b) => {
      const printer = b.printer ? parsePrinter(b.printer) : cfg.printers[b.name ?? 'receipt'];
      if (!printer) throw Object.assign(new Error('Printer not configured'), { status: 404 });
      await printRaw(printer, TEST_PAGE);
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
    /** Tare/zero only with the command from the scale's manual; otherwise the cashier presses the key on the scale. */
    'POST /scale/tare': async (b) => {
      if (!cfg.scale) throw Object.assign(new Error('Scale not configured'), { status: 404 });
      const cmd = b.zero ? cfg.scale.zeroCommand : cfg.scale.tareCommand;
      if (!cmd) throw Object.assign(new Error(`Press ${b.zero ? 'ZERO' : 'TARE'} on the scale (no command set for this model)`), { status: 409 });
      await writeSerial(cfg.scale, Buffer.from(cmd.replace(/\\r/g, '\r').replace(/\\n/g, '\n'), 'ascii'));
      return { ok: true };
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
    // Pairing without copying the token: only an Afey POS page (an allowed origin, checked above) may ask for it.
    // Other websites are refused by the origin check, and a request without an Origin header gets nothing here.
    if (req.method === 'GET' && (req.url ?? '').split('?')[0] === '/pair') {
      if (!origin) return send(403, { error: 'Pair from Afey POS in the browser' });
      return send(200, { ok: true, token: cfg.pairingToken, port: cfg.port });
    }
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
