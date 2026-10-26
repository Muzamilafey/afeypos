/**
 * Loyalty program (rules, members, cards, points history and adjustments) and gift vouchers
 * (issue or sell, check, print, cancel). Spending both happens at checkout (sales/checkout.ts).
 */
import { Router } from 'express';
import { z } from 'zod';
import { code128Svg, formatMoney, LOYALTY_CARD_RE, maxRedeemablePoints, mergeLoyalty, VOUCHER_CODE_RE } from '@afeypos/shared';
import { CashMovement, Customer, LoyaltyTransaction, Shift, Tenant, Till, Voucher } from '../../models/index.js';
import { escapeRegex, idParam, objectId, pagination, parse, positiveCents } from '../../http/validate.js';
import { requireModule, requirePermission, requireAnyPermission } from '../../http/auth.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { runAsPlatform } from '../../lib/context.js';
import { changePoints, customerTier, newCardNo, newVoucherCode, voucherProblem } from './service.js';

const router = Router();
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// ---------------- loyalty program ----------------
const programSchema = z.object({
  name: z.string().trim().min(1).max(40),
  pointsPerUnitCents: z.number().int().min(1).max(100_000_000),
  pointValueCents: z.number().int().min(1).max(1_000_000),
  minRedeemPoints: z.number().int().min(0).max(1_000_000),
  maxRedeemBp: z.number().int().min(0).max(10000),
  welcomeBonus: z.number().int().min(0).max(1_000_000),
  tierMultipliersBp: z.record(z.string().max(30), z.number().int().min(0).max(100_000)),
}).partial();

router.get('/loyalty/program', requireModule('loyalty'), requirePermission('customers.read'), async (req, res) => {
  const t = await runAsPlatform(() => Tenant.findById(req.tenant!._id, { settings: 1 }).lean());
  const tiers = (t?.settings?.crm?.tiers ?? []).map((x: any) => ({ name: x.name, minSpendCents: x.minSpendCents }));
  const [members, points] = await Promise.all([
    Customer.countDocuments({ loyaltyCardNo: { $type: 'string' } }),
    Customer.aggregate([{ $group: { _id: null, total: { $sum: '$loyaltyPoints' } } }]),
  ]);
  const program = mergeLoyalty(t?.settings?.loyalty);
  res.json({ data: { program, tiers, stats: { members, pointsOutstanding: points[0]?.total ?? 0, valueOutstandingCents: (points[0]?.total ?? 0) * program.pointValueCents } } });
});

router.put('/loyalty/program', requireModule('loyalty'), requirePermission('settings.manage'), async (req, res) => {
  const body = parse(programSchema, req.body);
  const t = await runAsPlatform(() => Tenant.findById(req.tenant!._id, { settings: 1 }).lean());
  const program = mergeLoyalty({ ...mergeLoyalty(t?.settings?.loyalty), ...body });
  await runAsPlatform(() => Tenant.updateOne({ _id: req.tenant!._id }, { $set: { 'settings.loyalty': program } }));
  await audit(req, { action: 'loyalty.program_updated', entity: 'Tenant', entityId: req.tenant!._id, details: { program } });
  res.json({ data: { program } });
});

