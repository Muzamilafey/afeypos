import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { setupApp, teardown, registerTenant, createProduct, openShift, rid, type Ctx } from './helpers.js';
import { assertRestrictedHours } from '../src/modules/sales/checkout.js';
import { drainJobs, enqueue } from '../src/jobs/queue.js';
import { runInTenant, runAsPlatform } from '../src/lib/context.js';
import { ConsoleEmailProvider } from '../src/integrations/email/index.js';
import { ConsoleSmsProvider } from '../src/integrations/sms/index.js';
import { LedgerEntry, Tenant } from '../src/models/index.js';

let ctx: Ctx;
beforeAll(async () => {
  ctx = await setupApp({ UPLOAD_DIR: `/tmp/afeypos-test-uploads-${Date.now()}` });
});
afterAll(teardown);

describe('uploads', () => {
  it('stores type-checked files and requires a signed-in user to read them', async () => {
    const a = await registerTenant(ctx.api, 'filesa');
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]).toString('base64');
    const up = await a.client.post('/files', { base64: png });
    expect(up.status).toBe(201);
    expect((await a.client.get(`/files/${up.body.data.id}`)).status).toBe(200);
    expect((await ctx.api.get(`/api/v1/files/${up.body.data.id}`)).status).toBe(401);
    expect((await a.client.post('/files', { base64: Buffer.from('<script>alert(1)</script>').toString('base64') })).status).toBe(400);
    expect((await a.client.get('/files/..%2F..%2Fetc%2Fpasswd')).status).toBe(404);
  });
});

describe('liquor licensing hours', () => {
  it('blocks age-restricted sales outside licensed hours (including overnight windows)', () => {
    const at = (h: number) => new Date(Date.UTC(2026, 0, 1, h - 3, 0)); // EAT = UTC+3
    expect(() => assertRestrictedHours({ start: '17:00', end: '23:00' }, 'Africa/Nairobi', 'Beer', at(10))).toThrow(/between 17:00 and 23:00/);
    expect(() => assertRestrictedHours({ start: '17:00', end: '23:00' }, 'Africa/Nairobi', 'Beer', at(18))).not.toThrow();
    expect(() => assertRestrictedHours({ start: '20:00', end: '02:00' }, 'Africa/Nairobi', 'Beer', at(1 + 24))).not.toThrow();
    expect(() => assertRestrictedHours(undefined, 'Africa/Nairobi', 'Beer')).not.toThrow();
  });

  it('requires age confirmation for restricted products at checkout', async () => {
    const t = await registerTenant(ctx.api, 'liquorco', 'liquor');
    const p = await createProduct(t.client, { name: 'Lager 500ml', ageRestricted: true, prices: { retail: 25000 }, openingStock: [{ warehouseId: t.locations.warehouses[0]._id, qty: 10 }] });
    await openShift(t.client, t.locations.tills[0]._id);
    const body = { tillId: t.locations.tills[0]._id, lines: [{ productId: p._id, qty: 1 }], payments: [{ method: 'cash', amountCents: 25000 }] };
    expect((await t.client.post('/sales', { clientRequestId: rid(), ...body })).body.error.code).toBe('AGE_VERIFICATION_REQUIRED');
    const ok = await t.client.post('/sales', { clientRequestId: rid(), ...body, ageVerified: true });
    expect(ok.status).toBe(201);
    expect(ok.body.data.ageVerifiedBy).toBeTruthy();
    const inv = await t.client.get(`/sales/${ok.body.data._id}/invoice`);
    expect(inv.text).toContain('TAX INVOICE');
  });
});

describe('scheduled notifications', () => {
  it('emails the daily summary and sends weekly-deduplicated overdue credit reminders', async () => {
    const t = await registerTenant(ctx.api, 'schedco', 'wholesale');
    await t.client.patch('/settings/business', { settings: { dailyReportEmails: ['boss@schedco.test'], creditReminders: { enabled: true, overdueDays: 3 } } });
    await t.client.post('/settings/integrations', { kind: 'sms', provider: 'console', name: 'Dev SMS' });
    const p = await createProduct(t.client, { prices: { retail: 10000 }, openingStock: [{ warehouseId: t.locations.warehouses[0]._id, qty: 10 }] });
    await openShift(t.client, t.locations.tills[0]._id);
    const cust = (await t.client.post('/customers', { name: 'Slow Payer', phone: '0711000999', creditLimitCents: 100000 })).body.data;
    await t.client.post('/sales', { clientRequestId: rid(), tillId: t.locations.tills[0]._id, customerId: cust._id, lines: [{ productId: p._id, qty: 2 }], payments: [{ method: 'credit', amountCents: 20000 }] });
    const tenantId = new Types.ObjectId(t.tenant.id);
    await runInTenant(tenantId, () => LedgerEntry.updateMany({ kind: 'credit_sale' }, { $set: { dueDate: new Date(Date.now() - 10 * 86400_000) } }));

    ConsoleEmailProvider.outbox.length = 0;
    ConsoleSmsProvider.outbox.length = 0;
    const tenant = await runAsPlatform(() => Tenant.findById(tenantId).lean());
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: tenant!.settings!.timezone }).format(new Date());
    await runInTenant(tenantId, async () => {
      await enqueue('reports.dailySummary', { day });
      await enqueue('customers.creditReminders', { day });
      await enqueue('customers.creditReminders', { day });
    });
    await drainJobs();
    const mail = ConsoleEmailProvider.outbox.find((m) => m.to === 'boss@schedco.test');
    expect(mail?.text).toContain('Transactions: 1');
    expect(ConsoleSmsProvider.outbox.filter((m) => m.to === '254711000999')).toHaveLength(1);
  });
});

describe('business logo on the sign-in page', () => {
  it('serves the uploaded logo publicly, and nothing before one is set', async () => {
    const a = await registerTenant(ctx.api, 'logoa');
    expect((await ctx.api.get('/api/v1/public/logo')).status).toBe(404);
    expect((await ctx.api.get('/api/v1/public/config')).body.tenant.logoUrl).toBeNull();
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]).toString('base64');
    const up = await a.client.post('/files', { base64: png });
    expect((await a.client.patch('/settings/business', { settings: { logoFileId: up.body.data.id, tagline: 'Quality building materials' } })).status).toBe(200);
    expect((await a.client.patch('/settings/business', { settings: { logoFileId: '../../etc/passwd' } })).status).toBe(400);
    const cfg = await ctx.api.get('/api/v1/public/config');
    expect(cfg.body.tenant.logoUrl).toMatch(/^\/api\/v1\/public\/logo\?v=/);
    expect(cfg.body.tenant.tagline).toBe('Quality building materials');
    const logo = await ctx.api.get('/api/v1/public/logo');
    expect(logo.status).toBe(200);
    expect(logo.headers['content-type']).toContain('image/png');
  });
});
