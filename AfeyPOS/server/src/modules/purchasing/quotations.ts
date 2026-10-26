/**
 * Supplier quotations: ask one or more suppliers for prices (request for quotation, emailed as PDF), record each
 * supplier's answer, compare them line by line, and turn the chosen quote into a purchase order.
 */
import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { formatMoney, lineAmount, roundQty } from '@afeypos/shared';
import { Product, PurchaseOrder, Supplier, SupplierQuotation, Warehouse } from '../../models/index.js';
import { idParam, objectId, pagination, parse, positiveCents } from '../../http/validate.js';
import { requirePermission } from '../../http/auth.js';
import { badRequest, notFound, unprocessable } from '../../lib/errors.js';
import { nextNumber } from '../../lib/numbering.js';
import { audit } from '../../lib/audit.js';
import { resolveUnit } from '../catalog/units.js';
import { emailDocument } from '../documents/routes.js';

const router = Router();

const OPEN = ['draft', 'sent', 'quoted'];

const createSchema = z.object({
  supplierIds: z.array(objectId).min(1).max(10),
  warehouseId: objectId,
  respondBy: z.coerce.date().optional(),
  notes: z.string().trim().max(2000).optional(),
  lines: z.array(z.object({ productId: objectId, unitCode: z.string().optional(), qty: z.number().positive() })).min(1).max(300),
  /** Email the request to each supplier straight away. */
  send: z.boolean().default(false),
  message: z.string().trim().max(2000).optional(),
});

async function sendRfq(req: any, q: any, message?: string, to?: string, cc?: string[]) {
  const day = (d?: Date) => (d ? new Date(d).toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
  const emailed = await emailDocument(req, 'supplier_quotation', q._id, {
    templateKey: 'supplier_rfq', message: message || 'We would like a quotation for the items below.', to, cc,
    data: { replyBy: q.respondBy ? ` by ${day(q.respondBy)}` : '', items: q.lines.map((l: any) => `- ${roundQty(l.qty)} ${l.unitCode} ${l.name}`).join('\n') },
  });
  if (q.status === 'draft') q.status = 'sent';
  q.sentAt = new Date();
  await q.save();
  return emailed;
}

router.get('/supplier-quotations', requirePermission('purchasing.read'), async (req, res) => {
  const q = parse(pagination.extend({ status: z.string().optional(), supplierId: objectId.optional(), groupId: objectId.optional(), open: z.coerce.boolean().optional() }), req.query);
  const filter: Record<string, unknown> = {};
  if (q.status) filter.status = q.status;
  if (q.open) filter.status = { $in: OPEN };
  if (q.supplierId) filter.supplierId = q.supplierId;
  if (q.groupId) filter.groupId = q.groupId;
  if (q.q) filter.number = new RegExp(q.q.replace(/[^\w-]/g, ''), 'i');
  const [data, total] = await Promise.all([
    SupplierQuotation.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).populate('supplierId', 'name email').lean(),
    SupplierQuotation.countDocuments(filter),
  ]);
  // How many suppliers were asked in the same request (for "compare").
  const groups = await SupplierQuotation.aggregate([{ $match: { groupId: { $in: [...new Set(data.map((d) => String(d.groupId)))].map((g) => new Types.ObjectId(g)) } } }, { $group: { _id: '$groupId', n: { $sum: 1 } } }]);
  const size = new Map(groups.map((g) => [String(g._id), g.n]));
  res.json({ data: data.map((d) => ({ ...d, groupSize: size.get(String(d.groupId)) ?? 1 })), total, page: q.page, limit: q.limit });
});

router.get('/supplier-quotations/:id', requirePermission('purchasing.read'), async (req, res) => {
  const q = await SupplierQuotation.findById(idParam(req.params.id)).populate('supplierId', 'name email phone contactPerson').lean();
  if (!q) throw notFound('Supplier quotation');
  const po = q.purchaseOrderId ? await PurchaseOrder.findById(q.purchaseOrderId, { number: 1, status: 1 }).lean() : null;
  res.json({ data: { ...q, purchaseOrder: po } });
});

