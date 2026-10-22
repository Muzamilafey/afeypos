import { formatMoney } from '@afeypos/shared';

let currency = 'KES';
let locale = 'en-KE';
let timezone = 'Africa/Nairobi';

export function configureFormat(opts: { currency?: string; locale?: string; timezone?: string }) {
  currency = opts.currency ?? currency;
  locale = opts.locale ?? locale;
  timezone = opts.timezone ?? timezone;
}

export const money = (cents: number | null | undefined) => formatMoney(cents ?? 0, currency, locale);

/** Parses a user-typed amount ("1,250.50") into cents. */
export function toCentsInput(v: string): number {
  const n = Number(String(v).replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

export const fromCentsInput = (c: number | null | undefined) => (c === null || c === undefined ? '' : (c / 100).toFixed(2));

export const dateTime = (d: string | Date | null | undefined) =>
  d ? new Date(d).toLocaleString(locale, { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' }) : '—';

export const date = (d: string | Date | null | undefined) => (d ? new Date(d).toLocaleDateString(locale, { timeZone: timezone, dateStyle: 'medium' }) : '—');

export const qty = (n: number | null | undefined) => (n ?? 0).toLocaleString(locale, { maximumFractionDigits: 3 });

export function todayLocal(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function daysAgoLocal(days: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() - days * 86400_000));
}

const PAYMENT_LABELS: Record<string, string> = { cash: 'Cash', mpesa: 'M-Pesa', card: 'Card', bank: 'Bank', credit: 'On account', loyalty: 'Loyalty points', other: 'Other' };
export const paymentLabel = (method: string) => PAYMENT_LABELS[method] ?? method;
