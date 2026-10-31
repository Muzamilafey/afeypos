import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { formatMoney } from '@afeypos/shared';
import { CashMovement, Customer, LedgerEntry, PaymentIntent, Sale, Shift, Supplier, GoodsReceipt, Tenant } from '../../models/index.js';
import { escapeRegex, idParam, objectId, pagination, parse, positiveCents } from '../../http/validate.js';
import { requireModule, requirePermission } from '../../http/auth.js';
import { idempotent } from '../../http/idempotency.js';
import { withTransaction } from '../../db/connection.js';
import { AppError, badRequest, notFound, unprocessable } from '../../lib/errors.js';
import { nextNumber } from '../../lib/numbering.js';
import { audit } from '../../lib/audit.js';
import { allocateAgainstOpen, postCustomerCredit } from '../sales/returns.js';
import { notify } from '../notifications/service.js';
import { runAsPlatform } from '../../lib/context.js';

const router = Router();

const customerSchema = z.object({
  name: z.string().trim().min(1).max(160),
  code: z.string().trim().max(40).optional(),
  phone: z.string().trim().max(30).optional(),
  email: z.string().trim().toLowerCase().email().optional().or(z.literal('')),
  taxPin: z.string().trim().max(40).optional(),
  address: z.string().max(300).optional(),
  kind: z.enum(['retail', 'wholesale', 'contractor', 'corporate']).default('retail'),
  priceList: z.enum(['retail', 'wholesale', 'contractor']).default('retail'),
  creditLimitCents: positiveCents.default(0),
  paymentTermsDays: z.number().int().min(0).max(365).default(30),
  dateOfBirth: z.coerce.date().optional(),
  salesRepId: objectId.nullish(),
  notes: z.string().max(1000).optional(),
  active: z.boolean().default(true),
  tags: z.array(z.string().trim().toLowerCase().min(1).max(40)).max(20).optional(),
  accountManagerId: objectId.nullish(),
  gender: z.enum(['female', 'male', 'other']).nullish(),
  source: z.string().trim().max(60).optional(),
  marketingOptIn: z.boolean().optional(),
});

/** Ageing buckets of open debit entries relative to due date. */
export async function ageing(partyType: 'customer' | 'supplier', partyId?: Types.ObjectId, asOf = new Date()) {
  const match: Record<string, unknown> = { partyType, openCents: { $gt: 0 } };
  if (partyId) match.partyId = partyId;
  const rows = await LedgerEntry.aggregate([
    { $match: match },
    { $addFields: { days: { $dateDiff: { startDate: { $ifNull: ['$dueDate', '$at'] }, endDate: asOf, unit: 'day' } } } },
    {
      $group: {
        _id: '$partyId',
        current: { $sum: { $cond: [{ $lte: ['$days', 0] }, '$openCents', 0] } },
        d1_30: { $sum: { $cond: [{ $and: [{ $gt: ['$days', 0] }, { $lte: ['$days', 30] }] }, '$openCents', 0] } },
        d31_60: { $sum: { $cond: [{ $and: [{ $gt: ['$days', 30] }, { $lte: ['$days', 60] }] }, '$openCents', 0] } },
        d61_90: { $sum: { $cond: [{ $and: [{ $gt: ['$days', 60] }, { $lte: ['$days', 90] }] }, '$openCents', 0] } },
        d90plus: { $sum: { $cond: [{ $gt: ['$days', 90] }, '$openCents', 0] } },
        total: { $sum: '$openCents' },
      },
    },
    { $sort: { total: -1 } },
  ]);
  return rows;
}

