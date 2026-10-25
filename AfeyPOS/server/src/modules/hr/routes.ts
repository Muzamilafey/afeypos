/**
 * HR: employees, leave, salary advances, attendance and payroll (see payroll.ts and statutory.ts).
 * Runs on head office or a standalone shop; branch servers see HR as managed at HQ.
 */
import { Router } from 'express';
import { z } from 'zod';
import { formatMoney } from '@afeypos/shared';
import { Employee, LeaveRequest, PayrollRun, Payout, SalaryAdvance, Tenant, User } from '../../models/index.js';
import { idParam, objectId, pagination, parse, positiveCents, escapeRegex } from '../../http/validate.js';
import { requirePermission } from '../../http/auth.js';
import { badRequest, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { nextNumber } from '../../lib/numbering.js';
import { toCsv } from '../../lib/csv.js';
import { runAsPlatform } from '../../lib/context.js';
import { normalizePhone } from '../../lib/phone.js';
import { withTransaction } from '../../db/connection.js';
import { nextEmployeeNo } from '../staff/cards.js';
import { createPayouts } from '../payments/payouts.js';
import { attendanceSummary, buildLines, employeesFor, leaveBalance, leaveDays, monthBounds, runTotals, RULES_NAME, userNameMap, type LineInput } from './payroll.js';

const router = Router();

const money = z.number().int().min(0);
const item = z.object({ name: z.string().trim().min(1).max(60), amountCents: money });
const employeeSchema = z.object({
  userId: objectId.nullable().optional(),
  employeeNo: z.string().trim().max(30).optional(),
  name: z.string().trim().min(2).max(120),
  idNumber: z.string().trim().max(20).optional(),
  kraPin: z.string().trim().toUpperCase().regex(/^[AP]\d{9}[A-Z]$/, 'KRA PIN looks like A123456789B').or(z.literal('')).optional(),
  nssfNo: z.string().trim().max(20).optional(),
  shifNo: z.string().trim().max(20).optional(),
  phone: z.string().trim().max(20).optional(),
  email: z.string().trim().email().or(z.literal('')).optional(),
  dateOfBirth: z.coerce.date().optional(),
  gender: z.enum(['female', 'male', 'other']).nullable().optional(),
  branchId: objectId.nullable().optional(),
  department: z.string().trim().max(60).optional(),
  jobTitle: z.string().trim().max(80).optional(),
  employmentType: z.enum(['permanent', 'contract', 'casual']).default('permanent'),
  payType: z.enum(['monthly', 'daily', 'hourly']).default('monthly'),
  rateCents: money,
  allowances: z.array(item.extend({ taxable: z.boolean().default(true) })).max(20).default([]),
  deductions: z.array(item).max(20).default([]),
  pensionCents: money.default(0),
  payMethod: z.enum(['mpesa', 'bank', 'cash']).default('mpesa'),
  mpesaPhone: z.string().trim().max(20).optional(),
  bank: z.object({ name: z.string().max(60).optional(), branch: z.string().max(60).optional(), accountNo: z.string().max(40).optional() }).optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().nullable().optional(),
  status: z.enum(['active', 'suspended', 'terminated']).default('active'),
  annualLeaveDays: z.number().min(0).max(60).default(21),
  leaveOpeningDays: z.number().min(-60).max(120).default(0),
  emergencyContact: z.object({ name: z.string().max(80).optional(), phone: z.string().max(20).optional() }).optional(),
  notes: z.string().max(1000).optional(),
});

function checkPhones(body: { payMethod?: string; mpesaPhone?: string; phone?: string }) {
  if (body.mpesaPhone && !normalizePhone(body.mpesaPhone)) throw badRequest('Invalid M-Pesa number');
  if (body.payMethod === 'mpesa' && !body.mpesaPhone && !body.phone) throw badRequest('Enter the M-Pesa number salaries are paid to');
}

// ---------- employees ----------
router.get('/hr/employees', requirePermission('hr.manage'), async (req, res) => {
  const q = parse(pagination.extend({ status: z.string().optional(), branchId: objectId.optional() }), req.query);
  const filter: Record<string, unknown> = {};
  if (q.status) filter.status = q.status;
  if (q.branchId) filter.branchId = q.branchId;
  if (q.q) filter.$or = [{ name: new RegExp(escapeRegex(q.q), 'i') }, { employeeNo: new RegExp(escapeRegex(q.q), 'i') }, { idNumber: q.q }, { phone: q.q }];
  const [data, total] = await Promise.all([Employee.find(filter).sort({ employeeNo: 1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), Employee.countDocuments(filter)]);
  res.json({ data, total, page: q.page, limit: q.limit });
});

router.get('/hr/employees/:id', requirePermission('hr.manage'), async (req, res) => {
  const e = await Employee.findById(idParam(req.params.id)).lean();
  if (!e) throw notFound('Employee');
  const now = new Date();
  const period = new Date(now.getTime() + 3 * 3600_000).toISOString().slice(0, 7);
  const { start, end } = monthBounds(period);
  const att = e.userId ? (await attendanceSummary([e.userId], start, end)).get(String(e.userId)) : undefined;
  const [leave, advances, leaveRequests] = await Promise.all([
    leaveBalance(e),
    SalaryAdvance.find({ employeeId: e._id }).sort({ createdAt: -1 }).limit(20).lean(),
    LeaveRequest.find({ employeeId: e._id }).sort({ from: -1 }).limit(20).lean(),
  ]);
  const payslips = await PayrollRun.aggregate([{ $match: { status: { $in: ['approved', 'paid'] }, 'lines.employeeId': e._id } }, { $sort: { period: -1 } }, { $limit: 12 }, { $project: { number: 1, period: 1, status: 1, line: { $first: { $filter: { input: '$lines', cond: { $eq: ['$$this.employeeId', e._id] } } } } } }]);
  res.json({ data: { ...e, leave, advances, leaveRequests, attendance: { period, hours: att?.hours ?? 0, days: att?.days ?? 0, clockedIn: att?.open ?? false }, payslips: payslips.map((p) => ({ runId: p._id, number: p.number, period: p.period, status: p.status, lineId: p.line?._id, grossCents: p.line?.grossCents, netCents: p.line?.netCents })) } });
});

router.post('/hr/employees', requirePermission('hr.manage'), async (req, res) => {
  const body = parse(employeeSchema, req.body);
  checkPhones(body);
  let employeeNo = body.employeeNo;
  if (body.userId) {
    const u = await User.findById(body.userId);
    if (!u) throw notFound('User');
    if (!u.employeeNo) {
      u.employeeNo = employeeNo || (await nextEmployeeNo());
      await u.save();
    }
    employeeNo = u.employeeNo;
  }
  const e = await Employee.create({ ...body, kraPin: body.kraPin || undefined, email: body.email || undefined, employeeNo: employeeNo || (await nextEmployeeNo()) }).catch((err) => {
    if (err?.code === 11000) throw unprocessable(err.keyPattern?.userId ? 'That user already has an employee record' : 'That employee number is already used', 'DUPLICATE');
    throw err;
  });
  await audit(req, { action: 'hr.employee_created', entity: 'Employee', entityId: e._id, details: { employeeNo: e.employeeNo } });
  res.status(201).json({ data: e });
});

router.patch('/hr/employees/:id', requirePermission('hr.manage'), async (req, res) => {
  const body = parse(employeeSchema.partial(), req.body);
  const e = await Employee.findById(idParam(req.params.id));
  if (!e) throw notFound('Employee');
  checkPhones({ ...e.toObject(), ...body } as any);
  const before = { rateCents: e.rateCents, status: e.status };
  Object.assign(e, { ...body, ...(body.kraPin === '' ? { kraPin: undefined } : {}), ...(body.email === '' ? { email: undefined } : {}) });
  if (body.status === 'terminated' && !e.endDate) e.endDate = new Date();
  await e.save();
  await audit(req, { action: 'hr.employee_updated', entity: 'Employee', entityId: e._id, details: { fields: Object.keys(body), ...(body.rateCents !== undefined && body.rateCents !== before.rateCents ? { rateFrom: before.rateCents, rateTo: body.rateCents } : {}) } });
  res.json({ data: e });
});

/** Adds an employee record for every active staff login that has none yet (salary to be filled in). */
router.post('/hr/employees/import-users', requirePermission('hr.manage'), async (req, res) => {
  const linked = new Set((await Employee.find({ userId: { $ne: null } }, { userId: 1 }).lean()).map((e) => String(e.userId)));
  const users = (await User.find({ status: 'active' }).lean()).filter((u) => !linked.has(String(u._id)));
  const created = [];
  for (const u of users) {
    let no = u.employeeNo;
    if (!no) {
      no = await nextEmployeeNo();
      await User.updateOne({ _id: u._id }, { $set: { employeeNo: no } });
    }
    created.push(await Employee.create({ userId: u._id, employeeNo: no, name: u.name, phone: u.phone, email: u.email, mpesaPhone: u.phone, jobTitle: u.jobTitle, branchId: u.branchIds?.[0], rateCents: 0, payMethod: u.phone ? 'mpesa' : 'cash' }));
  }
  await audit(req, { action: 'hr.employees_imported', details: { count: created.length } });
  res.status(201).json({ data: created, count: created.length });
});

// ---------- attendance ----------
router.get('/hr/attendance', requirePermission('hr.manage'), async (req, res) => {
  const q = parse(z.object({ period: z.string().regex(/^\d{4}-\d{2}$/).optional(), format: z.enum(['json', 'csv']).default('json') }), req.query);
  const period = q.period ?? new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 7);
  const { start, end } = monthBounds(period);
  const employees = await Employee.find({ userId: { $ne: null } }).lean();
  const att = await attendanceSummary(employees.map((e) => e.userId!), start, end);
  const rows = employees.map((e) => {
    const a = att.get(String(e.userId));
    return { employeeNo: e.employeeNo, name: e.name, daysPresent: a?.days ?? 0, hoursWorked: a?.hours ?? 0, clockedInNow: a?.open ?? false };
  });
  if (q.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="attendance-${period}.csv"`);
    return res.send(toCsv(rows));
  }
  res.json({ data: rows, period });
});

// ---------- leave ----------
router.get('/hr/leave', requirePermission('hr.manage'), async (req, res) => {
  const q = parse(z.object({ status: z.string().optional(), employeeId: objectId.optional() }), req.query);
  const filter: Record<string, unknown> = {};
  if (q.status) filter.status = q.status;
  if (q.employeeId) filter.employeeId = q.employeeId;
  const rows = await LeaveRequest.find(filter).sort({ from: -1 }).limit(500).lean();
  const names = new Map((await Employee.find({ _id: { $in: rows.map((r) => r.employeeId) } }, { name: 1, employeeNo: 1 }).lean()).map((e) => [String(e._id), e]));
  res.json({ data: rows.map((r) => ({ ...r, employee: names.get(String(r.employeeId)) })) });
});

router.post('/hr/leave', requirePermission('hr.manage'), async (req, res) => {
  const body = parse(z.object({ employeeId: objectId, type: z.enum(['annual', 'sick', 'maternity', 'paternity', 'compassionate', 'unpaid']), from: z.coerce.date(), to: z.coerce.date(), days: z.number().positive().max(120).optional(), reason: z.string().max(300).optional() }), req.body);
  if (body.to < body.from) throw badRequest('The leave ends before it starts');
  const e = await Employee.findById(body.employeeId).lean();
  if (!e) throw notFound('Employee');
  const days = body.days ?? leaveDays(body.from, body.to);
  if (body.type === 'annual') {
    const bal = await leaveBalance(e, body.from.getUTCFullYear());
    if (days > bal.available - bal.pending) throw unprocessable(`Only ${Math.max(0, bal.available - bal.pending)} annual leave days are available`, 'LEAVE_EXCEEDS_BALANCE');
  }
  const l = await LeaveRequest.create({ ...body, days, requestedBy: req.auth!.userId });
  await audit(req, { action: 'hr.leave_requested', entity: 'LeaveRequest', entityId: l._id, details: { type: body.type, days } });
  res.status(201).json({ data: l });
});

router.post('/hr/leave/:id/decide', requirePermission('hr.manage'), async (req, res) => {
  const body = parse(z.object({ approve: z.boolean(), note: z.string().max(300).optional() }), req.body);
  const l = await LeaveRequest.findOneAndUpdate({ _id: idParam(req.params.id), status: 'pending' }, { $set: { status: body.approve ? 'approved' : 'rejected', decidedBy: req.auth!.userId, decidedAt: new Date(), decisionNote: body.note } }, { new: true });
  if (!l) throw unprocessable('This leave request has already been decided', 'ALREADY_DECIDED');
  await audit(req, { action: body.approve ? 'hr.leave_approved' : 'hr.leave_rejected', entity: 'LeaveRequest', entityId: l._id });
  res.json({ data: l });
});

router.post('/hr/leave/:id/cancel', requirePermission('hr.manage'), async (req, res) => {
  const l = await LeaveRequest.findOneAndUpdate({ _id: idParam(req.params.id), status: { $in: ['pending', 'approved'] } }, { $set: { status: 'cancelled' } }, { new: true });
  if (!l) throw notFound('Leave request');
  res.json({ data: l });
});

// ---------- salary advances ----------
router.get('/hr/advances', requirePermission('hr.manage'), async (req, res) => {
  const q = parse(z.object({ status: z.string().optional(), employeeId: objectId.optional() }), req.query);
  const filter: Record<string, unknown> = {};
  if (q.status) filter.status = q.status;
  if (q.employeeId) filter.employeeId = q.employeeId;
  const rows = await SalaryAdvance.find(filter).sort({ createdAt: -1 }).limit(500).lean();
  const names = new Map((await Employee.find({ _id: { $in: rows.map((r) => r.employeeId) } }, { name: 1, employeeNo: 1 }).lean()).map((e) => [String(e._id), e]));
  res.json({ data: rows.map((r) => ({ ...r, employee: names.get(String(r.employeeId)), outstandingCents: r.amountCents - r.recoveredCents })) });
});

router.post('/hr/advances', requirePermission('hr.manage'), async (req, res) => {
  const body = parse(z.object({ employeeId: objectId, amountCents: positiveCents, installmentCents: positiveCents.optional(), reason: z.string().max(300).optional(), payMethod: z.enum(['mpesa', 'cash', 'bank']).default('cash') }), req.body);
  const e = await Employee.findById(body.employeeId).lean();
  if (!e) throw notFound('Employee');
  const a = await SalaryAdvance.create({ ...body, installmentCents: Math.min(body.installmentCents ?? body.amountCents, body.amountCents), number: await nextNumber('advance', 'ADV'), requestedBy: req.auth!.userId });
  await audit(req, { action: 'hr.advance_requested', entity: 'SalaryAdvance', entityId: a._id, details: { amountCents: a.amountCents } });
  res.status(201).json({ data: a });
});

router.post('/hr/advances/:id/approve', requirePermission('payroll.approve'), async (req, res) => {
  const body = parse(z.object({ approve: z.boolean().default(true) }), req.body ?? {});
  const a = await SalaryAdvance.findById(idParam(req.params.id));
  if (!a || a.status !== 'requested') throw unprocessable('Only requested advances can be decided', 'NOT_REQUESTED');
  if (String(a.requestedBy) === String(req.auth!.userId)) throw forbidden('Another person must approve an advance you requested');
  a.status = body.approve ? 'approved' : 'rejected';
  a.approvedBy = req.auth!.userId;
  await a.save();
  await audit(req, { action: body.approve ? 'hr.advance_approved' : 'hr.advance_rejected', entity: 'SalaryAdvance', entityId: a._id });
  res.json({ data: a });
});

/** Pays out an approved advance: in cash/bank (recorded now) or as an M-Pesa B2C payout that is approved and sent like any payout. */
router.post('/hr/advances/:id/pay', requirePermission('payroll.manage'), async (req, res) => {
  const a = await SalaryAdvance.findById(idParam(req.params.id));
  if (!a || a.status !== 'approved') throw unprocessable('Only approved advances can be paid', 'NOT_APPROVED');
  if (a.payMethod === 'mpesa') {
    if (a.payoutId) throw unprocessable('A payout already exists for this advance', 'ALREADY_PAYING');
    const e = (await Employee.findById(a.employeeId).lean())!;
    const [p] = await createPayouts([{ purpose: 'salary', amountCents: a.amountCents, phone: e.mpesaPhone ?? e.phone ?? '', payeeName: e.name, employeeId: e._id, ref: { type: 'SalaryAdvance', id: a._id, number: a.number } }], req.auth!.userId);
    a.payoutId = p._id;
    await a.save();
    return res.json({ data: a, payout: p });
  }
  a.status = 'paid';
  a.paidAt = new Date();
  await a.save();
  await audit(req, { action: 'hr.advance_paid', entity: 'SalaryAdvance', entityId: a._id, details: { method: a.payMethod } });
  res.json({ data: a });
});

// ---------- payroll ----------
const inputSchema = z.object({
  daysWorked: z.number().min(0).max(31).optional(),
  hoursWorked: z.number().min(0).max(400).optional(),
  overtimeCents: money.optional(),
  bonusCents: money.optional(),
  extraAllowances: z.array(item.extend({ taxable: z.boolean().default(true) })).max(10).optional(),
  extraDeductions: z.array(item).max(10).optional(),
  holdAdvance: z.boolean().optional(),
});

async function loadRun(id: unknown) {
  const run = await PayrollRun.findById(idParam(id));
  if (!run) throw notFound('Payroll run');
  return run;
}

router.get('/hr/payroll', requirePermission('payroll.manage'), async (_req, res) => {
  res.json({ data: await PayrollRun.find({}, { lines: 0 }).sort({ period: -1, createdAt: -1 }).limit(100).lean() });
});

router.get('/hr/payroll/:id', requirePermission('payroll.manage'), async (req, res) => {
  const run = await PayrollRun.findById(idParam(req.params.id)).lean();
  if (!run) throw notFound('Payroll run');
  const names = await userNameMap([run.preparedBy, run.approvedBy]);
  const payouts = await Payout.find({ _id: { $in: run.lines.map((l) => l.payoutId).filter(Boolean) } }, { status: 1, receiptNumber: 1, resultDesc: 1 }).lean();
  res.json({ data: { ...run, preparedByName: names.get(String(run.preparedBy)), approvedByName: run.approvedBy ? names.get(String(run.approvedBy)) : undefined, payouts } });
});

router.post('/hr/payroll', requirePermission('payroll.manage'), async (req, res) => {
  const body = parse(z.object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), branchId: objectId.optional(), inputs: z.record(z.string(), inputSchema).default({}), notes: z.string().max(300).optional() }), req.body);
  const existing = await PayrollRun.findOne({ period: body.period, branchId: body.branchId ?? null, status: { $ne: 'cancelled' } }).lean();
  if (existing) throw unprocessable(`Payroll ${existing.number} already exists for ${body.period}; cancel it first or edit it`, 'PAYROLL_EXISTS');
  const employees = await employeesFor(body.branchId);
  if (!employees.length) throw unprocessable('No active employees to pay', 'NO_EMPLOYEES');
  const lines = await buildLines(employees, body.period, body.inputs as Record<string, LineInput>);
  const { start, end } = monthBounds(body.period);
  const run = await PayrollRun.create({ number: await nextNumber('payroll', 'PAY'), period: body.period, periodStart: start, periodEnd: new Date(end.getTime() - 1), branchId: body.branchId, lines, totals: runTotals(lines), rules: RULES_NAME, preparedBy: req.auth!.userId, notes: body.notes });
  await audit(req, { action: 'hr.payroll_created', entity: 'PayrollRun', entityId: run._id, details: { period: body.period, employees: lines.length, netCents: run.totals?.netCents } });
  res.status(201).json({ data: run });
});

/** Changes one employee's entries (days, hours, overtime, one-off items) and recalculates that payslip. */
router.patch('/hr/payroll/:id/lines/:lineId', requirePermission('payroll.manage'), async (req, res) => {
  const input = parse(inputSchema, req.body);
  const run = await loadRun(req.params.id);
  if (run.status !== 'draft') throw unprocessable('Only draft payrolls can be changed', 'NOT_DRAFT');
  const line = run.lines.id(String(req.params.lineId));
  if (!line) throw notFound('Payslip');
  const e = await Employee.findById(line.employeeId).lean();
  if (!e) throw notFound('Employee');
  const merged = { ...(line.input ?? {}), ...input };
  const [fresh] = await buildLines([e], run.period, { [String(e._id)]: merged });
  line.set(fresh);
  run.totals = runTotals(run.lines) as any;
  run.markModified('lines');
  await run.save();
  res.json({ data: run });
});

/** Rebuilds a draft from current employee records, keeping what was entered per employee. */
router.post('/hr/payroll/:id/recalculate', requirePermission('payroll.manage'), async (req, res) => {
  const run = await loadRun(req.params.id);
  if (run.status !== 'draft') throw unprocessable('Only draft payrolls can be recalculated', 'NOT_DRAFT');
  const inputs = Object.fromEntries(run.lines.map((l) => [String(l.employeeId), l.input ?? {}]));
  const lines = await buildLines(await employeesFor(run.branchId), run.period, inputs);
  run.set({ lines, totals: runTotals(lines), rules: RULES_NAME });
  await run.save();
  res.json({ data: run });
});

/** A different person approves; advance recoveries are booked against the advances at this point. */
router.post('/hr/payroll/:id/approve', requirePermission('payroll.approve'), async (req, res) => {
  const run = await withTransaction(async () => {
    const r = await loadRun(req.params.id);
    if (r.status !== 'draft') throw unprocessable('Only draft payrolls can be approved', 'NOT_DRAFT');
    if (String(r.preparedBy) === String(req.auth!.userId)) throw forbidden('Another person must approve a payroll you prepared');
    for (const line of r.lines) {
      let left = line.advanceRecoveryCents ?? 0;
      if (!left) continue;
      for (const a of await SalaryAdvance.find({ employeeId: line.employeeId, status: 'paid' }).sort({ createdAt: 1 })) {
        if (left <= 0) break;
        const take = Math.min(left, a.installmentCents, a.amountCents - a.recoveredCents);
        a.recoveredCents += take;
        if (a.recoveredCents >= a.amountCents) a.status = 'settled';
        await a.save();
        left -= take;
      }
    }
    r.status = 'approved';
    r.approvedBy = req.auth!.userId;
    r.approvedAt = new Date();
    await r.save();
    return r;
  });
  await audit(req, { action: 'hr.payroll_approved', entity: 'PayrollRun', entityId: run._id, details: { netCents: run.totals?.netCents } });
  res.json({ data: run });
});

router.post('/hr/payroll/:id/cancel', requirePermission('payroll.approve'), async (req, res) => {
  const run = await withTransaction(async () => {
    const r = await loadRun(req.params.id);
    if (r.status === 'paid' || r.lines.some((l) => l.paid || l.payoutId)) throw unprocessable('Payments have started for this payroll; it cannot be cancelled', 'PAYROLL_PAID');
    if (r.status === 'cancelled') return r;
    if (r.status === 'approved') {
      // Give the recovered advance amounts back.
      for (const line of r.lines) {
        let left = line.advanceRecoveryCents ?? 0;
        for (const a of await SalaryAdvance.find({ employeeId: line.employeeId, recoveredCents: { $gt: 0 } }).sort({ createdAt: -1 })) {
          if (left <= 0) break;
          const back = Math.min(left, a.recoveredCents);
          a.recoveredCents -= back;
          a.status = 'paid';
          await a.save();
          left -= back;
        }
      }
    }
    r.status = 'cancelled';
    await r.save();
    return r;
  });
  await audit(req, { action: 'hr.payroll_cancelled', entity: 'PayrollRun', entityId: run._id });
  res.json({ data: run });
});

/** Creates M-Pesa B2C salary payouts for the approved payroll; they still need a payout approver to send. */
router.post('/hr/payroll/:id/mpesa-payouts', requirePermission('payroll.manage'), requirePermission('payouts.request'), async (req, res) => {
  const run = await loadRun(req.params.id);
  if (run.status !== 'approved') throw unprocessable('Approve the payroll before paying it', 'NOT_APPROVED');
  const todo = run.lines.filter((l) => l.payMethod === 'mpesa' && !l.payoutId && !l.paid && (l.netCents ?? 0) >= 1000);
  const skipped: string[] = [];
  const rows: { line: (typeof todo)[number]; payout: Parameters<typeof createPayouts>[0][number] }[] = [];
  for (const l of todo) {
    // B2C pays whole shillings; any cents are paid with the next salary or in cash.
    const amount = Math.floor((l.netCents ?? 0) / 100) * 100;
    if (!l.mpesaPhone || !normalizePhone(l.mpesaPhone)) {
      skipped.push(`${l.name}: no valid M-Pesa number`);
      continue;
    }
    rows.push({ line: l, payout: { purpose: 'salary' as const, amountCents: amount, phone: l.mpesaPhone, payeeName: l.name ?? undefined, employeeId: l.employeeId, ref: { type: 'PayrollRun', id: run._id, number: run.number }, batchId: run.number } });
  }
  const created = rows.length ? await createPayouts(rows.map((r) => r.payout), req.auth!.userId) : [];
  created.forEach((p, i) => {
    rows[i].line.payoutId = p._id;
  });
  await run.save();
  await audit(req, { action: 'hr.payroll_payouts_created', entity: 'PayrollRun', entityId: run._id, details: { count: created.length, skipped: skipped.length } });
  res.status(201).json({ data: { created: created.length, totalCents: created.reduce((s, p) => s + p.amountCents, 0), batchId: run.number, skipped } });
});

/** Records salaries paid by bank or cash (or everything outstanding). */
router.post('/hr/payroll/:id/mark-paid', requirePermission('payroll.manage'), async (req, res) => {
  const body = parse(z.object({ lineIds: z.array(objectId).optional() }), req.body ?? {});
  const run = await loadRun(req.params.id);
  if (run.status !== 'approved') throw unprocessable('Approve the payroll before recording payment', 'NOT_APPROVED');
  for (const l of run.lines) {
    if (l.payoutId) continue; // M-Pesa lines are confirmed by Safaricom
    if (!body.lineIds || body.lineIds.some((id) => String(id) === String(l._id))) l.paid = true;
  }
  if (run.lines.every((l) => l.paid)) {
    run.status = 'paid';
    run.paidAt = new Date();
  }
  await run.save();
  await audit(req, { action: 'hr.payroll_marked_paid', entity: 'PayrollRun', entityId: run._id, details: { lines: body.lineIds?.length ?? 'all' } });
  res.json({ data: run });
});

/** Monthly statutory schedule: PAYE (for the iTax P10 return), SHIF, NSSF and Housing Levy per employee. */
router.get('/hr/payroll/:id/statutory', requirePermission('payroll.manage'), async (req, res) => {
  const q = parse(z.object({ format: z.enum(['json', 'csv']).default('json') }), req.query);
  const run = await loadRun(req.params.id);
  const c = (v?: number | null) => ((v ?? 0) / 100).toFixed(2);
  const rows = run.lines.map((l) => ({
    'Employee No': l.employeeNo, 'KRA PIN': l.kraPin ?? '', Name: l.name, 'ID No': l.idNumber ?? '', 'NSSF No': l.nssfNo ?? '', 'SHIF No': l.shifNo ?? '',
    'Gross pay': c(l.grossCents), 'NSSF employee': c(l.nssfCents), 'NSSF employer': c(l.nssfEmployerCents), 'SHIF': c(l.shifCents),
    'Housing levy employee': c(l.ahlCents), 'Housing levy employer': c(l.ahlEmployerCents), 'Taxable pay': c(l.taxablePayCents),
    'Tax charged': c(l.payeBeforeReliefCents), 'Personal relief': c(l.personalReliefCents), PAYE: c(l.payeCents),
  }));
  if (q.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="statutory-${run.period}.csv"`);
    return res.send(toCsv(rows));
  }
  res.json({ data: rows, totals: run.totals, period: run.period, rules: run.rules });
});