router.post('/supplier-quotations', requirePermission('purchasing.manage'), async (req, res) => {
  const body = parse(createSchema, req.body);
  const supplierIds = [...new Set(body.supplierIds.map(String))];
  const suppliers = await Supplier.find({ _id: { $in: supplierIds } }).lean();
  if (suppliers.length !== supplierIds.length) throw notFound('Supplier');
  if (!(await Warehouse.exists({ _id: body.warehouseId }))) throw notFound('Warehouse');
  const lines = [];
  for (const l of body.lines) {
    const p = await Product.findById(l.productId).lean();
    if (!p) throw notFound('Product');
    const unit = resolveUnit(p as any, l.unitCode ?? p.units.find((u) => u.isDefaultPurchase)?.code ?? p.baseUnit);
    lines.push({ productId: p._id, name: p.name, unitCode: unit.code, factor: unit.factor, qty: roundQty(l.qty) });
  }
  const groupId = new Types.ObjectId();
  const created = [];
  const emails: Record<string, unknown> = {};
  for (const s of suppliers) {
    const q = await SupplierQuotation.create({ number: await nextNumber('rfq', 'RFQ'), groupId, supplierId: s._id, warehouseId: body.warehouseId, respondBy: body.respondBy, notes: body.notes, lines, createdBy: req.auth!.userId });
    if (body.send) emails[String(s._id)] = await sendRfq(req, q, body.message);
    created.push(q);
  }
  await audit(req, { action: 'supplier_quotation.requested', entity: 'SupplierQuotation', entityId: created[0]!._id, details: { numbers: created.map((c) => c.number), suppliers: suppliers.map((s) => s.name) } });
  res.status(201).json({ data: created, groupId, emails });
});

router.post('/supplier-quotations/:id/send', requirePermission('purchasing.manage'), async (req, res) => {
  const body = parse(z.object({ message: z.string().trim().max(2000).optional(), to: z.string().trim().email().optional().or(z.literal('')), cc: z.array(z.string().trim().email()).max(5).default([]) }), req.body ?? {});
  const q = await SupplierQuotation.findOne({ _id: idParam(req.params.id), status: { $in: OPEN } });
  if (!q) throw unprocessable('Only open quotation requests can be sent', 'NOT_OPEN');
  const emailed = await sendRfq(req, q, body.message, body.to || undefined, body.cc);
  await audit(req, { action: 'supplier_quotation.sent', entity: 'SupplierQuotation', entityId: q._id, details: { emailed } });
  res.json({ data: q, emailed });
});

/** Record the supplier's prices (from their email, phone call or quote document). */
router.put('/supplier-quotations/:id/quote', requirePermission('purchasing.manage'), async (req, res) => {
  const body = parse(z.object({
    lines: z.array(z.object({ lineId: objectId, unitCostCents: positiveCents.nullable(), available: z.boolean().default(true), notes: z.string().trim().max(300).optional() })).min(1),
    validUntil: z.coerce.date().optional(), supplierRef: z.string().trim().max(60).optional(), deliveryDays: z.number().int().min(0).max(365).optional(), supplierNotes: z.string().trim().max(2000).optional(),
  }), req.body);
  const q = await SupplierQuotation.findOne({ _id: idParam(req.params.id), status: { $in: OPEN } });
  if (!q) throw unprocessable('This quotation is closed', 'NOT_OPEN');
  for (const l of body.lines) {
    const line = q.lines.id(l.lineId);
    if (!line) throw badRequest('A line is not on this quotation');
    // null = not priced (yet)
    line.unitCostCents = (l.available ? l.unitCostCents : null) as number;
    line.available = l.available;
    line.notes = l.notes;
  }
  if (q.lines.every((l) => l.available !== false && l.unitCostCents == null)) throw badRequest('Enter at least one price');
  q.totalCents = q.lines.filter((l) => l.available !== false && l.unitCostCents != null).reduce((a, l) => a + lineAmount(l.qty, l.unitCostCents!), 0);
  Object.assign(q, { validUntil: body.validUntil, supplierRef: body.supplierRef, deliveryDays: body.deliveryDays, supplierNotes: body.supplierNotes, status: 'quoted', quotedAt: new Date() });
  await q.save();
  await audit(req, { action: 'supplier_quotation.quoted', entity: 'SupplierQuotation', entityId: q._id, details: { totalCents: q.totalCents } });
  res.json({ data: q });
});