// ---- customers ----
router.get('/customers', requirePermission('customers.read'), requireModule('customers'), async (req, res) => {
  const q = parse(pagination.extend({ withBalance: z.enum(['true']).optional(), kind: z.string().optional(), tag: z.string().optional() }), req.query);
  const filter: Record<string, unknown> = {};
  if (q.q) {
    const rx = new RegExp(escapeRegex(q.q), 'i');
    filter.$or = [{ name: rx }, { phone: rx }, { code: rx }, { email: rx }];
  }
  if (q.withBalance) filter.balanceCents = { $gt: 0 };
  if (q.kind) filter.kind = q.kind;
  if (q.tag) filter.tags = q.tag.toLowerCase();
  const [data, total] = await Promise.all([Customer.find(filter).sort({ name: 1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), Customer.countDocuments(filter)]);
  res.json({ data, total, page: q.page, limit: q.limit });
});

router.post('/customers', requirePermission('customers.manage'), requireModule('customers'), async (req, res) => {
  const body = parse(customerSchema, req.body);
  if (body.creditLimitCents > 0 && !req.auth!.permissions.has('credit.approve')) throw badRequest('Setting a credit limit requires credit approval permission');
  const code = body.code || (await nextNumber('customer', 'C', 5));
  const c = await Customer.create({ ...body, code, email: body.email || undefined, ...(body.marketingOptIn ? { marketingOptInAt: new Date() } : {}) });
  await audit(req, { action: 'customer.created', entity: 'Customer', entityId: c._id });
  res.status(201).json({ data: c });
});

router.get('/customers/:id', requirePermission('customers.read'), requireModule('customers'), async (req, res) => {
  const c = await Customer.findById(idParam(req.params.id)).lean();
  if (!c) throw notFound('Customer');
  const [recentSales, age] = await Promise.all([
    Sale.find({ customerId: c._id }, { number: 1, totalCents: 1, creditCents: 1, status: 1, completedAt: 1 }).sort({ completedAt: -1 }).limit(20).lean(),
    ageing('customer', c._id),
  ]);
  res.json({ data: { ...c, recentSales, ageing: age[0] ?? null } });
});

router.patch('/customers/:id', requirePermission('customers.manage'), requireModule('customers'), async (req, res) => {
  const body = parse(customerSchema.partial(), req.body);
  const id = idParam(req.params.id);
  const before = await Customer.findById(id).lean();
  if (!before) throw notFound('Customer');
  if (body.creditLimitCents !== undefined && body.creditLimitCents !== before.creditLimitCents && !req.auth!.permissions.has('credit.approve')) {
    throw badRequest('Changing a credit limit requires credit approval permission');
  }
  const consent = body.marketingOptIn === true && !before.marketingOptIn ? { marketingOptInAt: new Date() } : body.marketingOptIn === false && before.marketingOptIn ? { marketingOptOutAt: new Date() } : {};
  const c = await Customer.findOneAndUpdate({ _id: id }, { $set: { ...body, ...consent } }, { new: true });
  await audit(req, { action: 'customer.updated', entity: 'Customer', entityId: id, details: body.creditLimitCents !== undefined ? { creditLimitBefore: before.creditLimitCents, creditLimitAfter: body.creditLimitCents } : undefined });
  res.json({ data: c });
});

router.get('/customers/:id/statement', requirePermission('customers.read'), requireModule('customers'), async (req, res) => {
  const id = idParam(req.params.id);
  const q = parse(z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }), req.query);
  const c = await Customer.findById(id).lean();
  if (!c) throw notFound('Customer');
  const filter: Record<string, unknown> = { partyType: 'customer', partyId: id };
  if (q.from || q.to) filter.at = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  const entries = await LedgerEntry.find(filter).sort({ at: 1 }).lean();
  const opening = q.from ? (await LedgerEntry.findOne({ partyType: 'customer', partyId: id, at: { $lt: q.from } }).sort({ at: -1 }).lean())?.balanceAfterCents ?? 0 : 0;
  res.json({ data: { customer: c, openingBalanceCents: opening, entries, closingBalanceCents: entries.length ? entries[entries.length - 1].balanceAfterCents : opening, ageing: (await ageing('customer', id))[0] ?? null } });
});

router.post('/customers/:id/statement/send', requirePermission('customers.read'), requireModule('customers'), async (req, res) => {
  const c = await Customer.findById(idParam(req.params.id)).lean();
  if (!c) throw notFound('Customer');
  const tenant = await runAsPlatform(() => Tenant.findById(req.tenant!._id).lean());
  const cur = tenant?.settings?.currency ?? 'KES';
  const entries = await LedgerEntry.find({ partyType: 'customer', partyId: c._id }).sort({ at: -1 }).limit(30).lean();
  const statementText = entries.reverse().map((e) => `${e.at.toISOString().slice(0, 10)}  ${e.kind.padEnd(12)} ${(e.ref?.number ?? '').padEnd(14)} ${formatMoney(e.amountCents, cur).padStart(14)}  bal ${formatMoney(e.balanceAfterCents, cur)}`).join('\n');
  const data = { business: tenant?.name, customer: c.name, balance: formatMoney(c.balanceCents, cur), statementText };
  const out: Record<string, unknown> = {};
  if (c.email) out.email = await notify({ channel: 'email', to: c.email, templateKey: 'customer_statement', data });
  if (c.phone) out.sms = await notify({ channel: 'sms', to: c.phone, templateKey: 'customer_statement', data });
  res.status(202).json({ data: out });
});

