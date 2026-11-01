/**
 * The Afey device bridge on this till PC (printers, drawer, scale, fingerprint reader). Its address and
 * pairing token are per computer, kept with the workstation settings.
 */
import { getWorkstation, setWorkstation } from './workstation';

export class BridgeError extends Error {
  constructor(message: string, public status = 0) {
    super(message);
  }
}

export function bridgeConfigured() {
  const w = getWorkstation();
  return Boolean(w.bridgeUrl && w.bridgeToken);
}

export async function bridge<T = any>(path: string, body?: unknown, timeoutMs = 40_000, signal?: AbortSignal): Promise<T> {
  const w = getWorkstation();
  if (!w.bridgeUrl || !w.bridgeToken) throw new BridgeError('This computer is not paired with the Afey device bridge. Set it up under Hardware → This computer.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const cancel = () => ctrl.abort();
  signal?.addEventListener('abort', cancel);
  try {
    const res = await fetch(`${w.bridgeUrl.replace(/\/$/, '')}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Afey-Bridge-Token': w.bridgeToken },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new BridgeError(data?.error ?? `Device bridge returned ${res.status}`, res.status);
    return data as T;
  } catch (e) {
    if (e instanceof BridgeError) throw e;
    if (signal?.aborted) throw new BridgeError('Cancelled');
    throw new BridgeError(ctrl.signal.aborted ? 'The fingerprint reader timed out' : 'Cannot reach the Afey device bridge on this computer. Is it running?');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

export interface BridgeStatus {
  ok: boolean;
  printers: string[];
  fingerprint: { vendor: string; connected: boolean; model?: string; message?: string };
  biometricDevicePaired: boolean;
}

export const bridgeStatus = () => bridge<BridgeStatus>('/status', undefined, 8000);

/** Touch-only identification (or 1:1 when an email is given) for sign-in, approval or attendance. */
export function fingerprint<T = any>(purpose: 'login' | 'override' | 'attendance', extra: { email?: string; permission?: string; forUserId?: string } = {}, signal?: AbortSignal) {
  return bridge<{ data: T }>(extra.email ? '/fingerprint/verify' : '/fingerprint/identify', { purpose, ...extra }, 40_000, signal).then((r) => r.data);
}

export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:9123';

/**
 * Pairs this browser with the bridge on this PC without copying the token: the bridge gives it only to Afey POS
 * pages (the addresses it was installed for). Saves the address and token for this computer.
 */
export async function pairBridge(url = DEFAULT_BRIDGE_URL): Promise<BridgeStatus> {
  let res: Response;
  try {
    res = await fetch(`${url.replace(/\/$/, '')}/pair`, { signal: AbortSignal.timeout(4000) });
  } catch {
    throw new BridgeError('The device bridge is not running on this computer yet. Run the installer first (step 1), then press Connect again.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 403) throw new BridgeError(`The bridge on this PC was installed for another address. Download the installer again from this page (${window.location.origin}) and run it.`, 403);
  if (!res.ok || !data?.token) throw new BridgeError(data?.error ?? `Device bridge returned ${res.status}`, res.status);
  setWorkstation({ bridgeUrl: url, bridgeToken: data.token });
  return bridgeStatus();
}

/**
 * A ready-made installer for this till: a .cmd file with this Afey POS address filled in. Double-clicked, it asks
 * for administrator rights once, then installs the bridge from this server (no GitHub, no build tools).
 */
export function bridgeInstallerCmd(origin = window.location.origin): string {
  const ps = `& ([scriptblock]::Create((Invoke-RestMethod '${origin}/api/v1/public/bridge/install.ps1' -UseBasicParsing))) -ServerUrl '${origin}' -SourceUrl '${origin}/api/v1/public/bridge/files'`;
  return [
    '@echo off',
    'title Afey POS device bridge installer',
    'rem Installs the Afey device bridge on this till PC, for the receipt printer and cash drawer.',
    'net session >nul 2>&1',
    'if %errorlevel% neq 0 (',
    '  echo Asking for administrator rights...',
    `  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"`,
    '  exit /b',
    ')',
    `powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps.replace(/"/g, '\\"')}"`,
    'echo.',
    'echo Done. Go back to Afey POS in the browser and press Connect.',
    'pause',
    '',
  ].join('\r\n');
}
