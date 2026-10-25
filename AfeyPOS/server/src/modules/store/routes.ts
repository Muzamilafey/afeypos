/**
 * Online shop.
 *  - Public storefront API (/api/v1/store/*, no sign-in, open CORS, no cookies): catalogue, cart quote,
 *    checkout with M-Pesa STK Push or pay on delivery, order tracking by number + token or phone.
 *  - Staff API (/online-orders): accept, pick, ready / out for delivery, complete (becomes a normal sale:
 *    stock, eTIMS, accounts) or cancel (stock released; a paid M-Pesa order is marked for refund).
 * Orders are taken on head office (the public server). The order's branch fulfils it; with branch
 * servers the order syncs to that branch, which completes it locally.
 */
import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import type { Types } from 'mongoose';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import rateLimit from 'express-rate-limit';
import { lineAmount, roundQty } from '@afeypos/shared';
import { Branch, Category, Customer, IntegrationConfig, OnlineOrder, PaymentIntent, Product, StockLevel, Tenant, Till, Warehouse } from '../../models/index.js';
import { escapeRegex, idParam, objectId, pagination, parse, qty } from '../../http/validate.js';
import { requirePermission } from '../../http/auth.js';
import { AppError, badRequest, notFound, unprocessable } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { nextNumber } from '../../lib/numbering.js';
import { normalizePhone, isKenyanMobile } from '../../lib/phone.js';
import { runAsPlatform } from '../../lib/context.js';
import { env } from '../../config/env.js';
import { registerJob } from '../../jobs/queue.js';
import { emitToTenant } from '../../realtime/socket.js';
import { notify } from '../notifications/service.js';
import { quotePrice } from '../catalog/pricing.js';
import { adjustReserved } from '../inventory/stock.js';
import { tenantFilePath, mimeFor } from '../files/routes.js';
import { buildStkCallback, handleStkCallback, startStk } from '../payments/mpesa.js';
import { checkout } from '../sales/checkout.js';
import { createPayouts } from '../payments/payouts.js';

export const storefrontRoutes = Router();
export const onlineOrderRoutes = Router();

const STATUS_TEXT: Record<string, string> = {
  pending_payment: 'is waiting for your M-Pesa payment', placed: 'has been received', accepted: 'has been accepted', picking: 'is being packed',
  ready: 'is ready for collection', out_for_delivery: 'is on the way', completed: 'is complete. Thank you!', cancelled: 'has been cancelled',
};

const orderLimiter = rateLimit({ windowMs: 10 * 60_000, limit: () => (env().NODE_ENV === 'test' ? 100_000 : 20), standardHeaders: 'draft-7', legacyHeaders: false, message: { error: { code: 'RATE_LIMITED', message: 'Too many orders from this connection; please try again later' } } });

function storeSettings(req: Request) {
  const s = req.tenant!.settings?.store;
  if (!s?.enabled || !req.capabilities!.modules.includes('onlineStore')) throw new AppError(404, 'STORE_CLOSED', 'The online shop is not open');
  return s;
}

async function storeWarehouse(s: any) {
  if (s.warehouseId) return s.warehouseId as Types.ObjectId;
  const w = s.branchId ? await Warehouse.findOne({ branchId: s.branchId }).lean() : await Warehouse.findOne({}).sort({ createdAt: 1 }).lean();
  if (!w) throw new AppError(409, 'STORE_NOT_SET_UP', 'Choose the shop warehouse in settings');
  return w._id;
}

const publicImage = (src: string) => {
  const m = /^\/api\/v1\/files\/([a-f0-9]{32}\.(png|jpg|webp))$/.exec(src);
  return m ? `/api/v1/store/images/${m[1]}` : src;
};

function presentProduct(p: any, stock: Map<string, number>) {
  const available = p.trackStock === false || p.type !== 'stock' ? null : Math.max(0, stock.get(String(p._id)) ?? 0);
  return {
    id: p._id, name: p.name, sku: p.sku, unit: p.baseUnit, priceCents: p.prices?.retail ?? 0, categoryId: p.categoryId, images: (p.images ?? []).map(publicImage),
    description: p.online?.description ?? p.description ?? '', featured: Boolean(p.online?.featured), allowFractional: Boolean(p.allowFractional),
    inStock: available === null || available > 0, available: available === null ? null : Math.floor(available), ageRestricted: Boolean(p.ageRestricted),
  };
}

