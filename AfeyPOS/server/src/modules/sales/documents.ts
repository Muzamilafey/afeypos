import { Router } from 'express';
import { z } from 'zod';
import { calculateTax, formatMoney, lineAmount, PRICE_LISTS, roundQty, type PriceListKey } from '@afeypos/shared';
import { Branch, Customer, Product, Sale, SalesDocument, Tenant, Warehouse } from '../../models/index.js';
import { idParam, objectId, pagination, parse, positiveCents } from '../../http/validate.js';
import { assertBranchAccess, requireModule, requirePermission } from '../../http/auth.js';
import { badRequest, notFound, unprocessable } from '../../lib/errors.js';
import { nextNumber } from '../../lib/numbering.js';
import { audit } from '../../lib/audit.js';
import { withTransaction } from '../../db/connection.js';
import { quotePrice } from '../catalog/pricing.js';
import { resolveUnit } from '../catalog/units.js';
import { adjustReserved } from '../inventory/stock.js';
import { runAsPlatform } from '../../lib/context.js';

const router = Router();

const MODULE_FOR = { quotation: 'quotations', sales_order: 'salesOrders', delivery_note: 'deliveryNotes' } as const;
const PREFIX = { quotation: 'QT', sales_order: 'SO', delivery_note: 'DN' } as const;

const docSchema = z.object({
  type: z.enum(['quotation', 'sales_order']),
  customerId: objectId.optional(),
  customerName: z.string().max(160).optional(),
  branchId: objectId,
  warehouseId: objectId.optional(),
  priceList: z.enum(PRICE_LISTS).optional(),
  validUntil: z.coerce.date().optional(),
  notes: z.string().max(2000).optional(),
  salesRepId: objectId.optional(),
  lines: z.array(z.object({ productId: objectId, unitCode: z.string().optional(), qty: z.number().positive(), unitPriceCents: positiveCents.optional(), discountCents: positiveCents.default(0) })).min(1).max(500),
});

router.get('/documents', requirePermission('sales.read'), async (req, res) => {
  const q = parse(pagination.extend({ type: z.enum(['quotation', 'sales_order', 'delivery_note']), status: z.string().optional(), customerId: objectId.optional() }), req.query);
  if (!req.capabilities!.modules.includes(MODULE_FOR[q.type])) throw unprocessable(`${q.type} module is not enabled`, 'MODULE_DISABLED');
  const filter: Record<string, unknown> = { type: q.type };
  if (q.status) filter.status = q.status;
  if (q.customerId) filter.customerId = q.customerId;
  if (q.q) filter.number = new RegExp(q.q.replace(/[^\w-]/g, ''), 'i');
  const [data, total] = await Promise.all([SalesDocument.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), SalesDocument.countDocuments(filter)]);
  // Email addresses for "Email with PDF".
  const emails = new Map((await Customer.find({ _id: { $in: data.map((d) => d.customerId).filter(Boolean) } }, { email: 1 }).lean()).map((c) => [String(c._id), c.email]));
  res.json({ data: data.map((d) => ({ ...d, customerEmail: d.customerId ? emails.get(String(d.customerId)) ?? null : null })), total, page: q.page, limit: q.limit });
});

router.get('/documents/:id', requirePermission('sales.read'), async (req, res) => {
  const d = await SalesDocument.findById(idParam(req.params.id)).lean();
  if (!d) throw notFound('Document');
  const customer = d.customerId ? await Customer.findById(d.customerId, { name: 1, phone: 1, email: 1, address: 1, taxPin: 1 }).lean() : null;
  res.json({ data: { ...d, customer } });
});

