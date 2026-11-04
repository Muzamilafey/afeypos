/**
 * Communications: send an SMS or email to a group of customers, staff or suppliers, from ready-made templates
 * or your own wording. Uses the existing notify() service (templates, delivery, logging). Customers who opted
 * out of marketing are never messaged; everyone must have a phone (SMS) or an email (email).
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { Customer, NotificationLog, Supplier, Tenant, User } from '../../models/index.js';
import { parse } from '../../http/validate.js';
import { requirePermission } from '../../http/auth.js';
import { badRequest } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { runAsPlatform } from '../../lib/context.js';
import { notify } from '../notifications/service.js';

const router = Router();
const MANAGE = requirePermission('comms.send');

export type Audience = 'customers' | 'staff' | 'suppliers';

/** Ready-made messages. {{name}} and {{business}} are filled in for each recipient. */
export const COMM_TEMPLATES: { id: string; name: string; audiences: Audience[]; subject: string; sms: string; body: string }[] = [
  { id: 'promo', name: 'Promotion / offer', audiences: ['customers'], subject: 'A special offer from {{business}}', sms: 'Hi {{name}}, {{business}} has a special offer for you this week. Come visit us!', body: 'Hi {{name}},\n\n{{business}} has a special offer for you this week. Visit us to enjoy great prices.\n\nThank you for shopping with us.' },
  { id: 'new-stock', name: 'New stock arrival', audiences: ['customers'], subject: 'New arrivals at {{business}}', sms: 'Hi {{name}}, fresh stock has just arrived at {{business}}. Come and have a look!', body: 'Hi {{name}},\n\nFresh stock has just arrived at {{business}}. Come in and have a look.\n\nSee you soon.' },
  { id: 'holiday', name: 'Holiday greeting', audiences: ['customers', 'staff', 'suppliers'], subject: 'Season\'s greetings from {{business}}', sms: 'Dear {{name}}, {{business}} wishes you a happy holiday season. Thank you for your support!', body: 'Dear {{name}},\n\n{{business}} wishes you and your family a happy holiday season.\n\nThank you for your continued support.' },
  { id: 'reminder', name: 'Payment reminder', audiences: ['customers'], subject: 'Payment reminder from {{business}}', sms: 'Dear {{name}}, this is a friendly reminder from {{business}} about your outstanding balance. Thank you.', body: 'Dear {{name}},\n\nThis is a friendly reminder from {{business}} about your outstanding account balance. Kindly clear it at your earliest convenience.\n\nThank you.' },
  { id: 'thanks', name: 'Thank you', audiences: ['customers'], subject: 'Thank you from {{business}}', sms: 'Thank you {{name}} for choosing {{business}}. We value your business!', body: 'Dear {{name}},\n\nThank you for choosing {{business}}. We truly value your business and look forward to serving you again.' },
  { id: 'staff-notice', name: 'Staff notice', audiences: ['staff'], subject: 'Notice from {{business}}', sms: 'Hi {{name}}, a notice from {{business}} management: ', body: 'Hi {{name}},\n\nThis is a notice from {{business}} management:\n\n' },
  { id: 'staff-meeting', name: 'Staff meeting', audiences: ['staff'], subject: 'Staff meeting - {{business}}', sms: 'Hi {{name}}, there is a staff meeting at {{business}}. Date/time: ', body: 'Hi {{name}},\n\nPlease note there is a staff meeting at {{business}}.\n\nDate and time: \nVenue: \n\nKindly attend.' },
  { id: 'supplier-order', name: 'Supplier - place an order', audiences: ['suppliers'], subject: 'Order enquiry from {{business}}', sms: 'Hello {{name}}, {{business}} would like to place an order. Please get in touch.', body: 'Hello {{name}},\n\n{{business}} would like to place an order. Please get in touch so we can share the details.\n\nRegards,\n{{business}}' },
  { id: 'supplier-notice', name: 'Supplier notice', audiences: ['suppliers'], subject: 'Notice from {{business}}', sms: 'Hello {{name}}, a notice from {{business}}: ', body: 'Hello {{name}},\n\nThis is a notice from {{business}}:\n\n\nRegards,\n{{business}}' },
  { id: 'blank', name: 'Blank (write your own)', audiences: ['customers', 'staff', 'suppliers'], subject: 'A message from {{business}}', sms: '', body: '' },
];

const filterSchema = z.object({
  audience: z.enum(['customers', 'staff', 'suppliers']),
  /** Customers only: limit to those with a balance owing, or with any of these tags. */
  withBalance: z.boolean().optional(),
  tags: z.array(z.string().trim().max(40)).max(20).optional(),
  roles: z.array(z.string().trim().max(40)).max(20).optional(),
});

