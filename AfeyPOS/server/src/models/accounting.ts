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
