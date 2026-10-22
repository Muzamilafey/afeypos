import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { formatMoney, lineAmount, roundQty } from '@afeypos/shared';
import { GoodsReceipt, LedgerEntry, Product, PurchaseOrder, Supplier, SupplierReturn, Tenant, Warehouse } from '../../models/index.js';
import { idParam, objectId, pagination, parse, positiveCents } from '../../http/validate.js';
import { requirePermission } from '../../http/auth.js';
import { idempotent } from '../../http/idempotency.js';
import { withTransaction } from '../../db/connection.js';
import { badRequest, notFound, unprocessable } from '../../lib/errors.js';
import { nextNumber } from '../../lib/numbering.js';
import { audit } from '../../lib/audit.js';
import { applyMovement } from '../inventory/stock.js';
import { resolveUnit } from '../catalog/units.js';
import { allocateAgainstOpen } from '../sales/returns.js';
import { notify } from '../notifications/service.js';
import { runAsPlatform } from '../../lib/context.js';

const router = Router();

const lineSchema = z.object({ productId: objectId, unitCode: z.string().optional(), qty: z.number().positive(), unitCostCents: positiveCents });

router.get('/purchase-orders', requirePermission('purchasing.read'), async (req, res) => {
  const q = parse(pagination.extend({ status: z.string().optional(), supplierId: objectId.optional() }), req.query);
  const filter: Record<string, unknown> = {};
  if (q.status) filter.status = q.status;
  if (q.supplierId) filter.supplierId = q.supplierId;
  const [data, total] = await Promise.all([PurchaseOrder.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).populate('supplierId', 'name').lean(), PurchaseOrder.countDocuments(filter)]);
  res.json({ data, total, page: q.page, limit: q.limit });
});

router.get('/purchase-orders/:id', requirePermission('purchasing.read'), async (req, res) => {
  const po = await PurchaseOrder.findById(idParam(req.params.id)).populate('supplierId', 'name email phone').lean();
  if (!po) throw notFound('Purchase order');
  const receipts = await GoodsReceipt.find({ purchaseOrderId: po._id }, { number: 1, totalCents: 1, createdAt: 1 }).lean();
  res.json({ data: { ...po, receipts } });
});

router.post('/purchase-orders', requirePermission('purchasing.manage'), async (req, res) => {
  const body = parse(z.object({ supplierId: objectId, warehouseId: objectId, expectedAt: z.coerce.date().optional(), notes: z.string().max(1000).optional(), lines: z.array(lineSchema).min(1).max(500) }), req.body);
  if (!(await Supplier.exists({ _id: body.supplierId }))) throw notFound('Supplier');
  if (!(await Warehouse.exists({ _id: body.warehouseId }))) throw notFound('Warehouse');
  const lines = [];
  for (const l of body.lines) {
    const p = await Product.findById(l.productId).lean();
    if (!p) throw notFound('Product');
    const unit = resolveUnit(p as any, l.unitCode ?? p.units.find((u) => u.isDefaultPurchase)?.code ?? p.baseUnit);
    lines.push({ productId: p._id, name: p.name, unitCode: unit.code, factor: unit.factor, qty: roundQty(l.qty), unitCostCents: l.unitCostCents });
  }
  const number = await nextNumber('po', 'PO');
  const po = await PurchaseOrder.create({ ...body, number, lines, totalCents: lines.reduce((a, l) => a + lineAmount(l.qty, l.unitCostCents), 0), createdBy: req.auth!.userId });
  await audit(req, { action: 'purchase_order.created', entity: 'PurchaseOrder', entityId: po._id, details: { number } });
  res.status(201).json({ data: po });
});

router.post('/purchase-orders/:id/send', requirePermission('purchasing.manage'), async (req, res) => {
  const po = await PurchaseOrder.findOne({ _id: idParam(req.params.id), status: { $in: ['draft', 'sent'] } });
  if (!po) throw notFound('Purchase order');
  const supplier = await Supplier.findById(po.supplierId).lean();
  po.status = 'sent';
  po.sentAt = new Date();
  await po.save();
  let emailed: unknown = null;
  if (supplier?.email && req.capabilities!.modules.includes('email')) {
    const tenant = await runAsPlatform(() => Tenant.findById(req.tenant!._id).lean());
    const cur = tenant?.settings?.currency ?? 'KES';
    emailed = await notify({
      channel: 'email', to: supplier.email, templateKey: 'purchase_order', dedupeKey: `po:${po._id}:${po.sentAt.getTime()}`,
      data: { business: tenant?.name, supplier: supplier.name, number: po.number, total: formatMoney(po.totalCents, cur), items: po.lines.map((l) => `${l.qty} ${l.unitCode} x ${l.name} @ ${formatMoney(l.unitCostCents, cur)}`).join('\n') },
    });
  }
  await audit(req, { action: 'purchase_order.sent', entity: 'PurchaseOrder', entityId: po._id });
  res.json({ data: po, emailed });
});

