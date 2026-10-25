import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, type Ctx } from './helpers.js';

let ctx: Ctx;
beforeAll(async () => {
  ctx = await setupApp();
});
afterAll(teardown);

describe('smoke', () => {
  it('health reports a replica set', async () => {
    const r = await ctx.api.get('/health');
    expect(r.status).toBe(200);
    expect(r.body.database.transactions).toBe(true);
  });
  it('does not force HTTPS on plain-HTTP installations (LAN tills)', async () => {
    const r = await ctx.api.get('/health');
    expect(r.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
    expect(r.headers['strict-transport-security']).toBeUndefined();
  });
  it('sets up the business and loads /me', async () => {
    const { client } = await registerTenant(ctx.api, 'smoke');
    const me = await client.get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.tenant.slug).toBe('smoke-shop');
    expect(me.body.deploymentMode).toBe('standalone');
  });
});
