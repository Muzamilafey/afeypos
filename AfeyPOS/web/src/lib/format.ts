import { formatMoney, paymentProviderLabel } from '@afeypos/shared';

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

const PAYMENT_LABELS: Record<string, string> = { cash: 'Cash', mpesa: 'M-Pesa', card: 'Card', bank: 'Bank', credit: 'On account', loyalty: 'Loyalty points', voucher: 'Gift voucher', gateway: 'Mobile money / online', other: 'Other' };
/** Payment method label; gateway payments show their provider (e.g. "Paystack"). */
export const paymentLabel = (method: string, provider?: string | null) => (method === 'gateway' && provider ? paymentProviderLabel(provider) : (PAYMENT_LABELS[method] ?? method));

/**
 * Part of a phone number for the till screen: 254712345678 → 0712 ••• 678. Safaricom's own masking
 * (e.g. 2547****678) is shown as sent; a hashed number (newer C2B confirmations) is not shown at all.
 */
export function maskPhone(phone?: string | null): string {
  const p = String(phone ?? '').trim();
  if (!p || /^[a-f0-9]{32,}$/i.test(p)) return '';
  if (/[*x•]/i.test(p)) return p.replace(/^254/, '0');
  const d = p.replace(/\D/g, '');
  if (d.length < 9) return '';
  const local = d.startsWith('254') ? `0${d.slice(3)}` : d.startsWith('0') ? d : `0${d}`;
  return `${local.slice(0, 4)} ••• ${local.slice(-3)}`;
}

/** Who paid an M-Pesa payment, as M-Pesa reported it: "JANE WANJIKU (0712 ••• 678)". */
export function mpesaPayer(i: { payerName?: string | null; phone?: string | null }): string {
  const name = String(i.payerName ?? '').trim().replace(/\s+/g, ' ');
  const phone = maskPhone(i.phone);
  return name && phone ? `${name} (${phone})` : name || phone;
}
