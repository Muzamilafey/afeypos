import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, createProduct, openShift, rid, type Ctx } from './helpers.js';
import { drainJobs } from '../src/jobs/queue.js';
import { ConsoleSmsProvider } from '../src/integrations/sms/index.js';
import { Sale } from '../src/models/index.js';
import { runAsPlatform } from '../src/lib/context.js';
import { segmentOf, tierOf } from '../src/modules/crm/routes.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
let till: string;
let product: any;
let regular: any;
let lapsed: any;
let quiet: any;
const DAY = 86400_000;

const buy = async (customerId: string, qty: number, daysAgo = 0) => {
  const s = await t.client.post('/sales', { clientRequestId: rid(), tillId: till, customerId, lines: [{ productId: product._id, qty }], payments: [{ method: 'cash', amountCents: qty * 50000 }] });
  if (daysAgo) await runAsPlatform(() => Sale.updateOne({ _id: s.body.data._id }, { $set: { completedAt: new Date(Date.now() - daysAgo * DAY) } }));
  return s.body.data;
};

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'crmco', 'supermarket');
  till = t.locations.tills[0]._id;
  await openShift(t.client, till);
  await t.client.post('/settings/integrations', { kind: 'sms', provider: 'console', name: 'Dev SMS' });
  product = await createProduct(t.client, { name: 'Rice 5kg', sku: 'RICE5', prices: { retail: 50000 }, costCents: 40000, openingStock: [{ warehouseId: t.locations.warehouses[0]._id, qty: 500 }] });
  const today = new Date(Date.now() + 3 * 3600_000).toISOString().slice(5, 10);
  regular = (await t.client.post('/customers', { name: 'Achieng Otieno', phone: '0711000001', tags: ['Estate A'], marketingOptIn: true, dateOfBirth: `1990-${today}` })).body.data;
  lapsed = (await t.client.post('/customers', { name: 'Baraka Mwangi', phone: '0711000002', marketingOptIn: true })).body.data;
  quiet = (await t.client.post('/customers', { name: 'Chebet Kip', phone: '0711000003', marketingOptIn: false })).body.data;
  expect(regular.tags).toEqual(['estate a']);
  expect(regular.marketingOptInAt).toBeTruthy();
  // Achieng: long-standing, 12 visits in the last fortnight-ish and big spend. Baraka: last bought 90 days ago.
  await buy(regular._id, 2, 200);
  for (let i = 0; i < 12; i++) await buy(regular._id, 4, i);
  await buy(lapsed._id, 1, 300);
  await buy(lapsed._id, 1, 90);
  await buy(quiet._id, 1, 5);
});
afterAll(teardown);

describe('segments and tiers', () => {
  it('classifies by recency and frequency, and tiers by 12-month spend', () => {
    const now = new Date();
    expect(segmentOf({}, now)).toBe('never');
    expect(segmentOf({ firstAt: new Date(now.getTime() - 5 * DAY), lastAt: now, visits: 1 }, now)).toBe('new');
    expect(segmentOf({ firstAt: new Date(now.getTime() - 300 * DAY), lastAt: new Date(now.getTime() - 3 * DAY), visits: 15 }, now)).toBe('champion');
    expect(segmentOf({ firstAt: new Date(now.getTime() - 300 * DAY), lastAt: new Date(now.getTime() - 100 * DAY), visits: 3 }, now)).toBe('at_risk');
    expect(segmentOf({ firstAt: new Date(now.getTime() - 300 * DAY), lastAt: new Date(now.getTime() - 200 * DAY), visits: 1 }, now)).toBe('lost');
    const tiers = [{ name: 'Bronze', minSpendCents: 0 }, { name: 'Gold', minSpendCents: 1_000_000 }];
    expect(tierOf(999_999, tiers)).toBe('Bronze');
    expect(tierOf(1_000_000, tiers)).toBe('Gold');
  });

  it('gives each customer insights: tier, segment, favourites and next tier', async () => {
    const r = (await t.client.get(`/crm/customers/${regular._id}/insights`)).body.data;
    expect(r).toMatchObject({ visits: 13, spendCents: (2 + 48) * 50000, tier: 'Silver', segment: 'champion' });
    expect(r.favourites[0]).toMatchObject({ name: 'Rice 5kg', times: 13 });
    expect(r.nextTier).toMatchObject({ name: 'Gold', needCents: 10_000_000 - 2_500_000 });
    const b = (await t.client.get(`/crm/customers/${lapsed._id}/insights`)).body.data;
    expect(b).toMatchObject({ segment: 'at_risk', tier: 'Bronze', daysSinceLast: 90 });
  });

  it('shows an overview with segments, top customers, people at risk and birthdays', async () => {
    const o = (await t.client.get('/crm/overview')).body.data;
    expect(o.customers).toBe(3);
    expect(o.optedIn).toBe(2);
    expect(o.top[0].name).toBe('Achieng Otieno');
    expect(o.atRisk.map((c: any) => c.name)).toEqual(['Baraka Mwangi']);
    expect(o.birthdays.map((c: any) => c.name)).toEqual(['Achieng Otieno']);
  });
});

