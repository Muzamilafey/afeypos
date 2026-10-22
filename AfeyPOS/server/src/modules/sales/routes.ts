import { Router } from 'express';
import { z } from 'zod';
import { Sale, SaleReturn, Customer, Tenant } from '../../models/index.js';
import { parse, idParam, objectId, pagination, positiveCents, escapeRegex } from '../../http/validate.js';
import { can, requireModule, requirePermission, assertBranchAccess } from '../../http/auth.js';
import { idempotent } from '../../http/idempotency.js';
import { notFound } from '../../lib/errors.js';
import { emitToTenant } from '../../realtime/socket.js';
import { notify } from '../notifications/service.js';
import { formatMoney } from '@afeypos/shared';
import { checkout, checkoutSchema } from './checkout.js';
import { processReturn, returnSchema, voidSale, voidSchema } from './returns.js';
import { closeShift, openShift, recordCashMovement, shiftSummary } from './shifts.js';
import { Shift } from '../../models/index.js';
import { renderReceiptText } from '../hardware/receipt.js';

const router = Router();

router.post('/sales', requirePermission('sales.create'), idempotent('sale'), async (req, res) => {
  const input = parse(checkoutSchema, req.body);
  const { sale, replay } = await checkout(req, input);
  if (!replay) {
    emitToTenant(req.tenant!._id, 'sale.created', { id: sale._id, number: sale.number, totalCents: sale.totalCents, branchId: sale.branchId, tillId: sale.tillId });
  }
  res.status(replay ? 200 : 201).json({ data: sale, replay });
});

