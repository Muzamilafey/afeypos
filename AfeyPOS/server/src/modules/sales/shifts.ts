import type { Request } from 'express';
import { Types } from 'mongoose';
import { CashMovement, Sale, SaleReturn, Shift, Till } from '../../models/index.js';
import { withTransaction } from '../../db/connection.js';
import { AppError, forbidden, notFound } from '../../lib/errors.js';
import { nextNumber } from '../../lib/numbering.js';
import { audit } from '../../lib/audit.js';
import { assertBranchAccess, can } from '../../http/auth.js';
import { mergeCheckoutRules } from '@afeypos/shared';
import { consumeOverride } from '../auth/routes.js';

export const checkoutRulesOf = (req: Request) => mergeCheckoutRules(req.tenant!.settings?.checkoutRules, req.tenant!.settings ?? {});

export async function openShift(req: Request, tillId: Types.ObjectId, openingFloatCents: number) {
  const till = await Till.findOne({ _id: tillId, active: true });
  if (!till) throw notFound('Till');
  assertBranchAccess(req, till.branchId);
  const rules = checkoutRulesOf(req).shifts;
  if (openingFloatCents < rules.minOpeningFloatCents) throw new AppError(422, 'FLOAT_TOO_LOW', `The opening float must be at least ${(rules.minOpeningFloatCents / 100).toFixed(2)}`);
  if (rules.oneOpenShiftPerCashier) {
    const other = await Shift.findOne({ userId: req.auth!.userId, status: 'open' }, { number: 1, tillId: 1 }).lean();
    if (other) {
      const t = await Till.findById(other.tillId, { name: 1 }).lean();
      throw new AppError(409, 'SHIFT_OPEN_ELSEWHERE', `You already have shift ${other.number} open${t ? ` on ${t.name}` : ''}. Close it first.`);
    }
  }
  try {
    return await withTransaction(async () => {
      const number = await nextNumber('shift', 'SHF');
      const [shift] = await Shift.create([{ number, tillId, branchId: till.branchId, userId: req.auth!.userId, openingFloatCents }]);
      if (openingFloatCents > 0) await CashMovement.create([{ shiftId: shift._id, tillId, type: 'float', amountCents: openingFloatCents, userId: req.auth!.userId, reason: 'Opening float' }]);
      await audit(req, { action: 'shift.opened', entity: 'Shift', entityId: shift._id, details: { till: till.code, openingFloatCents } });
      return shift;
    });
  } catch (err: any) {
    if (err?.code === 11000 && err?.keyPattern?.tillId) throw new AppError(409, 'SHIFT_ALREADY_OPEN', 'This till already has an open shift');
    throw err;
  }
}

