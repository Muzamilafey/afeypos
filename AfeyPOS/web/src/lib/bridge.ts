/**
 * The Afey device bridge on this till PC (printers, drawer, scale, fingerprint reader). Its address and
 * pairing token are per computer, kept with the workstation settings.
 */
import { getWorkstation } from './workstation';

export class BridgeError extends Error {
  constructor(message: string, public status = 0) {
    super(message);
  }
}

export function bridgeConfigured() {
  const w = getWorkstation();
  return Boolean(w.bridgeUrl && w.bridgeToken);
}

export async function bridge<T = any>(path: string, body?: unknown, timeoutMs = 40_000): Promise<T> {
  const w = getWorkstation();
  if (!w.bridgeUrl || !w.bridgeToken) throw new BridgeError('This computer is not paired with the Afey device bridge. Set it up under Hardware → This computer.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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
    throw new BridgeError(ctrl.signal.aborted ? 'The fingerprint reader timed out' : 'Cannot reach the Afey device bridge on this computer. Is it running?');
  } finally {
    clearTimeout(timer);
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
export function fingerprint<T = any>(purpose: 'login' | 'override' | 'attendance', extra: { email?: string; permission?: string; forUserId?: string } = {}) {
  return bridge<{ data: T }>(extra.email ? '/fingerprint/verify' : '/fingerprint/identify', { purpose, ...extra }).then((r) => r.data);
}
