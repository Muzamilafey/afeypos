/**
 * API client. The access token lives in memory only; the refresh token is an httpOnly cookie.
 * On 401 the client performs one single-flight refresh and retries the request.
 */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) {
    super(message);
  }
}

type Scope = 'tenant';
const tokens: Record<Scope, string | null> = { tenant: null };
const refreshing: Partial<Record<Scope, Promise<boolean>>> = {};
let onSessionExpired: ((scope: Scope) => void) | null = null;

export function setAccessToken(token: string | null, scope: Scope = 'tenant') {
  tokens[scope] = token;
}
export function getAccessToken(scope: Scope = 'tenant') {
  return tokens[scope];
}
export function onExpired(fn: (scope: Scope) => void) {
  onSessionExpired = fn;
}

function headers(extra: Record<string, string> = {}, scope: Scope): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json', ...extra };
  const t = tokens[scope];
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
}

async function refresh(scope: Scope): Promise<boolean> {
  if (!refreshing[scope]) {
    refreshing[scope] = (async () => {
      try {
        const res = await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include', headers: headers({}, scope) });
        if (!res.ok) return false;
        const body = await res.json();
        tokens[scope] = body.accessToken;
        return true;
      } catch {
        return false;
      } finally {
        setTimeout(() => delete refreshing[scope], 0);
      }
    })();
  }
  return refreshing[scope]!;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, unknown>;
  idempotencyKey?: string;
  scope?: Scope;
  raw?: boolean;
}

export async function api<T = any>(path: string, opts: RequestOptions = {}): Promise<T> {
  const scope = opts.scope ?? 'tenant';
  const base = '/api/v1';
  const qs = opts.query
    ? '?' + new URLSearchParams(Object.entries(opts.query).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])).toString()
    : '';
  const exec = () =>
    fetch(base + path + qs, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      credentials: 'include',
      headers: headers({ ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}) }, scope),
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  let res: Response;
  try {
    res = await exec();
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the Afey POS server. Check the network connection.');
  }
  if (res.status === 401 && !path.startsWith('/auth/login') && !path.includes('/auth/refresh')) {
    if (await refresh(scope)) res = await exec();
    else {
      tokens[scope] = null;
      onSessionExpired?.(scope);
    }
  }
  if (opts.raw) return res as unknown as T;
  const text = await res.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'ERROR', e.message ?? `Request failed (${res.status})`, e.details);
  }
  return data as T;
}

export async function tryRestoreSession(scope: Scope = 'tenant') {
  return refresh(scope);
}

/**
 * Random v4 UUID. crypto.randomUUID() only exists in secure contexts (HTTPS or localhost), but shop tills
 * usually open the local server over plain HTTP (http://192.168.x.x:9999), so fall back to getRandomValues.
 */
export function newRequestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export async function download(path: string, filename: string, query?: Record<string, unknown>) {
  const res = await api<Response>(path, { raw: true, query });
  if (!res.ok) throw new ApiError(res.status, 'DOWNLOAD', 'Download failed');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Opens server-rendered HTML (receipts, documents) in a print window. */
export async function openPrintable(path: string) {
  const res = await api<Response>(path, { raw: true });
  const html = await res.text();
  const w = window.open('', '_blank', 'width=420,height=700');
  if (!w) throw new ApiError(0, 'POPUP', 'Allow pop-ups to print');
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.onload = () => w.print();
  setTimeout(() => w.print(), 400);
}
