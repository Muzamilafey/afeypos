import type { Request } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { roundQty } from '@afeypos/shared';
import { CashMovement, Customer, LedgerEntry, PaymentIntent, Product, Sale, SaleReturn, Shift, Till } from '../../models/index.js';
import { withTransaction } from '../../db/connection.js';
import { AppError, badRequest, notFound, unprocessable } from '../../lib/errors.js';
import { nextNumber } from '../../lib/numbering.js';
import { audit } from '../../lib/audit.js';
import { objectId, qty } from '../../http/validate.js';
import { can } from '../../http/auth.js';
import { applyMovement } from '../inventory/stock.js';

export const returnSchema = z.object({
  clientRequestId: z.string().min(8).max(100),
  tillId: objectId.optional(),
  lines: z.array(z.object({ lineId: objectId, qty, restock: z.boolean().default(true), serials: z.array(z.string()).optional() })).min(1),
  refundMethod: z.enum(['cash', 'mpesa', 'card', 'account', 'credit_note']),
  reference: z.string().max(100).optional(),
  reason: z.string().trim().min(2).max(300),
});

export const voidSchema = z.object({
  clientRequestId: z.string().min(8).max(100),
  reason: z.string().trim().min(2).max(300),
});

function proportion(total: number, part: number, whole: number) {
  return whole === 0 ? 0 : Math.round((total * part) / whole);
}

export async function processReturn(req: Request, saleId: Types.ObjectId, input: z.infer<typeof returnSchema>) {
  const existing = await SaleReturn.findOne({ clientRequestId: input.clientRequestId });
  if (existing) return existing;
  return withTransaction(async () => {
    const sale = await Sale.findById(saleId);
    if (!sale) throw notFound('Sale');
    if (sale.status === 'voided' || sale.status === 'returned') throw unprocessable('This sale has already been fully returned or voided', 'SALE_CLOSED');
    const userId = req.auth!.userId;
    const number = await nextNumber('return', 'RTN');
    const returnId = new Types.ObjectId();

    let shift = null;
    if (input.refundMethod === 'cash') {
      if (!input.tillId) throw badRequest('Select the till paying out the cash refund');
      const till = await Till.findById(input.tillId);
      if (!till) throw notFound('Till');
      shift = await Shift.findOne({ tillId: till._id, status: 'open' });
      if (!shift) throw new AppError(409, 'SHIFT_REQUIRED', 'Open a shift on this till to pay out a cash refund');
    }
    if (input.refundMethod === 'account' && !sale.customerId) throw badRequest('Refund to account requires a customer sale');

    const lines = [];
    let refund = 0;
    for (const l of input.lines) {
      const line = sale.lines.find((x) => String(x._id) === String(l.lineId));
      if (!line) throw notFound('Sale line');
      const remaining = roundQty((line.qty ?? 0) - (line.returnedQty ?? 0));
      const q = roundQty(l.qty);
      if (q > remaining) throw unprocessable(`Only ${remaining} of ${line.name} can still be returned`, 'RETURN_EXCEEDS_SOLD');
      const product = await Product.findById(line.productId);
      const baseQty = roundQty(q * (line.unitFactor ?? 1));
      let serials: string[] | undefined;
      if (product?.trackSerials) {
        serials = l.serials ?? [];
        if (serials.length !== baseQty || serials.some((s) => !(line.serials ?? []).includes(s))) throw badRequest(`Provide the ${baseQty} serial number(s) being returned for ${line.name}`);
      }
      const refundCents = proportion(line.totalCents ?? 0, q, line.qty ?? 1);
      const costCents = proportion(line.costCents ?? 0, q, line.qty ?? 1);
      if (l.restock && product) {
        const unitCost = line.baseQty ? Math.round((line.costCents ?? 0) / line.baseQty) : 0;
        // Return to the batch the goods were sold from (first allocation) when batch tracked.
        const batches = product.trackBatches && line.batches?.length ? [{ batchNo: line.batches[0].batchNo!, expiryDate: line.batches[0].expiryDate, qty: baseQty }] : undefined;
        await applyMovement({ product, productId: product._id, warehouseId: sale.warehouseId, qty: baseQty, type: 'sale_return', unitCostCents: unitCost, ref: { type: 'SaleReturn', id: returnId, number }, userId, reason: input.reason, serials, batches });
      }
      line.returnedQty = roundQty((line.returnedQty ?? 0) + q);
      refund += refundCents;
      lines.push({ lineId: line._id, productId: line.productId, name: line.name, qty: q, baseQty, refundCents, netCents: proportion(line.netCents ?? 0, q, line.qty ?? 1), taxCents: proportion(line.taxCents ?? 0, q, line.qty ?? 1), costCents: l.restock ? costCents : 0, restocked: l.restock, serials });
    }

    if (shift) await CashMovement.create([{ shiftId: shift._id, tillId: shift.tillId, type: 'refund', amountCents: -refund, userId, reason: input.reason, ref: { type: 'SaleReturn', id: returnId, number } }]);
    if (input.refundMethod === 'account' && sale.customerId) await postCustomerCredit(sale.customerId, refund, { type: 'SaleReturn', id: returnId, number }, userId, 'return');

    sale.refundedCents = (sale.refundedCents ?? 0) + refund;
    sale.status = sale.lines.every((l) => roundQty((l.returnedQty ?? 0)) >= (l.qty ?? 0)) ? 'returned' : 'partially_returned';
    await sale.save();

    const [ret] = await SaleReturn.create([{ _id: returnId, number, clientRequestId: input.clientRequestId, saleId: sale._id, branchId: sale.branchId, shiftId: shift?._id, customerId: sale.customerId, lines, refundCents: refund, refundMethod: input.refundMethod, reason: input.reason, processedBy: userId }]);
    await audit(req, { action: 'sale.returned', entity: 'Sale', entityId: sale._id, details: { returnNumber: number, refundCents: refund, method: input.refundMethod, reference: input.reference } });
    return ret;
  });
}

