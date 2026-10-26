import { Router } from 'express';
import { z } from 'zod';
import { Sale, SaleReturn, Customer, Tenant, User, Payout } from '../../models/index.js';
import { parse, idParam, objectId, pagination, positiveCents, escapeRegex } from '../../http/validate.js';
import { can, requirePermission, assertBranchAccess, requireAnyPermission } from '../../http/auth.js';
import { idempotent } from '../../http/idempotency.js';
import { notFound } from '../../lib/errors.js';
import { emitToTenant } from '../../realtime/socket.js';
import { notify } from '../notifications/service.js';
import { formatMoney, mergeReceipt } from '@afeypos/shared';
import { checkout, checkoutSchema } from './checkout.js';
import { mpesaPhoneOf, processReturn, returnPolicy, returnSchema, voidSale, voidSchema } from './returns.js';
import { closeShift, openShift, recordCashMovement, shiftSummary } from './shifts.js';
import { Shift } from '../../models/index.js';
import { creditNoteAsReceipt, receiptContext, renderReceiptEscPos, renderReceiptHtml, renderReceiptText } from '../hardware/receipt.js';
import { runAsPlatform } from '../../lib/context.js';

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

/** Finds a sale for a return from a scanned or typed receipt number (the receipt barcode is the number). */
router.get('/sales/lookup', requirePermission('sales.read'), async (req, res) => {
  const { code } = parse(z.object({ code: z.string().trim().min(2).max(100) }), req.query);
  const filter: Record<string, unknown> = { $or: [{ number: new RegExp(`^${escapeRegex(code)}$`, 'i') }, { 'payments.reference': code.toUpperCase() }, { 'lines.serials': code }] };
  if (req.auth!.branchIds.length) filter.branchId = { $in: req.auth!.branchIds };
  if (!can(req, 'sales.read.all') && !can(req, 'sales.return')) filter.cashierId = req.auth!.userId;
  const sales = await Sale.find(filter, { number: 1, completedAt: 1, totalCents: 1, status: 1, customerId: 1, branchId: 1 }).sort({ completedAt: -1 }).limit(10).lean();
  res.json({ data: sales });
});

router.get('/sales/:id', requirePermission('sales.read'), async (req, res) => {
  const sale = await Sale.findById(idParam(req.params.id)).lean();
  if (!sale) throw notFound('Sale');
  if (!can(req, 'sales.read.all') && String(sale.cashierId) !== String(req.auth!.userId)) throw notFound('Sale');
  assertBranchAccess(req, sale.branchId);
  const returns = await SaleReturn.find({ saleId: sale._id }).lean();
  const customer = sale.customerId ? await Customer.findById(sale.customerId, { name: 1, phone: 1, email: 1 }).lean() : null;
  // What the return policy will ask for, so the till can warn before the cashier starts.
  const returnPolicyInfo = { windowDays: req.tenant!.settings?.returns?.windowDays ?? 14, approvalAboveCents: req.tenant!.settings?.returns?.approvalAboveCents ?? 0, restockByDefault: req.tenant!.settings?.returns?.restockByDefault ?? true, outsideWindow: returnPolicy(req.tenant!.settings ?? undefined, sale.completedAt ?? sale.createdAt, 0).length > 0, mpesaPhone: await mpesaPhoneOf(sale as any) };
  res.json({ data: { ...sale, returns, customer, returnPolicy: returnPolicyInfo } });
});

/** Cashiers without sales.return can still start a return; the service asks for a supervisor's approval. */
// Cashiers start returns (approval rules apply in processReturn); dedicated returns staff too.
const canStartReturn = requireAnyPermission('sales.return', 'sales.create');