router.get('/sales', requirePermission('sales.read'), async (req, res) => {
  const q = parse(
    pagination.extend({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), status: z.string().optional(), customerId: objectId.optional(), branchId: objectId.optional(), tillId: objectId.optional(), shiftId: objectId.optional(), cashierId: objectId.optional() }),
    req.query,
  );
  const filter: Record<string, unknown> = {};
  if (!can(req, 'sales.read.all')) filter.cashierId = req.auth!.userId;
  else if (q.cashierId) filter.cashierId = q.cashierId;
  if (req.auth!.branchIds.length) filter.branchId = { $in: req.auth!.branchIds };
  if (q.branchId) {
    assertBranchAccess(req, q.branchId);
    filter.branchId = q.branchId;
  }
  for (const k of ['status', 'customerId', 'tillId', 'shiftId'] as const) if (q[k]) filter[k] = q[k];
  if (q.from || q.to) filter.completedAt = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  if (q.q) filter.$or = [{ number: new RegExp(escapeRegex(q.q), 'i') }, { 'payments.reference': q.q }, { 'lines.serials': q.q }];
  const [data, total] = await Promise.all([
    Sale.find(filter).sort({ completedAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    Sale.countDocuments(filter),
  ]);
  res.json({ data, total, page: q.page, limit: q.limit });
});

router.get('/sales/:id', requirePermission('sales.read'), async (req, res) => {
  const sale = await Sale.findById(idParam(req.params.id)).lean();
  if (!sale) throw notFound('Sale');
  if (!can(req, 'sales.read.all') && String(sale.cashierId) !== String(req.auth!.userId)) throw notFound('Sale');
  assertBranchAccess(req, sale.branchId);
  const returns = await SaleReturn.find({ saleId: sale._id }).lean();
  const customer = sale.customerId ? await Customer.findById(sale.customerId, { name: 1, phone: 1, email: 1 }).lean() : null;
  res.json({ data: { ...sale, returns, customer } });
});

router.post('/sales/:id/returns', requirePermission('sales.return'), idempotent('sale-return'), async (req, res) => {
  const input = parse(returnSchema, req.body);
  const ret = await processReturn(req, idParam(req.params.id), input);
  emitToTenant(req.tenant!._id, 'sale.returned', { saleId: req.params.id, refundCents: ret.refundCents });
  res.status(201).json({ data: ret });
});

router.post('/sales/:id/void', requirePermission('sales.void'), idempotent('sale-void'), async (req, res) => {
  const input = parse(voidSchema, req.body);
  const sale = await voidSale(req, idParam(req.params.id), input);
  emitToTenant(req.tenant!._id, 'sale.voided', { id: sale._id, number: sale.number });
  res.json({ data: sale });
});

/** Sends a receipt by SMS/email in the background (never blocks checkout). */
router.post('/sales/:id/send-receipt', requirePermission('sales.read'), async (req, res) => {
  const body = parse(z.object({ sms: z.string().max(30).optional(), email: z.string().email().optional() }), req.body);
  const sale = await Sale.findById(idParam(req.params.id)).lean();
  if (!sale) throw notFound('Sale');
  const tenant = (await Tenant.findById(req.tenant!._id).lean())!;
  const currency = tenant.settings?.currency ?? 'KES';
  const data = {
    business: tenant.name, number: sale.number, total: formatMoney(sale.totalCents, currency), paid: formatMoney(sale.paidCents, currency),
    footer: tenant.settings?.receiptFooter ?? '', customer: 'Customer', receiptText: renderReceiptText(tenant as any, sale as any),
  };
  const results: Record<string, unknown> = {};
  if (body.sms && req.capabilities!.modules.includes('sms')) results.sms = await notify({ channel: 'sms', to: body.sms, templateKey: 'receipt', data, dedupeKey: `receipt:${sale._id}:${body.sms}`, ref: { type: 'Sale', id: sale._id } });
  if (body.email && req.capabilities!.modules.includes('email')) results.email = await notify({ channel: 'email', to: body.email, templateKey: 'receipt', data, dedupeKey: `receipt:${sale._id}:${body.email}`, ref: { type: 'Sale', id: sale._id } });
  res.status(202).json({ data: results });
});

// ---- shifts ----
router.get('/shifts', requirePermission('shifts.open'), async (req, res) => {
  const q = parse(pagination.extend({ status: z.enum(['open', 'closed']).optional(), tillId: objectId.optional() }), req.query);
  const filter: Record<string, unknown> = {};
  if (!can(req, 'shifts.manage')) filter.userId = req.auth!.userId;
  if (q.status) filter.status = q.status;
  if (q.tillId) filter.tillId = q.tillId;
  const [data, total] = await Promise.all([Shift.find(filter).sort({ openedAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), Shift.countDocuments(filter)]);
  res.json({ data, total, page: q.page, limit: q.limit });
});

router.get('/shifts/current', requirePermission('shifts.open'), async (req, res) => {
  const { tillId } = parse(z.object({ tillId: objectId }), req.query);
  const shift = await Shift.findOne({ tillId, status: 'open' }).lean();
  res.json({ data: shift });
});

router.post('/shifts', requirePermission('shifts.open'), async (req, res) => {
  const body = parse(z.object({ tillId: objectId, openingFloatCents: positiveCents.default(0) }), req.body);
  res.status(201).json({ data: await openShift(req, body.tillId, body.openingFloatCents) });
});

router.get('/shifts/:id/summary', requirePermission('shifts.open'), async (req, res) => {
  const summary = await shiftSummary(idParam(req.params.id));
  if (!can(req, 'shifts.manage') && String(summary.shift.userId) !== String(req.auth!.userId)) throw notFound('Shift');
  res.json({ data: summary });
});

router.post('/shifts/:id/cash', requirePermission('cash.movement'), async (req, res) => {
  const body = parse(z.object({ type: z.enum(['cash_in', 'cash_out']), amountCents: positiveCents.refine((v) => v > 0), reason: z.string().trim().min(2).max(200) }), req.body);
  res.status(201).json({ data: await recordCashMovement(req, idParam(req.params.id), body.type, body.amountCents, body.reason) });
});

router.post('/shifts/:id/close', requirePermission('shifts.open'), async (req, res) => {
  const body = parse(z.object({ countedCashCents: positiveCents, notes: z.string().max(500).optional(), denominations: z.record(z.string(), z.number().int().nonnegative()).optional() }), req.body);
  const result = await closeShift(req, idParam(req.params.id), body.countedCashCents, body.notes, body.denominations);
  emitToTenant(req.tenant!._id, 'shift.closed', { id: result.shift._id, varianceCents: result.shift.varianceCents });
  res.json({ data: result });
});

export const salesRoutes = router;
