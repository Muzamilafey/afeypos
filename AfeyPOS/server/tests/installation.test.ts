import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, type Ctx } from './helpers.js';
import { loadEnv } from '../src/config/env.js';
import { Tenant } from '../src/models/index.js';
import { runAsPlatform } from '../src/lib/context.js';

let ctx: Ctx;
beforeAll(async () => {
  // Older .env files say "local": it still means a standalone single-business installation.
  ctx = await setupApp({ DEPLOYMENT_MODE: 'local' });
});
afterAll(teardown);

describe('single-business installation', () => {
  it('offers only minimart and supermarket', async () => {
    const r = await ctx.api.get('/api/v1/public/business-types');
    expect(r.body.data.map((t: any) => t.type)).toEqual(['minimart', 'supermarket']);
  });

  it('runs first-time setup once and serves the same business on any address', async () => {
    const cfg = await ctx.api.get('/api/v1/public/config').set('Host', '192.168.1.10:4000');
    expect(cfg.body.setupRequired).toBe(true);
    expect(cfg.body.deploymentMode).toBe('standalone');
    const body = { businessName: 'Duka Langu', businessType: 'minimart', ownerName: 'Ali', email: 'ali@duka.test', password: 'Duka12345', taxPin: 'P051234567X' };
    const r = await ctx.api.post('/api/v1/public/register').set('Host', '192.168.1.10:4000').send(body);
    expect(r.status).toBe(201);
    expect(r.body.tenant.status).toBe('active');
    const again = await ctx.api.post('/api/v1/public/register').send({ ...body, email: 'x@duka.test' });
    expect(again.body.error.code).toBe('ALREADY_SETUP');
    // Any till on the LAN, or the public hostname, reaches the same business.
    const login = await ctx.api.post('/api/v1/auth/login').set('Host', '192.168.1.10:4000').send({ email: 'ali@duka.test', password: 'Duka12345' });
    expect(login.status).toBe(200);
    const me = await ctx.api.get('/api/v1/auth/me').set('Host', 'pos.duka.co.ke').set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(me.body.tenant.name).toBe('Duka Langu');
    expect(me.body.tenant.settings.taxPin).toBe('P051234567X');
    // No plans or limits: every module can be enabled.
    const mods = await ctx.api.put('/api/v1/settings/modules').set('Authorization', `Bearer ${login.body.accessToken}`).send({ enabled: ['biometrics', 'ageVerification'] });
    expect(mods.body.data.modules).toEqual(expect.arrayContaining(['multiBranch', 'biometrics', 'ageVerification']));
  });

  it('keeps working for installs set up with a retired business type', async () => {
    await runAsPlatform(() => Tenant.updateOne({}, { $set: { businessType: 'hardware' } }));
    const login = await ctx.api.post('/api/v1/auth/login').send({ email: 'ali@duka.test', password: 'Duka12345' });
    const me = await ctx.api.get('/api/v1/auth/me').set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.capabilities.businessType).toBe('supermarket');
  });

  it('rejects the removed multi-tenant mode and branch servers without an HQ address', () => {
    const base = { JWT_ACCESS_SECRET: 'x'.repeat(40), ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') };
    expect(() => loadEnv({ ...base, DEPLOYMENT_MODE: 'cloud' })).toThrow(/standalone, hq or branch/);
    expect(() => loadEnv({ ...base, DEPLOYMENT_MODE: 'branch', SYNC_ENABLED: 'true' })).toThrow(/SYNC_HQ_URL/);
    expect(loadEnv({ ...base, DEPLOYMENT_MODE: 'hq' }).DEPLOYMENT_MODE).toBe('hq');
    loadEnv({ ...process.env });
  });
});