// ---------------- members ----------------
router.get('/loyalty/members', requireModule('loyalty'), requirePermission('customers.read'), async (req, res) => {
  const q = parse(pagination.extend({ q: z.string().trim().max(100).optional(), all: z.enum(['true']).optional() }), req.query);
  const filter: Record<string, unknown> = { kind: { $ne: 'walk_in' } };
  if (!q.all) filter.$or = [{ loyaltyCardNo: { $type: 'string' } }, { loyaltyPoints: { $gt: 0 } }];
  if (q.q) {
    const rx = new RegExp(escapeRegex(q.q), 'i');
    filter.$and = [{ $or: [{ name: rx }, { phone: rx }, { code: rx }, { loyaltyCardNo: rx }] }];
  }
  const [data, total] = await Promise.all([
    Customer.find(filter, { name: 1, phone: 1, code: 1, loyaltyCardNo: 1, loyaltyPoints: 1, loyaltyJoinedAt: 1 }).sort({ loyaltyPoints: -1, name: 1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    Customer.countDocuments(filter),
  ]);
  res.json({ data, total, page: q.page, limit: q.limit });
});

/** Finds the customer for a scanned loyalty card (or their code / phone) at the till. */
router.get('/loyalty/lookup', requireModule('loyalty'), requirePermission('sales.create'), async (req, res) => {
  const { code } = parse(z.object({ code: z.string().trim().min(3).max(40) }), req.query);
  const up = code.toUpperCase();
  const digits = code.replace(/\D/g, '');
  const or: Record<string, unknown>[] = [{ loyaltyCardNo: up }, { code: up }];
  if (digits.length >= 9) or.push({ phone: new RegExp(`${digits.slice(-9)}$`) });
  const found = await Customer.find({ $or: or, kind: { $ne: 'walk_in' }, active: { $ne: false } }).limit(2).lean();
  if (found.length !== 1) throw new AppError(404, 'NOT_FOUND', found.length ? 'Several customers match: scan the card' : `No loyalty member with card or phone "${code}"`);
  const c = found[0];
  const t = await runAsPlatform(() => Tenant.findById(req.tenant!._id, { settings: 1 }).lean());
  const program = mergeLoyalty(t?.settings?.loyalty);
  res.json({ data: { ...c, tier: await customerTier(c._id, t?.settings?.crm?.tiers), pointValueCents: program.pointValueCents, minRedeemPoints: program.minRedeemPoints, maxRedeemBp: program.maxRedeemBp } });
});

/** Points a customer can use on a sale of this total (the till pre-fills the amount). */
router.get('/loyalty/redeemable', requireModule('loyalty'), requirePermission('sales.create'), async (req, res) => {
  const q = parse(z.object({ customerId: objectId, totalCents: z.coerce.number().int().min(0) }), req.query);
  const [c, t] = await Promise.all([Customer.findById(q.customerId, { loyaltyPoints: 1 }).lean(), runAsPlatform(() => Tenant.findById(req.tenant!._id, { settings: 1 }).lean())]);
  if (!c) throw notFound('Customer');
  const program = mergeLoyalty(t?.settings?.loyalty);
  const points = maxRedeemablePoints(program, q.totalCents, c.loyaltyPoints ?? 0);
  res.json({ data: { balance: c.loyaltyPoints ?? 0, points, amountCents: points * program.pointValueCents, pointValueCents: program.pointValueCents, minRedeemPoints: program.minRedeemPoints } });
});

/** Gives the customer a loyalty card (and the welcome bonus, once). */
router.post('/loyalty/members/:id/enroll', requireModule('loyalty'), requireAnyPermission('loyalty.manage', 'customers.manage'), async (req, res) => {
  const body = parse(z.object({ cardNo: z.string().trim().toUpperCase().regex(LOYALTY_CARD_RE, 'Card numbers are LC and 10 digits').optional() }), req.body ?? {});
  const c = await Customer.findOne({ _id: idParam(req.params.id), kind: { $ne: 'walk_in' } });
  if (!c) throw notFound('Customer');
  const cardNo = body.cardNo ?? c.loyaltyCardNo ?? (await newCardNo());
  if (await Customer.exists({ loyaltyCardNo: cardNo, _id: { $ne: c._id } })) throw new AppError(409, 'CARD_IN_USE', 'This card number belongs to another customer');
  const firstTime = !c.loyaltyJoinedAt;
  c.loyaltyCardNo = cardNo;
  if (firstTime) c.loyaltyJoinedAt = new Date();
  await c.save();
  const t = await runAsPlatform(() => Tenant.findById(req.tenant!._id, { settings: 1 }).lean());
  const program = mergeLoyalty(t?.settings?.loyalty);
  if (firstTime && program.welcomeBonus > 0) await changePoints({ customerId: c._id, points: program.welcomeBonus, kind: 'bonus', note: 'Welcome bonus', userId: req.auth!.userId });
  await audit(req, { action: 'loyalty.enrolled', entity: 'Customer', entityId: c._id, details: { cardNo } });
  res.json({ data: await Customer.findById(c._id, { name: 1, phone: 1, code: 1, loyaltyCardNo: 1, loyaltyPoints: 1, loyaltyJoinedAt: 1 }).lean() });
});

router.get('/loyalty/members/:id/history', requireModule('loyalty'), requirePermission('customers.read'), async (req, res) => {
  const q = parse(pagination, req.query);
  const filter = { customerId: idParam(req.params.id) };
  const [data, total] = await Promise.all([LoyaltyTransaction.find(filter).sort({ at: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), LoyaltyTransaction.countDocuments(filter)]);
  res.json({ data, total, page: q.page, limit: q.limit });
});

/** Manual correction or goodwill points, always with a reason. */
router.post('/loyalty/members/:id/adjust', requireModule('loyalty'), requirePermission('loyalty.manage'), async (req, res) => {
  const body = parse(z.object({ points: z.number().int().refine((v) => v !== 0, 'Enter points to add or remove').refine((v) => Math.abs(v) <= 1_000_000, 'Too many points'), note: z.string().trim().min(3).max(200) }), req.body);
  const c = await Customer.findById(idParam(req.params.id), { _id: 1 }).lean();
  if (!c) throw notFound('Customer');
  const balance = await changePoints({ customerId: c._id, points: body.points, kind: 'adjust', note: body.note, userId: req.auth!.userId });
  if (balance === null) throw badRequest('The customer does not have that many points to remove');
  await audit(req, { action: 'loyalty.adjusted', entity: 'Customer', entityId: c._id, details: body });
  res.json({ data: { balance } });
});

/** Printable loyalty card(s) with the card number as a barcode. */
router.get('/loyalty/cards', requireModule('loyalty'), requirePermission('customers.read'), async (req, res) => {
  const { ids } = parse(z.object({ ids: z.string().max(5000) }), req.query);
  const list = await Customer.find({ _id: { $in: ids.split(',').filter((x) => /^[a-f0-9]{24}$/.test(x)) }, loyaltyCardNo: { $type: 'string' } }).lean();
  const t = await runAsPlatform(() => Tenant.findById(req.tenant!._id, { name: 1, settings: 1 }).lean());
  const program = mergeLoyalty(t?.settings?.loyalty);
  const cards = list.map((c) => `<div class="card"><div class="top"><div class="biz">${esc(t?.name ?? '')}</div><div class="prog">${esc(program.name)}</div></div><div class="name">${esc(c.name)}</div><div class="bc">${code128Svg(c.loyaltyCardNo!, 36, 1.3)}</div><div class="no">${esc(c.loyaltyCardNo!)}</div></div>`).join('');
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Loyalty cards</title><style>
    @page{size:A4;margin:10mm}body{font-family:Georgia,serif;margin:0;display:flex;flex-wrap:wrap;gap:6mm}
    .card{width:85.6mm;height:54mm;box-sizing:border-box;border-radius:3.5mm;padding:5mm;background:#556b47;color:#fff;display:flex;flex-direction:column;-webkit-print-color-adjust:exact;print-color-adjust:exact;page-break-inside:avoid}
    .top{display:flex;justify-content:space-between;align-items:baseline}.biz{font-weight:900;font-size:13pt}.prog{font-size:9pt;letter-spacing:.15em;text-transform:uppercase;opacity:.85}
    .name{margin-top:auto;font-size:11pt;font-weight:700}.bc{background:#fff;border-radius:1.5mm;padding:1.5mm;margin-top:2mm;text-align:center}.bc svg{height:9mm;max-width:100%}.no{font-family:ui-monospace,monospace;font-size:9pt;margin-top:1mm;letter-spacing:.1em}
  </style></head><body>${cards || '<p>No cards</p>'}</body></html>`);
});

// ---------------- gift vouchers ----------------
const presentVoucher = (v: any) => ({ ...v, usable: !voucherProblem(v), problem: voucherProblem(v) });

router.get('/vouchers', requirePermission('vouchers.manage'), async (req, res) => {
  const q = parse(pagination.extend({ q: z.string().trim().max(60).optional(), status: z.enum(['active', 'used', 'cancelled']).optional() }), req.query);
  const filter: Record<string, unknown> = {};
  if (q.status) filter.status = q.status;
  if (q.q) filter.$or = [{ code: new RegExp(escapeRegex(q.q.toUpperCase())) }, { batch: new RegExp(escapeRegex(q.q), 'i') }, { note: new RegExp(escapeRegex(q.q), 'i') }];
  const [rows, total, sums] = await Promise.all([
    Voucher.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    Voucher.countDocuments(filter),
    Voucher.aggregate([{ $match: { status: 'active' } }, { $group: { _id: null, count: { $sum: 1 }, balance: { $sum: '$balanceCents' } } }]),
  ]);
  res.json({ data: rows.map(presentVoucher), total, page: q.page, limit: q.limit, outstanding: { count: sums[0]?.count ?? 0, balanceCents: sums[0]?.balance ?? 0 } });
});

/** Issues one or many vouchers. Sold for cash at a till with an open shift, the cash is added to that drawer. */
router.post('/vouchers', requirePermission('vouchers.manage'), async (req, res) => {
  const body = parse(z.object({
    amountCents: positiveCents.refine((v) => v >= 100, 'At least 1.00'),
    quantity: z.number().int().min(1).max(200).default(1),
    source: z.enum(['sold', 'promo', 'compensation']).default('sold'),
    expiresAt: z.coerce.date().optional(),
    customerId: objectId.optional(),
    note: z.string().trim().max(200).optional(),
    payment: z.object({ method: z.enum(['cash', 'mpesa', 'card', 'bank']), reference: z.string().trim().max(100).optional(), tillId: objectId.optional() }).optional(),
  }), req.body);
  if (body.expiresAt && body.expiresAt.getTime() < Date.now()) throw badRequest('The expiry date is in the past');
  if (body.source === 'sold' && !body.payment) throw badRequest('Say how the customer paid for the voucher');
  let shiftId: unknown;
  if (body.source === 'sold' && body.payment?.method === 'cash' && body.payment.tillId) {
    const shift = await Shift.findOne({ tillId: body.payment.tillId, status: 'open' }, { _id: 1 }).lean();
    if (!shift) throw new AppError(409, 'SHIFT_NOT_OPEN', 'Open a shift on this till to take cash for the voucher');
    shiftId = shift._id;
  }
  const batch = body.quantity > 1 ? `B${Date.now().toString(36).toUpperCase()}` : undefined;
  const docs = [];
  for (let i = 0; i < body.quantity; i++) {
    docs.push({
      code: await newVoucherCode(), initialCents: body.amountCents, balanceCents: body.amountCents, expiresAt: body.expiresAt, source: body.source,
      customerId: body.customerId, note: body.note, batch, issuedBy: req.auth!.userId, payment: body.payment ? { ...body.payment, shiftId } : undefined,
    });
  }
  const created = await Voucher.insertMany(docs);
  if (shiftId) {
    const till = await Till.findById(body.payment!.tillId, { _id: 1 }).lean();
    await CashMovement.create([{ shiftId, tillId: till!._id, type: 'cash_in', amountCents: body.amountCents * body.quantity, userId: req.auth!.userId, ref: { type: 'Voucher', id: created[0]!._id, number: created[0]!.code }, reason: `Gift voucher${body.quantity > 1 ? `s (${body.quantity})` : ` ${created[0]!.code}`} sold` }]);
  }
  await audit(req, { action: 'voucher.issued', entity: 'Voucher', entityId: created[0]!._id, details: { count: created.length, amountCents: body.amountCents, source: body.source, batch } });
  res.status(201).json({ data: created.map((v) => presentVoucher(v.toObject())) });
});

/** Balance check at the till before paying with a voucher. */
router.get('/vouchers/check', requirePermission('sales.create'), async (req, res) => {
  const { code } = parse(z.object({ code: z.string().trim().toUpperCase().max(20) }), req.query);
  const v = await Voucher.findOne({ code }).lean();
  if (!v) throw new AppError(404, 'NOT_FOUND', VOUCHER_CODE_RE.test(code) ? 'No voucher with this code' : 'Voucher codes look like GV-ABCD2345');
  res.json({ data: { code: v.code, balanceCents: v.balanceCents, initialCents: v.initialCents, expiresAt: v.expiresAt, status: v.status, usable: !voucherProblem(v as any), problem: voucherProblem(v as any) } });
});

router.post('/vouchers/:id/cancel', requirePermission('vouchers.manage'), async (req, res) => {
  const body = parse(z.object({ reason: z.string().trim().min(3).max(200) }), req.body);
  const v = await Voucher.findOneAndUpdate({ _id: idParam(req.params.id), status: { $ne: 'cancelled' } }, { $set: { status: 'cancelled', cancelledAt: new Date(), cancelledBy: req.auth!.userId, cancelReason: body.reason } }, { new: true }).lean();
  if (!v) throw notFound('Voucher');
  await audit(req, { action: 'voucher.cancelled', entity: 'Voucher', entityId: v._id, details: { code: v.code, balanceCents: v.balanceCents, reason: body.reason } });
  res.json({ data: presentVoucher(v) });
});

/** Printable vouchers (one per page on a receipt printer, or several on A4). */
router.get('/vouchers/print', requirePermission('vouchers.manage'), async (req, res) => {
  const q = parse(z.object({ ids: z.string().max(10000), paper: z.enum(['a4', 'receipt']).default('a4') }), req.query);
  const list = await Voucher.find({ _id: { $in: q.ids.split(',').filter((x) => /^[a-f0-9]{24}$/.test(x)) } }).lean();
  const t = await runAsPlatform(() => Tenant.findById(req.tenant!._id, { name: 1, settings: 1, contact: 1 }).lean());
  const cur = t?.settings?.currency ?? 'KES';
  const items = list.map((v) => `<div class="v"><div class="rib">VOUCHER</div><div class="biz">${esc(t?.name ?? '')}</div><div class="lead">pay with</div><div class="title">Voucher</div>
    <div class="amt">${esc(formatMoney(v.balanceCents, cur))}</div>${v.expiresAt ? `<div class="exp">Valid until ${esc(new Date(v.expiresAt).toLocaleDateString('en-KE', { dateStyle: 'medium' }))}</div>` : ''}
    <div class="bc">${code128Svg(v.code, 40, 1.4)}</div><div class="code">${esc(v.code)}</div><div class="fine">Use at the till. Not exchangeable for cash.${t?.contact?.phone ? ` ${esc(t.contact.phone)}` : ''}</div></div>`).join('');
  const receipt = q.paper === 'receipt';
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Vouchers</title><style>
    @page{size:${receipt ? '80mm auto' : 'A4'};margin:${receipt ? '3mm' : '10mm'}}body{margin:0;font-family:Georgia,serif;display:flex;flex-wrap:wrap;gap:6mm}
    .v{position:relative;overflow:hidden;width:${receipt ? '72mm' : '90mm'};box-sizing:border-box;padding:6mm;border-radius:3mm;background:#84603a;color:#fff;text-align:center;-webkit-print-color-adjust:exact;print-color-adjust:exact;page-break-inside:avoid;${receipt ? 'page-break-after:always;' : ''}}
    .rib{position:absolute;right:-14mm;top:5mm;transform:rotate(35deg);background:#f39a32;padding:1mm 14mm;font:700 7pt sans-serif;letter-spacing:.25em}
    .biz{font:700 9pt sans-serif;letter-spacing:.12em;text-transform:uppercase;opacity:.9}.lead{margin-top:3mm;font-size:13pt;font-weight:900}.title{font-size:26pt;font-weight:900;line-height:1}
    .amt{margin-top:3mm;font:800 20pt sans-serif}.exp{font:9pt sans-serif;opacity:.9}.bc{background:#fff;border-radius:1.5mm;padding:2mm;margin-top:4mm}.bc svg{height:12mm;max-width:100%}
    .code{font:700 11pt ui-monospace,monospace;letter-spacing:.15em;margin-top:1mm}.fine{font:7.5pt sans-serif;opacity:.85;margin-top:2mm}
  </style></head><body>${items || '<p>No vouchers</p>'}</body></html>`);
});

export const loyaltyRoutes = router;