/** Expected-versus-actual summary for a shift (X report while open, Z report when closed). */
export async function shiftSummary(shiftId: Types.ObjectId) {
  const shift = await Shift.findById(shiftId).lean();
  if (!shift) throw notFound('Shift');
  const [cash] = await CashMovement.aggregate([{ $match: { shiftId: shift._id } }, { $group: { _id: null, total: { $sum: '$amountCents' } } }]);
  const byType = await CashMovement.aggregate([{ $match: { shiftId: shift._id } }, { $group: { _id: '$type', total: { $sum: '$amountCents' }, count: { $sum: 1 } } }]);
  const byMethod = await Sale.aggregate([
    { $match: { shiftId: shift._id, status: { $ne: 'voided' } } },
    { $unwind: '$payments' },
    { $group: { _id: '$payments.method', total: { $sum: '$payments.amountCents' }, count: { $sum: 1 } } },
  ]);
  const [sales] = await Sale.aggregate([
    { $match: { shiftId: shift._id, status: { $ne: 'voided' } } },
    { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$totalCents' }, discounts: { $sum: '$discountCents' }, tax: { $sum: '$taxCents' } } },
  ]);
  const [voids] = await Sale.aggregate([{ $match: { shiftId: shift._id, status: 'voided' } }, { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$totalCents' } } }]);
  const [refunds] = await SaleReturn.aggregate([{ $match: { shiftId: shift._id, isVoid: { $ne: true } } }, { $group: { _id: '$refundMethod', total: { $sum: '$refundCents' } } }]);
  const expectedCashCents = cash?.total ?? 0;
  return {
    shift,
    expectedCashCents,
    cashMovements: Object.fromEntries(byType.map((r) => [r._id, { totalCents: r.total, count: r.count }])),
    paymentsByMethod: Object.fromEntries(byMethod.map((r) => [r._id, { totalCents: r.total, count: r.count }])),
    sales: { count: sales?.count ?? 0, totalCents: sales?.total ?? 0, discountCents: sales?.discounts ?? 0, taxCents: sales?.tax ?? 0 },
    voids: { count: voids?.count ?? 0, totalCents: voids?.total ?? 0 },
    refunds,
  };
}

export async function recordCashMovement(req: Request, shiftId: Types.ObjectId, type: 'cash_in' | 'cash_out', amountCents: number, reason: string) {
  const shift = await Shift.findOne({ _id: shiftId, status: 'open' });
  if (!shift) throw new AppError(409, 'SHIFT_NOT_OPEN', 'Shift is not open');
  if (String(shift.userId) !== String(req.auth!.userId) && !can(req, 'shifts.manage')) throw forbidden('Not your shift');
  const [m] = await CashMovement.create([{ shiftId, tillId: shift.tillId, type, amountCents: type === 'cash_out' ? -amountCents : amountCents, reason, userId: req.auth!.userId }]);
  await audit(req, { action: `shift.${type}`, entity: 'Shift', entityId: shiftId, details: { amountCents, reason } });
  return m;
}

export async function closeShift(req: Request, shiftId: Types.ObjectId, countedCashCents: number, notes?: string, denominations?: Record<string, number>, overrideToken?: string) {
  const rules = checkoutRulesOf(req).shifts;
  return withTransaction(async () => {
    const shift = await Shift.findOne({ _id: shiftId, status: 'open' });
    if (!shift) throw new AppError(409, 'SHIFT_NOT_OPEN', 'Shift is not open');
    if (String(shift.userId) !== String(req.auth!.userId) && !can(req, 'shifts.manage')) throw forbidden('Only the shift owner or a manager can close this shift');
    let approvedBy: string | null = null;
    if (rules.closeNeedsApproval && !can(req, 'shifts.manage')) {
      approvedBy = await consumeOverride(overrideToken, 'shifts.manage', String(req.tenant!._id), String(req.auth!.userId));
      if (!approvedBy) throw new AppError(403, 'OVERRIDE_REQUIRED', 'Supervisor approval required: close the shift', { permission: 'shifts.manage' });
    }
    const summary = await shiftSummary(shift._id);
    shift.status = 'closed';
    shift.closedAt = new Date();
    shift.closedBy = req.auth!.userId;
    shift.expectedCashCents = summary.expectedCashCents;
    shift.countedCashCents = countedCashCents;
    shift.varianceCents = countedCashCents - summary.expectedCashCents;
    shift.totalsByMethod = summary.paymentsByMethod;
    shift.salesCount = summary.sales.count;
    shift.salesTotalCents = summary.sales.totalCents;
    shift.denominations = denominations;
    shift.notes = notes;
    await shift.save();
    await audit(req, { action: 'shift.closed', entity: 'Shift', entityId: shift._id, details: { expected: shift.expectedCashCents, counted: countedCashCents, variance: shift.varianceCents, ...(approvedBy ? { approvedBy } : {}) } });
    return { ...summary, shift: shift.toObject() };
  });
}

/** Blind close: cashiers see what they counted, never the expected cash or the variance. */
export function hideExpected<T extends Record<string, any>>(req: Request, summary: T): T {
  if (!checkoutRulesOf(req).shifts.blindClose || can(req, 'shifts.manage')) return summary;
  const { expectedCashCents: _e, cashMovements: _c, ...rest } = summary as any;
  const shift = rest.shift ? { ...rest.shift, expectedCashCents: undefined, varianceCents: undefined } : rest.shift;
  return { ...rest, shift, blind: true } as T;
}
