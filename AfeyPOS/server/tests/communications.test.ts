import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, Client, type Ctx } from './helpers.js';
import { drainJobs } from '../src/jobs/queue.js';
import { NotificationLog } from '../src/models/index.js';
import { runAsPlatform } from '../src/lib/context.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'comms', 'supermarket');
  await t.client.post('/settings/integrations', { kind: 'sms', provider: 'console', name: 'Dev SMS' });
  // Two customers who agreed, one who did not; one with no phone.
  await t.client.post('/customers', { name: 'Achieng', phone: '0711000001', marketingOptIn: true, tags: ['hotel'], creditLimitCents: 100000 });
  await t.client.post('/customers', { name: 'Baraka', phone: '0711000002', marketingOptIn: true });
  await t.client.post('/customers', { name: 'Chebet', phone: '0711000003', marketingOptIn: false });
  await t.client.post('/customers', { name: 'NoPhone', marketingOptIn: true });
  // A supplier with a phone.
  await t.client.post('/suppliers', { name: 'Bidco', phone: '0720000001' });
});
afterAll(teardown);

describe('communications', () => {
  it('counts who can be reached, respecting opt-in and the channel', async () => {
    expect((await t.client.post('/communications/recipients', { audience: 'customers', channel: 'sms' })).body.data.count).toBe(2);
    expect((await t.client.post('/communications/recipients', { audience: 'customers', channel: 'email' })).body.data.count).toBe(0);
    expect((await t.client.post('/communications/recipients', { audience: 'customers', channel: 'sms', tags: ['hotel'] })).body.data.count).toBe(1);
    expect((await t.client.post('/communications/recipients', { audience: 'suppliers', channel: 'sms' })).body.data.count).toBe(1);
    expect((await t.client.post('/communications/recipients', { audience: 'staff', channel: 'sms' })).body.data.count).toBe(1); // the owner has a phone
  });

  it('sends to a group, filling in the name and business, and logs each one', async () => {
    const r = await t.client.post('/communications/send', { audience: 'customers', channel: 'sms', message: 'Hi {{name}}, a note from {{business}}.' });
    expect(r.body.data).toMatchObject({ queued: 2, total: 2 });
    await drainJobs();
    const logs = await runAsPlatform(() => NotificationLog.find({ templateKey: 'comm.message' }).sort({ to: 1 }).lean());
    expect(logs).toHaveLength(2);
    expect(logs[0]!.body).toBe('Hi Achieng, a note from comms shop.');
    expect(logs.every((l) => l.channel === 'sms')).toBe(true);
    const hist = (await t.client.get('/communications/log')).body.data;
    expect(hist.length).toBe(2);
  });

  it('a test goes to one address only; email needs a subject; cashiers may not send', async () => {
    const test = await t.client.post('/communications/send', { audience: 'customers', channel: 'sms', message: 'Test {{business}}', testTo: '0712999888' });
    expect(test.body.data).toMatchObject({ queued: 1, total: 1 });
    expect((await t.client.post('/communications/send', { audience: 'customers', channel: 'email', message: 'Hi' })).status).toBe(400);
    expect((await t.client.post('/communications/send', { audience: 'suppliers', channel: 'email', message: 'x', subject: 'Hi' })).status).toBe(400); // supplier has no email
    await t.client.post('/settings/users', { name: 'Cash', email: 'cash@comms.test', password: 'Passw0rd!x', roles: ['cashier'] });
    const cashier = new Client(ctx.api, 'comms');
    await cashier.login('cash@comms.test', 'Passw0rd!x');
    expect((await cashier.post('/communications/send', { audience: 'customers', channel: 'sms', message: 'x' })).status).toBe(403);
    expect((await cashier.get('/communications/templates')).status).toBe(403);
  });
});