const paymentSchema = z.object({
  clientRequestId: z.string().min(8).max(100),
  amountCents: positiveCents.refine((v) => v > 0, 'Amount must be positive'),
  method: z.enum(['cash', 'mpesa', 'gateway', 'card', 'bank', 'cheque', 'other']),
  reference: z.string().trim().max(100).optional(),
  paymentIntentId: objectId.optional(),
  tillId: objectId.optional(),
  notes: z.string().max(300).optional(),
});

/** Customer pays towards their account; allocated FIFO to the oldest open invoices/credit sales. */
router.post('/customers/:id/payments', requirePermission('customers.payments'), requireModule('customerCredit'), idempotent('customer-payment'), async (req, res) => {
  const id = idParam(req.params.id);
  const body = parse(paymentSchema, req.body);
  const existing = await LedgerEntry.findOne({ partyType: 'customer', partyId: id, reference: `req:${body.clientRequestId}` }).lean();
  if (existing) {
    res.json({ data: existing, replay: true });
    return;
  }
  const result = await withTransaction(async () => {
    const customer = await Customer.findById(id);
    if (!customer) throw notFound('Customer');
    const number = await nextNumber('receipt', 'PAY');
    const payId = new Types.ObjectId();
    let reference = body.reference;
    if (body.method === 'mpesa' || body.method === 'gateway') {
      if (!body.paymentIntentId) throw badRequest('Select the confirmed payment');
      const intent = await PaymentIntent.findOneAndUpdate(
        { _id: body.paymentIntentId, provider: body.method === 'mpesa' ? 'mpesa' : { $ne: 'mpesa' }, status: 'succeeded', $expr: { $gte: [{ $subtract: ['$paidAmountCents', '$allocatedCents'] }, body.amountCents] } },
        { $inc: { allocatedCents: body.amountCents }, $set: { allocatedTo: { kind: 'customer_payment', id: payId, number }, allocatedAt: new Date() } },
        { new: true },
      );
      if (!intent) throw unprocessable('Payment not confirmed or already used', body.method === 'mpesa' ? 'MPESA_NOT_AVAILABLE' : 'PAYMENT_NOT_AVAILABLE');
      reference = intent.receiptNumber ?? intent.reference ?? reference;
    }
    if (body.method === 'cash' && body.tillId) {
      const shift = await Shift.findOne({ tillId: body.tillId, status: 'open' });
      if (!shift) throw new AppError(409, 'SHIFT_REQUIRED', 'Open a shift on this till to receive cash');
      await CashMovement.create([{ shiftId: shift._id, tillId: body.tillId, type: 'customer_payment', amountCents: body.amountCents, userId: req.auth!.userId, ref: { type: 'CustomerPayment', id: payId, number } }]);
    }
    const r = await postCustomerCredit(customer._id, body.amountCents, { type: 'CustomerPayment', id: payId, number }, req.auth!.userId, 'payment', { method: body.method, reference: `req:${body.clientRequestId}` });
    await LedgerEntry.updateOne({ _id: r.entry._id }, { $set: { notes: [reference, body.notes].filter(Boolean).join(' - ') } });
    await audit(req, { action: 'customer.payment_received', entity: 'Customer', entityId: customer._id, details: { number, amountCents: body.amountCents, method: body.method, reference } });
    return { entry: r.entry, balanceCents: r.balanceCents, number, customer, reference };
  });
  const tenant = await runAsPlatform(() => Tenant.findById(req.tenant!._id).lean());
  const cur = tenant?.settings?.currency ?? 'KES';
  if (result.customer.phone && req.capabilities!.modules.includes('sms')) {
    await notify({ channel: 'sms', to: result.customer.phone, templateKey: 'payment_confirmation', data: { business: tenant?.name, amount: formatMoney(body.amountCents, cur), reference: result.reference ?? result.number, balance: formatMoney(result.balanceCents, cur), customer: result.customer.name }, dedupeKey: `pay:${result.number}` });
  }
  res.status(201).json({ data: { number: result.number, balanceCents: result.balanceCents, entry: result.entry } });
});

