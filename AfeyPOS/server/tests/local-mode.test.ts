import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, type Ctx } from './helpers.js';

let ctx: Ctx;
beforeAll(async () => {
  ctx = await setupApp({ DEPLOYMENT_MODE: 'local' });
});
afterAll(teardown);

describe('local single-tenant installation', () => {
  it('runs first-time setup once and resolves the tenant without subdomains', async () => {
    const cfg = await ctx.api.get('/api/v1/public/config').set('Host', '192.168.1.10:4000');
    expect(cfg.body.setupRequired).toBe(true);
    const body = { businessName: 'Duka Langu', businessType: 'hardware', ownerName: 'Ali', email: 'ali@duka.test', password: 'Duka12345' };
    const r = await ctx.api.post('/api/v1/public/register').set('Host', '192.168.1.10:4000').send(body);
    expect(r.status).toBe(201);
    expect(r.body.tenant.status).toBe('active');
    const again = await ctx.api.post('/api/v1/public/register').send({ ...body, email: 'x@duka.test' });
    expect(again.body.error.code).toBe('ALREADY_SETUP');
    // Any till on the LAN reaches the same business by IP address.
    const login = await ctx.api.post('/api/v1/auth/login').set('Host', '192.168.1.10:4000').send({ email: 'ali@duka.test', password: 'Duka12345' });
    expect(login.status).toBe(200);
    const me = await ctx.api.get('/api/v1/auth/me').set('Host', 'localhost:4000').set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(me.body.deploymentMode).toBe('local');
    // Local installations have no plan restrictions.
    const mods = await ctx.api.put('/api/v1/settings/modules').set('Authorization', `Bearer ${login.body.accessToken}`).send({ enabled: ['multiBranch', 'multiTill', 'biometrics'] });
    expect(mods.body.data.modules).toEqual(expect.arrayContaining(['multiBranch', 'multiTill', 'biometrics']));
  });
});