/** Side by side: every product of the request with each supplier's price; the cheapest available is marked. */
router.get('/supplier-quotations/compare/:groupId', requirePermission('purchasing.read'), async (req, res) => {
  const quotes = await SupplierQuotation.find({ groupId: idParam(req.params.groupId) }).populate('supplierId', 'name').sort({ createdAt: 1 }).lean();
  if (!quotes.length) throw notFound('Quotation request');
  const products = quotes[0]!.lines.map((l) => ({ productId: l.productId, name: l.name, qty: l.qty, unitCode: l.unitCode }));
  const rows = products.map((p) => {
    const prices = quotes.map((q) => {
      const l = q.lines.find((x) => String(x.productId) === String(p.productId));
      return { quotationId: q._id, unitCostCents: l && l.available !== false ? l.unitCostCents ?? null : null, available: l?.available !== false, notes: l?.notes };
    });
    const best = prices.filter((x) => x.unitCostCents != null).sort((a, b) => a.unitCostCents! - b.unitCostCents!)[0];
    return { ...p, prices, bestQuotationId: best?.quotationId ?? null };
  });
  res.json({
    data: {
      quotes: quotes.map((q) => ({ id: q._id, number: q.number, supplier: q.supplierId, status: q.status, totalCents: q.totalCents, deliveryDays: q.deliveryDays, validUntil: q.validUntil, complete: q.lines.every((l) => l.available !== false && l.unitCostCents != null) })),
      rows,
    },
  });
});

/** Accept a quote: creates the purchase order at the quoted prices (available lines only). Other open quotes of the same request are closed. */
router.post('/supplier-quotations/:id/accept', requirePermission('purchasing.manage'), async (req, res) => {
  const body = parse(z.object({ expectedAt: z.coerce.date().optional(), lineIds: z.array(objectId).optional(), closeOthers: z.boolean().default(true), sendOrder: z.boolean().default(false) }), req.body ?? {});
  const q = await SupplierQuotation.findOne({ _id: idParam(req.params.id), status: 'quoted' });
  if (!q) throw unprocessable('Only a quoted request can be accepted (enter the supplier’s prices first)', 'NOT_QUOTED');
  const pick = body.lineIds?.map(String);
  const lines = q.lines.filter((l) => l.available !== false && l.unitCostCents != null && (!pick || pick.includes(String(l._id))));
  if (!lines.length) throw badRequest('No priced lines to order');
  const number = await nextNumber('po', 'PO');
  const po = await PurchaseOrder.create({
    number, supplierId: q.supplierId, warehouseId: q.warehouseId, expectedAt: body.expectedAt ?? (q.deliveryDays != null ? new Date(Date.now() + q.deliveryDays * 86_400_000) : undefined),
    notes: `From quotation ${q.number}${q.supplierRef ? ` (supplier ref ${q.supplierRef})` : ''}`, supplierQuotationId: q._id, createdBy: req.auth!.userId,
    lines: lines.map((l) => ({ productId: l.productId, name: l.name, unitCode: l.unitCode, factor: l.factor, qty: l.qty, unitCostCents: l.unitCostCents! })),
    totalCents: lines.reduce((a, l) => a + lineAmount(l.qty, l.unitCostCents!), 0),
  });
  Object.assign(q, { status: 'accepted', decidedAt: new Date(), purchaseOrderId: po._id });
  await q.save();
  if (body.closeOthers) {
    await SupplierQuotation.updateMany({ groupId: q.groupId, _id: { $ne: q._id }, status: { $in: OPEN } }, { $set: { status: 'rejected', decidedAt: new Date(), decisionNote: `Order placed with another supplier (${q.number})` } });
  }
  let emailed: unknown = null;
  if (body.sendOrder) {
    const s = await Supplier.findById(q.supplierId).lean();
    emailed = await emailDocument(req, 'purchase_order', po._id, { templateKey: 'purchase_order', data: { supplier: s?.name, total: formatMoney(po.totalCents, req.tenant!.settings?.currency ?? 'KES'), items: po.lines.map((l) => `${l.qty} ${l.unitCode} x ${l.name}`).join('\n') } });
    po.status = 'sent';
    po.sentAt = new Date();
    await po.save();
  }
  await audit(req, { action: 'supplier_quotation.accepted', entity: 'SupplierQuotation', entityId: q._id, details: { purchaseOrder: number, totalCents: po.totalCents } });
  res.json({ data: q, purchaseOrder: po, emailed });
});

for (const [action, status] of [['reject', 'rejected'], ['cancel', 'cancelled']] as const) router.post(`/supplier-quotations/:id/${action}`, requirePermission('purchasing.manage'), async (req, res) => {
  const body = parse(z.object({ note: z.string().trim().max(300).optional() }), req.body ?? {});
  const q = await SupplierQuotation.findOneAndUpdate({ _id: idParam(req.params.id), status: { $in: OPEN } }, { $set: { status, decidedAt: new Date(), decisionNote: body.note } }, { new: true });
  if (!q) throw unprocessable('This quotation is already closed', 'NOT_OPEN');
  await audit(req, { action: `supplier_quotation.${status}`, entity: 'SupplierQuotation', entityId: q._id });
  res.json({ data: q });
});

export const supplierQuotationRoutes = router;
