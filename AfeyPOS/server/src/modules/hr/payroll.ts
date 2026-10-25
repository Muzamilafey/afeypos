/**
 * Payroll calculation. A run covers one calendar month (YYYY-MM) for all active employees, or one branch.
 *  - Monthly staff: basic salary; approved unpaid leave is deducted at basic / 26 per day.
 *  - Daily and hourly staff: rate × days or hours worked (entered, or taken from clock-in records).
 *  - Gross = basic + allowances + overtime + bonus − unpaid leave; statutory deductions per statutory.ts.
 *  - Advances are recovered by instalment, but never so far that take-home pay drops below one third of
 *    gross (Employment Act 2007, s. 19(3): deductions may not exceed two thirds of wages).
 */
import { Types } from 'mongoose';
import { AttendanceRecord, Employee, LeaveRequest, SalaryAdvance, User } from '../../models/index.js';
import { kenyaStatutory, KENYA_2025 } from './statutory.js';

export const DAYS_PER_MONTH = 26;

export interface LineInput {
  daysWorked?: number;
  hoursWorked?: number;
  overtimeCents?: number;
  bonusCents?: number;
  extraAllowances?: { name: string; amountCents: number; taxable?: boolean }[];
  extraDeductions?: { name: string; amountCents: number }[];
  /** Skip advance recovery this month. */
  holdAdvance?: boolean;
}

export function monthBounds(period: string, tz = 'Africa/Nairobi') {
  const [y, m] = period.split('-').map(Number);
  // Months in East Africa Time (UTC+3, no daylight saving).
  const offset = tz === 'Africa/Nairobi' ? 3 * 3600_000 : 0;
  const start = new Date(Date.UTC(y, m - 1, 1) - offset);
  const end = new Date(Date.UTC(y, m, 1) - offset);
  return { start, end };
}

/** Hours and distinct days on site from clock-in/clock-out pairs (an unclosed shift counts nothing; shifts capped at 16 h). */
export async function attendanceSummary(userIds: Types.ObjectId[], start: Date, end: Date) {
  const recs = await AttendanceRecord.find({ userId: { $in: userIds }, at: { $gte: start, $lt: end } }).sort({ userId: 1, at: 1 }).lean();
  const out = new Map<string, { hours: number; days: number; open: boolean }>();
  const days = new Map<string, Set<string>>();
  let openAt: Date | null = null;
  let current = '';
  for (const r of recs) {
    const uid = String(r.userId);
    if (uid !== current) {
      current = uid;
      openAt = null;
    }
    const s = out.get(uid) ?? { hours: 0, days: 0, open: false };
    if (r.kind === 'clock_in') {
      openAt = r.at;
      s.open = true;
    } else if (openAt) {
      s.hours += Math.min(16, (r.at.getTime() - openAt.getTime()) / 3600_000);
      const d = days.get(uid) ?? new Set();
      d.add(new Date(openAt.getTime() + 3 * 3600_000).toISOString().slice(0, 10));
      days.set(uid, d);
      openAt = null;
      s.open = false;
    }
    out.set(uid, s);
  }
  for (const [uid, s] of out) {
    s.hours = Math.round(s.hours * 100) / 100;
    s.days = days.get(uid)?.size ?? 0;
  }
  return out;
}

/** Days of approved leave of a type that fall inside [start, end). */
function overlapDays(l: { from: Date; to: Date; days: number }, start: Date, end: Date) {
  const total = Math.max(1, Math.round((l.to.getTime() - l.from.getTime()) / 86400_000) + 1);
  const from = Math.max(l.from.getTime(), start.getTime());
  const to = Math.min(l.to.getTime() + 86400_000, end.getTime());
  if (to <= from) return 0;
  return Math.round(((to - from) / 86400_000 / total) * l.days * 100) / 100;
}

