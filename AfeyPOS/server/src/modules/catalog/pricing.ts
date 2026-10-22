import { Types } from 'mongoose';
import type { PriceListKey } from '@afeypos/shared';
import { CustomerPrice, Promotion, type ProductDoc } from '../../models/index.js';
import { resolveUnit } from './units.js';

export interface PriceQuote {
  /** Price per selling unit before promotions/customer pricing, from the chosen price list. */
  listPriceCents: number;
  /** Price per selling unit to charge. */
  unitPriceCents: number;
  source: 'customer' | 'tier' | 'unit_price' | 'base_price' | 'promotion' | 'fallback';
  promotionId?: Types.ObjectId;
  unitFactor: number;
}

function basePrice(product: ProductDoc, list: PriceListKey): number | null {
  const p = (product.prices ?? {}) as Record<string, number | null | undefined>;
  return p[list] ?? null;
}

/**
 * Price resolution order:
 *  1. customer-specific price for the unit
 *  2. quantity tier for the price list (price per base unit x factor)
 *  3. unit price for the price list
 *  4. base price for the price list x factor
 *  5. retail unit price, then retail base price x factor
 * Then an active promotion is applied if it yields a lower price.
 */
export async function quotePrice(opts: {
  product: ProductDoc;
  unitCode?: string | null;
  qty: number;
  priceList: PriceListKey;
  customerId?: Types.ObjectId | null;
  branchId?: Types.ObjectId | null;
  couponCode?: string | null;
  at?: Date;
}): Promise<PriceQuote> {
  const { product, priceList } = opts;
  const unit = resolveUnit(product, opts.unitCode);
  const baseQty = opts.qty * unit.factor;
  const fromUnit = (list: PriceListKey) => unit.prices[list] ?? null;
  const fromBase = (list: PriceListKey) => {
    const b = basePrice(product, list);
    return b === null ? null : Math.round(b * unit.factor);
  };
  const listPrice = fromUnit(priceList) ?? fromBase(priceList) ?? fromUnit('retail') ?? fromBase('retail') ?? 0;
  let price = listPrice;
  let source: PriceQuote['source'] = fromUnit(priceList) !== null ? 'unit_price' : fromBase(priceList) !== null ? 'base_price' : 'fallback';

  if (opts.customerId) {
    const cp = await CustomerPrice.findOne({ customerId: opts.customerId, productId: product._id, unitCode: unit.code }).lean();
    if (cp) {
      price = cp.priceCents;
      source = 'customer';
    }
  }
  if (source !== 'customer') {
    const tiers = (product.priceTiers ?? []).filter((t) => t.priceList === priceList && (t.minQty ?? 0) <= baseQty).sort((a, b) => (b.minQty ?? 0) - (a.minQty ?? 0));
    if (tiers[0]?.priceCents !== undefined && tiers[0].priceCents !== null) {
      const tierPrice = Math.round(tiers[0].priceCents * unit.factor);
      if (tierPrice < price) {
        price = tierPrice;
        source = 'tier';
      }
    }
  }

  let promotionId: Types.ObjectId | undefined;
  const at = opts.at ?? new Date();
  const promos = await Promotion.find({
    active: true,
    $and: [
      { $or: [{ startsAt: null }, { startsAt: { $exists: false } }, { startsAt: { $lte: at } }] },
      { $or: [{ endsAt: null }, { endsAt: { $exists: false } }, { endsAt: { $gte: at } }] },
      { $or: [{ productIds: product._id }, ...(product.categoryId ? [{ categoryIds: product.categoryId }] : [])] },
      { $or: [{ couponCode: null }, { couponCode: { $exists: false } }, ...(opts.couponCode ? [{ couponCode: opts.couponCode.toUpperCase() }] : [])] },
    ],
  }).lean();
  for (const p of promos) {
    if (p.branchIds?.length && opts.branchId && !p.branchIds.some((b) => String(b) === String(opts.branchId))) continue;
    if ((p.minQty ?? 0) > baseQty) continue;
    if (p.maxUses && p.uses >= p.maxUses) continue;
    const candidate = p.kind === 'percent' ? Math.round(price * (1 - p.value / 10000)) : Math.round(p.value * unit.factor);
    if (candidate < price) {
      price = candidate;
      source = 'promotion';
      promotionId = p._id;
    }
  }
  return { listPriceCents: listPrice, unitPriceCents: Math.max(0, price), source, promotionId, unitFactor: unit.factor };
}
