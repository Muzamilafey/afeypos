import type { ProductDoc } from '../../models/index.js';
import { badRequest } from '../../lib/errors.js';

export interface ResolvedUnit {
  code: string;
  name: string;
  factor: number;
  prices: { retail?: number | null; wholesale?: number | null; contractor?: number | null };
}

/** Returns the unit definition (with conversion factor to the base unit) for a product. */
export function resolveUnit(product: Pick<ProductDoc, 'baseUnit' | 'units' | 'name'>, code?: string | null): ResolvedUnit {
  const c = code ?? product.baseUnit;
  const u = product.units.find((x) => x.code === c);
  if (u) return { code: u.code, name: u.name, factor: u.factor, prices: (u.prices ?? {}) as ResolvedUnit['prices'] };
  if (c === product.baseUnit) return { code: c, name: c, factor: 1, prices: {} };
  throw badRequest(`${product.name} is not sold in unit "${c}"`);
}

export function defaultSaleUnit(product: Pick<ProductDoc, 'baseUnit' | 'units'>): string {
  return product.units.find((u) => u.isDefaultSale)?.code ?? product.baseUnit;
}

export function defaultPurchaseUnit(product: Pick<ProductDoc, 'baseUnit' | 'units'>): string {
  return product.units.find((u) => u.isDefaultPurchase)?.code ?? product.baseUnit;
}
