import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, type Ctx } from './helpers.js';

// 1x1 transparent PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'icons', 'supermarket');
});
afterAll(teardown);

describe('installed app icon', () => {
  it('is Afey’s until the business saves a logo, then the icons made from it', async () => {
    const pub = (p: string) => ctx.api.get(`/api/v1/public${p}`).set('Host', 'localhost');
    expect((await pub('/app-icon/192')).status).toBe(302);
    const up = async () => (await t.client.post('/files', { base64: PNG, purpose: 'attachment' })).body.data.id as string;
    const logo = await up();
    const appIcon = { source: logo, i192: await up(), i512: await up(), m512: await up() };
    expect((await t.client.patch('/settings/business', { settings: { logoFileId: logo, appIcon } })).status).toBe(200);
    expect((await pub('/config')).body.tenant.appIconUrl).toMatch(/^\/api\/v1\/public\/app-icon\/192\?v=/);
    const icon = await pub('/app-icon/maskable');
    expect(icon.status).toBe(200);
    expect(icon.headers['content-type']).toBe('image/png');
    // A new logo without icons yet: back to Afey's icon (never a stale one).
    await t.client.patch('/settings/business', { settings: { logoFileId: await up() } });
    expect((await pub('/app-icon/512')).status).toBe(302);
    expect((await pub('/config')).body.tenant.appIconUrl).toBeNull();
  });
});
