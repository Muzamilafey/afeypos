import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, Client, OWNER_PASSWORD, type Ctx } from './helpers.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'names', 'supermarket');
});
afterAll(teardown);

describe('usernames', () => {
  it('a user signs in and approves with a username instead of the email', async () => {
    const u = await t.client.post('/settings/users', { name: 'Grace Wanjiku', email: 'grace@names.test', username: 'Grace.W', password: 'GraceTill2026!', pin: '4321', roles: ['branch_manager'] });
    expect(u.status).toBe(201);
    expect(u.body.data.username).toBe('grace.w');
    // Taken by another user.
    expect((await t.client.post('/settings/users', { name: 'Other', email: 'other@names.test', username: 'grace.w', password: 'OtherTill2026!', roles: ['cashier'] })).status).toBe(409);
    const c = new Client(ctx.api, 'names');
    await c.login('grace.w', 'GraceTill2026!');
    expect((await c.get('/auth/me')).body.user.email).toBe('grace@names.test');
    expect((await new Client(ctx.api, 'names').post('/auth/pin-login', { email: 'grace.w', pin: '4321' })).status).toBe(200);
    // The same box takes a PIN or a password when confirming.
    const ok = await t.client.post('/auth/override', { email: 'grace.w', password: '4321', pin: '4321', permission: 'sales.void' });
    expect(ok.body.overrideToken).toBeTruthy();
    expect((await t.client.post('/auth/override', { email: 'grace.w', password: 'wrong', permission: 'sales.void' })).status).toBe(401);
  });

  it('only an owner or administrator can confirm a branch server token', async () => {
    const br = await t.client.post('/settings/branches', { name: 'Thika', code: 'THK9' });
    const id = br.body.data.branch._id;
    expect((await t.client.post(`/settings/branches/${id}/sync-token`, {})).status).toBe(403);
    const asManager = (await t.client.post('/auth/override', { email: 'grace.w', password: 'GraceTill2026!', permission: 'settings.manage' }));
    if (asManager.body.overrideToken) {
      // A manager with settings rights is still not an owner or administrator.
      expect((await t.client.post(`/settings/branches/${id}/sync-token`, {}, { 'X-Approval': asManager.body.overrideToken })).status).toBe(403);
    }
    const owner = await t.client.post('/auth/override', { email: 'owner@names.test', password: OWNER_PASSWORD, permission: 'settings.manage' });
    const r = await t.client.post(`/settings/branches/${id}/sync-token`, {}, { 'X-Approval': owner.body.overrideToken });
    // Head office only (this test installation is a single shop), but the approval itself was accepted.
    expect([200, 409]).toContain(r.status);
    if (r.status === 409) expect(r.body.error.code).toBe('NOT_HQ');
    // Single use.
    expect((await t.client.post(`/settings/branches/${id}/sync-token`, {}, { 'X-Approval': owner.body.overrideToken })).status).toBe(403);
  });
});