async function available(productIds: Types.ObjectId[], warehouseId: Types.ObjectId) {
  const rows = await StockLevel.find({ productId: { $in: productIds }, warehouseId }, { productId: 1, qty: 1, reserved: 1 }).lean();
  return new Map(rows.map((r) => [String(r.productId), (r.qty ?? 0) - (r.reserved ?? 0)]));
}

// ---------------- public storefront ----------------

storefrontRoutes.get('/config', async (req, res) => {
  const s = storeSettings(req);
  const t = req.tenant!;
  const branchIds = s.branchId ? [s.branchId] : [];
  const branches = await Branch.find(branchIds.length ? { _id: { $in: branchIds } } : { active: { $ne: false } }, { name: 1, address: 1, phone: 1 }).lean();
  const usedCats = await Product.distinct('categoryId', { 'online.enabled': true, active: { $ne: false } });
  const categories = await Category.find({ _id: { $in: usedCats }, active: { $ne: false } }, { name: 1, color: 1, sortOrder: 1 }).sort({ sortOrder: 1, name: 1 }).lean();
  res.json({
    data: {
      name: t.name, tagline: t.settings?.tagline ?? '', currency: t.settings?.currency ?? 'KES', logoUrl: t.settings?.logoFileId ? `/api/v1/public/logo?v=${t.settings.logoFileId.slice(0, 8)}` : null,
      announcement: s.announcement ?? '', contactPhone: s.contactPhone ?? '', hours: s.hours ?? '',
      pickup: s.pickup !== false, delivery: s.delivery !== false, deliveryAreas: s.deliveryAreas ?? [], deliveryFeeCents: s.deliveryFeeCents ?? 0, freeDeliveryAboveCents: s.freeDeliveryAboveCents ?? 0,
      minOrderCents: s.minOrderCents ?? 0, payOnDelivery: s.payOnDelivery !== false, mpesa: s.mpesa !== false && req.capabilities!.modules.includes('mpesa'),
      branches: branches.map((b) => ({ id: b._id, name: b.name, address: (b as any).address ?? '', phone: (b as any).phone ?? '' })), categories: categories.map((c) => ({ id: c._id, name: c.name, color: c.color })),
    },
  });
});

