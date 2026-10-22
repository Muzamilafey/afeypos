import { createHmac, timingSafeEqual } from 'node:crypto';
import { IntegrationError } from '../http.js';
import type { WebhookInput } from './types.js';

/** Major units for providers that take decimal amounts, e.g. 12345 cents -> 123.45 */
export const major = (cents: number) => Math.round(cents) / 100;

/** "123.45", "100" — for providers that take string amounts. */
export const majorString = (cents: number) => (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2));

/** Parses a provider amount in major units (number or string) back to integer cents. */
export function toCents(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : undefined;
}

export function header(input: WebhookInput, name: string): string {
  const v = input.headers[name.toLowerCase()];
  return (Array.isArray(v) ? v[0] : v) ?? '';
}

export function hmacHex(algorithm: 'sha256' | 'sha512', key: string, data: Buffer | string): string {
  return createHmac(algorithm, key).update(data).digest('hex');
}

/** Constant-time comparison of two strings (false when lengths differ). */
export function secureCompare(a: string, b: string): boolean {
  const x = Buffer.from(a ?? '');
  const y = Buffer.from(b ?? '');
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

export function requireSecret(secrets: Record<string, any>, key: string, label: string): string {
  const v = secrets[key];
  if (!v) throw new IntegrationError(`${label} is not configured`, undefined, undefined, false);
  return String(v);
}

/** International dialling code for a currency, with channel hints for shared currencies (XAF, XOF, USD). */
export function dialCode(currency: string, channel?: string): string {
  const byChannel: Record<string, string> = { CMR: '237', COD: '243', CIV: '225', SEN: '221', BEN: '229', GAB: '241', COG: '242' };
  const suffix = channel?.split('_').pop() ?? '';
  if (byChannel[suffix]) return byChannel[suffix];
  const byCurrency: Record<string, string> = {
    KES: '254', UGX: '256', TZS: '255', RWF: '250', ZMW: '260', MWK: '265', GHS: '233', NGN: '234', ZAR: '27', CDF: '243', XAF: '237', XOF: '225', MZN: '258', SLE: '232', ETB: '251',
  };
  return byCurrency[currency.toUpperCase()] ?? '254';
}

/** Normalises a phone number to E.164 digits (no '+') using the given country dialling code. */
export function toMsisdn(input: string, dial: string): string | null {
  let d = input.replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = dial + d.slice(1);
  else if (!d.startsWith(dial) && d.length <= 10) d = dial + d;
  return /^\d{10,15}$/.test(d) ? d : null;
}

/** National significant number, e.g. 254712345678 -> 712345678 */
export const nationalNumber = (msisdn: string, dial: string) => (msisdn.startsWith(dial) ? msisdn.slice(dial.length) : msisdn);

/** Keeps letters, digits and spaces, e.g. alnum('Sale #12!', 22) -> 'Sale 12' */
export const alnum = (s: string, max: number) => s.replace(/[^A-Za-z0-9 ]/g, '').trim().slice(0, max);

export function splitName(name?: string): { first: string; last: string } {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] ?? 'Customer', last: parts.slice(1).join(' ') || 'POS' };
}

/** Cached OAuth client-credentials token per (provider, key). */
const tokens = new Map<string, { token: string; expiresAt: number }>();
export async function cachedToken(cacheKey: string, fetchToken: () => Promise<{ token: string; expiresIn?: number }>): Promise<string> {
  const c = tokens.get(cacheKey);
  if (c && c.expiresAt > Date.now() + 30_000) return c.token;
  const t = await fetchToken();
  if (!t.token) throw new IntegrationError('The provider did not return an access token', undefined, undefined, false);
  tokens.set(cacheKey, { token: t.token, expiresAt: Date.now() + (t.expiresIn ?? 3000) * 1000 });
  return t.token;
}