export async function buildLines(employees: any[], period: string, inputs: Record<string, LineInput> = {}) {
  const { start, end } = monthBounds(period);
  const userIds = employees.map((e) => e.userId).filter(Boolean) as Types.ObjectId[];
  const att = await attendanceSummary(userIds, start, end);
  const unpaid = await LeaveRequest.find({ employeeId: { $in: employees.map((e) => e._id) }, type: 'unpaid', status: 'approved', from: { $lt: end }, to: { $gte: start } }).lean();
  const advances = await SalaryAdvance.find({ employeeId: { $in: employees.map((e) => e._id) }, status: 'paid' }).sort({ createdAt: 1 }).lean();
  return employees.map((e) => {
    const input = inputs[String(e._id)] ?? {};
    const a = e.userId ? att.get(String(e.userId)) : undefined;
    const daysWorked = input.daysWorked ?? (e.payType === 'daily' ? a?.days ?? 0 : a?.days);
    const hoursWorked = input.hoursWorked ?? (e.payType === 'hourly' ? a?.hours ?? 0 : a?.hours);
    let basic = e.rateCents;
    if (e.payType === 'daily') basic = Math.round(e.rateCents * (daysWorked ?? 0));
    if (e.payType === 'hourly') basic = Math.round(e.rateCents * (hoursWorked ?? 0));
    const unpaidDays = e.payType === 'monthly' ? unpaid.filter((l) => String(l.employeeId) === String(e._id)).reduce((s, l) => s + overlapDays(l, start, end), 0) : 0;
    const unpaidCents = Math.min(basic, Math.round((e.rateCents / DAYS_PER_MONTH) * unpaidDays));
    const allowances = [...(e.allowances ?? []), ...(input.extraAllowances ?? [])].filter((x) => x.amountCents > 0).map((x) => ({ name: x.name, amountCents: Math.round(x.amountCents), taxable: x.taxable !== false }));
    if (input.bonusCents) allowances.push({ name: 'Bonus', amountCents: Math.round(input.bonusCents), taxable: true });
    const overtime = Math.round(input.overtimeCents ?? 0);
    const gross = basic - unpaidCents + overtime + allowances.reduce((s, x) => s + x.amountCents, 0);
    const st = kenyaStatutory({ grossCents: gross, nonTaxableCents: allowances.filter((x) => !x.taxable).reduce((s, x) => s + x.amountCents, 0), pensionCents: e.pensionCents });
    const deductions = [...(e.deductions ?? []), ...(input.extraDeductions ?? [])].filter((x) => x.amountCents > 0).map((x) => ({ name: x.name, amountCents: Math.round(x.amountCents) }));
    const otherDeductions = deductions.reduce((s, x) => s + x.amountCents, 0);
    const floor = Math.ceil(st.grossCents / 3);
    let advance = 0;
    if (!input.holdAdvance) {
      const planned = advances.filter((x) => String(x.employeeId) === String(e._id)).reduce((s, x) => s + Math.min(x.installmentCents, x.amountCents - x.recoveredCents), 0);
      advance = Math.max(0, Math.min(planned, st.netAfterStatutoryCents - otherDeductions - floor));
    }
    const net = st.netAfterStatutoryCents - otherDeductions - advance;
    return {
      employeeId: e._id, employeeNo: e.employeeNo, name: e.name, kraPin: e.kraPin, nssfNo: e.nssfNo, shifNo: e.shifNo, idNumber: e.idNumber, jobTitle: e.jobTitle,
      payType: e.payType, daysWorked, hoursWorked, basicCents: basic, allowances, overtimeCents: overtime, unpaidLeaveDays: unpaidDays, unpaidLeaveCents: unpaidCents,
      grossCents: st.grossCents, nssfCents: st.nssfCents, nssfEmployerCents: st.nssfEmployerCents, shifCents: st.shifCents, ahlCents: st.ahlCents, ahlEmployerCents: st.ahlEmployerCents,
      nitaCents: st.nitaCents, pensionCents: st.pensionCents, taxablePayCents: st.taxablePayCents, payeBeforeReliefCents: st.payeBeforeReliefCents, personalReliefCents: st.personalReliefCents,
      payeCents: st.payeCents, deductions, advanceRecoveryCents: advance, netCents: net,
      employerCostCents: st.grossCents + st.nssfEmployerCents + st.ahlEmployerCents + st.nitaCents,
      payMethod: e.payMethod, mpesaPhone: e.mpesaPhone ?? e.phone, bankAccount: e.bank?.accountNo ? `${e.bank.name ?? ''} ${e.bank.accountNo}`.trim() : undefined,
      paid: false,
      input,
    };
  });
}

export function runTotals(lines: any[]) {
  const sum = (k: string) => lines.reduce((s, l) => s + (l[k] ?? 0), 0);
  return {
    grossCents: sum('grossCents'), netCents: sum('netCents'), payeCents: sum('payeCents'), nssfCents: sum('nssfCents'), nssfEmployerCents: sum('nssfEmployerCents'),
    shifCents: sum('shifCents'), ahlCents: sum('ahlCents'), ahlEmployerCents: sum('ahlEmployerCents'), nitaCents: sum('nitaCents'),
    deductionsCents: lines.reduce((s, l) => s + (l.deductions ?? []).reduce((a: number, d: any) => a + d.amountCents, 0), 0),
    advanceRecoveryCents: sum('advanceRecoveryCents'), employerCostCents: sum('employerCostCents'), employees: lines.length,
  };
}

/** Annual leave: entitlement accrues monthly over the year (from the start date), plus opening days, less approved annual leave. */
export async function leaveBalance(e: any, year = new Date().getUTCFullYear(), now = new Date()) {
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const from = new Date(Math.max(yearStart.getTime(), new Date(e.startDate ?? yearStart).getTime()));
  const until = new Date(Math.min(now.getTime(), Date.UTC(year + 1, 0, 1)));
  const months = Math.max(0, (until.getUTCFullYear() - from.getUTCFullYear()) * 12 + until.getUTCMonth() - from.getUTCMonth() + (until.getUTCDate() >= from.getUTCDate() ? 1 : 0));
  const accrued = Math.round(((e.annualLeaveDays ?? 21) / 12) * Math.min(12, months) * 100) / 100;
  const taken = (await LeaveRequest.find({ employeeId: e._id, type: 'annual', status: 'approved', from: { $gte: yearStart, $lt: new Date(Date.UTC(year + 1, 0, 1)) } }).lean()).reduce((s, l) => s + l.days, 0);
  const pending = (await LeaveRequest.find({ employeeId: e._id, type: 'annual', status: 'pending' }).lean()).reduce((s, l) => s + l.days, 0);
  const opening = e.leaveOpeningDays ?? 0;
  return { year, entitlement: e.annualLeaveDays ?? 21, accrued, opening, taken, pending, available: Math.round((accrued + opening - taken) * 100) / 100 };
}

/** Days between two dates inclusive, not counting Sundays (shops trade on Saturdays). */
export function leaveDays(from: Date, to: Date) {
  let n = 0;
  for (let t = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()); t <= to.getTime(); t += 86400_000) if (new Date(t).getUTCDay() !== 0) n += 1;
  return n;
}

export async function employeesFor(branchId?: Types.ObjectId | null) {
  return Employee.find({ status: 'active', ...(branchId ? { branchId } : {}) }).sort({ employeeNo: 1 }).lean();
}

export async function userNameMap(ids: unknown[]) {
  return new Map((await User.find({ _id: { $in: ids.filter(Boolean) } }, { name: 1 }).lean()).map((u) => [String(u._id), u.name]));
}

export const RULES_NAME = KENYA_2025.name;
