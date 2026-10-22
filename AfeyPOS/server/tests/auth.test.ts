import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, Client, BASE, OWNER_PASSWORD, type Ctx } from './helpers.js';
import { drainJobs } from '../src/jobs/queue.js';
import { ConsoleEmailProvider } from '../src/integrations/email/index.js';
import { totp } from '../src/lib/crypto.js';

let ctx: Ctx;
beforeAll(async () => {
  ctx = await setupApp();
});
afterAll(teardown);

describe('registration & onboarding', () => {
  it('rejects reserved, invalid and duplicate subdomains', async () => {
    const base = { businessName: 'Shop X', businessType: 'retail', ownerName: 'Ann', email: 'a@x.test', password: 'Passw0rd!' };
    expect((await ctx.api.post('/api/v1/public/register').set('Host', BASE).send({ ...base, subdomain: 'admin' })).status).toBe(409);
    expect((await ctx.api.post('/api/v1/public/register').set('Host', BASE).send({ ...base, subdomain: '-x' })).status).toBe(409);
    expect((await ctx.api.post('/api/v1/public/register').set('Host', BASE).send({ ...base, subdomain: 'okshop', password: 'short' })).status).toBe(400);
    await registerTenant(ctx.api, 'dupe');
    const r = await ctx.api.post('/api/v1/public/register').set('Host', BASE).send({ ...base, subdomain: 'dupe' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('SUBDOMAIN_UNAVAILABLE');
    const check = await ctx.api.get('/api/v1/public/subdomain-check?slug=dupe').set('Host', BASE);
    expect(check.body.available).toBe(false);
  });

  it('provisions branch, warehouse, till, owner, categories and a trial', async () => {
    const { client, tenant, locations } = await registerTenant(ctx.api, 'hardwareco', 'hardware');
    expect(tenant.status).toBe('trial');
    expect(locations.branches).toHaveLength(1);
    expect(locations.warehouses).toHaveLength(1);
    expect(locations.tills).toHaveLength(1);
    const me = await client.get('/auth/me');
    expect(me.body.user.roles).toEqual(['tenant_owner']);
    expect(me.body.capabilities.modules).toEqual(expect.arrayContaining(['quotations', 'unitConversions', 'fractionalQuantities']));
    expect(me.body.navigation.map((n: any) => n.key)).toContain('quotations');
    const cats = await client.get('/categories');
    expect(cats.body.data.map((c: any) => c.name)).toContain('Cement');
  });
});

describe('login, sessions and refresh tokens', () => {
  it('rejects wrong passwords generically and locks after repeated failures', async () => {
    await registerTenant(ctx.api, 'lockme');
    const c = new Client(ctx.api, 'lockme');
    const bad = await c.post('/auth/login', { email: 'owner@lockme.test', password: 'wrong' });
    expect(bad.status).toBe(401);
    const unknown = await c.post('/auth/login', { email: 'nobody@lockme.test', password: 'wrong' });
    expect(unknown.body.error.message).toBe(bad.body.error.message);
    for (let i = 0; i < 4; i++) await c.post('/auth/login', { email: 'owner@lockme.test', password: 'wrong' });
    const locked = await c.post('/auth/login', { email: 'owner@lockme.test', password: OWNER_PASSWORD });
    expect(locked.status).toBe(423);
  });

  it('rotates refresh tokens and revokes the session on reuse', async () => {
    const { client } = await registerTenant(ctx.api, 'rotate');
    const login = await client.post('/auth/login', { email: 'owner@rotate.test', password: OWNER_PASSWORD });
    const cookie = (login.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('afey_rt='))!.split(';')[0];
    const r1 = await client.post('/auth/refresh', {}, { Cookie: cookie });
    expect(r1.status).toBe(200);
    const cookie2 = (r1.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('afey_rt='))!.split(';')[0];
    expect(cookie2).not.toBe(cookie);
    // Old token presented again within grace window: refused, session survives.
    expect((await client.post('/auth/refresh', {}, { Cookie: cookie })).status).toBe(401);
    const r2 = await client.post('/auth/refresh', {}, { Cookie: cookie2 });
    expect(r2.status).toBe(200);
    // Logout revokes the session; access token stops working.
    const token = r2.body.accessToken;
    const cookie3 = (r2.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('afey_rt='))!.split(';')[0];
    await client.post('/auth/logout', {}, { Cookie: cookie3 });
    expect((await client.as(token).get('/auth/me')).status).toBe(401);
  });

  it('supports TOTP two-factor authentication', async () => {
    const { client } = await registerTenant(ctx.api, 'twofa');
    const setup = await client.post('/auth/2fa/setup');
    expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect((await client.post('/auth/2fa/enable', { code: '000000' })).status).toBe(400);
    expect((await client.post('/auth/2fa/enable', { code: totp(setup.body.secret) })).status).toBe(200);
    const fresh = new Client(ctx.api, 'twofa');
    const step1 = await fresh.post('/auth/login', { email: 'owner@twofa.test', password: OWNER_PASSWORD });
    expect(step1.body.mfaRequired).toBe(true);
    expect(step1.body.accessToken).toBeUndefined();
    expect((await fresh.post('/auth/mfa', { mfaToken: step1.body.mfaToken, code: '123456' })).status).toBe(401);
    const step2 = await fresh.post('/auth/mfa', { mfaToken: step1.body.mfaToken, code: totp(setup.body.secret) });
    expect(step2.status).toBe(200);
    expect(step2.body.accessToken).toBeTruthy();
  });

  it('resets passwords through an emailed single-use token without revealing accounts', async () => {
    await registerTenant(ctx.api, 'resetco');
    const c = new Client(ctx.api, 'resetco');
    ConsoleEmailProvider.outbox.length = 0;
    expect((await c.post('/auth/password/forgot', { email: 'ghost@resetco.test' })).status).toBe(200);
    expect((await c.post('/auth/password/forgot', { email: 'owner@resetco.test' })).status).toBe(200);
    await drainJobs();
    const mail = ConsoleEmailProvider.outbox.find((m) => m.to === 'owner@resetco.test');
    expect(mail).toBeTruthy();
    expect(ConsoleEmailProvider.outbox.find((m) => m.to === 'ghost@resetco.test')).toBeUndefined();
    const token = /token=([\w-]+)/.exec(mail!.text)![1];
    expect((await c.post('/auth/password/reset', { token, password: 'NewPassw0rd' })).status).toBe(200);
    expect((await c.post('/auth/password/reset', { token, password: 'NewPassw0rd2' })).status).toBe(400);
    await c.login('owner@resetco.test', 'NewPassw0rd');
  });
});

describe('role-based access control', () => {
  it('enforces permissions server-side', async () => {
    const { client } = await registerTenant(ctx.api, 'rbac');
    const u = await client.post('/settings/users', { name: 'Cashier One', email: 'cash@rbac.test', password: 'Cashier123', roles: ['cashier'] });
    expect(u.status).toBe(201);
    expect(u.body.data.passwordHash).toBeUndefined();
    const cashier = new Client(ctx.api, 'rbac');
    await cashier.login('cash@rbac.test', 'Cashier123');
    expect((await cashier.get('/products')).status).toBe(200);
    expect((await cashier.post('/products', { name: 'x', sku: 'x' })).status).toBe(403);
    expect((await cashier.get('/settings/users')).status).toBe(403);
    expect((await cashier.get('/reports/profit')).status).toBe(403);
    expect((await cashier.post('/settings/users', { name: 'Evil', email: 'e@rbac.test', password: 'Evil12345', roles: ['tenant_owner'] })).status).toBe(403);
    const me = await cashier.get('/auth/me');
    expect(me.body.navigation.map((n: any) => n.key)).not.toContain('settings');
    // Disabling the user revokes access immediately.
    await client.patch(`/settings/users/${u.body.data._id}`, { status: 'disabled' });
    expect((await cashier.get('/products')).status).toBe(401);
  });

  it('managers cannot promote users to owner', async () => {
    const { client } = await registerTenant(ctx.api, 'promo');
    await client.post('/settings/users', { name: 'Admin', email: 'admin@promo.test', password: 'Admin1234', roles: ['business_admin'] });
    const admin = new Client(ctx.api, 'promo');
    await admin.login('admin@promo.test', 'Admin1234');
    const r = await admin.post('/settings/users', { name: 'Own', email: 'own@promo.test', password: 'Owner1234', roles: ['tenant_owner'] });
    expect(r.status).toBe(403);
  });
});