router.post('/purchase-orders/:id/cancel', requirePermission('purchasing.manage'), async (req, res) => {
  const po = await PurchaseOrder.findOneAndUpdate({ _id: idParam(req.params.id), status: { $in: ['draft', 'sent'] } }, { $set: { status: 'cancelled' } }, { new: true });
  if (!po) throw unprocessable('Only unreceived purchase orders can be cancelled');
  await audit(req, { action: 'purchase_order.cancelled', entity: 'PurchaseOrder', entityId: po._id });
  res.json({ data: po });
});

const grnSchema = z.object({
  clientRequestId: z.string().min(8).max(100).optional(),
  supplierId: objectId,
  warehouseId: objectId,
  purchaseOrderId: objectId.optional(),
  supplierInvoiceNo: z.string().trim().max(60).optional(),
  invoiceDate: z.coerce.date().optional(),
  dueDate: z.coerce.date().optional(),
  taxCents: positiveCents.default(0),
  notes: z.string().max(1000).optional(),
  lines: z.array(lineSchema.extend({ poLineId: objectId.optional(), batchNo: z.string().max(60).optional(), expiryDate: z.coerce.date().optional(), serials: z.array(z.string()).optional() })).min(1).max(500),
  updateProductCost: z.boolean().default(true),
});

/** Goods received note: increases stock (weighted average cost) and the supplier payable. */
router.get('/goods-receipts', requirePermission('purchasing.read'), async (req, res) => {
  const q = parse(pagination.extend({ supplierId: objectId.optional() }), req.query);
  const filter = q.supplierId ? { supplierId: q.supplierId } : {};
  const [data, total] = await Promise.all([GoodsReceipt.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).populate('supplierId', 'name').lean(), GoodsReceipt.countDocuments(filter)]);
  res.json({ data, total, page: q.page, limit: q.limit });
});

router.get('/goods-receipts/:id', requirePermission('purchasing.read'), async (req, res) => {
  const g = await GoodsReceipt.findById(idParam(req.params.id)).populate('supplierId', 'name').lean();
  if (!g) throw notFound('Goods receipt');
  res.json({ data: g });
});

router.post('/goods-receipts', requirePermission('inventory.receive'), idempotent('grn'), async (req, res) => {
  const body = parse(grnSchema, req.body);
  if (body.clientRequestId) {
    const ex = await GoodsReceipt.findOne({ clientRequestId: body.clientRequestId }).lean();
    if (ex) {
      res.json({ data: ex, replay: true });
      return;
    }
  }
  const grn = await withTransaction(async () => {
    const supplier = await Supplier.findById(body.supplierId);
    if (!supplier) throw notFound('Supplier');
    if (!(await Warehouse.exists({ _id: body.warehouseId }))) throw notFound('Warehouse');
    const po = body.purchaseOrderId ? await PurchaseOrder.findOne({ _id: body.purchaseOrderId, supplierId: supplier._id, status: { $in: ['draft', 'sent', 'partially_received'] } }) : null;
    if (body.purchaseOrderId && !po) throw unprocessable('Purchase order is not open for receiving');
    const id = new Types.ObjectId();
    const number = await nextNumber('grn', 'GRN');
    const lines = [];
    for (const l of body.lines) {
      const product = await Product.findById(l.productId);
      if (!product) throw notFound('Product');
      const unit = resolveUnit(product, l.unitCode ?? product.units.find((u) => u.isDefaultPurchase)?.code ?? product.baseUnit);
      const baseQty = roundQty(l.qty * unit.factor);
      const baseCost = Math.round(l.unitCostCents / unit.factor);
      if (po) {
        const pl = l.poLineId ? po.lines.id(l.poLineId) : po.lines.find((x) => String(x.productId) === String(product._id));
        if (!pl) throw badRequest(`${product.name} is not on the purchase order`);
        pl.receivedQty = roundQty((pl.receivedQty ?? 0) + baseQty / (pl.factor || 1));
      }
      if (product.trackBatches && !l.batchNo) throw badRequest(`${product.name} requires a batch number`);
      await applyMovement({ product, productId: product._id, warehouseId: body.warehouseId, qty: baseQty, type: 'purchase_receipt', unitCostCents: baseCost, ref: { type: 'GoodsReceipt', id, number }, userId: req.auth!.userId, batchNo: l.batchNo, expiryDate: l.expiryDate, serials: l.serials, reason: body.supplierInvoiceNo ? `Invoice ${body.supplierInvoiceNo}` : undefined });
      if (body.updateProductCost) await Product.updateOne({ _id: product._id }, { $set: { costCents: baseCost } });
      lines.push({ productId: product._id, poLineId: l.poLineId, name: product.name, unitCode: unit.code, factor: unit.factor, qty: roundQty(l.qty), unitCostCents: l.unitCostCents, batchNo: l.batchNo, expiryDate: l.expiryDate, serials: l.serials });
    }
    const subtotal = lines.reduce((a, l) => a + lineAmount(l.qty, l.unitCostCents), 0);
    const total = subtotal + body.taxCents;
    if (po) {
      po.status = po.lines.every((l) => (l.receivedQty ?? 0) >= l.qty) ? 'received' : 'partially_received';
      await po.save();
    }
    const dueDate = body.dueDate ?? new Date((body.invoiceDate ?? new Date()).getTime() + (supplier.paymentTermsDays ?? 30) * 86400_000);
    const updated = await Supplier.findOneAndUpdate({ _id: supplier._id }, { $inc: { balanceCents: total } }, { new: true });
    await LedgerEntry.create([{ partyType: 'supplier', partyId: supplier._id, kind: 'purchase', amountCents: total, openCents: total, balanceAfterCents: updated!.balanceCents, dueDate, ref: { type: 'GoodsReceipt', id, number }, reference: body.supplierInvoiceNo, userId: req.auth!.userId }]);
    const [g] = await GoodsReceipt.create([{ _id: id, number, clientRequestId: body.clientRequestId, supplierId: supplier._id, purchaseOrderId: po?._id, warehouseId: body.warehouseId, supplierInvoiceNo: body.supplierInvoiceNo, invoiceDate: body.invoiceDate, dueDate, lines, subtotalCents: subtotal, taxCents: body.taxCents, totalCents: total, receivedBy: req.auth!.userId, notes: body.notes }]);
    await audit(req, { action: 'goods_receipt.posted', entity: 'GoodsReceipt', entityId: id, details: { number, totalCents: total, supplier: supplier.name } });
    return g;
  });
  res.status(201).json({ data: grn });
});