/** Bank transfer schedule for staff paid by bank. */
router.get('/hr/payroll/:id/bank-file', requirePermission('payroll.manage'), async (req, res) => {
  const run = await loadRun(req.params.id);
  const employees = new Map((await Employee.find({ _id: { $in: run.lines.map((l) => l.employeeId) } }).lean()).map((e) => [String(e._id), e]));
  const rows = run.lines.filter((l) => l.payMethod === 'bank').map((l) => {
    const e = employees.get(String(l.employeeId));
    return { 'Employee No': l.employeeNo, Name: l.name, Bank: e?.bank?.name ?? '', Branch: e?.bank?.branch ?? '', 'Account No': e?.bank?.accountNo ?? '', Amount: ((l.netCents ?? 0) / 100).toFixed(2), Reference: `${run.number} salary ${run.period}` };
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="bank-${run.period}.csv"`);
  res.send(toCsv(rows));
});

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function payslipHtml(t: any, run: any, l: any) {
  const cur = t.settings?.currency ?? 'KES';
  const m = (c: number) => formatMoney(c ?? 0, cur);
  const row = (label: string, v: number, strong = false) => `<tr${strong ? ' class="b"' : ''}><td>${esc(label)}</td><td class="n">${m(v)}</td></tr>`;
  const earnings = [row(l.payType === 'monthly' ? 'Basic salary' : `Basic (${l.payType === 'daily' ? `${l.daysWorked ?? 0} days` : `${l.hoursWorked ?? 0} hours`})`, l.basicCents),
    ...(l.allowances ?? []).map((a: any) => row(a.name + (a.taxable === false ? ' (non-taxable)' : ''), a.amountCents)),
    ...(l.overtimeCents ? [row('Overtime', l.overtimeCents)] : []), ...(l.unpaidLeaveCents ? [row(`Unpaid leave (${l.unpaidLeaveDays} days)`, -l.unpaidLeaveCents)] : []), row('Gross pay', l.grossCents, true)].join('');
  const deductions = [row('NSSF', l.nssfCents), row('SHIF', l.shifCents), row('Housing levy', l.ahlCents), ...(l.pensionCents ? [row('Pension', l.pensionCents)] : []), row('PAYE', l.payeCents),
    ...(l.deductions ?? []).map((d: any) => row(d.name, d.amountCents)), ...(l.advanceRecoveryCents ? [row('Salary advance recovery', l.advanceRecoveryCents)] : [])].join('');
  return `<section class="slip"><header><div><h1>${esc(t.name)}</h1><div class="muted">${esc(t.contact?.address ?? '')}${t.settings?.taxPin ? ` · PIN ${esc(t.settings.taxPin)}` : ''}</div></div><div class="r"><h2>Payslip</h2><div>${esc(run.period)} · ${esc(run.number)}</div></div></header>
  <table class="who"><tr><td>Name</td><td>${esc(l.name)}</td><td>Employee No</td><td>${esc(l.employeeNo)}</td></tr><tr><td>Job title</td><td>${esc(l.jobTitle ?? '')}</td><td>KRA PIN</td><td>${esc(l.kraPin ?? '')}</td></tr><tr><td>NSSF No</td><td>${esc(l.nssfNo ?? '')}</td><td>SHIF No</td><td>${esc(l.shifNo ?? '')}</td></tr></table>
  <div class="cols"><table><thead><tr><th colspan="2">Earnings</th></tr></thead>${earnings}</table><table><thead><tr><th colspan="2">Deductions</th></tr></thead>${deductions}</table></div>
  <table class="tax">${row('Taxable pay', l.taxablePayCents)}${row('Tax charged', l.payeBeforeReliefCents)}${row('Personal relief', l.personalReliefCents)}</table>
  <div class="net">Net pay <span>${m(l.netCents)}</span></div><div class="muted">Paid by ${esc(l.payMethod)}${l.payMethod === 'mpesa' && l.mpesaPhone ? ` to ${esc(l.mpesaPhone)}` : ''}${l.payMethod === 'bank' && l.bankAccount ? ` to ${esc(l.bankAccount)}` : ''}. Employer also pays NSSF ${m(l.nssfEmployerCents)}, housing levy ${m(l.ahlEmployerCents)}, NITA ${m(l.nitaCents)}.</div></section>`;
}

router.get('/hr/payroll/:id/payslips', requirePermission('payroll.manage'), async (req, res) => {
  const q = parse(z.object({ lineId: objectId.optional() }), req.query);
  const run = await loadRun(req.params.id);
  const t = await runAsPlatform(() => Tenant.findById(req.tenant!._id).lean());
  const lines = run.lines.filter((l) => !q.lineId || String(l._id) === String(q.lineId));
  if (!lines.length) throw notFound('Payslip');
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Payslips ${esc(run.period)}</title><style>
  @page { size: A5; margin: 10mm; } body { font: 12px/1.4 system-ui, Segoe UI, Roboto, sans-serif; color: #111; margin: 0; }
  .slip { page-break-after: always; padding: 6mm; max-width: 148mm; margin: 0 auto; } header { display: flex; justify-content: space-between; border-bottom: 2px solid #0f766e; margin-bottom: 8px; }
  h1 { font-size: 16px; margin: 0; color: #0f766e; } h2 { font-size: 14px; margin: 0; } .r { text-align: right; } .muted { color: #555; font-size: 11px; }
  table { width: 100%; border-collapse: collapse; margin: 6px 0; } td, th { padding: 3px 4px; border-bottom: 1px solid #eee; text-align: left; } .n { text-align: right; font-variant-numeric: tabular-nums; }
  .b td { font-weight: 600; } .cols { display: flex; gap: 10px; } .cols table { flex: 1; } .who td:nth-child(odd) { color: #555; width: 18%; }
  .net { font-size: 16px; font-weight: 700; display: flex; justify-content: space-between; border-top: 2px solid #111; padding-top: 6px; margin-top: 6px; }
  </style></head><body>${lines.map((l) => payslipHtml(t, run, l)).join('')}<script>window.onload=()=>window.print()</script></body></html>`);
});

export const hrRoutes = router;
