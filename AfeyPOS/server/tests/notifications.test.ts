import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, createProduct, openShift, rid, type Ctx } from './helpers.js';
import { drainJobs } from '../src/jobs/queue.js';
import { ConsoleSmsProvider } from '../src/integrations/sms/index.js';
import { NotificationLog } from '../src/models/index.js';
import { runAsPlatform } from '../src/lib/context.js';
import { render } from '../src/modules/notifications/templates.js';
import { normalizePhone } from '../src/lib/phone.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'notify', 'retail');
  await openShift(t.client, t.locations.tills[0]._id);
});
afterAll(teardown);

describe('notifications', () => {
  it('normalises phone numbers and renders templates', () => {
    expect(normalizePhone('0712 345 678')).toBe('254712345678');
    expect(normalizePhone('+254712345678')).toBe('254712345678');
    expect(normalizePhone('712345678')).toBe('254712345678');
    expect(normalizePhone('abc')).toBeNull();
    expect(render('Hi {{name}}, {{missing}}!', { name: 'Ann' })).toBe('Hi Ann, !');
  });

  it('queues receipts without blocking checkout, sends through the provider and deduplicates', async () => {
    const p = await createProduct(t.client, { prices: { retail: 5000 }, openingStock: [{ warehouseId: t.locations.warehouses[0]._id, qty: 5 }] });
    const sale = (await t.client.post('/sales', { clientRequestId: rid(), tillId: t.locations.tills[0]._id, lines: [{ productId: p._id, qty: 1 }], payments: [{ method: 'cash', amountCents: 5000 }] })).body.data;
    // No SMS provider configured: the message is skipped, never an error for the cashier.
    const r0 = await t.client.post(`/sales/${sale._id}/send-receipt`, { sms: '0712000111' });
    expect(r0.status).toBe(202);
    await drainJobs();
    const skipped = await runAsPlatform(() => NotificationLog.findOne({ to: '254712000111' }).lean());
    expect(skipped!.status).toBe('skipped');

    await t.client.post('/settings/integrations', { kind: 'sms', provider: 'console', name: 'Dev SMS' });
    ConsoleSmsProvider.outbox.length = 0;
    const r1 = await t.client.post(`/sales/${sale._id}/send-receipt`, { sms: '0712000222' });
    expect(r1.body.data.sms.queued).toBe(true);
    const r2 = await t.client.post(`/sales/${sale._id}/send-receipt`, { sms: '0712000222' });
    expect(r2.body.data.sms.queued).toBe(false);
    expect(r2.body.data.sms.reason).toBe('duplicate');
    await drainJobs();
    expect(ConsoleSmsProvider.outbox).toHaveLength(1);
    expect(ConsoleSmsProvider.outbox[0].message).toContain(sale.number);
    const logs = await t.client.get('/settings/notifications/logs?channel=sms');
    expect(logs.body.data.find((l: any) => l.to === '254712000222').status).toBe('sent');
  });

  it('retries transient provider failures with backoff', async () => {
    const original = ConsoleSmsProvider.prototype.send;
    let calls = 0;
    ConsoleSmsProvider.prototype.send = async function (to: string, message: string) {
      calls++;
      if (calls === 1) throw new Error('network down');
      return original.call(this, to, message);
    };
    try {
      const cfgs = (await t.client.get('/settings/integrations')).body.data;
      const test = await t.client.post(`/settings/integrations/${cfgs[0].id}/test`, { to: '0712000333' });
      expect(test.body.data.ok).toBe(true);
      await drainJobs();
      const log = await runAsPlatform(() => NotificationLog.findOne({ to: '254712000333' }).lean());
      expect(log!.status).toBe('queued');
      expect(log!.error).toContain('network down');
      const { Job } = await import('../src/models/index.js');
      await runAsPlatform(() => Job.updateMany({ type: 'notification.send', status: 'queued' }, { $set: { runAt: new Date(0) } }));
      await drainJobs();
      const after = await runAsPlatform(() => NotificationLog.findOne({ to: '254712000333' }).lean());
      expect(after!.status).toBe('sent');
    } finally {
      ConsoleSmsProvider.prototype.send = original;
    }
  });
});
