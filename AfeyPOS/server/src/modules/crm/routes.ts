/**
 * CRM: customer insights (12-month spend tier, buying segment from recency and frequency, favourite
 * products), activities and follow-ups, segments and SMS/email campaigns to customers who opted in,
 * and the automatic birthday greeting.
 *
 * Segments (last purchase / number of visits in the last 12 months):
 *   new: first purchase within 30 days · champion: bought within 14 days and 12+ visits ·
 *   loyal: within 30 days and 4+ visits · active: within 60 days · at risk: 61-120 days · lost: over 120 days
 */
import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { Campaign, Customer, CustomerActivity, Sale, Tenant, User } from '../../models/index.js';
import { idParam, objectId, parse } from '../../http/validate.js';
import { requirePermission } from '../../http/auth.js';
import { badRequest, notFound, unprocessable } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { nextNumber } from '../../lib/numbering.js';
import { runAsPlatform, runInTenant } from '../../lib/context.js';
import { registerJob } from '../../jobs/queue.js';
import { notify } from '../notifications/service.js';

const router = Router();

const DAY = 86400_000;
export const SEGMENTS = ['new', 'champion', 'loyal', 'active', 'at_risk', 'lost', 'never'] as const;
type Segment = (typeof SEGMENTS)[number];

export function segmentOf(s: { lastAt?: Date | null; firstAt?: Date | null; visits?: number }, now = new Date()): Segment {
  if (!s.lastAt) return 'never';
  const since = (now.getTime() - new Date(s.lastAt).getTime()) / DAY;
  const first = s.firstAt ? (now.getTime() - new Date(s.firstAt).getTime()) / DAY : Infinity;
  if (first <= 30) return 'new';
  if (since <= 14 && (s.visits ?? 0) >= 12) return 'champion';
  if (since <= 30 && (s.visits ?? 0) >= 4) return 'loyal';
  if (since <= 60) return 'active';
  if (since <= 120) return 'at_risk';
  return 'lost';
}

export function tierOf(spendCents: number, tiers: { name?: string | null; minSpendCents?: number | null }[]) {
  const sorted = [...tiers].sort((a, b) => (b.minSpendCents ?? 0) - (a.minSpendCents ?? 0));
  return sorted.find((t) => spendCents >= (t.minSpendCents ?? 0))?.name ?? null;
}

async function crmSettings(tenantId: unknown) {
  const t = await runAsPlatform(() => Tenant.findById(tenantId, { name: 1, settings: 1 }).lean());
  return { name: t?.name ?? '', tiers: t?.settings?.crm?.tiers?.length ? t.settings.crm.tiers : [{ name: 'Bronze', minSpendCents: 0 }], birthday: t?.settings?.crm?.birthdayGreeting };
}