storefrontRoutes.get('/products', async (req, res) => {
  const s = storeSettings(req);
  const q = parse(pagination.extend({ categoryId: objectId.optional(), featured: z.coerce.boolean().optional(), limit: z.coerce.number().int().min(1).max(60).default(24) }), req.query);
  const filter: Record<string, unknown> = { 'online.enabled': true, active: { $ne: false } };
  if (q.categoryId) filter.categoryId = q.categoryId;
  if (q.featured) filter['online.featured'] = true;
  if (q.q) filter.$or = [{ name: new RegExp(escapeRegex(q.q), 'i') }, { 'barcodes.code': q.q }, { sku: q.q }];
  const [rows, total] = await Promise.all([Product.find(filter).sort({ 'online.featured': -1, name: 1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), Product.countDocuments(filter)]);
  const stock = await available(rows.map((r) => r._id), await storeWarehouse(s));
  res.json({ data: rows.map((p) => presentProduct(p, stock)), total, page: q.page, limit: q.limit });
});

storefrontRoutes.get('/products/:id', async (req, res) => {
  const s = storeSettings(req);
  const p = await Product.findOne({ _id: idParam(req.params.id), 'online.enabled': true, active: { $ne: false } }).lean();
  if (!p) throw notFound('Product');
  res.json({ data: presentProduct(p, await available([p._id], await storeWarehouse(s))) });
});

/** Product photos of products listed online (other uploaded files stay private). */
storefrontRoutes.get('/images/:id', async (req, res) => {
  const id = String(req.params.id);
  if (!/^[a-f0-9]{32}\.(png|jpg|webp)$/.test(id)) throw notFound('Image');
  if (!(await Product.exists({ images: `/api/v1/files/${id}`, 'online.enabled': true }))) throw notFound('Image');
  const file = tenantFilePath(String(req.tenant!._id), id);
  if (!file || !fs.existsSync(file)) throw notFound('Image');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.type(mimeFor(id)).sendFile(path.resolve(file));
});

const cartSchema = z.object({
  lines: z.array(z.object({ productId: objectId, qty })).min(1).max(100),
  fulfilment: z.enum(['delivery', 'pickup']).default('pickup'),
  area: z.string().max(60).optional(),
});

/** Prices a cart the same way the till does; refuses what is not listed or not in stock. */
async function priceCart(req: Request, input: z.infer<typeof cartSchema>) {
  const s = storeSettings(req);
  const warehouseId = await storeWarehouse(s);
  const products = new Map((await Product.find({ _id: { $in: input.lines.map((l) => l.productId) }, 'online.enabled': true, active: { $ne: false } }).lean()).map((p) => [String(p._id), p]));
  const stock = await available([...products.values()].map((p) => p._id), warehouseId);
  const problems: string[] = [];
  const lines = [];
  for (const l of input.lines) {
    const p = products.get(String(l.productId));
    if (!p) {
      problems.push('A product in your basket is no longer sold online');
      continue;
    }
    const q = p.allowFractional ? roundQty(l.qty) : Math.round(l.qty);
    if (q <= 0) continue;
    if (p.type === 'stock' && p.trackStock !== false && (stock.get(String(p._id)) ?? 0) < q) {
      problems.push(`Only ${Math.max(0, Math.floor(stock.get(String(p._id)) ?? 0))} ${p.name} left`);
      continue;
    }
    const quote = await quotePrice({ product: p as any, unitCode: p.baseUnit, qty: q, priceList: 'retail', branchId: s.branchId ?? undefined });
    lines.push({ productId: p._id, name: p.name, sku: p.sku, unitCode: p.baseUnit, qty: q, unitPriceCents: quote.unitPriceCents, totalCents: lineAmount(q, quote.unitPriceCents) });
  }
  const subtotal = lines.reduce((a, l) => a + l.totalCents, 0);
  let fee = 0;
  if (input.fulfilment === 'delivery') {
    if (s.delivery === false) throw unprocessable('Delivery is not available; choose pickup', 'NO_DELIVERY');
    const area = (s.deliveryAreas ?? []).find((a: any) => a.name === input.area);
    if ((s.deliveryAreas ?? []).length && !area) problems.push('Choose a delivery area');
    fee = area?.feeCents ?? s.deliveryFeeCents ?? 0;
    if (s.freeDeliveryAboveCents && subtotal >= s.freeDeliveryAboveCents) fee = 0;
  } else if (s.pickup === false) throw unprocessable('Pickup is not available; choose delivery', 'NO_PICKUP');
  if (s.minOrderCents && subtotal < s.minOrderCents) problems.push(`The minimum order is ${(s.minOrderCents / 100).toFixed(0)}`);
  return { lines, subtotalCents: subtotal, deliveryFeeCents: fee, totalCents: subtotal + fee, problems, warehouseId, settings: s };
}

storefrontRoutes.post('/cart/quote', async (req, res) => {
  const q = await priceCart(req, parse(cartSchema, req.body));
  res.json({ data: { lines: q.lines, subtotalCents: q.subtotalCents, deliveryFeeCents: q.deliveryFeeCents, totalCents: q.totalCents, problems: q.problems } });
});

const orderSchema = cartSchema.extend({
  clientRequestId: z.string().min(8).max(100),
  customer: z.object({ name: z.string().trim().min(2).max(120), phone: z.string().trim().min(9).max(20), email: z.string().trim().email().optional().or(z.literal('')) }),
  address: z.string().trim().max(300).optional(),
  notes: z.string().trim().max(500).optional(),
  payment: z.enum(['mpesa', 'on_delivery']),
  mpesaPhone: z.string().trim().max(20).optional(),
  marketingOptIn: z.boolean().default(false),
});

function presentOrder(o: any) {
  return {
    number: o.number, token: o.trackingToken, status: o.status, statusText: STATUS_TEXT[o.status], fulfilment: o.fulfilment, area: o.area, address: o.address, customer: { name: o.customer?.name },
    lines: o.lines, subtotalCents: o.subtotalCents, deliveryFeeCents: o.deliveryFeeCents, totalCents: o.totalCents,
    payment: { method: o.payment?.method, status: o.payment?.status, receiptNumber: o.payment?.receiptNumber },
    history: (o.history ?? []).map((h: any) => ({ status: h.status, at: h.at, text: STATUS_TEXT[h.status] })), createdAt: o.createdAt,
  };
}

async function findOrCreateCustomer(c: { name: string; phone: string; email?: string }, optIn: boolean) {
  const phone = normalizePhone(c.phone)!;
  const local = `0${phone.slice(3)}`;
  const existing = await Customer.findOne({ phone: { $in: [phone, local, `+${phone}`] } });
  if (existing) {
    if (optIn && !existing.marketingOptIn) {
      existing.marketingOptIn = true;
      existing.marketingOptInAt = new Date();
      await existing.save();
    }
    return existing;
  }
  return Customer.create({ code: await nextNumber('customer', 'C', 5), name: c.name, phone: local, email: c.email || undefined, kind: 'retail', source: 'online shop', marketingOptIn: optIn, ...(optIn ? { marketingOptInAt: new Date() } : {}) });
}

async function startOrderPayment(req: Request, o: any, phone: string, attempt: string) {
  const amount = Math.ceil(o.totalCents / 100) * 100; // M-Pesa takes whole shillings
  const { intent } = await startStk({ tenant: req.tenant!, clientRequestId: `order:${o._id}:${attempt}`, amountCents: amount, phone, accountReference: o.number.replace(/[^A-Za-z0-9]/g, ''), branchId: o.branchId, description: `Order ${o.number}` });
  await PaymentIntent.updateOne({ _id: intent._id }, { $set: { onlineOrderId: o._id } });
  o.payment.paymentIntentId = intent._id;
  o.payment.status = 'pending';
  o.payment.phone = intent.phone;
  await o.save();
}

/** Brings the order's payment up to date with its M-Pesa intent. */
export async function refreshPayment(o: any) {
  if (o.payment?.method !== 'mpesa' || !o.payment.paymentIntentId || o.payment.status === 'paid') return o;
  const intent = await PaymentIntent.findById(o.payment.paymentIntentId).lean();
  if (!intent) return o;
  if (intent.status === 'succeeded') {
    o.payment.status = 'paid';
    o.payment.paidCents = intent.paidAmountCents ?? intent.amountCents;
    o.payment.receiptNumber = intent.receiptNumber;
    if (o.status === 'pending_payment') {
      o.status = 'placed';
      o.history.push({ status: 'placed', at: new Date(), note: `Paid by M-Pesa ${intent.receiptNumber ?? ''}`.trim() });
    }
    await o.save();
    await newOrderNotice(o);
  } else if (['failed', 'cancelled', 'expired'].includes(intent.status) && o.payment.status === 'pending') {
    o.payment.status = 'failed';
    await o.save();
  }
  return o;
}

async function newOrderNotice(o: any) {
  emitToTenant(o.tenantId, 'online-order.placed', { id: o._id, number: o.number, totalCents: o.totalCents });
  const t = await runAsPlatform(() => Tenant.findById(o.tenantId, { name: 1, settings: 1 }).lean());
  const to = t?.settings?.store?.notifyPhone;
  if (to) await notify({ channel: 'sms', to, templateKey: 'order_new', data: { business: t!.name, number: o.number, total: (o.totalCents / 100).toFixed(2), customer: o.customer?.name, fulfilment: o.fulfilment }, dedupeKey: `order-new:${o._id}` });
}

async function tellCustomer(o: any, extra = '') {
  if (!o.customer?.phone) return;
  const t = await runAsPlatform(() => Tenant.findById(o.tenantId, { name: 1 }).lean());
  await notify({ channel: 'sms', to: o.customer.phone, templateKey: 'order_update', data: { business: t?.name ?? '', number: o.number, statusText: STATUS_TEXT[o.status], extra }, dedupeKey: `order:${o._id}:${o.status}` });
}

storefrontRoutes.post('/orders', orderLimiter, async (req, res) => {
  const body = parse(orderSchema, req.body);
  const existing = await OnlineOrder.findOne({ clientRequestId: body.clientRequestId }).lean();
  if (existing) return res.json({ data: presentOrder(existing), replay: true });
  const phone = normalizePhone(body.customer.phone);
  if (!phone || !isKenyanMobile(phone)) throw badRequest('Enter a valid Kenyan mobile number, e.g. 0712345678');
  const q = await priceCart(req, body);
  if (q.problems.length) throw unprocessable(q.problems.join('. '), 'CART_PROBLEM', { problems: q.problems });
  if (!q.lines.length) throw badRequest('Your basket is empty');
  if (body.fulfilment === 'delivery' && !body.address) throw badRequest('Enter the delivery address');
  if (body.payment === 'on_delivery' && q.settings.payOnDelivery === false) throw unprocessable('Pay with M-Pesa to place this order', 'PAY_ON_DELIVERY_OFF');
  if (body.payment === 'mpesa' && (q.settings.mpesa === false || !req.capabilities!.modules.includes('mpesa'))) throw unprocessable('M-Pesa payment is not available', 'MPESA_OFF');
  const customer = await findOrCreateCustomer({ ...body.customer, phone }, body.marketingOptIn);
  const branchId = q.settings.branchId ?? (await Warehouse.findById(q.warehouseId, { branchId: 1 }).lean())?.branchId;
  const o = await OnlineOrder.create({
    number: await nextNumber('online-order', 'WEB'), clientRequestId: body.clientRequestId, trackingToken: crypto.randomBytes(12).toString('base64url'),
    status: body.payment === 'mpesa' ? 'pending_payment' : 'placed', customer: { name: body.customer.name, phone, email: body.customer.email || undefined }, customerId: customer._id,
    fulfilment: body.fulfilment, address: body.address, area: body.area, notes: body.notes, branchId, warehouseId: q.warehouseId,
    lines: q.lines, subtotalCents: q.subtotalCents, deliveryFeeCents: q.deliveryFeeCents, totalCents: q.totalCents,
    payment: { method: body.payment, status: 'unpaid' }, history: [{ status: body.payment === 'mpesa' ? 'pending_payment' : 'placed', at: new Date() }],
  });
  // Hold the stock while the order is open (only possible where this server owns the warehouse).
  try {
    for (const l of q.lines) await adjustReserved(l.productId, q.warehouseId, l.qty);
    o.reserved = true;
    await o.save();
  } catch (err: any) {
    if (err?.code !== 'STOCK_OWNED_ELSEWHERE') throw err;
  }
  if (body.payment === 'mpesa') {
    try {
      await startOrderPayment(req, o, body.mpesaPhone || phone, '1');
    } catch (err: any) {
      // The order stays; the customer can retry the payment from the tracking page.
      o.payment!.status = 'failed';
      await o.save();
      return res.status(201).json({ data: presentOrder(o), paymentError: err?.message ?? 'M-Pesa is not available right now' });
    }
  } else {
    await newOrderNotice(o);
  }
  res.status(201).json({ data: presentOrder(o) });
});

async function publicOrder(req: Request) {
  const q = parse(z.object({ token: z.string().max(40).optional(), phone: z.string().max(20).optional() }), req.query);
  const o = await OnlineOrder.findOne({ number: String(req.params.number).toUpperCase() });
  if (!o) throw notFound('Order');
  const phone = q.phone ? normalizePhone(q.phone) : null;
  if (!((q.token && q.token === o.trackingToken) || (phone && phone === o.customer?.phone))) throw notFound('Order');
  return o;
}

storefrontRoutes.get('/orders/:number', async (req, res) => {
  const o = await refreshPayment(await publicOrder(req));
  res.json({ data: presentOrder(o) });
});

storefrontRoutes.post('/orders/:number/pay', orderLimiter, async (req, res) => {
  const body = parse(z.object({ phone: z.string().max(20).optional() }), req.body ?? {});
  const o = await refreshPayment(await publicOrder(req));
  if (o.payment.method !== 'mpesa' || o.payment.status === 'paid' || o.status === 'cancelled') throw unprocessable('This order does not need a payment', 'NOTHING_TO_PAY');
  await startOrderPayment(req, o, body.phone || o.payment.phone || o.customer.phone, String(Date.now()));
  res.json({ data: presentOrder(o) });
});

/** Training and tests: confirm the M-Pesa prompt of an order (simulator only). */
storefrontRoutes.post('/orders/:number/simulate-payment', async (req, res) => {
  if (env().NODE_ENV === 'production') throw notFound('Endpoint');
  const o = await publicOrder(req);
  const intent = o.payment?.paymentIntentId ? await PaymentIntent.findById(o.payment.paymentIntentId).lean() : null;
  if (!intent) throw notFound('Payment');
  const cfg = await IntegrationConfig.findById(intent.configId).lean();
  if (cfg?.provider !== 'mock' || !intent.checkoutRequestId) throw notFound('Simulated payment');
  await handleStkCallback(req.tenant!._id, buildStkCallback(intent.checkoutRequestId, intent.merchantRequestId ?? 'mock', 0, intent.amountCents / 100, intent.phone ?? '254700000000'), 'simulator');
  res.json({ data: presentOrder(await refreshPayment(o)) });
});

// ---------------- staff ----------------

onlineOrderRoutes.get('/online-orders', requirePermission('orders.manage'), async (req, res) => {
  const q = parse(pagination.extend({ status: z.string().optional(), open: z.coerce.boolean().optional() }), req.query);
  const filter: Record<string, unknown> = {};
  if (q.status) filter.status = q.status;
  if (q.open) filter.status = { $nin: ['completed', 'cancelled'] };
  if (req.auth!.branchIds.length) filter.branchId = { $in: req.auth!.branchIds };
  if (q.q) filter.$or = [{ number: new RegExp(escapeRegex(q.q), 'i') }, { 'customer.name': new RegExp(escapeRegex(q.q), 'i') }, { 'customer.phone': normalizePhone(q.q) ?? q.q }];
  const pending = await OnlineOrder.find({ ...filter, 'payment.status': 'pending' }).limit(50);
  for (const o of pending) await refreshPayment(o);
  const [data, total] = await Promise.all([OnlineOrder.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), OnlineOrder.countDocuments(filter)]);
  res.json({ data, total, page: q.page, limit: q.limit });
});

