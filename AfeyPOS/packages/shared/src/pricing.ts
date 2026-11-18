/**
 * Price maths for the product wizard and editor. Integer cents and basis points throughout (1% = 100 bp).
 * These only calculate and warn: nothing here changes a price by itself.
 */

/** Gross margin in bp: (price - cost) / price. Null when there is no price. */
export function marginBp(costCents: number, priceCents: number | null | undefined): number | null {
  if (!priceCents || priceCents <= 0) return null;
  return Math.round(((priceCents - costCents) * 10000) / priceCents);
}

/** Markup in bp: (price - cost) / cost. Null when there is no cost. */
export function markupBp(costCents: number, priceCents: number | null | undefined): number | null {
  if (!costCents || costCents <= 0 || priceCents === null || priceCents === undefined) return null;
  return Math.round(((priceCents - costCents) * 10000) / costCents);
}

/** Price giving this margin on the cost (margin must be below 100%). */
export function priceForMargin(costCents: number, margin: number): number | null {
  if (margin >= 10000 || costCents <= 0) return null;
  return Math.round((costCents * 10000) / (10000 - margin));
}

/** Price giving this markup on the cost. */
export function priceForMarkup(costCents: number, markup: number): number | null {
  if (costCents <= 0 || markup <= -10000) return null;
  return Math.round((costCents * (10000 + markup)) / 10000);
}

/** Tax-inclusive price from a tax-exclusive one. */
export function addTax(exclusiveCents: number, rateBp: number): number {
  return Math.round((exclusiveCents * (10000 + rateBp)) / 10000);
}

/** Tax-exclusive price from a tax-inclusive one. */
export function removeTax(inclusiveCents: number, rateBp: number): number {
  return Math.round((inclusiveCents * 10000) / (10000 + rateBp));
}

/** Gross profit per unit in cents, on the tax-exclusive price when prices include tax. */
export function grossProfitCents(costCents: number, priceCents: number, opts: { pricesIncludeTax: boolean; taxRateBp: number }): number {
  const net = opts.pricesIncludeTax ? removeTax(priceCents, opts.taxRateBp) : priceCents;
  return net - costCents;
}

export interface PriceWarning { level: 'error' | 'warn'; field: string; message: string }

/**
 * Checks a product's prices against its cost and minimum price. Errors are prices the business would lose money on
 * or that break its own rules; warnings are worth a second look. Cost is per base unit, tax-exclusive.
 */
export function pricingWarnings(p: {
  costCents: number;
  retailCents?: number | null;
  wholesaleCents?: number | null;
  minPriceCents?: number | null;
  pricesIncludeTax: boolean;
  taxRateBp: number;
  units?: { code: string; factor: number; retailCents?: number | null }[];
  branchPrices?: { name: string; retailCents?: number | null }[];
}): PriceWarning[] {
  const out: PriceWarning[] = [];
  const net = (c: number) => (p.pricesIncludeTax ? removeTax(c, p.taxRateBp) : c);
  const check = (field: string, label: string, price: number | null | undefined, factor = 1) => {
    if (price === null || price === undefined) return;
    const cost = Math.round(p.costCents * factor);
    if (p.costCents > 0 && net(price) < cost) out.push({ level: 'error', field, message: `${label} is below cost (${(net(price) / 100).toFixed(2)} vs cost ${(cost / 100).toFixed(2)} before tax)` });
    else if (p.costCents > 0 && net(price) === cost) out.push({ level: 'warn', field, message: `${label} equals cost: no profit` });
    const min = p.minPriceCents ? Math.round(p.minPriceCents * factor) : 0;
    if (min && price < min) out.push({ level: 'error', field, message: `${label} is below the minimum price (${(min / 100).toFixed(2)})` });
  };
  if (!p.retailCents) out.push({ level: 'warn', field: 'retail', message: 'No selling price: the till will ask for one or sell at 0' });
  check('retail', 'Retail price', p.retailCents);
  check('wholesale', 'Wholesale price', p.wholesaleCents);
  if (p.wholesaleCents && p.retailCents && p.wholesaleCents > p.retailCents) out.push({ level: 'warn', field: 'wholesale', message: 'Wholesale price is higher than retail' });
  if (p.minPriceCents && p.retailCents && p.minPriceCents > p.retailCents) out.push({ level: 'error', field: 'minPrice', message: 'Minimum price is higher than the retail price' });
  for (const u of p.units ?? []) check(`unit.${u.code}`, `${u.code} price`, u.retailCents, u.factor);
  for (const b of p.branchPrices ?? []) check(`branch.${b.name}`, `${b.name} price`, b.retailCents);
  const m = marginBp(p.costCents, p.retailCents ? net(p.retailCents) : null);
  if (m !== null && m > 0 && m < 500) out.push({ level: 'warn', field: 'retail', message: `Margin is only ${(m / 100).toFixed(1)}%` });
  return out;
}