/** Return goods to a supplier: reduces stock at current cost and the payable (or creates a supplier credit). */
router.post('/supplier-returns', requirePermission('purchasing.manage'), async (req, res) => {
  const body = parse(z.object({ supplierId: objectId, warehouseId: objectId, goodsReceiptId: objectId.optional(), reason: z.string().trim().min(2).max(300), lines: z.array(z.object({ productId: objectId, qty: z.number().positive(), unitCostCents: positiveCents.optional(), batchNo: z.string().optional(), serials: z.array(z.string()).optional() })).min(1) }), req.body);
  const ret = await withTransaction(async () => {
    const supplier = await Supplier.findById(body.supplierId);
    if (!supplier) throw notFound('Supplier');
    const id = new Types.ObjectId();
    const number = await nextNumber('supplier-return', 'SRN');
    const lines = [];
    for (const l of body.lines) {
      const product = await Product.findById(l.productId);
      if (!product) throw notFound('Product');
      const mv = await applyMovement({ product, productId: product._id, warehouseId: body.warehouseId, qty: -l.qty, type: 'supplier_return', ref: { type: 'SupplierReturn', id, number }, userId: req.auth!.userId, batchNo: l.batchNo, serials: l.serials, reason: body.reason });
      lines.push({ productId: product._id, name: product.name, qty: l.qty, unitCostCents: l.unitCostCents ?? mv?.unitCostCents ?? 0, batchNo: l.batchNo, serials: l.serials });
    }
    const total = lines.reduce((a, l) => a + lineAmount(l.qty, l.unitCostCents), 0);
    const s = await Supplier.findOneAndUpdate({ _id: supplier._id }, { $inc: { balanceCents: -total } }, { new: true });
    const allocations = await allocateAgainstOpen('supplier', supplier._id, total);
    await LedgerEntry.create([{ partyType: 'supplier', partyId: supplier._id, kind: 'supplier_return', amountCents: -total, balanceAfterCents: s!.balanceCents, ref: { type: 'SupplierReturn', id, number }, userId: req.auth!.userId, allocations, notes: body.reason }]);
    const [r] = await SupplierReturn.create([{ _id: id, number, supplierId: supplier._id, warehouseId: body.warehouseId, goodsReceiptId: body.goodsReceiptId, lines, totalCents: total, reason: body.reason, createdBy: req.auth!.userId }]);
    await audit(req, { action: 'supplier_return.posted', entity: 'SupplierReturn', entityId: id, details: { number, totalCents: total } });
    return r;
  });
  res.status(201).json({ data: ret });
});

router.get('/supplier-returns', requirePermission('purchasing.read'), async (_req, res) => {
  res.json({ data: await SupplierReturn.find({}).sort({ createdAt: -1 }).limit(200).populate('supplierId', 'name').lean() });
});

export const purchasingRoutes = router;