router.post('/documents', requirePermission('quotations.manage'), async (req, res) => {
  const body = parse(docSchema, req.body);
  if (!req.capabilities!.modules.includes(MODULE_FOR[body.type])) throw unprocessable(`${body.type} module is not enabled`, 'MODULE_DISABLED');
  assertBranchAccess(req, body.branchId);
  const branch = await Branch.findById(body.branchId);
  if (!branch) throw notFound('Branch');
  const warehouseId = body.warehouseId ?? (await Warehouse.findOne({ branchId: branch._id, isDefault: true }).lean())?._id ?? (await Warehouse.findOne({ branchId: branch._id }).lean())?._id;
  const customer = body.customerId ? await Customer.findById(body.customerId).lean() : null;
  const priceList = (body.priceList ?? customer?.priceList ?? req.capabilities!.checkout.defaultPriceList) as PriceListKey;
  const settings = req.tenant!.settings!;
  const lines = [];
  for (const l of body.lines) {
    const product = await Product.findOne({ _id: l.productId, active: true });
    if (!product) throw notFound('Product');
    const unit = resolveUnit(product, l.unitCode);
    const quote = await quotePrice({ product, unitCode: unit.code, qty: l.qty, priceList, customerId: customer?._id, branchId: branch._id });
    const unitPrice = l.unitPriceCents ?? quote.unitPriceCents;
    if (l.unitPriceCents !== undefined && l.unitPriceCents !== quote.unitPriceCents && !req.auth!.permissions.has('sales.price.override')) throw badRequest('You cannot change quoted prices');
    const gross = lineAmount(l.qty, unitPrice);
    const amount = gross - Math.min(l.discountCents, gross);
    const rate = product.taxRateBp ?? settings.defaultTaxRateBp ?? 0;
    const tax = calculateTax(amount, rate, settings.pricesIncludeTax ?? true);
    lines.push({ productId: product._id, sku: product.sku, name: product.name, unitCode: unit.code, unitFactor: unit.factor, qty: roundQty(l.qty), unitPriceCents: unitPrice, discountCents: Math.min(l.discountCents, gross), taxRateBp: rate, taxCents: tax.tax, totalCents: tax.gross });
  }
  const number = await nextNumber(body.type, PREFIX[body.type]);
  const doc = await SalesDocument.create({
    type: body.type, number, customerId: customer?._id, customerName: customer?.name ?? body.customerName, branchId: branch._id, warehouseId, priceList, lines,
    totalCents: lines.reduce((a, l) => a + l.totalCents, 0), taxCents: lines.reduce((a, l) => a + l.taxCents, 0),
    validUntil: body.validUntil ?? (body.type === 'quotation' ? new Date(Date.now() + 14 * 86400_000) : undefined), notes: body.notes, salesRepId: body.salesRepId, createdBy: req.auth!.userId,
  });
  await audit(req, { action: `${body.type}.created`, entity: 'SalesDocument', entityId: doc._id, details: { number, totalCents: doc.totalCents } });
  res.status(201).json({ data: doc });
});

router.post('/documents/:id/status', requirePermission('quotations.manage'), async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(['sent', 'accepted', 'cancelled']) }), req.body);
  const doc = await withTransaction(async () => {
    const d = await SalesDocument.findOne({ _id: idParam(req.params.id), status: { $in: ['draft', 'sent', 'accepted'] } });
    if (!d) throw unprocessable('Document can no longer be changed');
    if (status === 'cancelled' && d.stockReserved) {
      for (const l of d.lines) await adjustReserved(l.productId!, d.warehouseId!, -roundQty(l.qty! * (l.unitFactor ?? 1)));
      d.stockReserved = false;
    }
    d.status = status;
    await d.save();
    await audit(req, { action: `${d.type}.${status}`, entity: 'SalesDocument', entityId: d._id });
    return d;
  });
  res.json({ data: doc });
});

/** Reserves stock for a sales order so it is not sold to someone else before fulfilment. */
router.post('/documents/:id/reserve', requirePermission('quotations.manage'), requireModule('salesOrders'), async (req, res) => {
  const doc = await withTransaction(async () => {
    const d = await SalesDocument.findOne({ _id: idParam(req.params.id), type: 'sales_order', status: { $in: ['draft', 'sent', 'accepted'] }, stockReserved: false });
    if (!d) throw unprocessable('Order cannot be reserved');
    for (const l of d.lines) await adjustReserved(l.productId!, d.warehouseId!, roundQty(l.qty! * (l.unitFactor ?? 1)));
    d.stockReserved = true;
    await d.save();
    return d;
  });
  res.json({ data: doc });
});

/** Creates a delivery note for a completed sale (dispatch document; stock already left at sale). */
router.post('/delivery-notes', requirePermission('sales.read'), requireModule('deliveryNotes'), async (req, res) => {
  const body = parse(z.object({ saleId: objectId, deliveryAddress: z.string().max(300).optional(), driver: z.string().max(120).optional(), vehicle: z.string().max(40).optional(), notes: z.string().max(500).optional(), lines: z.array(z.object({ lineId: objectId, qty: z.number().positive() })).optional() }), req.body);
  const sale = await Sale.findById(body.saleId).lean();
  if (!sale) throw notFound('Sale');
  const customer = sale.customerId ? await Customer.findById(sale.customerId).lean() : null;
  const already = await SalesDocument.find({ type: 'delivery_note', saleId: sale._id, status: { $ne: 'cancelled' } }).lean();
  const delivered = new Map<string, number>();
  for (const d of already) for (const l of d.lines) delivered.set(String(l._id), (delivered.get(String(l._id)) ?? 0) + (l.qty ?? 0));
  const lines = sale.lines
    .map((l) => {
      const want = body.lines ? body.lines.find((x) => String(x.lineId) === String(l._id))?.qty ?? 0 : (l.qty ?? 0) - (l.returnedQty ?? 0) - (delivered.get(String(l._id)) ?? 0);
      return { _id: l._id, productId: l.productId, sku: l.sku, name: l.name, unitCode: l.unitCode, unitFactor: l.unitFactor, qty: roundQty(want) };
    })
    .filter((l) => l.qty > 0);
  for (const l of lines) {
    const src = sale.lines.find((x) => String(x._id) === String(l._id))!;
    if (l.qty + (delivered.get(String(l._id)) ?? 0) > (src.qty ?? 0) - (src.returnedQty ?? 0)) throw unprocessable(`Cannot deliver more ${l.name} than was sold`);
  }
  if (!lines.length) throw unprocessable('Nothing left to deliver on this sale');
  const number = await nextNumber('delivery_note', 'DN');
  const dn = await SalesDocument.create({ type: 'delivery_note', number, saleId: sale._id, customerId: sale.customerId, customerName: customer?.name, branchId: sale.branchId, warehouseId: sale.warehouseId, lines, deliveryAddress: body.deliveryAddress ?? customer?.address, driver: body.driver, vehicle: body.vehicle, notes: body.notes, status: 'sent', createdBy: req.auth!.userId });
  await audit(req, { action: 'delivery_note.created', entity: 'SalesDocument', entityId: dn._id, details: { number, sale: sale.number } });
  res.status(201).json({ data: dn });
});