/** The people in an audience who can actually be reached on this channel. */
async function recipients(req: Request, f: z.infer<typeof filterSchema>, channel: 'sms' | 'email') {
  const field = channel === 'sms' ? 'phone' : 'email';
  const has = { [field]: { $exists: true, $nin: [null, ''] } } as Record<string, unknown>;
  if (f.audience === 'customers') {
    const q: Record<string, unknown> = { active: { $ne: false }, marketingOptIn: true, ...has };
    if (f.withBalance) q.balanceCents = { $gt: 0 };
    if (f.tags?.length) q.tags = { $in: f.tags };
    const rows = await Customer.find(q, { name: 1, phone: 1, email: 1 }).limit(5000).lean();
    return rows.map((c) => ({ id: c._id, name: c.name, to: (c as any)[field] as string }));
  }
  if (f.audience === 'suppliers') {
    const rows = await Supplier.find({ active: { $ne: false }, ...has }, { name: 1, phone: 1, email: 1 }).limit(5000).lean();
    return rows.map((s) => ({ id: s._id, name: s.name, to: (s as any)[field] as string }));
  }
  const q: Record<string, unknown> = { active: { $ne: false }, ...has };
  if (f.roles?.length) q.roles = { $in: f.roles };
  const rows = await runAsPlatform(() => User.find({ tenantId: req.tenant!._id, ...q }, { name: 1, phone: 1, email: 1 }).limit(5000).lean());
  return rows.map((u) => ({ id: u._id, name: u.name, to: (u as any)[field] as string }));
}

router.get('/communications/templates', MANAGE, (_req, res) => {
  res.json({ data: COMM_TEMPLATES });
});

/** How many people a message would reach, with a few example names. */
router.post('/communications/recipients', MANAGE, async (req, res) => {
  const body = parse(filterSchema.extend({ channel: z.enum(['sms', 'email']) }), req.body);
  const people = await recipients(req, body, body.channel);
  res.json({ data: { count: people.length, sample: people.slice(0, 5).map((p) => p.name) } });
});

const sendSchema = filterSchema.extend({
  channel: z.enum(['sms', 'email']),
  subject: z.string().trim().max(200).optional(),
  message: z.string().trim().min(1).max(2000),
  /** Send only to this phone/email, to try the message first. */
  testTo: z.string().trim().max(120).optional(),
});

router.post('/communications/send', MANAGE, async (req, res) => {
  const body = parse(sendSchema, req.body);
  if (body.channel === 'email' && !body.subject) throw badRequest('Enter a subject for the email');
  const tenant: any = await runAsPlatform(() => Tenant.findById(req.tenant!._id, { name: 1 }).lean());
  const business = tenant?.name ?? '';
  const fill = (text: string, name: string) => text.replace(/\{\{\s*name\s*\}\}/gi, name || 'customer').replace(/\{\{\s*business\s*\}\}/gi, business);
  const batchId = `comm:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

  // A test goes to one address only, with a sample name.
  const list = body.testTo
    ? [{ id: null, name: req.auth!.name, to: body.testTo }]
    : await recipients(req, body, body.channel);
  if (!list.length) throw badRequest(`No ${body.audience} can be reached by ${body.channel} with these filters (they need a ${body.channel === 'sms' ? 'phone number' : 'email address'}${body.audience === 'customers' ? ', and must have agreed to messages' : ''}).`);

  let queued = 0;
  let skipped = 0;
  for (const p of list) {
    const r = await notify({
      channel: body.channel, to: p.to, templateKey: 'comm.message',
      data: { subject: fill(body.subject ?? `A message from ${business}`, p.name), message: fill(body.message, p.name), business },
      dedupeKey: body.testTo ? undefined : `${batchId}:${p.id}`,
      ref: p.id ? { type: body.audience, id: p.id as any } : undefined,
    });
    if (r.queued) queued++; else skipped++;
  }
  await audit(req, { action: 'communications.sent', details: { audience: body.audience, channel: body.channel, queued, skipped, test: Boolean(body.testTo) } });
  res.json({ data: { queued, skipped, total: list.length } });
});

/** Recent messages sent from here. */
router.get('/communications/log', MANAGE, async (req, res) => {
  const rows = await NotificationLog.find({ tenantId: req.tenant!._id, templateKey: 'comm.message' }).sort({ createdAt: -1 }).limit(200).lean();
  res.json({ data: rows.map((r: any) => ({ id: r._id, channel: r.channel, to: r.to, subject: r.subject, body: r.body, status: r.status, error: r.error, at: r.createdAt })) });
});

export const communicationsRoutes = router;