/** How the product is sold; decides the base unit and whether quantities can be fractional. */
export const SELLING_METHODS = [
  { key: 'unit', label: 'By piece', hint: 'Counted items: a bottle, a bar of soap', baseUnits: ['pc'], fractional: false },
  { key: 'weight', label: 'By weight', hint: 'Weighed at the counter or on a scale: meat, sugar, vegetables', baseUnits: ['kg', 'g'], fractional: true },
  { key: 'volume', label: 'By volume', hint: 'Measured liquids: cooking oil, paraffin, milk', baseUnits: ['l', 'ml'], fractional: true },
  { key: 'length', label: 'By length', hint: 'Cut to length: cable, fabric, pipe', baseUnits: ['m', 'ft'], fractional: true },
  { key: 'area', label: 'By area', hint: 'Sold per square metre: tiles, carpet, glass', baseUnits: ['m2'], fractional: true },
  { key: 'pack', label: 'Packs & cartons', hint: 'Sold singly and by the carton or dozen', baseUnits: ['pc'], fractional: false },
  { key: 'multi_uom', label: 'Several units', hint: 'Bought in one unit, sold in others (bag and kg)', baseUnits: ['kg', 'pc', 'l', 'm'], fractional: true },
  { key: 'variants', label: 'With variants', hint: 'Sizes or colours, each with its own stock', baseUnits: ['pc'], fractional: false },
] as const;
export type SellingMethod = (typeof SELLING_METHODS)[number]['key'];

/** Common extra units per method, as factors of the base unit (e.g. g = 0.001 kg). */
export const UNIT_PRESETS: Record<string, { code: string; name: string; factor: number }[]> = {
  kg: [{ code: 'g', name: 'Gram', factor: 0.001 }, { code: 'bag', name: 'Bag (50 kg)', factor: 50 }],
  g: [{ code: 'kg', name: 'Kilogram', factor: 1000 }],
  l: [{ code: 'ml', name: 'Millilitre', factor: 0.001 }, { code: 'jerrycan', name: 'Jerrycan (20 l)', factor: 20 }],
  ml: [{ code: 'l', name: 'Litre', factor: 1000 }],
  m: [{ code: 'ft', name: 'Foot', factor: 0.3048 }, { code: 'roll', name: 'Roll (100 m)', factor: 100 }],
  ft: [{ code: 'm', name: 'Metre', factor: 3.28084 }],
  m2: [{ code: 'box', name: 'Box (1.44 m²)', factor: 1.44 }],
  pc: [{ code: 'dozen', name: 'Dozen', factor: 12 }, { code: 'ctn', name: 'Carton (24)', factor: 24 }, { code: 'pack', name: 'Pack (6)', factor: 6 }],
};

/**
 * Checks unit conversions. Every unit is defined against the base unit only, so conversions cannot loop;
 * this catches the mistakes that are still possible (duplicates, the base unit listed again, zero factors).
 */
export function unitProblems(baseUnit: string, units: { code: string; factor: number }[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const u of units) {
    if (!u.code.trim()) { out.push('A unit has no code'); continue; }
    if (u.code === baseUnit && u.factor !== 1) out.push(`${u.code} is the base unit: its factor must be 1`);
    if (seen.has(u.code)) out.push(`${u.code} is listed twice`);
    seen.add(u.code);
    if (!(u.factor > 0)) out.push(`${u.code}: the factor must be more than 0`);
  }
  return out;
}
