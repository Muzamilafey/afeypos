/**
 * Loyalty points and gift vouchers: the parts checkout, voids and the loyalty pages share.
 * Every point change is written to the LoyaltyTransaction ledger; voucher balances only change atomically.
 */
import crypto from 'node:crypto';
import { Types } from 'mongoose';
import { mergeLoyalty, type LoyaltyProgram } from '@afeypos/shared';
import { Customer, LoyaltyTransaction, Sale, Voucher } from '../../models/index.js';
import { unprocessable } from '../../lib/errors.js';
import { tierOf } from '../crm/routes.js';

export const programOf = (settings: { loyalty?: unknown } | null | undefined): LoyaltyProgram => mergeLoyalty(settings?.loyalty);

/** The customer's CRM tier from their last 12 months of spending (decides how fast they earn). */
export async function customerTier(customerId: unknown, tiers: { name?: string | null; minSpendCents?: number | null }[] | null | undefined) {
  if (!tiers?.length) return null;
  const since = new Date(Date.now() - 365 * 86400_000);
  const [row] = await Sale.aggregate([
    { $match: { customerId: new Types.ObjectId(String(customerId)), status: { $ne: 'voided' }, completedAt: { $gte: since } } },
    { $group: { _id: null, spend: { $sum: { $subtract: ['$totalCents', { $ifNull: ['$refundedCents', 0] }] } } } },
  ]);
  return tierOf(row?.spend ?? 0, tiers);
}

/** Changes a customer's points and records why. A negative change never takes the balance below zero. */
export async function changePoints(input: { customerId: unknown; points: number; kind: 'earn' | 'redeem' | 'bonus' | 'adjust' | 'reverse'; saleId?: unknown; saleNumber?: string; branchId?: unknown; note?: string; userId?: unknown }) {
  if (!input.points) return null;
  const filter: Record<string, unknown> = { _id: input.customerId };
  if (input.points < 0) filter.loyaltyPoints = { $gte: -input.points };
  const c = await Customer.findOneAndUpdate(filter, { $inc: { loyaltyPoints: input.points } }, { new: true, projection: { loyaltyPoints: 1 } });
  if (!c) return null;
  await LoyaltyTransaction.create([{ customerId: input.customerId, points: input.points, kind: input.kind, saleId: input.saleId, saleNumber: input.saleNumber, branchId: input.branchId, note: input.note, userId: input.userId }]);
  return c.loyaltyPoints;
}

/** Unused loyalty card number (LC + 10 digits). */
export async function newCardNo() {
  for (let i = 0; i < 20; i++) {
    const n = `LC${String(crypto.randomInt(0, 1e10)).padStart(10, '0')}`;
    if (!(await Customer.exists({ loyaltyCardNo: n }))) return n;
  }
  throw new Error('Could not generate a card number');
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** Unused voucher code: GV- and 8 characters without look-alikes. */
export async function newVoucherCode() {
  for (let i = 0; i < 20; i++) {
    const code = `GV-${Array.from(crypto.randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join('')}`;
    if (!(await Voucher.exists({ code }))) return code;
  }
  throw new Error('Could not generate a voucher code');
}

/** Why a voucher cannot be used right now, or null when it can. */
export function voucherProblem(v: { status: string; balanceCents: number; expiresAt?: Date | null } | null) {
  if (!v) return 'No voucher with this code';
  if (v.status === 'cancelled') return 'This voucher was cancelled';
  if (v.status === 'used' || v.balanceCents <= 0) return 'This voucher has been used up';
  if (v.expiresAt && v.expiresAt.getTime() < Date.now()) return `This voucher expired on ${v.expiresAt.toISOString().slice(0, 10)}`;
  return null;
}

/** Takes an amount off a voucher at checkout (inside the sale's transaction). */
export async function spendVoucher(code: string, amountCents: number, sale: { id: Types.ObjectId; number: string }) {
  const now = new Date();
  const v = await Voucher.findOneAndUpdate(
    { code: code.trim().toUpperCase(), status: 'active', balanceCents: { $gte: amountCents }, $or: [{ expiresAt: null }, { expiresAt: { $exists: false } }, { expiresAt: { $gt: now } }] },
    { $inc: { balanceCents: -amountCents }, $push: { redemptions: { saleId: sale.id, saleNumber: sale.number, amountCents, at: now } } },
    { new: true },
  );
  if (!v) {
    const found = await Voucher.findOne({ code: code.trim().toUpperCase() }).lean();
    const why = voucherProblem(found as any) ?? `The voucher only has ${((found?.balanceCents ?? 0) / 100).toFixed(2)} left`;
    throw unprocessable(why, 'VOUCHER_NOT_AVAILABLE');
  }
  if (v.balanceCents === 0) await Voucher.updateOne({ _id: v._id }, { $set: { status: 'used' } });
  return v;
}

/** A voided sale gives back what it took from vouchers. */
export async function refundVoucher(code: string, amountCents: number, saleId: unknown) {
  await Voucher.updateOne(
    { code: code.trim().toUpperCase(), status: { $ne: 'cancelled' } },
    { $inc: { balanceCents: amountCents }, $set: { status: 'active' }, $pull: { redemptions: { saleId } } },
  );
}