router.post('/delivery-notes/:id/delivered', requirePermission('sales.read'), requireModule('deliveryNotes'), async (req, res) => {
  const d = await SalesDocument.findOneAndUpdate({ _id: idParam(req.params.id), type: 'delivery_note', status: 'sent' }, { $set: { status: 'delivered' } }, { new: true });
  if (!d) throw notFound('Delivery note');
  await audit(req, { action: 'delivery_note.delivered', entity: 'SalesDocument', entityId: d._id });
  res.json({ data: d });
});

/** Printable A4 HTML for quotations, orders and delivery notes. */
router.get('/documents/:id/print', requirePermission('sales.read'), async (req, res) => {
  const d = await SalesDocument.findById(idParam(req.params.id)).lean();
  if (!d) throw notFound('Document');
  const tenant = await runAsPlatform(() => Tenant.findById(req.tenant!._id).lean());
  const cur = tenant?.settings?.currency ?? 'KES';
  const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const title = { quotation: 'QUOTATION', sales_order: 'SALES ORDER', delivery_note: 'DELIVERY NOTE' }[d.type];
  const showPrices = d.type !== 'delivery_note';
  const rows = d.lines.map((l) => `<tr><td>${esc(l.sku)}</td><td>${esc(l.name)}</td><td class="r">${esc(l.qty)} ${esc(l.unitCode)}</td>${showPrices ? `<td class="r">${esc(formatMoney(l.unitPriceCents ?? 0, cur))}</td><td class="r">${esc(formatMoney(l.totalCents ?? 0, cur))}</td>` : '<td></td>'}</tr>`).join('');
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(d.number)}</title><style>
  body{font:13px system-ui,sans-serif;margin:24px;color:#111} h1{margin:0;font-size:22px} table{width:100%;border-collapse:collapse;margin-top:16px} td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left} .r{text-align:right} .muted{color:#555}
  @media print{button{display:none}}</style></head><body>
  <div style="display:flex;justify-content:space-between"><div><h1>${esc(tenant?.name)}</h1><div class="muted">${esc(tenant?.settings?.taxPin ? 'PIN ' + tenant.settings.taxPin : '')}</div></div>
  <div style="text-align:right"><h2 style="margin:0">${title}</h2><div>${esc(d.number)}</div><div class="muted">${esc(new Date(d.createdAt!).toLocaleDateString('en-KE'))}</div>${d.validUntil ? `<div class="muted">Valid until ${esc(new Date(d.validUntil).toLocaleDateString('en-KE'))}</div>` : ''}</div></div>
  <p><strong>To:</strong> ${esc(d.customerName ?? 'Customer')}${d.deliveryAddress ? `<br>${esc(d.deliveryAddress)}` : ''}</p>
  <table><thead><tr><th>SKU</th><th>Item</th><th class="r">Qty</th>${showPrices ? '<th class="r">Unit price</th><th class="r">Amount</th>' : '<th>Received (sign)</th>'}</tr></thead><tbody>${rows}</tbody></table>
  ${showPrices ? `<p class="r"><strong>Total: ${esc(formatMoney(d.totalCents ?? 0, cur))}</strong><br><span class="muted">Includes tax ${esc(formatMoney(d.taxCents ?? 0, cur))}</span></p>` : `<p>Driver: ${esc(d.driver)} &nbsp; Vehicle: ${esc(d.vehicle)}</p><p>Received by: ____________________ Date: __________</p>`}
  ${d.notes ? `<p class="muted">${esc(d.notes)}</p>` : ''}<p class="muted">Generated by Afey POS</p><button onclick="print()">Print</button></body></html>`);
});

export const documentRoutes = router;
