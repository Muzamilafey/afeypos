import { Schema } from 'mongoose';
import { ObjectId, refSchema, tenantModel } from './common.js';

const customerSchema = new Schema(
  {
    code: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, lowercase: true, trim: true },
    taxPin: String,
    address: String,
    kind: { type: String, enum: ['walk_in', 'retail', 'wholesale', 'contractor', 'corporate'], default: 'retail' },
    priceList: { type: String, enum: ['retail', 'wholesale', 'contractor'], default: 'retail' },
    creditLimitCents: { type: Number, default: 0 },
    /** Amount the customer owes the business (receivable). */
    balanceCents: { type: Number, default: 0 },
    paymentTermsDays: { type: Number, default: 30 },
    loyaltyPoints: { type: Number, default: 0 },
    dateOfBirth: Date,
    salesRepId: { type: ObjectId, ref: 'User' },
    notes: String,
    active: { type: Boolean, default: true },
    /** CRM: free tags ("hotel", "estate A"), who looks after the account, how they found us. */
    tags: { type: [String], default: [] },
    accountManagerId: ObjectId,
    gender: { type: String, enum: ['female', 'male', 'other', null], default: null },
    source: String,
    /** Consent to marketing messages (Kenya Data Protection Act); receipts and statements do not need it. */
    marketingOptIn: { type: Boolean, default: false },
    marketingOptInAt: Date,
    marketingOptOutAt: Date,
  },
  { timestamps: true },
);
customerSchema.index({ tenantId: 1, code: 1 }, { unique: true });
customerSchema.index({ tenantId: 1, tags: 1 });
customerSchema.index({ tenantId: 1, phone: 1 });
customerSchema.index({ tenantId: 1, name: 'text', phone: 'text', email: 'text' });
export const Customer = tenantModel('Customer', customerSchema);

const supplierSchema = new Schema(
  {
    code: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    phone: String,
    email: { type: String, lowercase: true, trim: true },
    taxPin: String,
    address: String,
    contactPerson: String,
    /** Amount the business owes the supplier (payable). */
    balanceCents: { type: Number, default: 0 },
    paymentTermsDays: { type: Number, default: 30 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
supplierSchema.index({ tenantId: 1, code: 1 }, { unique: true });
export const Supplier = tenantModel('Supplier', supplierSchema);

/**
 * Account ledger for customers (receivables) and suppliers (payables).
 * amountCents > 0 increases what the party owes / is owed; payments are negative.
 * Debit documents (invoices, credit sales, GRNs) carry openCents for allocation and ageing.
 */
const ledgerEntrySchema = new Schema(
  {
    partyType: { type: String, enum: ['customer', 'supplier'], required: true },
    partyId: { type: ObjectId, required: true },
    kind: { type: String, enum: ['opening', 'credit_sale', 'invoice', 'payment', 'return', 'adjustment', 'purchase', 'supplier_return', 'refund'], required: true },
    amountCents: { type: Number, required: true },
    openCents: { type: Number, default: 0 },
    balanceAfterCents: { type: Number, required: true },
    dueDate: Date,
    ref: { type: refSchema },
    method: String,
    reference: String,
    allocations: { type: [{ entryId: ObjectId, amountCents: Number, _id: false }], default: undefined },
    notes: String,
    userId: ObjectId,
    at: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);
ledgerEntrySchema.index({ tenantId: 1, partyType: 1, partyId: 1, at: 1 });
ledgerEntrySchema.index({ tenantId: 1, partyType: 1, openCents: 1 });
export const LedgerEntry = tenantModel('LedgerEntry', ledgerEntrySchema);