onlineOrderRoutes.get('/online-orders/:id', requirePermission('orders.manage'), async (req, res) => {
  const o = await OnlineOrder.findById(idParam(req.params.id));
  if (!o) throw notFound('Order');
  await refreshPayment(o);
  res.json({ data: o });
});

const NEXT: Record<string, string[]> = {
  placed: ['accepted', 'cancelled'], accepted: ['picking', 'ready', 'out_for_delivery', 'cancelled'], picking: ['ready', 'out_for_delivery', 'cancelled'],
  ready: ['cancelled'], out_for_delivery: ['cancelled'], pending_payment: ['cancelled'],
};

async function releaseStock(o: any) {
  if (!o.reserved) return;
  for (const l of o.lines) await adjustReserved(l.productId, o.warehouseId, -l.qty);
  o.reserved = false;
}

onlineOrderRoutes.post('/online-orders/:id/status', requirePermission('orders.manage'), async (req, res) => {
  const body = parse(z.object({ status: z.enum(['accepted', 'picking', 'ready', 'out_for_delivery', 'cancelled']), note: z.string().max(300).optional() }), req.body);
  const o = await OnlineOrder.findById(idParam(req.params.id));
  if (!o) throw notFound('Order');
  await refreshPayment(o);
  if (!(NEXT[o.status] ?? []).includes(body.status)) throw unprocessable(`An order that ${STATUS_TEXT[o.status]} cannot be marked ${body.status.replace(/_/g, ' ')}`, 'BAD_TRANSITION');
  if (body.status === 'ready' && o.fulfilment !== 'pickup') throw unprocessable('Delivery orders go out for delivery', 'BAD_TRANSITION');
  if (body.status === 'out_for_delivery' && o.fulfilment !== 'delivery') throw unprocessable('Pickup orders are made ready for collection', 'BAD_TRANSITION');
  o.status = body.status;
  o.history.push({ status: body.status, at: new Date(), by: req.auth!.userId, note: body.note });
  if (body.status === 'cancelled') {
    o.cancelReason = body.note;
    await releaseStock(o);
    if (o.payment?.status === 'paid') {
      o.payment.status = 'refund_due';
      // Refund to the phone that paid, as an M-Pesa payout someone approves.
      if (req.capabilities!.modules.includes('mpesa') && o.payment.phone) {
        await createPayouts([{ purpose: 'refund', amountCents: Math.floor((o.payment.paidCents ?? o.totalCents) / 100) * 100, phone: o.payment.phone, payeeName: o.customer?.name ?? undefined, ref: { type: 'OnlineOrder', id: o._id, number: o.number } }], req.auth!.userId).catch(() => undefined);
      }
    }
  }
  await o.save();
  await tellCustomer(o, body.status === 'ready' ? 'Bring your order number.' : body.note ?? '');
  await audit(req, { action: `online_order.${body.status}`, entity: 'OnlineOrder', entityId: o._id, details: { number: o.number } });
  res.json({ data: o });
});

