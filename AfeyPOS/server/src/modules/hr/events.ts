import type { Types } from 'mongoose';
import { PayrollRun, SalaryAdvance } from '../../models/index.js';

/** Called when an M-Pesa B2C payout is confirmed: marks the payslip (or advance) it paid. */
export async function onPayoutSucceeded(p: { _id: Types.ObjectId; ref?: { type?: string | null; id?: Types.ObjectId | null } | null }) {
  if (p.ref?.type === 'PayrollRun' && p.ref.id) {
    await PayrollRun.updateOne({ _id: p.ref.id }, { $set: { 'lines.$[l].paid': true } }, { arrayFilters: [{ 'l.payoutId': p._id }] });
    const run = await PayrollRun.findById(p.ref.id);
    if (run && run.status === 'approved' && run.lines.every((l) => l.paid)) {
      run.status = 'paid';
      run.paidAt = new Date();
      await run.save();
    }
  }
  if (p.ref?.type === 'SalaryAdvance' && p.ref.id) {
    await SalaryAdvance.updateOne({ _id: p.ref.id, status: 'approved' }, { $set: { status: 'paid', paidAt: new Date() } });
  }
}
