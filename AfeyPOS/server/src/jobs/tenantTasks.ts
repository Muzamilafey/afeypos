import { formatMoney } from '@afeypos/shared';
import { Customer, LedgerEntry, Sale, Tenant } from '../models/index.js';
import { enqueue, registerJob } from './queue.js';
import { runAsPlatform, runInTenant } from '../lib/context.js';
import { notify } from '../modules/notifications/service.js';
import { localDateString, localMidnightUtc } from '../modules/reports/routes.js';

function localHour(tz: string, at = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(at)) % 24;
}

/** Hourly fan-out: queues per-tenant daily tasks when it is the right local hour for that tenant. */
registerJob('tenants.dailyTasks', async () => {
  const tenants = await runAsPlatform(() => Tenant.find({ status: { $in: ['trial', 'active', 'past_due'] } }, { settings: 1 }).lean());
  for (const t of tenants) {
    const tz = t.settings?.timezone ?? 'Africa/Nairobi';
    const day = localDateString(new Date(), tz);
    const hour = localHour(tz);
    await runInTenant(t._id, async () => {
      if (hour === 21 && t.settings?.dailyReportEmails?.length) await enqueue('reports.dailySummary', { day }, { dedupeKey: `daily-report:${t._id}:${day}` });
      if (hour === 9 && t.settings?.creditReminders?.enabled) await enqueue('customers.creditReminders', { day }, { dedupeKey: `credit-reminders:${t._id}:${day}` });
    });
  }
});

registerJob('reports.dailySummary', async ({ day }: { day: string }, job) => {
  const tenant = await runAsPlatform(() => Tenant.findById(job.tenantId).lean());
  if (!tenant) return;
  const tz = tenant.settings?.timezone ?? 'Africa/Nairobi';
  const cur = tenant.settings?.currency ?? 'KES';
  const start = localMidnightUtc(day, tz);
  const end = new Date(start.getTime() + 86400_000);
  const match = { completedAt: { $gte: start, $lt: end }, status: { $ne: 'voided' } };
  const [s] = await Sale.aggregate([{ $match: match }, { $group: { _id: null, n: { $sum: 1 }, gross: { $sum: '$totalCents' }, net: { $sum: '$netCents' }, cost: { $sum: '$costCents' }, credit: { $sum: '$creditCents' } } }]);
  const pay = await Sale.aggregate([{ $match: match }, { $unwind: '$payments' }, { $group: { _id: '$payments.method', t: { $sum: '$payments.amountCents' } } }]);
  const top = await Sale.aggregate([{ $match: match }, { $unwind: '$lines' }, { $group: { _id: '$lines.name', t: { $sum: '$lines.totalCents' } } }, { $sort: { t: -1 } }, { $limit: 5 }]);
  const m = (c: number) => formatMoney(c ?? 0, cur);
  const reportText = [
    `Sales summary for ${tenant.name} on ${day}`,
    '',
    `Transactions: ${s?.n ?? 0}`,
    `Sales (incl. tax): ${m(s?.gross)}`,
    `Gross profit (before returns): ${m((s?.net ?? 0) - (s?.cost ?? 0))}`,
    `Sold on credit: ${m(s?.credit)}`,
    '',
    'Payments:',
    ...pay.map((p) => `  ${p._id}: ${m(p.t)}`),
    '',
    'Top products:',
    ...top.map((p) => `  ${p._id}: ${m(p.t)}`),
  ].join('\n');
  for (const to of tenant.settings?.dailyReportEmails ?? []) {
    await notify({ channel: 'email', to, templateKey: 'scheduled_report', data: { business: tenant.name, reportName: 'Daily sales summary', period: day, reportText }, dedupeKey: `daily-report:${day}:${to}` });
  }
});

registerJob('customers.creditReminders', async (_payload, job) => {
  const tenant = await runAsPlatform(() => Tenant.findById(job.tenantId).lean());
  if (!tenant) return;
  const days = tenant.settings?.creditReminders?.overdueDays ?? 7;
  const cutoff = new Date(Date.now() - days * 86400_000);
  const overdue = await LedgerEntry.aggregate([
    { $match: { partyType: 'customer', openCents: { $gt: 0 }, dueDate: { $lt: cutoff } } },
    { $group: { _id: '$partyId', overdue: { $sum: '$openCents' } } },
  ]);
  const week = `${new Date().getUTCFullYear()}-W${Math.ceil(((Date.now() - Date.UTC(new Date().getUTCFullYear(), 0, 1)) / 86400_000 + 1) / 7)}`;
  for (const o of overdue) {
    const c = await Customer.findById(o._id).lean();
    if (!c?.phone || !c.active) continue;
    await notify({ channel: 'sms', to: c.phone, templateKey: 'credit_reminder', data: { business: tenant.name, customer: c.name, balance: formatMoney(c.balanceCents, tenant.settings?.currency ?? 'KES') }, dedupeKey: `credit-reminder:${c._id}:${week}`, ref: { type: 'Customer', id: c._id } });
  }
});
