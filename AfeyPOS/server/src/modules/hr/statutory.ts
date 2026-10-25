/**
 * Kenyan statutory payroll deductions (monthly), in cents.
 *
 * Rules in force from February 2025 (confirm with KRA, SHA and NSSF before filing; rates change in Finance Acts):
 *  - NSSF (NSSF Act 2013, year 3): 6 % employee + 6 % employer. Tier I on pay up to the lower earnings limit
 *    (KES 8,000); Tier II on pay between KES 8,000 and the upper earnings limit (KES 72,000).
 *  - SHIF (Social Health Insurance Act 2023): 2.75 % of gross pay, minimum KES 300.
 *  - Affordable Housing Levy: 1.5 % employee + 1.5 % employer of gross pay.
 *  - PAYE: NSSF (and other registered pension up to KES 30,000), SHIF and the Housing Levy are deducted
 *    before tax (Tax Laws (Amendment) Act 2024). Monthly bands 10 % to 24,000; 25 % to 32,333; 30 % to 500,000;
 *    32.5 % to 800,000; 35 % above. Personal relief KES 2,400.
 *  - NITA industrial training levy: KES 50 per employee per month, paid by the employer.
 */
export interface KenyaRules {
  name: string;
  nssf: { rateBp: number; lowerLimitCents: number; upperLimitCents: number };
  shif: { rateBp: number; minimumCents: number };
  ahl: { employeeBp: number; employerBp: number };
  paye: { bands: { uptoCents: number | null; rateBp: number }[]; personalReliefCents: number; pensionLimitCents: number };
  nitaCents: number;
}

export const KENYA_2025: KenyaRules = {
  name: 'Kenya 2025 (NSSF year 3, SHIF, Housing Levy, PAYE after deductions)',
  nssf: { rateBp: 600, lowerLimitCents: 800_000, upperLimitCents: 7_200_000 },
  shif: { rateBp: 275, minimumCents: 30_000 },
  ahl: { employeeBp: 150, employerBp: 150 },
  paye: {
    bands: [
      { uptoCents: 2_400_000, rateBp: 1000 },
      { uptoCents: 3_233_300, rateBp: 2500 },
      { uptoCents: 50_000_000, rateBp: 3000 },
      { uptoCents: 80_000_000, rateBp: 3250 },
      { uptoCents: null, rateBp: 3500 },
    ],
    personalReliefCents: 240_000,
    pensionLimitCents: 3_000_000,
  },
  nitaCents: 5_000,
};

const pct = (cents: number, bp: number) => Math.round((cents * bp) / 10_000);

export function nssf(grossCents: number, r = KENYA_2025) {
  const tier1 = pct(Math.min(grossCents, r.nssf.lowerLimitCents), r.nssf.rateBp);
  const tier2 = pct(Math.max(0, Math.min(grossCents, r.nssf.upperLimitCents) - r.nssf.lowerLimitCents), r.nssf.rateBp);
  return { tier1, tier2, employee: tier1 + tier2, employer: tier1 + tier2 };
}

export function shif(grossCents: number, r = KENYA_2025) {
  return grossCents <= 0 ? 0 : Math.max(r.shif.minimumCents, pct(grossCents, r.shif.rateBp));
}

export function payeOn(taxableCents: number, r = KENYA_2025) {
  let tax = 0;
  let lower = 0;
  for (const b of r.paye.bands) {
    const upper = b.uptoCents ?? Infinity;
    if (taxableCents > lower) tax += ((Math.min(taxableCents, upper) - lower) * b.rateBp) / 10_000;
    lower = upper;
  }
  return Math.round(tax);
}

export interface PayInput {
  /** Everything paid this month (basic, allowances, overtime) less unpaid leave. */
  grossCents: number;
  /** Allowances that are not taxable (e.g. qualifying per diem); still part of gross for SHIF and the levy. */
  nonTaxableCents?: number;
  /** Registered pension contributions on top of NSSF. */
  pensionCents?: number;
}

export function kenyaStatutory(input: PayInput, r = KENYA_2025) {
  const gross = Math.max(0, Math.round(input.grossCents));
  const n = nssf(gross, r);
  const sh = shif(gross, r);
  const ahl = pct(gross, r.ahl.employeeBp);
  const ahlEmployer = pct(gross, r.ahl.employerBp);
  const pension = Math.min(Math.max(0, input.pensionCents ?? 0), Math.max(0, r.paye.pensionLimitCents - n.employee));
  const taxable = Math.max(0, gross - (input.nonTaxableCents ?? 0) - n.employee - pension - sh - ahl);
  const payeBeforeRelief = payeOn(taxable, r);
  const relief = Math.min(r.paye.personalReliefCents, payeBeforeRelief);
  const paye = payeBeforeRelief - relief;
  return {
    grossCents: gross,
    nssfCents: n.employee,
    nssfEmployerCents: n.employer,
    shifCents: sh,
    ahlCents: ahl,
    ahlEmployerCents: ahlEmployer,
    pensionCents: pension,
    taxablePayCents: taxable,
    payeBeforeReliefCents: payeBeforeRelief,
    personalReliefCents: relief,
    payeCents: paye,
    nitaCents: gross > 0 ? r.nitaCents : 0,
    /** Before other deductions and advance recoveries. */
    netAfterStatutoryCents: gross - n.employee - pension - sh - ahl - paye,
  };
}
