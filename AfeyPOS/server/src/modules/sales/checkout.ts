import type { Request } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { allocateProportionally, calculateTax, lineAmount, percentOf, PRICE_LISTS, roundQty, type Permission, type PriceListKey } from '@afeypos/shared';
import {
  CashMovement, Customer, LedgerEntry, PaymentIntent, Product, Promotion, Sale, SalesDocument, SerialItem, Shift, Till, User, Branch,
} from '../../models/index.js';
import { withTransaction } from '../../db/connection.js';
import { AppError, badRequest, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { nextNumber } from '../../lib/numbering.js';
import { audit } from '../../lib/audit.js';
import { objectId, positiveCents, qty } from '../../http/validate.js';
import { assertBranchAccess, can } from '../../http/auth.js';
import { adjustReserved, applyMovement } from '../inventory/stock.js';
import { quotePrice } from '../catalog/pricing.js';
import { resolveUnit } from '../catalog/units.js';
import { consumeOverride } from '../auth/routes.js';
import { queueSaleForEtims } from '../etims/service.js';

export const PAYMENT_METHODS = ['cash', 'mpesa', 'card', 'bank', 'credit', 'loyalty', 'gateway', 'other'] as const;

export const checkoutSchema = z.object({
  clientRequestId: z.string().min(8).max(100),
  tillId: objectId,
  customerId: objectId.optional(),
  priceList: z.enum(PRICE_LISTS).optional(),
  salesRepId: objectId.optional(),
  couponCode: z.string().trim().max(40).optional(),
  lines: z
    .array(
      z.object({
        productId: objectId,
        unitCode: z.string().max(20).optional(),
        qty,
        unitPriceCents: positiveCents.optional(),
        discountCents: positiveCents.optional(),
        discountBp: z.number().int().min(0).max(10000).optional(),
        serials: z.array(z.string().trim().min(1).max(80)).max(1000).optional(),
        batchNo: z.string().max(60).optional(),
        prescriptionRef: z.string().trim().max(100).optional(),
      }),
    )
    .min(1)
    .max(500),
  cartDiscountCents: positiveCents.default(0),
  payments: z
    .array(
      z.object({
        method: z.enum(PAYMENT_METHODS),
        amountCents: positiveCents,
        tenderedCents: positiveCents.optional(),
        reference: z.string().trim().max(100).optional(),
        paymentIntentId: objectId.optional(),
      }),
    )
    .max(10)
    .default([]),
  ageVerified: z.boolean().optional(),
  overrideToken: z.string().optional(),
  salesDocumentId: objectId.optional(),
  notes: z.string().max(500).optional(),
});

export type CheckoutInput = z.infer<typeof checkoutSchema>;

/** Rejects age-restricted (liquor) sales outside the licensed hours configured for the business. */
export function assertRestrictedHours(hours: { start?: string; end?: string } | undefined, timezone: string, name: string, now = new Date()) {
  if (!hours?.start || !hours?.end) return;
  const local = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  const inside = hours.start <= hours.end ? local >= hours.start && local < hours.end : local >= hours.start || local < hours.end;
  if (!inside) throw unprocessable(`${name} can only be sold between ${hours.start} and ${hours.end}`, 'OUTSIDE_LICENSED_HOURS');
}

/** Tracks permissions granted either directly or through a single-use supervisor override. */
export class Authorizer {
  overrides: { action: string; supervisorId: Types.ObjectId; at: Date }[] = [];
  private consumed: Record<string, string> = {};
  constructor(private req: Request, private overrideToken?: string) {}
  async require(perm: Permission, action: string) {
    if (can(this.req, perm)) return;
    if (this.consumed[perm]) return;
    if (!this.overrideToken) throw new AppError(403, 'OVERRIDE_REQUIRED', `Supervisor approval required: ${action}`, { permission: perm });
    const sup = await consumeOverride(this.overrideToken, perm, String(this.req.tenant!._id), String(this.req.auth!.userId));
    if (!sup) throw new AppError(403, 'OVERRIDE_REQUIRED', `Supervisor approval required: ${action}`, { permission: perm });
    this.consumed[perm] = sup;
    this.overrideToken = undefined;
    this.overrides.push({ action, supervisorId: new Types.ObjectId(sup), at: new Date() });
  }
}

export async function checkout(req: Request, input: CheckoutInput) {
  const existing = await Sale.findOne({ clientRequestId: input.clientRequestId });
  if (existing) return { sale: existing, replay: true };
  try {
    const sale = await withTransaction(() => checkoutTx(req, input));
    return { sale, replay: false };
  } catch (err: any) {
    if (err?.code === 11000 && err?.keyPattern?.clientRequestId) {
      const dup = await Sale.findOne({ clientRequestId: input.clientRequestId });
      if (dup) return { sale: dup, replay: true };
    }
    throw err;
  }
}

async function checkoutTx(req: Request, input: CheckoutInput) {
  const tenant = req.tenant!;
  const settings = tenant.settings!;
  const caps = req.capabilities!;
  const userId = req.auth!.userId;
  const authz = new Authorizer(req, input.overrideToken);

  const dup = await Sale.findOne({ clientRequestId: input.clientRequestId });
  if (dup) return dup;

  const till = await Till.findOne({ _id: input.tillId, active: true });
  if (!till) throw notFound('Till');
  assertBranchAccess(req, till.branchId);
  const branch = await Branch.findById(till.branchId);

  let shift = null;
  if (settings.requireOpenShift) {
    shift = await Shift.findOne({ tillId: till._id, status: 'open' });
    if (!shift) throw new AppError(409, 'SHIFT_REQUIRED', 'Open a shift on this till before selling');
    if (String(shift.userId) !== String(userId) && !can(req, 'shifts.manage')) throw forbidden('This till has a shift opened by another cashier');
  }

  const customer = input.customerId ? await Customer.findOne({ _id: input.customerId, active: true }) : null;
  if (input.customerId && !customer) throw notFound('Customer');
  const priceList = (input.priceList ?? (customer?.priceList as PriceListKey | undefined) ?? caps.checkout.defaultPriceList) as PriceListKey;
  if (!caps.priceLists.includes(priceList)) throw badRequest(`Price list ${priceList} is not enabled`);

  // ---- price every line ----
  const priced = [];
  let ageVerifiedBy: Types.ObjectId | undefined;
  for (const l of input.lines) {
    const product = await Product.findOne({ _id: l.productId, active: true });
    if (!product) throw notFound('Product');
    const unit = resolveUnit(product, l.unitCode);
    const lineQty = roundQty(l.qty);
    const baseQty = roundQty(lineQty * unit.factor);
    if (!Number.isInteger(lineQty) && !(product.allowFractional && caps.checkout.allowFractionalQty)) {
      throw badRequest(`${product.name} cannot be sold in fractional quantities`);
    }
    if (product.minOrderQty > 0 && baseQty < product.minOrderQty) {
      throw unprocessable(`${product.name} has a minimum order of ${product.minOrderQty} ${product.baseUnit}`, 'MIN_ORDER_QTY');
    }
    if (product.requiresPrescription && caps.modules.includes('prescriptions') && !l.prescriptionRef) {
      throw unprocessable(`${product.name} requires a prescription reference`, 'PRESCRIPTION_REQUIRED');
    }
    if (product.ageRestricted && caps.modules.includes('ageVerification')) {
      assertRestrictedHours(settings.restrictedSaleHours as { start?: string; end?: string } | undefined, settings.timezone ?? 'Africa/Nairobi', product.name);
      if (!input.ageVerified) throw unprocessable(`${product.name} is age-restricted: confirm the customer is ${product.minAge ?? 18} or older`, 'AGE_VERIFICATION_REQUIRED');
      ageVerifiedBy = userId;
    }
    const quote = await quotePrice({ product, unitCode: unit.code, qty: lineQty, priceList, customerId: customer?._id, branchId: till.branchId, couponCode: input.couponCode });
    let unitPrice = quote.unitPriceCents;
    if (l.unitPriceCents !== undefined && l.unitPriceCents !== unitPrice) {
      await authz.require('sales.price.override', `price change on ${product.name}`);
      unitPrice = l.unitPriceCents;
    }
    const gross = lineAmount(lineQty, unitPrice);
    let discount = l.discountCents ?? (l.discountBp ? percentOf(gross, l.discountBp) : 0);
    discount = Math.min(discount, gross);
    priced.push({ input: l, product, unit, lineQty, baseQty, quote, unitPrice, gross, discount });
  }

  const linesGross = priced.reduce((a, p) => a + p.gross, 0);
  const lineDiscounts = priced.reduce((a, p) => a + p.discount, 0);
  const cartDiscount = Math.min(input.cartDiscountCents, linesGross - lineDiscounts);
  const totalDiscount = lineDiscounts + cartDiscount;
  if (totalDiscount > 0) {
    await authz.require('sales.discount', 'apply a discount');
    if (linesGross > 0 && (totalDiscount * 10000) / linesGross > (settings.cashierDiscountLimitBp ?? 0)) {
      await authz.require('sales.discount.override', `discount above ${(settings.cashierDiscountLimitBp ?? 0) / 100}%`);
    }
  }
  const cartShares = allocateProportionally(cartDiscount, priced.map((p) => p.gross - p.discount));

  // ---- tax & totals ----
  const lines = priced.map((p, i) => {
    const amount = p.gross - p.discount - cartShares[i];
    const rate = p.product.taxRateBp ?? settings.defaultTaxRateBp ?? 0;
    const tax = calculateTax(amount, rate, settings.pricesIncludeTax ?? true);
    return { ...p, cartShare: cartShares[i], rate, tax };
  });
  const totalCents = lines.reduce((a, l) => a + l.tax.gross, 0);
  const taxCents = lines.reduce((a, l) => a + l.tax.tax, 0);
  const netCents = lines.reduce((a, l) => a + l.tax.net, 0);

  // ---- payments ----
  const paymentsSum = input.payments.reduce((a, p) => a + p.amountCents, 0);
  if (paymentsSum !== totalCents) {
    throw unprocessable(`Payments (${paymentsSum / 100}) must equal the sale total (${totalCents / 100})`, 'PAYMENT_MISMATCH', { totalCents, paymentsSum });
  }
  const saleId = new Types.ObjectId();
  const number = await nextNumber('sale', 'RCP');
  const payments = [];
  let creditCents = 0;
  let changeCents = 0;
  let cashCents = 0;
  let loyaltyRedeemed = 0;
  for (const p of input.payments) {
    if (p.amountCents === 0) continue;
    const row: Record<string, unknown> = { method: p.method, amountCents: p.amountCents, reference: p.reference };
    switch (p.method) {
      case 'cash': {
        const tendered = p.tenderedCents ?? p.amountCents;
        if (tendered < p.amountCents) throw badRequest('Cash tendered is less than the cash amount');
        row.tenderedCents = tendered;
        row.changeCents = tendered - p.amountCents;
        changeCents += tendered - p.amountCents;
        cashCents += p.amountCents;
        break;
      }
      case 'mpesa':
      case 'gateway': {
        // Only provider-confirmed intents can be used, each shilling once (atomic claim).
        const isMpesa = p.method === 'mpesa';
        if (!caps.modules.includes(isMpesa ? 'mpesa' : 'payments')) throw badRequest(isMpesa ? 'M-Pesa is not enabled' : 'Payment gateways are not enabled');
        if (!p.paymentIntentId) throw badRequest('Electronic payments must reference a confirmed payment');
        const intent = await PaymentIntent.findOneAndUpdate(
          { _id: p.paymentIntentId, provider: isMpesa ? 'mpesa' : { $ne: 'mpesa' }, status: 'succeeded', $expr: { $gte: [{ $subtract: ['$paidAmountCents', '$allocatedCents'] }, p.amountCents] } },
          { $inc: { allocatedCents: p.amountCents }, $set: { allocatedTo: { kind: 'sale', id: saleId, number }, allocatedAt: new Date() } },
          { new: true },
        );
        if (!intent) throw unprocessable('The payment is not confirmed, has already been used, or is less than the amount', isMpesa ? 'MPESA_NOT_AVAILABLE' : 'PAYMENT_NOT_AVAILABLE');
        row.reference = intent.receiptNumber ?? intent.reference;
        row.paymentIntentId = intent._id;
        if (!isMpesa) row.provider = intent.provider;
        break;
      }
      case 'credit': {
        if (!caps.modules.includes('customerCredit')) throw badRequest('Customer credit is not enabled');
        if (!customer || customer.kind === 'walk_in') throw unprocessable('Select a registered customer for credit sales', 'CUSTOMER_REQUIRED');
        await authz.require('sales.credit', 'sell on credit');
        if (customer.balanceCents + p.amountCents > customer.creditLimitCents) {
          await authz.require('credit.approve', `credit above ${customer.name}'s limit`);
        }
        creditCents += p.amountCents;
        break;
      }
      case 'loyalty': {
        if (!caps.modules.includes('loyalty') || !customer) throw badRequest('Loyalty redemption requires a customer and the loyalty module');
        const value = settings.loyalty?.pointValueCents ?? 100;
        if (p.amountCents % value !== 0) throw badRequest(`Loyalty redemptions must be multiples of ${value / 100}`);
        const points = p.amountCents / value;
        const r = await Customer.updateOne({ _id: customer._id, loyaltyPoints: { $gte: points } }, { $inc: { loyaltyPoints: -points } });
        if (r.modifiedCount !== 1) throw unprocessable('Customer does not have enough loyalty points', 'INSUFFICIENT_POINTS');
        loyaltyRedeemed += points;
        break;
      }
      default:
        if (p.paymentIntentId) throw badRequest('Only M-Pesa and gateway payments can reference a payment intent');
    }
    payments.push(row);
  }

  // ---- stock ----
  const saleLines = [];
  for (const l of lines) {
    const mv = await applyMovement({
      product: l.product,
      productId: l.product._id,
      warehouseId: till.warehouseId,
      qty: -l.baseQty,
      type: 'sale',
      ref: { type: 'Sale', id: saleId, number },
      userId,
      serials: l.input.serials,
      batchNo: l.input.batchNo,
      allowNegative: settings.allowNegativeStock,
    });
    const warrantyEndsAt = l.product.warrantyMonths > 0 ? new Date(Date.now() + l.product.warrantyMonths * 30.4375 * 86400_000) : undefined;
    if (l.product.trackSerials && l.input.serials?.length) {
      await SerialItem.updateMany({ productId: l.product._id, serial: { $in: l.input.serials } }, { $set: { saleId, customerId: customer?._id, soldAt: new Date(), warrantyEndsAt } });
    }
    saleLines.push({
      productId: l.product._id,
      sku: l.product.sku,
      name: l.product.name,
      unitCode: l.unit.code,
      unitFactor: l.unit.factor,
      qty: l.lineQty,
      baseQty: l.baseQty,
      listPriceCents: l.quote.listPriceCents,
      unitPriceCents: l.unitPrice,
      discountCents: l.discount,
      cartDiscountCents: l.cartShare,
      taxRateBp: l.rate,
      taxCents: l.tax.tax,
      totalCents: l.tax.gross,
      netCents: l.tax.net,
      costCents: mv ? Math.round(mv.unitCostCents * l.baseQty) : 0,
      serials: l.input.serials?.length ? l.input.serials : undefined,
      batches: mv?.batches,
      promotionId: l.quote.promotionId,
      prescriptionRef: l.input.prescriptionRef,
      warrantyEndsAt,
    });
  }
  const promoIds = [...new Set(lines.map((l) => l.quote.promotionId).filter(Boolean).map(String))];
  if (promoIds.length) await Promotion.updateMany({ _id: { $in: promoIds } }, { $inc: { uses: 1 } });

  // ---- customer account, loyalty, commission ----
  let dueDate: Date | undefined;
  if (creditCents > 0 && customer) {
    const updated = await Customer.findOneAndUpdate({ _id: customer._id }, { $inc: { balanceCents: creditCents } }, { new: true });
    dueDate = new Date(Date.now() + (customer.paymentTermsDays ?? 30) * 86400_000);
    await LedgerEntry.create([{ partyType: 'customer', partyId: customer._id, kind: 'credit_sale', amountCents: creditCents, openCents: creditCents, balanceAfterCents: updated!.balanceCents, dueDate, ref: { type: 'Sale', id: saleId, number }, userId }]);
  }
  let loyaltyEarned = 0;
  if (customer && customer.kind !== 'walk_in' && caps.modules.includes('loyalty')) {
    const per = settings.loyalty?.pointsPerUnitCents ?? 10000;
    loyaltyEarned = Math.floor((totalCents - loyaltyRedeemed * (settings.loyalty?.pointValueCents ?? 100)) / per);
    if (loyaltyEarned > 0) await Customer.updateOne({ _id: customer._id }, { $inc: { loyaltyPoints: loyaltyEarned } });
  }
  let commissionCents = 0;
  const repId = input.salesRepId ?? customer?.salesRepId ?? undefined;
  if (repId && caps.modules.includes('salesReps')) {
    const rep = await User.findById(repId).lean();
    if (rep?.commissionRateBp) commissionCents = percentOf(netCents, rep.commissionRateBp);
  }

  if (shift && cashCents > 0) {
    await CashMovement.create([{ shiftId: shift._id, tillId: till._id, type: 'sale', amountCents: cashCents, userId, ref: { type: 'Sale', id: saleId, number } }]);
  }

  if (input.salesDocumentId) {
    const doc = await SalesDocument.findOneAndUpdate(
      { _id: input.salesDocumentId, status: { $in: ['draft', 'sent', 'accepted'] } },
      { $set: { status: 'converted', convertedSaleId: saleId } },
      { new: true },
    );
    if (!doc) throw unprocessable('The quotation/order cannot be converted (already converted, cancelled or expired)', 'DOCUMENT_NOT_CONVERTIBLE');
    if (doc.stockReserved && doc.warehouseId) {
      for (const l of doc.lines) await adjustReserved(l.productId!, doc.warehouseId, -roundQty((l.qty ?? 0) * (l.unitFactor ?? 1)));
      await SalesDocument.updateOne({ _id: doc._id }, { $set: { stockReserved: false } });
    }
  }

  const [sale] = await Sale.create([
    {
      _id: saleId,
      number,
      clientRequestId: input.clientRequestId,
      branchId: till.branchId,
      warehouseId: till.warehouseId,
      tillId: till._id,
      shiftId: shift?._id,
      cashierId: userId,
      customerId: customer?._id,
      salesRepId: repId,
      priceList,
      lines: saleLines,
      grossCents: linesGross,
      discountCents: totalDiscount,
      taxCents,
      totalCents,
      netCents,
      costCents: saleLines.reduce((a, l) => a + l.costCents, 0),
      payments,
      paidCents: totalCents - creditCents,
      creditCents,
      changeCents,
      loyalty: { earned: loyaltyEarned, redeemed: loyaltyRedeemed },
      couponCode: input.couponCode,
      ageVerifiedBy,
      overrides: authz.overrides,
      salesDocumentId: input.salesDocumentId,
      dueDate,
      notes: input.notes,
      commissionCents,
      completedAt: new Date(),
    },
  ]);

  await queueSaleForEtims(saleId, till.branchId, caps);
  await audit(req, {
    action: 'sale.completed',
    entity: 'Sale',
    entityId: saleId,
    details: { number, totalCents, branch: branch?.code, overrides: authz.overrides.map((o) => o.action) },
    supervisorId: authz.overrides[0]?.supervisorId,
  });
  return sale;
}
