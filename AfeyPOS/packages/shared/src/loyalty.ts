/**
 * Customer loyalty program (Loyalty & vouchers > Program): how points are earned and spent.
 * Tiers come from the CRM spend tiers (12-month spend); each tier can earn faster.
 */
export interface LoyaltyProgram {
  /** Shown to staff and on loyalty cards, e.g. "Mandera Rewards". */
  name: string;
  /** Spend that earns one point, in cents (10000 = 1 point per KES 100). */
  pointsPerUnitCents: number;
  /** What one point is worth when paying, in cents (100 = KES 1). */
  pointValueCents: number;
  /** Fewest points a customer can pay with at once. */
  minRedeemPoints: number;
  /** Largest share of a sale that may be paid with points, in basis points (5000 = 50%). */
  maxRedeemBp: number;
  /** Points given once when a customer joins (gets a card). */
  welcomeBonus: number;
  /** Earning speed per CRM tier name, in basis points (10000 = normal, 15000 = 1.5 times). */
  tierMultipliersBp: Record<string, number>;
}

export const LOYALTY_DEFAULTS: LoyaltyProgram = {
  name: 'Rewards',
  pointsPerUnitCents: 10000,
  pointValueCents: 100,
  minRedeemPoints: 0,
  maxRedeemBp: 10000,
  welcomeBonus: 0,
  tierMultipliersBp: {},
};

const int = (v: unknown, d: number, min = 0, max = Number.MAX_SAFE_INTEGER) => (typeof v === 'number' && Number.isInteger(v) && v >= min ? Math.min(v, max) : d);

/** The saved program (settings.loyalty) over the defaults. */
export function mergeLoyalty(saved: unknown): LoyaltyProgram {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Partial<LoyaltyProgram>;
  const tiers: Record<string, number> = {};
  for (const [k, v] of Object.entries(s.tierMultipliersBp ?? {})) if (typeof v === 'number' && v >= 0 && v <= 100_000) tiers[k] = Math.round(v);
  return {
    name: typeof s.name === 'string' && s.name.trim() ? s.name.trim().slice(0, 40) : LOYALTY_DEFAULTS.name,
    pointsPerUnitCents: int(s.pointsPerUnitCents, LOYALTY_DEFAULTS.pointsPerUnitCents, 1),
    pointValueCents: int(s.pointValueCents, LOYALTY_DEFAULTS.pointValueCents, 1),
    minRedeemPoints: int(s.minRedeemPoints, LOYALTY_DEFAULTS.minRedeemPoints),
    maxRedeemBp: int(s.maxRedeemBp, LOYALTY_DEFAULTS.maxRedeemBp, 0, 10000),
    welcomeBonus: int(s.welcomeBonus, LOYALTY_DEFAULTS.welcomeBonus, 0, 1_000_000),
    tierMultipliersBp: tiers,
  };
}

/** Points earned on a sale: whole points only, faster for higher tiers. */
export function pointsEarned(program: LoyaltyProgram, eligibleCents: number, tier?: string | null): number {
  if (eligibleCents <= 0) return 0;
  const mult = (tier && program.tierMultipliersBp[tier]) || 10000;
  return Math.floor((eligibleCents * mult) / (program.pointsPerUnitCents * 10000));
}

/** Most points a sale of this total can take, under the program's limits. */
export function maxRedeemablePoints(program: LoyaltyProgram, saleTotalCents: number, balance: number): number {
  const cap = Math.floor((saleTotalCents * program.maxRedeemBp) / 10000 / program.pointValueCents);
  const n = Math.max(0, Math.min(balance, cap));
  return n < program.minRedeemPoints ? 0 : n;
}

/** Loyalty card numbers: "LC" and 10 digits, printed as a barcode on the card. */
export const LOYALTY_CARD_RE = /^LC\d{10}$/;
/** Voucher codes: "GV-" and 8 letters/digits without look-alikes (0/O, 1/I). */
export const VOUCHER_CODE_RE = /^GV-[A-HJ-NP-Z2-9]{8}$/;