describe('activities and follow-ups', () => {
  it('logs notes and follow-up tasks, and lists what is due', async () => {
    const note = await t.client.post('/crm/activities', { customerId: lapsed._id, type: 'call', subject: 'Asked why he stopped coming' });
    expect(note.body.data.done).toBe(true);
    const task = await t.client.post('/crm/activities', { customerId: lapsed._id, type: 'task', subject: 'Offer delivery to his estate', dueAt: new Date(Date.now() + 3600_000).toISOString() });
    expect(task.body.data.done).toBe(false);
    expect((await t.client.get('/crm/activities?open=true')).body.data.map((a: any) => a.subject)).toEqual(['Offer delivery to his estate']);
    expect((await t.client.get('/crm/overview')).body.data.followUps).toHaveLength(1);
    await t.client.patch(`/crm/activities/${task.body.data._id}`, { done: true });
    expect((await t.client.get('/crm/activities?open=true')).body.data).toHaveLength(0);
    const ins = (await t.client.get(`/crm/customers/${lapsed._id}/insights`)).body.data;
    expect(ins.activities).toHaveLength(2);
  });
});

describe('campaigns', () => {
  it('previews a segment and sends only to customers who opted in, once each', async () => {
    const all = (await t.client.post('/crm/segments/preview', { optedInOnly: false })).body.data;
    expect(all.count).toBe(3);
    const atRisk = (await t.client.post('/crm/segments/preview', { segments: ['at_risk'] })).body.data;
    expect(atRisk.sample.map((c: any) => c.name)).toEqual(['Baraka Mwangi']);
    const c = (await t.client.post('/crm/campaigns', { name: 'Weekend rice offer', channel: 'sms', message: 'Hi {{name}}, rice 5kg at KES 450 this weekend!', segment: {} })).body.data;
    ConsoleSmsProvider.outbox.length = 0;
    const sent = await t.client.post(`/crm/campaigns/${c._id}/send`, {});
    expect(sent.body.data).toMatchObject({ recipients: 2, queued: 2 });
    expect((await t.client.post(`/crm/campaigns/${c._id}/send`, {})).body.error.code).toBe('NOT_DRAFT');
    await drainJobs();
    expect(ConsoleSmsProvider.outbox.map((m) => m.to).sort()).toEqual(['254711000001', '254711000002']);
    expect(ConsoleSmsProvider.outbox.find((m) => m.to === '254711000001')!.message).toContain('Hi Achieng, rice 5kg');
    expect(ConsoleSmsProvider.outbox[0].message).toContain('STOP');
  });

  it('respects opt-outs and tag filters', async () => {
    await t.client.post(`/crm/customers/${lapsed._id}/opt-out`, {});
    const c = (await t.client.post('/crm/campaigns', { name: 'Estate A', channel: 'sms', message: 'New stock arrived in Estate A shop', segment: { tags: ['estate a'] } })).body.data;
    ConsoleSmsProvider.outbox.length = 0;
    expect((await t.client.post(`/crm/campaigns/${c._id}/send`, {})).body.data.recipients).toBe(1);
    const all = (await t.client.post('/crm/segments/preview', {})).body.data;
    expect(all.count).toBe(1);
  });

  it('sends birthday greetings once a year when switched on', async () => {
    await t.client.patch('/settings/business', { settings: { crm: { birthdayGreeting: { enabled: true, channel: 'sms', offer: 'Show this SMS for 10% off today.' } } } });
    const { enqueue } = await import('../src/jobs/queue.js');
    const { runInTenant } = await import('../src/lib/context.js');
    const day = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
    await drainJobs();
    ConsoleSmsProvider.outbox.length = 0;
    await runInTenant(t.tenant.id, () => enqueue('crm.birthdays', { day, tenantId: t.tenant.id }));
    await runInTenant(t.tenant.id, () => enqueue('crm.birthdays', { day, tenantId: t.tenant.id }));
    await drainJobs();
    expect(ConsoleSmsProvider.outbox).toHaveLength(1);
    expect(ConsoleSmsProvider.outbox[0].message).toContain('Happy birthday Achieng');
    expect(ConsoleSmsProvider.outbox[0].message).toContain('10% off');
  });
});
