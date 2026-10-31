import { Schema } from 'mongoose';
import { ObjectId, tenantModel } from './common.js';

/** Chart of accounts. System accounts (key set) are used by automatic posting and cannot be deleted. */
const accountSchema = new Schema(
  {
    code: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: ['asset', 'liability', 'equity', 'income', 'expense'], required: true },
    /** Finer grouping for statements: current_asset, inventory, cogs, operating_expense... */
    subtype: String,
    key: String,
    description: String,
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
accountSchema.index({ tenantId: 1, code: 1 }, { unique: true });
accountSchema.index({ tenantId: 1, key: 1 }, { unique: true, partialFilterExpression: { key: { $type: 'string' } } });
export const Account = tenantModel('Account', accountSchema);

const journalLineSchema = new Schema(
  {
    accountCode: { type: String, required: true },
    debitCents: { type: Number, default: 0, min: 0 },
    creditCents: { type: Number, default: 0, min: 0 },
    branchId: ObjectId,
    partyType: String,
    partyId: ObjectId,
    memo: String,
  },
  { _id: false },
);

/** Double-entry journal. Automatic entries carry the source document and a unique key, so posting is idempotent. */
const journalEntrySchema = new Schema(
  {
    number: { type: String, required: true },
    date: { type: Date, required: true },
    memo: String,
    source: { type: { type: String }, id: ObjectId, number: String },
    sourceKey: String,
    manual: { type: Boolean, default: false },
    reversalOf: ObjectId,
    reversedBy: ObjectId,
    branchId: ObjectId,
    lines: { type: [journalLineSchema], required: true },
    totalCents: Number,
    createdBy: ObjectId,
  },
  { timestamps: true },
);
journalEntrySchema.index({ tenantId: 1, number: 1 }, { unique: true });
journalEntrySchema.index({ tenantId: 1, sourceKey: 1 }, { unique: true, partialFilterExpression: { sourceKey: { $type: 'string' } } });
journalEntrySchema.index({ tenantId: 1, date: 1 });
journalEntrySchema.index({ tenantId: 1, 'lines.accountCode': 1, date: 1 });
export const JournalEntry = tenantModel('JournalEntry', journalEntrySchema);

/**
 * A real account money sits in: a bank account, an M-Pesa account, the safe or a petty-cash float. Each one
 * points at a ledger account, so deposits, transfers and payments post themselves and can be reconciled
 * against the bank's own statement.
 */
const bankAccountSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    kind: { type: String, enum: ['bank', 'mpesa', 'cash', 'petty_cash', 'card', 'other'], default: 'bank' },
    bank: String,
    accountNumber: String,
    branchId: ObjectId,
    /** Ledger account this money belongs to (chart of accounts code). */
    accountCode: { type: String, required: true },
    currency: { type: String, default: 'KES' },
    openingBalanceCents: { type: Number, default: 0 },
    openingDate: Date,
    /** Expenses and payouts paid this way land here (cash, mpesa, bank, card). */
    paymentMethods: { type: [String], default: [] },
    active: { type: Boolean, default: true },
    notes: String,
  },
  { timestamps: true },
);
bankAccountSchema.index({ tenantId: 1, name: 1 }, { unique: true });
export const BankAccount = tenantModel('BankAccount', bankAccountSchema, { branchScope: [{ path: 'branchId', kind: 'branch' }] });

/**
 * Money in or out of one of those accounts that the shop records itself: a deposit of till cash, a withdrawal,
 * a transfer between accounts, bank charges or interest. Sales and expenses post their own journals, so they
 * appear in the reconciliation through the ledger, not here.
 */
const bankTransactionSchema = new Schema(
  {
    number: { type: String, required: true },
    accountId: { type: ObjectId, required: true },
    /** deposit and charge add to the account; withdrawal and fee take away; transfer moves to toAccountId. */
    kind: { type: String, enum: ['deposit', 'withdrawal', 'transfer', 'charge', 'interest'], required: true },
    toAccountId: ObjectId,
    amountCents: { type: Number, required: true, min: 1 },
    date: { type: Date, default: () => new Date() },
    reference: String,
    memo: String,
    branchId: ObjectId,
    shiftId: ObjectId,
    journalId: ObjectId,
    /** Ticked off against the bank's statement. */
    reconciledAt: Date,
    reconciledBy: ObjectId,
    statementRef: String,
    userId: ObjectId,
  },
  { timestamps: true },
);
bankTransactionSchema.index({ tenantId: 1, number: 1 }, { unique: true });
bankTransactionSchema.index({ tenantId: 1, accountId: 1, date: -1 });
export const BankTransaction = tenantModel('BankTransaction', bankTransactionSchema, { branchScope: [{ path: 'branchId', kind: 'branch' }] });

/** What a category may be spent in a month, so Expenses can show spending against the budget. */
const budgetSchema = new Schema(
  {
    /** YYYY-MM. */
    period: { type: String, required: true },
    category: { type: String, required: true, trim: true },
    branchId: ObjectId,
    amountCents: { type: Number, required: true, min: 0 },
    notes: String,
  },
  { timestamps: true },
);
budgetSchema.index({ tenantId: 1, period: 1, category: 1, branchId: 1 }, { unique: true });
export const Budget = tenantModel('Budget', budgetSchema, { branchScope: [{ path: 'branchId', kind: 'branch' }] });
