/** Small fetch wrapper with timeout for outbound integrations. */
export class IntegrationError extends Error {
  constructor(message: string, public status?: number, public body?: unknown, public retryable = true) {
    super(message);
  }
}

export async function httpJson<T = any>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 15000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let body: any = text;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      /* non-JSON */
    }
    if (!res.ok) throw new IntegrationError(`HTTP ${res.status} from ${new URL(url).host}`, res.status, body, res.status >= 500 || res.status === 429);
    return body as T;
  } catch (err: any) {
    if (err instanceof IntegrationError) throw err;
    if (err?.name === 'AbortError') throw new IntegrationError(`Timeout calling ${new URL(url).host}`);
    throw new IntegrationError(`Network error calling ${new URL(url).host}: ${err?.message}`);
  } finally {
    clearTimeout(t);
  }
}
