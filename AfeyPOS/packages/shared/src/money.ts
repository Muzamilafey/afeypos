/**
 * Monetary values are stored and calculated as integer minor units (cents).
 * Quantities may be fractional (e.g. 2.5 metres) and are rounded to 3 decimals.
 * Never use floating point arithmetic on money directly - go through these helpers.
 */
export type Cents = number;

export const QTY_DECIMALS = 3;
const QTY_FACTOR = 10 ** QTY_DECIMALS;

export function assertCents(value: number, label = 'amount'): Cents {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be an integer number of cents`);
  return value;
}

/** Converts a major-unit amount ("12.50" or 12.5) to cents, rounding half away from zero. */
export function toCents(major: number | string): Cents {
  const n = typeof major === 'string' ? Number(major.trim()) : major;
  if (!Number.isFinite(n)) throw new Error(`Invalid money amount: ${major}`);
  // Use string-based rounding to avoid 1.005 * 100 = 100.49999 errors.
  const sign = n < 0 ? -1 : 1;
  const [int, frac = ''] = Math.abs(n).toFixed(6).split('.');
  const cents = Number(int) * 100 + Number(frac.slice(0, 2)) + (Number(frac[2] ?? '0') >= 5 ? 1 : 0);
  return sign * cents;
}

export function fromCents(cents: Cents): number {
  return cents / 100;
}

export function formatMoney(cents: Cents, currency = 'KES', locale = 'en-KE'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: 2 }).format(cents / 100);
}

export function roundQty(qty: number): number {
  return Math.round((qty + Number.EPSILON * Math.sign(qty)) * QTY_FACTOR) / QTY_FACTOR;
}

/** qty x unit price (in cents) rounded to the nearest cent. */
export function lineAmount(qty: number, unitPriceCents: Cents): Cents {
  return Math.round(roundQty(qty) * unitPriceCents);
}

/** Percentage expressed in basis points (1% = 100bp). */
export function percentOf(amount: Cents, basisPoints: number): Cents {
  return Math.round((amount * basisPoints) / 10000);
}

export interface TaxResult {
  net: Cents;
  tax: Cents;
  gross: Cents;
}

/** Calculates tax for an amount. rate is in basis points (16% VAT = 1600). */
export function calculateTax(amount: Cents, rateBp: number, inclusive: boolean): TaxResult {
  if (rateBp <= 0) return { net: amount, tax: 0, gross: amount };
  if (inclusive) {
    const tax = Math.round((amount * rateBp) / (10000 + rateBp));
    return { net: amount - tax, tax, gross: amount };
  }
  const tax = percentOf(amount, rateBp);
  return { net: amount, tax, gross: amount + tax };
}

/**
 * Splits an amount into parts proportionally to weights, distributing remainder cents
 * so the parts always sum exactly to the total (largest remainder method).
 */
export function allocateProportionally(total: Cents, weights: number[]): Cents[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) return weights.map((_, i) => (i === 0 ? total : 0));
  const raw = weights.map((w) => (total * w) / sum);
  const floored = raw.map((r) => Math.floor(r));
  let remainder = total - floored.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floored[i] += 1;
    remainder -= 1;
  }
  return floored;
}
