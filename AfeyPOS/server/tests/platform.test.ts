import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, createProduct, Client, BASE, type Ctx } from './helpers.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
let ptoken: string;
const P = (path: string) => `/api/v1/platform${path}`;

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'clientco', 'supermarket');
  const r = await ctx.api.post(P('/auth/login')).set('Host', `admin.${BASE}`).send({ email: 'owner@afeypos.test', password: 'PlatformPass123' });
  expect(r.status).toBe(200);
  ptoken = r.body.accessToken;
});
afterAll(teardown);

const pget = (path: string, token = ptoken) => ctx.api.get(P(path)).set('Authorization', `Bearer ${token}`);
const ppost = (path: string, body: object = {}, token = ptoken) => ctx.api.post(P(path)).set('Authorization', `Bearer ${token}`).send(body);

describe('platform owner portal', () => {
  it('lists tenants with usage but no business records, and rejects tenant tokens', async () => {
    const list = await pget('/tenants');
    expect(list.body.data.map((x: any) => x.slug)).toContain('clientco');
    expect(list.body.data[0].callbackToken).toBeUndefined();
    const detail = await pget(`/tenants/${t.tenant.id}`);
    expect(detail.body.data.usage.users).toBe(1);
    expect((await pget('/tenants', t.client.token)).status).toBe(401);
    // Platform tokens cannot be used on tenant APIs.
    expect((await new Client(ctx.api, 'clientco').as(ptoken).get('/products')).status).toBe(403);
  });

  it('suspends and reactivates tenants', async () => {
    expect((await ctx.api.patch(P(`/tenants/${t.tenant.id}`)).set('Authorization', `Bearer ${ptoken}`).send({ status: 'suspended' })).status).toBe(400);
    await ctx.api.patch(P(`/tenants/${t.tenant.id}`)).set('Authorization', `Bearer ${ptoken}`).send({ status: 'suspended', reason: 'Unpaid invoice' });
    expect((await t.client.get('/products')).body.error.code).toBe('TENANT_SUSPENDED');
    await ctx.api.patch(P(`/tenants/${t.tenant.id}`)).set('Authorization', `Bearer ${ptoken}`).send({ status: 'active' });
    expect((await t.client.get('/products')).status).toBe(200);
  });

  it('manages plans and entitlements', async () => {
    const r = await ppost('/plans', { code: 'kiosk', name: 'Kiosk', priceMonthlyCents: 50000, limits: { branches: 1, users: 1, tills: 1, products: 300, smsPerMonth: 0 }, modules: ['pos', 'inventory', 'reports'] });
    expect(r.status).toBe(201);
    const plans = await ctx.api.get('/api/v1/public/plans').set('Host', BASE);
    expect(plans.body.data.map((p: any) => p.code)).toContain('kiosk');
  });

  it('runs an audited, tenant-approved, read-only, expiring support session', async () => {
    await ppost('/users', { email: 'support@afeypos.test', name: 'Support Sam', password: 'Support123', roles: ['platform_support'] });
    const sl = await ctx.api.post(P('/auth/login')).send({ email: 'support@afeypos.test', password: 'Support123' });
    const stoken = sl.body.accessToken;
    expect((await ppost(`/tenants`, {}, stoken)).status).toBe(403);
    const g = await ppost('/support/grants', { tenantId: t.tenant.id, reason: 'Customer reports missing receipts', durationMinutes: 30 }, stoken);
    expect(g.status).toBe(201);
    expect((await ppost(`/support/grants/${g.body.data._id}/session`, {}, stoken)).status).toBe(404);
    // Tenant owner approves.
    const approve = await t.client.post(`/settings/support-access/${g.body.data._id}/approve`);
    expect(approve.body.data.status).toBe('approved');
    const sess = await ppost(`/support/grants/${g.body.data._id}/session`, {}, stoken);
    expect(sess.body.data.readOnly).toBe(true);
    const support = new Client(ctx.api, 'clientco').as(sess.body.data.accessToken);
    await createProduct(t.client, { sku: 'SEEN' });
    expect((await support.get('/products')).status).toBe(200);
    expect((await support.post('/products', { name: 'x', sku: 'y' })).status).toBe(403);
    expect((await support.get('/settings/users')).status).toBe(403);
    // The support token is useless at other tenants.
    await registerTenant(ctx.api, 'elsewhere');
    expect((await new Client(ctx.api, 'elsewhere').as(sess.body.data.accessToken).get('/products')).status).toBe(401);
    const audit = await t.client.get('/audit?action=support');
    expect(audit.body.data.length).toBeGreaterThan(0);
    // Revocation ends access immediately.
    await t.client.post(`/settings/support-access/${g.body.data._id}/revoke`);
    expect((await support.get('/products')).status).toBe(401);
    const paudit = await pget('/audit?action=support');
    expect(paudit.body.data.map((a: any) => a.action)).toEqual(expect.arrayContaining(['support.requested', 'support.session_started']));
  });

  it('reports system health and failed jobs', async () => {
    const h = await pget('/health');
    expect(h.body.data.database.transactions).toBe(true);
    expect((await pget('/jobs')).status).toBe(200);
  });
});