router.post('/sales/:id/returns', canStartReturn, idempotent('sale-return'), async (req, res) => {
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

router.get('/returns', requirePermission('sales.read'), async (req, res) => {
  const q = parse(pagination.extend({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), branchId: objectId.optional(), refundMethod: z.string().optional(), reasonCode: z.string().optional(), saleId: objectId.optional() }), req.query);
  const filter: Record<string, unknown> = {};
  if (!can(req, 'sales.read.all')) filter.processedBy = req.auth!.userId;
  if (req.auth!.branchIds.length) filter.branchId = { $in: req.auth!.branchIds };
  if (q.branchId) {
    assertBranchAccess(req, q.branchId);
    filter.branchId = q.branchId;
  }
  for (const k of ['refundMethod', 'reasonCode', 'saleId'] as const) if (q[k]) filter[k] = q[k];
  if (q.from || q.to) filter.createdAt = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  if (q.q) {
    const sales = await Sale.find({ number: new RegExp(escapeRegex(q.q), 'i') }, { _id: 1 }).limit(50).lean();
    filter.$or = [{ number: new RegExp(escapeRegex(q.q), 'i') }, { saleId: { $in: sales.map((s) => s._id) } }];
  }
  const [rows, total] = await Promise.all([
    SaleReturn.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    SaleReturn.countDocuments(filter),
  ]);
  const sales = new Map((await Sale.find({ _id: { $in: rows.map((r) => r.saleId) } }, { number: 1 }).lean()).map((s) => [String(s._id), s.number]));
  const users = new Map((await User.find({ _id: { $in: rows.flatMap((r) => [r.processedBy, r.approvedBy].filter(Boolean)) } }, { name: 1 }).lean()).map((u) => [String(u._id), u.name]));
  const data = rows.map((r) => ({ ...r, saleNumber: sales.get(String(r.saleId)), processedByName: users.get(String(r.processedBy)), approvedByName: r.approvedBy ? users.get(String(r.approvedBy)) : undefined }));
  res.json({ data, total, page: q.page, limit: q.limit });
});

async function loadReturn(req: any) {
  const ret = await SaleReturn.findById(idParam(req.params.id)).lean();
  if (!ret) throw notFound('Return');
  assertBranchAccess(req, ret.branchId);
  if (!can(req, 'sales.read.all') && String(ret.processedBy) !== String(req.auth!.userId)) throw notFound('Return');
  const sale = (await Sale.findById(ret.saleId, { number: 1, completedAt: 1, totalCents: 1, status: 1 }).lean())!;
  return { ret, sale };
}

router.get('/returns/:id', requirePermission('sales.read'), async (req, res) => {
  const { ret, sale } = await loadReturn(req);
  const payout = ret.payoutId ? await Payout.findById(ret.payoutId, { status: 1, amountCents: 1, phone: 1, receiptNumber: 1, resultDesc: 1 }).lean() : null;
  res.json({ data: { ...ret, sale, payout } });
});

/** The credit note slip (text, HTML for browser printing, or ESC/POS for the bridge). */
router.get('/returns/:id/receipt', requirePermission('sales.read'), async (req, res) => {
  const { format, width } = parse(z.object({ format: z.enum(['html', 'text', 'escpos']).default('html'), width: z.coerce.number().int().min(24).max(64).optional() }), req.query);
  const { ret, sale } = await loadReturn(req);
  const tenant: any = await runAsPlatform(() => Tenant.findById(req.tenant!._id).lean());
  const note = creditNoteAsReceipt(ret as any, sale);
  const t = { ...tenant, settings: { ...tenant.settings, receiptHeader: note.header, receipt: { ...mergeReceipt(tenant.settings?.receipt), title: 'CREDIT NOTE' } } };
  const ctx = { ...(await receiptContext(tenant, sale as any, ret.processedBy)), width };
  if (format === 'html') res.type('html').send(renderReceiptHtml(t, note.sale, ctx));
  else if (format === 'text') res.type('text').send(renderReceiptText(t, note.sale, ctx));
  else res.json({ data: { base64: renderReceiptEscPos(t, note.sale, { ...ctx, openDrawer: ret.refundMethod === 'cash' }).toString('base64') } });
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
    footer: tenant.settings?.receiptFooter ?? '', customer: 'Customer', receiptText: renderReceiptText(tenant as any, sale as any, await receiptContext(tenant as any, sale)),
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

/** A4 tax invoice for a sale (credit/wholesale customers). */
router.get('/sales/:id/invoice', requirePermission('sales.read'), async (req, res) => {
  const sale = await Sale.findById(idParam(req.params.id)).lean();
  if (!sale) throw notFound('Sale');
  const tenant = (await Tenant.findById(req.tenant!._id).lean())!;
  const customer = sale.customerId ? await Customer.findById(sale.customerId).lean() : null;
  const cur = tenant.settings?.currency ?? 'KES';
  const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const rows = sale.lines.map((l) => `<tr><td>${esc(l.sku)}</td><td>${esc(l.name)}</td><td class="r">${esc(l.qty)} ${esc(l.unitCode)}</td><td class="r">${esc(formatMoney(l.unitPriceCents ?? 0, cur))}</td><td class="r">${esc((l.taxRateBp ?? 0) / 100)}%</td><td class="r">${esc(formatMoney(l.totalCents ?? 0, cur))}</td></tr>`).join('');
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Invoice ${esc(sale.number)}</title><style>body{font:13px system-ui,sans-serif;margin:24px}table{width:100%;border-collapse:collapse;margin-top:16px}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left}.r{text-align:right}@media print{button{display:none}}</style></head><body>
  <div style="display:flex;justify-content:space-between"><div><h1 style="margin:0">${esc(tenant.name)}</h1><div>${esc(tenant.settings?.taxPin ? 'PIN ' + tenant.settings.taxPin : '')}</div><div>${esc(tenant.contact?.phone ?? '')}</div></div>
  <div style="text-align:right"><h2 style="margin:0">TAX INVOICE</h2><div>${esc(sale.number)}</div><div>${esc(new Date(sale.completedAt).toLocaleDateString('en-KE'))}</div>${sale.dueDate ? `<div>Due ${esc(new Date(sale.dueDate).toLocaleDateString('en-KE'))}</div>` : ''}</div></div>
  <p><strong>Bill to:</strong> ${esc(customer?.name ?? 'Cash customer')}${customer?.taxPin ? ` · PIN ${esc(customer.taxPin)}` : ''}${customer?.address ? `<br>${esc(customer.address)}` : ''}</p>
  <table><thead><tr><th>SKU</th><th>Item</th><th class="r">Qty</th><th class="r">Price</th><th class="r">VAT</th><th class="r">Amount</th></tr></thead><tbody>${rows}</tbody></table>
  <p class="r">Discounts: ${esc(formatMoney(sale.discountCents, cur))}<br>Tax: ${esc(formatMoney(sale.taxCents, cur))}<br><strong>Total: ${esc(formatMoney(sale.totalCents, cur))}</strong><br>Paid: ${esc(formatMoney(sale.paidCents, cur))}<br>On account: ${esc(formatMoney(sale.creditCents, cur))}</p>
  <p style="color:#555">This invoice is generated by Afey POS. Fiscal (KRA eTIMS) submission is not performed by Afey POS.</p><button onclick="print()">Print</button></body></html>`);
});