router.post('/customers/:id/adjustments', requirePermission('credit.approve'), requireModule('customerCredit'), async (req, res) => {
  const body = parse(z.object({ amountCents: z.number().int().refine((v) => v !== 0), reason: z.string().trim().min(3).max(300) }), req.body);
  const id = idParam(req.params.id);
  const r = await withTransaction(async () => {
    const c = await Customer.findOneAndUpdate({ _id: id }, { $inc: { balanceCents: body.amountCents } }, { new: true });
    if (!c) throw notFound('Customer');
    const number = await nextNumber('adjustment-customer', 'CAD');
    const allocations = body.amountCents < 0 ? await allocateAgainstOpen('customer', id, -body.amountCents) : undefined;
    const [e] = await LedgerEntry.create([{ partyType: 'customer', partyId: id, kind: 'adjustment', amountCents: body.amountCents, openCents: body.amountCents > 0 ? body.amountCents : 0, balanceAfterCents: c.balanceCents, notes: body.reason, ref: { type: 'Adjustment', id: new Types.ObjectId(), number }, userId: req.auth!.userId, allocations }]);
    await audit(req, { action: 'customer.balance_adjusted', entity: 'Customer', entityId: id, details: body });
    return e;
  });
  res.status(201).json({ data: r });
});

router.get('/receivables/ageing', requirePermission('reports.financial'), requireModule('customerCredit'), async (_req, res) => {
  const rows = await ageing('customer');
  const names = new Map((await Customer.find({ _id: { $in: rows.map((r) => r._id) } }, { name: 1, phone: 1, creditLimitCents: 1 }).lean()).map((c) => [String(c._id), c]));
  res.json({ data: rows.map((r) => ({ ...r, customer: names.get(String(r._id)) })) });
});

// ---- suppliers ----
const supplierSchema = z.object({
  name: z.string().trim().min(1).max(160),
  code: z.string().trim().max(40).optional(),
  phone: z.string().trim().max(30).optional(),
  email: z.string().trim().toLowerCase().email().optional().or(z.literal('')),
  taxPin: z.string().max(40).optional(),
  address: z.string().max(300).optional(),
  contactPerson: z.string().max(120).optional(),
  paymentTermsDays: z.number().int().min(0).max(365).default(30),
  active: z.boolean().default(true),
});