/** Reduces what a customer owes (or creates a credit balance) and allocates it against open debts. */
export async function postCustomerCredit(customerId: Types.ObjectId, amount: number, ref: { type: string; id: Types.ObjectId; number: string }, userId: Types.ObjectId, kind: 'return' | 'refund' | 'payment', extra: { method?: string; reference?: string } = {}) {
  const c = await Customer.findOneAndUpdate({ _id: customerId }, { $inc: { balanceCents: -amount } }, { new: true });
  if (!c) throw notFound('Customer');
  const allocations = await allocateAgainstOpen('customer', customerId, amount);
  const [entry] = await LedgerEntry.create([{ partyType: 'customer', partyId: customerId, kind, amountCents: -amount, balanceAfterCents: c.balanceCents, ref, userId, allocations, ...extra }]);
  return { entry, balanceCents: c.balanceCents };
}

/** FIFO allocation of a payment/credit against the oldest open debit entries. */
export async function allocateAgainstOpen(partyType: 'customer' | 'supplier', partyId: Types.ObjectId, amount: number) {
  let remaining = amount;
  const allocations: { entryId: Types.ObjectId; amountCents: number }[] = [];
  const open = await LedgerEntry.find({ partyType, partyId, openCents: { $gt: 0 } }).sort({ dueDate: 1, at: 1 });
  for (const e of open) {
    if (remaining <= 0) break;
    const take = Math.min(e.openCents, remaining);
    const r = await LedgerEntry.updateOne({ _id: e._id, openCents: { $gte: take } }, { $inc: { openCents: -take } });
    if (r.modifiedCount === 1) {
      allocations.push({ entryId: e._id, amountCents: take });
      remaining -= take;
    }
  }
  return allocations;
}

/**
 * Voids a sale in its original, still-open shift: restocks everything, reverses cash and credit,
 * releases M-Pesa confirmations so they can be applied to a corrected sale.
 */
export async function voidSale(req: Request, saleId: Types.ObjectId, input: z.infer<typeof voidSchema>) {
  return withTransaction(async () => {
    const sale = await Sale.findById(saleId);
    if (!sale) throw notFound('Sale');
    if (sale.status === 'voided') return sale;
    if (sale.status !== 'completed') throw unprocessable('Sales with returns cannot be voided; process a return instead', 'SALE_HAS_RETURNS');
    if (sale.shiftId) {
      const shift = await Shift.findById(sale.shiftId);
      if (shift?.status !== 'open' && !can(req, 'shifts.manage')) throw unprocessable('Sales can only be voided while their shift is open', 'SHIFT_CLOSED');
    }
    const userId = req.auth!.userId;
    const ref = { type: 'SaleVoid', id: sale._id, number: sale.number };
    for (const line of sale.lines) {
      const product = await Product.findById(line.productId);
      if (!product) continue;
      const unitCost = line.baseQty ? Math.round((line.costCents ?? 0) / line.baseQty) : 0;
      const batches = product.trackBatches && line.batches?.length ? line.batches.map((b) => ({ batchNo: b.batchNo!, expiryDate: b.expiryDate, qty: b.qty! })) : undefined;
      await applyMovement({ product, productId: product._id, warehouseId: sale.warehouseId, qty: line.baseQty!, type: 'sale_return', unitCostCents: unitCost, ref, userId, reason: `void: ${input.reason}`, serials: line.serials ?? undefined, batches });
    }
    const cash = sale.payments.filter((p) => p.method === 'cash').reduce((a, p) => a + p.amountCents, 0);
    if (cash > 0 && sale.shiftId) await CashMovement.create([{ shiftId: sale.shiftId, tillId: sale.tillId, type: 'refund', amountCents: -cash, userId, reason: `void ${sale.number}`, ref }]);
    if (sale.creditCents > 0 && sale.customerId) {
      const c = await Customer.findOneAndUpdate({ _id: sale.customerId }, { $inc: { balanceCents: -sale.creditCents } }, { new: true });
      await LedgerEntry.updateOne({ partyType: 'customer', 'ref.id': sale._id, kind: 'credit_sale' }, { $set: { openCents: 0 } });
      await LedgerEntry.create([{ partyType: 'customer', partyId: sale.customerId, kind: 'adjustment', amountCents: -sale.creditCents, balanceAfterCents: c!.balanceCents, ref, userId, notes: 'Sale voided' }]);
    }
    for (const p of sale.payments.filter((x) => x.method === 'mpesa' && x.paymentIntentId)) {
      await PaymentIntent.updateOne({ _id: p.paymentIntentId }, { $inc: { allocatedCents: -p.amountCents }, $unset: { allocatedTo: 1, allocatedAt: 1 } });
    }
    const loyaltyPoints = (sale.loyalty?.redeemed ?? 0) - (sale.loyalty?.earned ?? 0);
    if (sale.customerId && loyaltyPoints !== 0) await Customer.updateOne({ _id: sale.customerId }, { $inc: { loyaltyPoints } });
    sale.status = 'voided';
    sale.voidedAt = new Date();
    sale.voidedBy = userId;
    sale.voidReason = input.reason;
    for (const l of sale.lines) l.returnedQty = l.qty ?? 0;
    await sale.save();
    await audit(req, { action: 'sale.voided', entity: 'Sale', entityId: sale._id, details: { number: sale.number, reason: input.reason, totalCents: sale.totalCents } });
    return sale;
  });
}
