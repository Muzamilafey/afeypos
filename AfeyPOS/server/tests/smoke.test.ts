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
  it('registers a tenant and loads /me', async () => {
    const { client } = await registerTenant(ctx.api, 'smoke');
    const me = await client.get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.tenant.slug).toBe('smoke');
  });
});