router.get('/suppliers', requirePermission('suppliers.read'), requireModule('suppliers'), async (req, res) => {
  const q = parse(pagination, req.query);
  const filter = q.q ? { $or: [{ name: new RegExp(escapeRegex(q.q), 'i') }, { code: q.q }, { phone: q.q }] } : {};
  const [data, total] = await Promise.all([Supplier.find(filter).sort({ name: 1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), Supplier.countDocuments(filter)]);
  res.json({ data, total, page: q.page, limit: q.limit });
});
router.post('/suppliers', requirePermission('suppliers.manage'), requireModule('suppliers'), async (req, res) => {
  const body = parse(supplierSchema, req.body);
  const code = body.code || (await nextNumber('supplier', 'S', 5));
  const s = await Supplier.create({ ...body, code, email: body.email || undefined });
  await audit(req, { action: 'supplier.created', entity: 'Supplier', entityId: s._id });
  res.status(201).json({ data: s });
});
router.get('/suppliers/:id', requirePermission('suppliers.read'), requireModule('suppliers'), async (req, res) => {
  const s = await Supplier.findById(idParam(req.params.id)).lean();
  if (!s) throw notFound('Supplier');
  const [entries, grns, age] = await Promise.all([
    LedgerEntry.find({ partyType: 'supplier', partyId: s._id }).sort({ at: -1 }).limit(50).lean(),
    GoodsReceipt.find({ supplierId: s._id }, { number: 1, totalCents: 1, paidCents: 1, dueDate: 1, supplierInvoiceNo: 1, createdAt: 1 }).sort({ createdAt: -1 }).limit(50).lean(),
    ageing('supplier', s._id),
  ]);
  res.json({ data: { ...s, entries, goodsReceipts: grns, ageing: age[0] ?? null } });
});
router.patch('/suppliers/:id', requirePermission('suppliers.manage'), requireModule('suppliers'), async (req, res) => {
  const body = parse(supplierSchema.partial(), req.body);
  const s = await Supplier.findOneAndUpdate({ _id: idParam(req.params.id) }, { $set: body }, { new: true });
  if (!s) throw notFound('Supplier');
  res.json({ data: s });
});

/** Pay a supplier; allocated FIFO to the oldest unpaid goods received notes. */
router.post('/suppliers/:id/payments', requirePermission('suppliers.pay'), requireModule('suppliers'), idempotent('supplier-payment'), async (req, res) => {
  const id = idParam(req.params.id);
  const body = parse(paymentSchema.omit({ paymentIntentId: true, tillId: true }).refine((b) => b.method !== 'gateway', 'Gateway collections cannot be used to pay suppliers'), req.body);
  const r = await withTransaction(async () => {
    const s = await Supplier.findOneAndUpdate({ _id: id }, { $inc: { balanceCents: -body.amountCents } }, { new: true });
    if (!s) throw notFound('Supplier');
    const number = await nextNumber('supplier-payment', 'SPY');
    const allocations = await allocateAgainstOpen('supplier', id, body.amountCents);
    for (const a of allocations) {
      const entry = await LedgerEntry.findById(a.entryId).lean();
      if (entry?.ref?.type === 'GoodsReceipt') await GoodsReceipt.updateOne({ _id: entry.ref.id }, { $inc: { paidCents: a.amountCents } });
    }
    const [e] = await LedgerEntry.create([{ partyType: 'supplier', partyId: id, kind: 'payment', amountCents: -body.amountCents, balanceAfterCents: s.balanceCents, method: body.method, reference: body.reference, notes: body.notes, ref: { type: 'SupplierPayment', id: new Types.ObjectId(), number }, userId: req.auth!.userId, allocations }]);
    await audit(req, { action: 'supplier.paid', entity: 'Supplier', entityId: id, details: { number, amountCents: body.amountCents, method: body.method } });
    return { entry: e, balanceCents: s.balanceCents, number };
  });
  res.status(201).json({ data: r });
});

/** What was bought from a supplier, what was paid and what is left, in date order. */
router.get('/suppliers/:id/statement', requirePermission('suppliers.read'), requireModule('suppliers'), async (req, res) => {
  const id = idParam(req.params.id);
  const q = parse(z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }), req.query);
  const sup = await Supplier.findById(id).lean();
  if (!sup) throw notFound('Supplier');
  const filter: Record<string, unknown> = { partyType: 'supplier', partyId: id };
  if (q.from || q.to) filter.at = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  const entries = await LedgerEntry.find(filter).sort({ at: 1 }).lean();
  const opening = q.from ? (await LedgerEntry.findOne({ partyType: 'supplier', partyId: id, at: { $lt: q.from } }).sort({ at: -1 }).lean())?.balanceAfterCents ?? 0 : 0;
  res.json({ data: { supplier: sup, openingBalanceCents: opening, entries, closingBalanceCents: entries.length ? entries[entries.length - 1]!.balanceAfterCents : opening, ageing: (await ageing('supplier', id))[0] ?? null } });
});

router.post('/suppliers/:id/statement/send', requirePermission('suppliers.read'), requireModule('suppliers'), async (req, res) => {
  const sup = await Supplier.findById(idParam(req.params.id)).lean();
  if (!sup) throw notFound('Supplier');
  const tenant = await runAsPlatform(() => Tenant.findById(req.tenant!._id).lean());
  const cur = tenant?.settings?.currency ?? 'KES';
  const entries = await LedgerEntry.find({ partyType: 'supplier', partyId: sup._id }).sort({ at: -1 }).limit(30).lean();
  const statementText = entries.reverse().map((e) => `${e.at.toISOString().slice(0, 10)}  ${e.kind.padEnd(12)} ${(e.ref?.number ?? '').padEnd(14)} ${formatMoney(e.amountCents, cur).padStart(14)}  bal ${formatMoney(e.balanceAfterCents, cur)}`).join('\n');
  const data = { business: tenant?.name, customer: sup.name, balance: formatMoney(sup.balanceCents, cur), statementText };
  const out: Record<string, unknown> = {};
  if (sup.email) out.email = await notify({ channel: 'email', to: sup.email, templateKey: 'customer_statement', data });
  if (sup.phone) out.sms = await notify({ channel: 'sms', to: sup.phone, templateKey: 'customer_statement', data });
  res.status(202).json({ data: out });
});

router.get('/payables/ageing', requirePermission('reports.financial'), requireModule('suppliers'), async (_req, res) => {
  const rows = await ageing('supplier');
  const names = new Map((await Supplier.find({ _id: { $in: rows.map((r) => r._id) } }, { name: 1 }).lean()).map((c) => [String(c._id), c]));
  res.json({ data: rows.map((r) => ({ ...r, supplier: names.get(String(r._id)) })) });
});

export const partyRoutes = router;
