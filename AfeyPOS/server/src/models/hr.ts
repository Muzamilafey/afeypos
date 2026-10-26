import { Schema } from 'mongoose';
import { ObjectId, tenantModel } from './common.js';

const moneyItem = { name: { type: String, required: true }, amountCents: { type: Number, required: true }, _id: false };

/** A person on the payroll. Staff who use the till are linked to their user account (attendance, card). */
const employeeSchema = new Schema(
  {
    userId: ObjectId,
    employeeNo: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    idNumber: String,
    kraPin: String,
    nssfNo: String,
    shifNo: String,
    phone: String,
    email: String,
    dateOfBirth: Date,
    gender: { type: String, enum: ['female', 'male', 'other', null], default: null },
    branchId: ObjectId,
    department: String,
    jobTitle: String,
    employmentType: { type: String, enum: ['permanent', 'contract', 'casual'], default: 'permanent' },
    /** monthly: rateCents is the monthly basic salary; daily / hourly: the rate per day or hour worked. */
    payType: { type: String, enum: ['monthly', 'daily', 'hourly'], default: 'monthly' },
    rateCents: { type: Number, required: true, min: 0 },
    allowances: { type: [{ ...moneyItem, taxable: { type: Boolean, default: true } }], default: [] },
    /** Recurring deductions after tax (SACCO, welfare, loan repayments...). */
    deductions: { type: [moneyItem], default: [] },
    /** Extra pension contributions (deductible with NSSF up to the KRA limit). */
    pensionCents: { type: Number, default: 0 },
    payMethod: { type: String, enum: ['mpesa', 'bank', 'cash'], default: 'mpesa' },
    mpesaPhone: String,
    bank: { name: String, branch: String, accountNo: String },
    startDate: { type: Date, default: () => new Date() },
    endDate: Date,
    status: { type: String, enum: ['active', 'suspended', 'terminated'], default: 'active' },
    annualLeaveDays: { type: Number, default: 21 },
    /** Leave days carried in when the employee was added to Afey POS. */
    leaveOpeningDays: { type: Number, default: 0 },
    emergencyContact: { name: String, phone: String },
    notes: String,
  },
  { timestamps: true },
);
employeeSchema.index({ tenantId: 1, employeeNo: 1 }, { unique: true });
employeeSchema.index({ tenantId: 1, userId: 1 }, { unique: true, partialFilterExpression: { userId: { $type: 'objectId' } } });
export const Employee = tenantModel('Employee', employeeSchema, { branchScope: [{ path: 'branchId', kind: 'branch' }] });

const leaveSchema = new Schema(
  {
    employeeId: { type: ObjectId, required: true },
    type: { type: String, enum: ['annual', 'sick', 'maternity', 'paternity', 'compassionate', 'unpaid'], required: true },
    from: { type: Date, required: true },
    to: { type: Date, required: true },
    days: { type: Number, required: true },
    reason: String,
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'cancelled'], default: 'pending' },
    requestedBy: ObjectId,
    decidedBy: ObjectId,
    decidedAt: Date,
    decisionNote: String,
  },
  { timestamps: true },
);
leaveSchema.index({ tenantId: 1, employeeId: 1, from: -1 });
export const LeaveRequest = tenantModel('LeaveRequest', leaveSchema);

const advanceSchema = new Schema(
  {
    number: { type: String, required: true },
    employeeId: { type: ObjectId, required: true },
    amountCents: { type: Number, required: true, min: 1 },
    /** Recovered from each payroll until settled. */
    installmentCents: { type: Number, required: true, min: 1 },
    recoveredCents: { type: Number, default: 0 },
    reason: String,
    status: { type: String, enum: ['requested', 'approved', 'paid', 'settled', 'rejected'], default: 'requested' },
    payMethod: { type: String, enum: ['mpesa', 'cash', 'bank'], default: 'cash' },
    payoutId: ObjectId,
    requestedBy: ObjectId,
    approvedBy: ObjectId,
    paidAt: Date,
  },
  { timestamps: true },
);
advanceSchema.index({ tenantId: 1, number: 1 }, { unique: true });
export const SalaryAdvance = tenantModel('SalaryAdvance', advanceSchema);

const payslipSchema = new Schema(
  {
    employeeId: { type: ObjectId, required: true },
    employeeNo: String,
    name: String,
    kraPin: String,
    nssfNo: String,
    shifNo: String,
    idNumber: String,
    jobTitle: String,
    payType: String,
    daysWorked: Number,
    hoursWorked: Number,
    basicCents: Number,
    allowances: { type: [{ ...moneyItem, taxable: Boolean }], default: [] },
    overtimeCents: { type: Number, default: 0 },
    /** Unpaid leave and absences (daily/hourly staff are simply paid for time worked). */
    unpaidLeaveDays: { type: Number, default: 0 },
    unpaidLeaveCents: { type: Number, default: 0 },
    grossCents: Number,
    nssfCents: Number,
    nssfEmployerCents: Number,
    shifCents: Number,
    ahlCents: Number,
    ahlEmployerCents: Number,
    nitaCents: Number,
    pensionCents: Number,
    taxablePayCents: Number,
    payeBeforeReliefCents: Number,
    personalReliefCents: Number,
    payeCents: Number,
    deductions: { type: [moneyItem], default: [] },
    advanceRecoveryCents: { type: Number, default: 0 },
    netCents: Number,
    employerCostCents: Number,
    payMethod: String,
    mpesaPhone: String,
    bankAccount: String,
    payoutId: ObjectId,
    paid: { type: Boolean, default: false },
    /** What was entered for this month (days, hours, overtime, one-off items), kept for recalculation. */
    input: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: true },
);

const payrollRunSchema = new Schema(
  {
    number: { type: String, required: true },
    /** YYYY-MM */
    period: { type: String, required: true },
    periodStart: Date,
    periodEnd: Date,
    branchId: ObjectId,
    status: { type: String, enum: ['draft', 'approved', 'paid', 'cancelled'], default: 'draft' },
    rules: String,
    lines: { type: [payslipSchema], default: [] },
    totals: {
      grossCents: Number, netCents: Number, payeCents: Number, nssfCents: Number, nssfEmployerCents: Number, shifCents: Number,
      ahlCents: Number, ahlEmployerCents: Number, nitaCents: Number, deductionsCents: Number, advanceRecoveryCents: Number, employerCostCents: Number, employees: Number,
    },
    preparedBy: ObjectId,
    approvedBy: ObjectId,
    approvedAt: Date,
    paidAt: Date,
    notes: String,
  },
  { timestamps: true },
);
payrollRunSchema.index({ tenantId: 1, number: 1 }, { unique: true });
payrollRunSchema.index({ tenantId: 1, period: 1 });
export const PayrollRun = tenantModel('PayrollRun', payrollRunSchema, { branchScope: [{ path: 'branchId', kind: 'branch' }] });
