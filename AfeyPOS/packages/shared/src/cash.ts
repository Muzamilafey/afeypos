/** Notes and coins for counting a till drawer (opening float and end of shift), by currency. */
export interface Denomination {
  /** Key used when saving a count, e.g. "note-1000", "coin-20". */
  key: string;
  kind: 'note' | 'coin';
  /** Face value in cents. */
  valueCents: number;
}

const make = (notes: number[], coins: number[]): Denomination[] => [
  ...notes.map((v) => ({ key: `note-${v}`, kind: 'note' as const, valueCents: Math.round(v * 100) })),
  ...coins.map((v) => ({ key: `coin-${v}`, kind: 'coin' as const, valueCents: Math.round(v * 100) })),
];

export const CASH_DENOMINATIONS: Record<string, Denomination[]> = {
  // Kenya: notes 1000, 500, 200, 100, 50; coins 20, 10, 5, 1 (and the 50-cent coin).
  KES: make([1000, 500, 200, 100, 50], [20, 10, 5, 1, 0.5]),
  UGX: make([50000, 20000, 10000, 5000, 2000, 1000], [1000, 500, 200, 100, 50]),
  TZS: make([10000, 5000, 2000, 1000, 500], [500, 200, 100, 50]),
  RWF: make([5000, 2000, 1000, 500], [100, 50, 20, 10, 5]),
  USD: make([100, 50, 20, 10, 5, 2, 1], [0.25, 0.1, 0.05, 0.01]),
};

/** Total of a count ({ "note-1000": 3, "coin-20": 5 }) in cents; unknown keys are ignored. */
export function denominationTotalCents(counts: Record<string, number>, list: Denomination[]): number {
  return list.reduce((a, d) => a + (Number.isInteger(counts[d.key]) && counts[d.key]! > 0 ? counts[d.key]! * d.valueCents : 0), 0);
}

export const denominationsFor = (currency?: string | null): Denomination[] | null => CASH_DENOMINATIONS[(currency ?? 'KES').toUpperCase()] ?? null;
