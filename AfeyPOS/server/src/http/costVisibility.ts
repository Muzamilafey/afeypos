/**
 * Cost prices and profit are hidden from users without `products.cost` (e.g. cashiers): the fields are removed
 * from every JSON response, so no endpoint can show them by accident. Supplier prices on purchasing documents
 * (unitCostCents) stay visible to staff who handle purchasing or receiving, since they work from supplier invoices.
 */
import type { Request, RequestHandler } from 'express';

const COST_KEYS = new Set(['costCents', 'avgCostCents', 'estCostCents', 'totalCostCents', 'stockValueCents', 'grossProfitCents', 'profitCents', 'netProfitCents', 'operatingProfitCents', 'marginBp', 'margin30Bp', 'costValueCents']);

function strip(v: unknown, keys: Set<string>, depth = 0): unknown {
  if (depth > 12 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => strip(x, keys, depth + 1));
  if (v instanceof Date || (v as { _bsontype?: string })._bsontype) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (!keys.has(k)) out[k] = strip(x, keys, depth + 1);
  return out;
}

/** Field names to hide for this user, or null when they may see costs. */
export function hiddenCostKeys(req: Request): Set<string> | null {
  const p = req.auth?.permissions;
  if (!p || p.has('products.cost')) return null;
  const keys = new Set(COST_KEYS);
  if (!p.has('purchasing.read') && !p.has('inventory.receive')) keys.add('unitCostCents');
  return keys;
}

/** For CSV and other non-JSON output built from rows. */
export const withoutCosts = <T>(req: Request, rows: T): T => {
  const keys = hiddenCostKeys(req);
  return keys ? (strip(rows, keys) as T) : rows;
};

export const hideCostsUnlessPermitted: RequestHandler = (req, res, next) => {
  const keys = hiddenCostKeys(req);
  if (!keys) return next();
  const json = res.json.bind(res);
  res.json = (body: unknown) => json(strip(JSON.parse(JSON.stringify(body ?? null)), keys));
  next();
};