async function deliveryProduct() {
  let p = await Product.findOne({ sku: 'DELIVERY' });
  if (!p) p = await Product.create({ name: 'Delivery fee', sku: 'DELIVERY', type: 'service', trackStock: false, baseUnit: 'pc', prices: { retail: 0 }, taxRateBp: 0 });
  return p;
}

/** Hands the order over and records it as a sale (stock, receipt, eTIMS and accounts follow as for any sale). */
onlineOrderRoutes.post('/online-orders/:id/complete', requirePermission('orders.manage'), requirePermission('sales.create'), async (req, res) => {
  const body = parse(z.object({ tillId: objectId, payments: z.array(z.object({ method: z.enum(['cash', 'mpesa', 'card', 'bank', 'other']), amountCents: z.number().int().positive(), tenderedCents: z.number().int().optional(), reference: z.string().max(100).optional(), paymentIntentId: objectId.optional() })).max(5).default([]) }), req.body);
  const o = await OnlineOrder.findById(idParam(req.params.id));
  if (!o) throw notFound('Order');
  await refreshPayment(o);
  if (o.status === 'completed') return res.json({ data: o, replay: true });
  if (!['accepted', 'picking', 'ready', 'out_for_delivery', 'placed'].includes(o.status)) throw unprocessable('This order cannot be completed', 'BAD_TRANSITION');
  const till = await Till.findById(body.tillId).lean();
  if (!till) throw notFound('Till');
  const lines: any[] = o.lines.map((l) => ({ productId: l.productId, qty: l.qty, unitPriceCents: l.unitPriceCents, unitCode: l.unitCode }));
  if (o.deliveryFeeCents) lines.push({ productId: (await deliveryProduct())._id, qty: 1, unitPriceCents: o.deliveryFeeCents });
  let payments = body.payments;
  if (o.payment?.status === 'paid' && o.payment.paymentIntentId) {
    payments = [{ method: 'mpesa', amountCents: o.totalCents!, paymentIntentId: o.payment.paymentIntentId as any }];
    // The order's intent is released for its own sale only.
    await PaymentIntent.updateOne({ _id: o.payment.paymentIntentId }, { $unset: { onlineOrderId: 1 } });
  }
  const paid = payments.reduce((s, p) => s + p.amountCents, 0);
  if (paid < (o.totalCents ?? 0)) throw unprocessable(`Collect ${((o.totalCents! - paid) / 100).toFixed(2)} before completing`, 'UNPAID');
  await releaseStock(o);
  await o.save();
  let sale;
  try {
    ({ sale } = await checkout(req, { clientRequestId: `online:${o._id}`, tillId: body.tillId, customerId: o.customerId as any, lines, payments, cartDiscountCents: 0, onlineOrderId: o._id as any } as any));
  } catch (err) {
    // Put the reservation back if the sale could not be made.
    try {
      for (const l of o.lines) await adjustReserved(l.productId!, o.warehouseId as any, l.qty!);
      o.reserved = true;
      await o.save();
    } catch {
      /* warehouse not owned here */
    }
    if (o.payment?.status === 'paid' && o.payment.paymentIntentId) await PaymentIntent.updateOne({ _id: o.payment.paymentIntentId, allocatedCents: 0 }, { $set: { onlineOrderId: o._id } });
    throw err;
  }
  o.status = 'completed';
  o.saleId = sale._id;
  o.saleNumber = sale.number;
  if (o.payment) {
    o.payment.status = 'paid';
    o.payment.paidCents = paid;
  }
  o.history.push({ status: 'completed', at: new Date(), by: req.auth!.userId, note: `Sale ${sale.number}` });
  await o.save();
  await tellCustomer(o);
  await audit(req, { action: 'online_order.completed', entity: 'OnlineOrder', entityId: o._id, details: { number: o.number, sale: sale.number } });
  res.json({ data: o, sale });
});

/** Unpaid M-Pesa orders are cancelled after two hours and their stock released. */
registerJob('store.expireUnpaid', async () => {
  const old = await OnlineOrder.find({ status: 'pending_payment', createdAt: { $lt: new Date(Date.now() - 2 * 3600_000) } }).limit(200);
  for (const o of old) {
    await refreshPayment(o);
    if (o.status !== 'pending_payment') continue;
    o.status = 'cancelled';
    o.cancelReason = 'Not paid within 2 hours';
    o.history.push({ status: 'cancelled', at: new Date(), note: o.cancelReason });
    await releaseStock(o).catch(() => undefined);
    await o.save();
  }
});
