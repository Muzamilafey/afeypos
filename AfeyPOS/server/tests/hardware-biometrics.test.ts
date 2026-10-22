import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import net from 'node:net';
import { setupApp, teardown, registerTenant, Client, type Ctx } from './helpers.js';
import { hmacSha256 } from '../src/lib/crypto.js';
import { BiometricTemplate } from '../src/models/index.js';
import { runAsPlatform } from '../src/lib/context.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
beforeAll(async () => {
  ctx = await setupApp({ DEPLOYMENT_MODE: 'cloud' });
  t = await registerTenant(ctx.api, 'devices', 'supermarket');
});
afterAll(teardown);

describe('hardware', () => {
  it('blocks server-side network printing in the cloud (SSRF) and generates label code', async () => {
    const d = await t.client.post('/hardware/devices', { kind: 'receipt_printer', name: 'Till 1 printer', connection: 'network', settings: { host: '10.0.0.50', port: 9100 } });
    expect(d.status).toBe(201);
    const test = await t.client.post(`/hardware/devices/${d.body.data._id}/test`);
    expect(test.body.data.ok).toBe(false);
    expect(test.body.data.message).toMatch(/browser|bridge/);
    const zpl = await t.client.post('/hardware/labels', { language: 'zpl', items: [{ name: 'Milk ^500ml', price: 'KES 65', barcode: '6001234', copies: 2 }] });
    expect(zpl.body.data.payload).toContain('^BCN');
    expect(zpl.body.data.payload).not.toContain('Milk ^500');
  });
});

describe('local network printing', () => {
  it('sends ESC/POS to a LAN printer from a local installation', async () => {
    const received: Buffer[] = [];
    const server = net.createServer((s) => s.on('data', (d) => received.push(d)));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as net.AddressInfo).port;
    const { sendRaw } = await import('../src/modules/hardware/routes.js');
    await sendRaw('127.0.0.1', port, Buffer.from([0x1b, 0x40, 0x41]));
    await new Promise((r) => setTimeout(r, 50));
    server.close();
    expect(Buffer.concat(received)).toEqual(Buffer.from([0x1b, 0x40, 0x41]));
  });
});

describe('biometrics (device bridge protocol)', () => {
  it('enrolls an encrypted template and issues an override only for a signed match', async () => {
    await t.client.put('/settings/modules', { enabled: ['biometrics'] }).then((r) => expect([200, 402]).toContain(r.status));
    // Supermarket on the starter plan is not entitled to biometrics; move to business plan via platform owner.
    const pl = await ctx.api.post('/api/v1/platform/auth/login').send({ email: 'owner@afeypos.test', password: 'PlatformPass123' });
    await ctx.api.patch(`/api/v1/platform/tenants/${t.tenant.id}`).set('Authorization', `Bearer ${pl.body.accessToken}`).send({ planCode: 'business' });
    expect((await t.client.put('/settings/modules', { enabled: ['biometrics'] })).status).toBe(200);
    await t.client.post('/settings/users', { name: 'Sup Visor', email: 'sup@devices.test', password: 'Super1234', roles: ['branch_manager'] });
    await t.client.post('/settings/users', { name: 'Cash Ier', email: 'cash@devices.test', password: 'Cashi1234', roles: ['cashier'] });
    const users = (await t.client.get('/settings/users')).body.data;
    const sup = users.find((u: any) => u.email === 'sup@devices.test');
    const cash = users.find((u: any) => u.email === 'cash@devices.test');
    const dev = await t.client.post('/biometrics/devices', { name: 'Till 1 reader', vendor: 'simulator' });
    const key = dev.body.data.deviceKey;
    const deviceId = dev.body.data.id;
    const template = Buffer.from('fake-minutiae-template-for-sup').toString('base64');
    const badSig = await t.client.post('/biometrics/enroll', { userId: sup._id, deviceId, format: 'sim', template, signature: '0'.repeat(64) });
    expect(badSig.status).toBe(401);
    const enroll = await t.client.post('/biometrics/enroll', { userId: sup._id, deviceId, format: 'sim', template, signature: hmacSha256(key, `enroll:${sup._id}:right_index:${template}`) });
    expect(enroll.status).toBe(201);
    const stored = await runAsPlatform(() => BiometricTemplate.findOne({ userId: sup._id }).lean());
    expect(stored!.templateEnc).not.toContain(template);

    const bridge = new Client(ctx.api, 'devices');
    const ts = Date.now();
    const ch = await bridge.post('/biometrics/challenge', { deviceId, email: 'sup@devices.test', purpose: 'override', ts, signature: hmacSha256(key, `challenge:sup@devices.test:override:${ts}`) });
    expect(ch.status).toBe(200);
    expect(ch.body.data.templates[0].template).toBe(template);
    const nonce = ch.body.data.nonce;
    const noMatch = await bridge.post('/biometrics/verify', { deviceId, nonce, matched: false, signature: hmacSha256(key, `verify:${nonce}:0`) });
    expect(noMatch.status).toBe(401);
    // Nonces are single use.
    const reuse = await bridge.post('/biometrics/verify', { deviceId, nonce, matched: true, permission: 'sales.void', forUserId: cash._id, signature: hmacSha256(key, `verify:${nonce}:1`) });
    expect(reuse.status).toBe(401);
    const ts2 = Date.now();
    const ch2 = await bridge.post('/biometrics/challenge', { deviceId, email: 'sup@devices.test', purpose: 'override', ts: ts2, signature: hmacSha256(key, `challenge:sup@devices.test:override:${ts2}`) });
    const ok = await bridge.post('/biometrics/verify', { deviceId, nonce: ch2.body.data.nonce, matched: true, permission: 'sales.void', forUserId: cash._id, signature: hmacSha256(key, `verify:${ch2.body.data.nonce}:1`) });
    expect(ok.status).toBe(200);
    expect(ok.body.data.overrideToken).toBeTruthy();
    const audit = await t.client.get('/audit?action=biometrics');
    expect(audit.body.data.map((a: any) => a.action)).toEqual(expect.arrayContaining(['biometrics.enrolled', 'biometrics.verified', 'biometrics.verification_failed']));
    expect(JSON.stringify(audit.body.data)).not.toContain(template);
  });
});
