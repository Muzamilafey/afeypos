import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, Client, type Ctx } from './helpers.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'buttons', 'supermarket');
});
afterAll(teardown);

describe('till buttons', () => {
  it('the owner sets icons, pictures, wording and colours; the tills receive them', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c70000000049454e44ae426082', 'hex').toString('base64');
    const file = (await t.client.post('/files', { base64: png, purpose: 'attachment' })).body.data.id;
    const r = await t.client.put('/settings/till-buttons', { buttons: { mpesa: { image: file, label: 'Lipa na M-Pesa' }, hold: { icon: 'pause', bg: '#123456', text: '#ffffff' }, clear: { label: '' }, drop: { icon: 'wallet' } } });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ mpesa: { image: file, label: 'Lipa na M-Pesa' }, hold: { icon: 'pause', bg: '#123456', text: '#ffffff' }, drop: { icon: 'wallet' } });
    const me = (await t.client.get('/auth/me')).body;
    expect(me.tenant.settings.tillButtons.hold).toMatchObject({ icon: 'pause', bg: '#123456' });
    expect((await t.client.get('/settings/till-buttons')).body.data.mpesa.label).toBe('Lipa na M-Pesa');
  });

  it('refuses unknown buttons, bad colours and anything that is not an uploaded picture; cashiers cannot change them', async () => {
    expect((await t.client.put('/settings/till-buttons', { buttons: { rocket: { icon: 'x' } } })).status).toBe(400);
    expect((await t.client.put('/settings/till-buttons', { buttons: { cash: { bg: 'red' } } })).status).toBe(400);
    expect((await t.client.put('/settings/till-buttons', { buttons: { cash: { image: 'https://evil.example/x.png' } } })).status).toBe(400);
    expect((await t.client.put('/settings/till-buttons', { buttons: { cash: { onclick: 'x' } } })).status).toBe(400);
    await t.client.post('/settings/users', { name: 'Cash', email: 'c@buttons.test', password: 'Passw0rd!x', roles: ['cashier'] });
    const cashier = new Client(ctx.api, 'buttons');
    await cashier.login('c@buttons.test', 'Passw0rd!x');
    expect((await cashier.put('/settings/till-buttons', { buttons: {} })).status).toBe(403);
    // They still see the owner's buttons at the till.
    expect((await cashier.get('/auth/me')).body.tenant.settings.tillButtons.drop.icon).toBe('wallet');
  });
});