/** Purchase statistics per customer over the last 12 months (all-time first purchase). */
async function stats(customerIds?: Types.ObjectId[]) {
  const since = new Date(Date.now() - 365 * DAY);
  const match: Record<string, unknown> = { customerId: customerIds ? { $in: customerIds } : { $ne: null }, status: { $ne: 'voided' } };
  const rows = await Sale.aggregate([
    { $match: match },
    { $group: { _id: '$customerId', firstAt: { $min: '$completedAt' }, lastAt: { $max: '$completedAt' }, visits: { $sum: { $cond: [{ $gte: ['$completedAt', since] }, 1, 0] } }, spendCents: { $sum: { $cond: [{ $gte: ['$completedAt', since] }, { $subtract: ['$totalCents', { $ifNull: ['$refundedCents', 0] }] }, 0] } }, lifetimeCents: { $sum: { $subtract: ['$totalCents', { $ifNull: ['$refundedCents', 0] }] } } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r as { firstAt: Date; lastAt: Date; visits: number; spendCents: number; lifetimeCents: number }]));
}

const segmentSchema = z.object({
  tags: z.array(z.string().toLowerCase()).optional(),
  tiers: z.array(z.string()).optional(),
  segments: z.array(z.enum(SEGMENTS)).optional(),
  kind: z.string().optional(),
  minSpendCents: z.number().int().min(0).optional(),
  birthdayMonth: z.number().int().min(1).max(12).optional(),
  withBalance: z.boolean().optional(),
  /** Campaigns only reach customers who agreed to marketing; previews can show everyone. */
  optedInOnly: z.boolean().default(true),
});
type SegmentFilter = z.infer<typeof segmentSchema>;

/** Customers matching a segment, with their insight figures. */
async function resolveSegment(tenantId: unknown, f: SegmentFilter) {
  const filter: Record<string, unknown> = { active: { $ne: false }, kind: { $ne: 'walk_in' } };
  if (f.tags?.length) filter.tags = { $in: f.tags };
  if (f.kind) filter.kind = f.kind;
  if (f.withBalance) filter.balanceCents = { $gt: 0 };
  if (f.optedInOnly) filter.marketingOptIn = true;
  if (f.birthdayMonth) filter.$expr = { $eq: [{ $month: '$dateOfBirth' }, f.birthdayMonth] };
  const customers = await Customer.find(filter, { name: 1, phone: 1, email: 1, tags: 1, kind: 1, marketingOptIn: 1, dateOfBirth: 1, balanceCents: 1, loyaltyPoints: 1 }).limit(20_000).lean();
  const st = await stats(customers.map((c) => c._id));
  const { tiers } = await crmSettings(tenantId);
  return customers
    .map((c) => {
      const s = st.get(String(c._id));
      return { ...c, spendCents: s?.spendCents ?? 0, visits: s?.visits ?? 0, lastAt: s?.lastAt ?? null, tier: tierOf(s?.spendCents ?? 0, tiers), segment: segmentOf(s ?? {}) };
    })
    .filter((c) => (!f.tiers?.length || f.tiers.includes(c.tier ?? '')) && (!f.segments?.length || f.segments.includes(c.segment)) && (f.minSpendCents === undefined || c.spendCents >= f.minSpendCents));
}

router.get('/crm/overview', requirePermission('customers.read'), async (req, res) => {
  const all = await resolveSegment(req.tenant!._id, { optedInOnly: false });
  const by = (k: 'segment' | 'tier') => Object.entries(all.reduce<Record<string, number>>((a, c) => ({ ...a, [c[k] ?? 'none']: (a[c[k] ?? 'none'] ?? 0) + 1 }), {})).map(([name, count]) => ({ name, count }));
  const now = new Date(Date.now() + 3 * 3600_000);
  const md = (d: Date) => `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  const week = new Set(Array.from({ length: 7 }, (_, i) => md(new Date(now.getTime() + i * DAY))));
  const birthdays = all.filter((c) => c.dateOfBirth && week.has(md(new Date(new Date(c.dateOfBirth).getTime() + 3 * 3600_000)))).map((c) => ({ _id: c._id, name: c.name, phone: c.phone, dateOfBirth: c.dateOfBirth }));
  const followUps = await CustomerActivity.find({ done: false, dueAt: { $lte: new Date(Date.now() + DAY) } }).sort({ dueAt: 1 }).limit(50).lean();
  const names = new Map(all.map((c) => [String(c._id), c.name]));
  res.json({
    data: {
      customers: all.length,
      optedIn: all.filter((c) => c.marketingOptIn).length,
      segments: by('segment'),
      tiers: by('tier'),
      top: [...all].sort((a, b) => b.spendCents - a.spendCents).slice(0, 10).map((c) => ({ _id: c._id, name: c.name, spendCents: c.spendCents, visits: c.visits, tier: c.tier, segment: c.segment })),
      atRisk: all.filter((c) => c.segment === 'at_risk').sort((a, b) => b.spendCents - a.spendCents).slice(0, 20).map((c) => ({ _id: c._id, name: c.name, phone: c.phone, spendCents: c.spendCents, lastAt: c.lastAt })),
      birthdays,
      followUps: followUps.map((f) => ({ ...f, customerName: names.get(String(f.customerId)) })),
    },
  });
});

router.get('/crm/customers/:id/insights', requirePermission('customers.read'), async (req, res) => {
  const id = idParam(req.params.id);
  const c = await Customer.findById(id).lean();
  if (!c) throw notFound('Customer');
  const s = (await stats([id])).get(String(id));
  const { tiers } = await crmSettings(req.tenant!._id);
  const [favourites, monthly, activities] = await Promise.all([
    Sale.aggregate([{ $match: { customerId: id, status: { $ne: 'voided' } } }, { $unwind: '$lines' }, { $group: { _id: '$lines.productId', name: { $first: '$lines.name' }, qty: { $sum: '$lines.qty' }, spendCents: { $sum: '$lines.totalCents' }, times: { $sum: 1 } } }, { $sort: { times: -1, spendCents: -1 } }, { $limit: 8 }]),
    Sale.aggregate([{ $match: { customerId: id, status: { $ne: 'voided' }, completedAt: { $gte: new Date(Date.now() - 365 * DAY) } } }, { $group: { _id: { $dateToString: { date: '$completedAt', format: '%Y-%m', timezone: 'Africa/Nairobi' } }, visits: { $sum: 1 }, spendCents: { $sum: '$totalCents' } } }, { $sort: { _id: 1 } }]),
    CustomerActivity.find({ customerId: id }).sort({ createdAt: -1 }).limit(50).lean(),
  ]);
  const users = new Map((await User.find({ _id: { $in: activities.flatMap((a) => [a.createdBy, a.assignedTo]).filter(Boolean) } }, { name: 1 }).lean()).map((u) => [String(u._id), u.name]));
  const tier = tierOf(s?.spendCents ?? 0, tiers);
  const sorted = [...tiers].sort((a, b) => (a.minSpendCents ?? 0) - (b.minSpendCents ?? 0));
  const next = sorted.find((t) => (t.minSpendCents ?? 0) > (s?.spendCents ?? 0));
  res.json({
    data: {
      spendCents: s?.spendCents ?? 0, lifetimeCents: s?.lifetimeCents ?? 0, visits: s?.visits ?? 0, firstAt: s?.firstAt ?? null, lastAt: s?.lastAt ?? null,
      avgBasketCents: s?.visits ? Math.round(s.spendCents / s.visits) : 0, daysSinceLast: s?.lastAt ? Math.floor((Date.now() - new Date(s.lastAt).getTime()) / DAY) : null,
      tier, nextTier: next ? { name: next.name, needCents: (next.minSpendCents ?? 0) - (s?.spendCents ?? 0) } : null, segment: segmentOf(s ?? {}),
      favourites, monthly, activities: activities.map((a) => ({ ...a, createdByName: users.get(String(a.createdBy)), assignedToName: a.assignedTo ? users.get(String(a.assignedTo)) : undefined })),
    },
  });
});

router.post('/crm/segments/preview', requirePermission('crm.manage'), async (req, res) => {
  const f = parse(segmentSchema, req.body);
  const rows = await resolveSegment(req.tenant!._id, f);
  res.json({ data: { count: rows.length, withPhone: rows.filter((r) => r.phone).length, withEmail: rows.filter((r) => r.email).length, sample: rows.slice(0, 20).map((r) => ({ _id: r._id, name: r.name, phone: r.phone, tier: r.tier, segment: r.segment, spendCents: r.spendCents })) } });
});

// ---------- activities ----------
router.get('/crm/activities', requirePermission('customers.read'), async (req, res) => {
  const q = parse(z.object({ customerId: objectId.optional(), open: z.coerce.boolean().optional(), mine: z.coerce.boolean().optional() }), req.query);
  const filter: Record<string, unknown> = {};
  if (q.customerId) filter.customerId = q.customerId;
  if (q.open) filter.done = false;
  if (q.mine) filter.assignedTo = req.auth!.userId;
  const rows = await CustomerActivity.find(filter).sort(q.open ? { dueAt: 1 } : { createdAt: -1 }).limit(300).lean();
  const names = new Map((await Customer.find({ _id: { $in: rows.map((r) => r.customerId) } }, { name: 1 }).lean()).map((c) => [String(c._id), c.name]));
  res.json({ data: rows.map((r) => ({ ...r, customerName: names.get(String(r.customerId)) })) });
});

router.post('/crm/activities', requirePermission('crm.manage'), async (req, res) => {
  const body = parse(z.object({ customerId: objectId, type: z.enum(['note', 'call', 'visit', 'sms', 'email', 'whatsapp', 'complaint', 'task']), subject: z.string().trim().min(2).max(160), body: z.string().max(2000).optional(), dueAt: z.coerce.date().optional(), assignedTo: objectId.optional() }), req.body);
  if (!(await Customer.exists({ _id: body.customerId }))) throw notFound('Customer');
  const a = await CustomerActivity.create({ ...body, assignedTo: body.assignedTo ?? (body.dueAt ? req.auth!.userId : undefined), done: !body.dueAt, doneAt: body.dueAt ? undefined : new Date(), createdBy: req.auth!.userId });
  res.status(201).json({ data: a });
});

router.patch('/crm/activities/:id', requirePermission('crm.manage'), async (req, res) => {
  const body = parse(z.object({ done: z.boolean().optional(), dueAt: z.coerce.date().nullable().optional(), body: z.string().max(2000).optional(), assignedTo: objectId.nullable().optional() }), req.body);
  const a = await CustomerActivity.findById(idParam(req.params.id));
  if (!a) throw notFound('Activity');
  if (body.done !== undefined) {
    a.done = body.done;
    a.doneAt = body.done ? new Date() : undefined;
  }
  if (body.dueAt !== undefined) a.dueAt = body.dueAt ?? undefined;
  if (body.body !== undefined) a.body = body.body;
  if (body.assignedTo !== undefined) a.assignedTo = body.assignedTo ?? undefined;
  await a.save();
  res.json({ data: a });
});

/** Records a customer's request to stop marketing messages. */
router.post('/crm/customers/:id/opt-out', requirePermission('customers.read'), async (req, res) => {
  const c = await Customer.findOneAndUpdate({ _id: idParam(req.params.id) }, { $set: { marketingOptIn: false, marketingOptOutAt: new Date() } }, { new: true });
  if (!c) throw notFound('Customer');
  await audit(req, { action: 'crm.opted_out', entity: 'Customer', entityId: c._id });
  res.json({ data: c });
});

// ---------- campaigns ----------
router.get('/crm/campaigns', requirePermission('crm.manage'), async (_req, res) => {
  res.json({ data: await Campaign.find({}).sort({ createdAt: -1 }).limit(100).lean() });
});

const campaignBody = z.object({ name: z.string().trim().min(2).max(100), channel: z.enum(['sms', 'email']), subject: z.string().max(150).optional(), message: z.string().trim().min(5).max(480), segment: segmentSchema.omit({ optedInOnly: true }).default({}) });

router.post('/crm/campaigns', requirePermission('crm.manage'), async (req, res) => {
  const body = parse(campaignBody, req.body);
  if (body.channel === 'email' && !body.subject) throw badRequest('Give the email a subject');
  const c = await Campaign.create({ ...body, number: await nextNumber('campaign', 'CMP'), createdBy: req.auth!.userId });
  res.status(201).json({ data: c });
});

/** Personalises {{name}} and queues one message per opted-in customer (each customer at most once per campaign). */
router.post('/crm/campaigns/:id/send', requirePermission('crm.manage'), async (req, res) => {
  const c = await Campaign.findOneAndUpdate({ _id: idParam(req.params.id), status: 'draft' }, { $set: { status: 'sent', sentBy: req.auth!.userId, sentAt: new Date() } }, { new: true });
  if (!c) throw unprocessable('Only draft campaigns can be sent', 'NOT_DRAFT');
  if (!req.capabilities!.modules.includes(c.channel as 'sms')) {
    await Campaign.updateOne({ _id: c._id }, { $set: { status: 'draft' }, $unset: { sentAt: 1, sentBy: 1 } });
    throw unprocessable(`Turn on the ${c.channel.toUpperCase()} module and connect a provider first`, 'CHANNEL_DISABLED');
  }
  const { name: business } = await crmSettings(req.tenant!._id);
  const people = await resolveSegment(req.tenant!._id, { ...(c.segment as SegmentFilter), optedInOnly: true });
  let queued = 0;
  let skipped = 0;
  for (const p of people) {
    const to = c.channel === 'sms' ? p.phone : p.email;
    if (!to) {
      skipped += 1;
      continue;
    }
    const first = p.name.split(' ')[0];
    const r = await notify({ channel: c.channel as 'sms', to, templateKey: 'campaign', data: { business, customer: first, subject: c.subject ?? c.name, message: c.message.replace(/\{\{\s*name\s*\}\}/g, first) }, dedupeKey: `campaign:${c._id}:${p._id}`, ref: { type: 'Campaign', id: c._id } });
    if (r.queued) queued += 1;
    else skipped += 1;
  }
  await Campaign.updateOne({ _id: c._id }, { $set: { recipients: people.length, queued, skipped } });
  await audit(req, { action: 'crm.campaign_sent', entity: 'Campaign', entityId: c._id, details: { recipients: people.length, queued } });
  res.json({ data: { ...c.toObject(), recipients: people.length, queued, skipped } });
});

router.post('/crm/campaigns/:id/cancel', requirePermission('crm.manage'), async (req, res) => {
  const c = await Campaign.findOneAndUpdate({ _id: idParam(req.params.id), status: 'draft' }, { $set: { status: 'cancelled' } }, { new: true });
  if (!c) throw notFound('Draft campaign');
  res.json({ data: c });
});

/** Daily (09:00): birthday greetings to opted-in customers, once a year each. */
registerJob('crm.birthdays', async ({ day, tenantId }: { day: string; tenantId: string }) => {
  await runInTenant(tenantId, async () => {
    const { name, birthday } = await crmSettings(tenantId);
    if (!birthday?.enabled) return;
    const [, m, d] = day.split('-').map(Number);
    const people = await Customer.find({ marketingOptIn: true, active: { $ne: false }, $expr: { $and: [{ $eq: [{ $month: { date: '$dateOfBirth', timezone: 'Africa/Nairobi' } }, m] }, { $eq: [{ $dayOfMonth: { date: '$dateOfBirth', timezone: 'Africa/Nairobi' } }, d] }] } }, { name: 1, phone: 1, email: 1 }).lean();
    for (const p of people) {
      const to = birthday.channel === 'email' ? p.email : p.phone;
      if (to) await notify({ channel: (birthday.channel ?? 'sms') as 'sms', to, templateKey: 'birthday', data: { business: name, customer: p.name.split(' ')[0], offer: birthday.offer ?? '' }, dedupeKey: `birthday:${p._id}:${day.slice(0, 4)}` });
    }
  });
});

export const crmRoutes = router;
