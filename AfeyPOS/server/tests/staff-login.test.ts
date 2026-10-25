import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, Client, rid, openShift, createProduct, type Ctx } from './helpers.js';
import { hmacSha256 } from '../src/lib/crypto.js';
import { User } from '../src/models/index.js';
import { runAsPlatform } from '../src/lib/context.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
let cashierId: string;
let managerId: string;
let cashierCard: string;
let managerCard: string;
const anon = () => new Client(ctx.api, 'staff');

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'staff', 'supermarket', {}, ['biometrics']);
  const c = await t.client.post('/settings/users', { name: 'Cathy Cashier', email: 'cathy@staff.test', password: 'Cathy1234', roles: ['cashier'], pin: '1234', jobTitle: 'Cashier' });
  const m = await t.client.post('/settings/users', { name: 'Manny Manager', email: 'manny@staff.test', password: 'Manny1234', roles: ['branch_manager'], pin: '9876' });
  cashierId = c.body.data._id;
  managerId = m.body.data._id;
  expect(c.body.data.employeeNo).toMatch(/^EMP-\d{4}$/);
  expect(m.body.data.employeeNo).not.toBe(c.body.data.employeeNo);
});
afterAll(teardown);

describe('employee cards', () => {
  it('issues a card once, keeps only a hash and an encrypted copy, and reprints it', async () => {
    const r = await t.client.post(`/settings/users/${cashierId}/card`, {});
    expect(r.status).toBe(201);
    cashierCard = r.body.data.code;
    expect(cashierCard).toMatch(/^AFE[A-Z2-7]{13}$/);
    expect(r.body.data).toMatchObject({ name: 'Cathy Cashier', jobTitle: 'Cashier' });
    const raw = await runAsPlatform(() => User.findById(cashierId).lean());
    expect(JSON.stringify(raw)).not.toContain(cashierCard);
    const list = (await t.client.get('/settings/users')).body.data.find((u: any) => u._id === cashierId);
    expect(list.card).toEqual({ last4: cashierCard.slice(-4), issuedAt: expect.any(String) });
    expect(JSON.stringify(list)).not.toContain('codeHash');
    expect((await t.client.get(`/settings/users/${cashierId}/card`)).body.data.code).toBe(cashierCard);
    managerCard = (await t.client.post(`/settings/users/${managerId}/card`, {})).body.data.code;
  });

  it('signs in with card and PIN; the card alone or a wrong PIN is refused', async () => {
    expect((await anon().post('/auth/card-login', { code: cashierCard })).body.error.code).toBe('PIN_REQUIRED');
    expect((await anon().post('/auth/card-login', { code: cashierCard, pin: '0000' })).status).toBe(401);
    expect((await anon().post('/auth/card-login', { code: 'AFEAAAAAAAAAAAAA', pin: '1234' })).status).toBe(401);
    // Scanners often send lower case; codes are case-insensitive.
    const ok = await anon().post('/auth/card-login', { code: cashierCard.toLowerCase(), pin: '1234' });
    expect(ok.status).toBe(200);
    const me = await anon().as(ok.body.accessToken).get('/auth/me');
    expect(me.body.user.name).toBe('Cathy Cashier');
    const audit = await t.client.get('/audit?action=auth.login');
    expect(audit.body.data.some((a: any) => a.details?.method === 'card+pin')).toBe(true);
  });

  it('can allow card-only sign-in when the business chooses', async () => {
    await t.client.patch('/settings/business', { settings: { staffLogin: { cardRequiresPin: false } } });
    expect((await anon().post('/auth/card-login', { code: cashierCard })).status).toBe(200);
    await t.client.patch('/settings/business', { settings: { staffLogin: { cardRequiresPin: true } } });
  });

  it('a supervisor approves with their card and PIN', async () => {
    const cashier = new Client(ctx.api, 'staff');
    await cashier.login('cathy@staff.test', 'Cathy1234');
    expect((await cashier.post('/auth/override', { cardCode: cashierCard, pin: '1234', permission: 'sales.void' })).status).toBe(403);
    expect((await cashier.post('/auth/override', { cardCode: managerCard, pin: '1111', permission: 'sales.void' })).status).toBe(401);
    const ov = await cashier.post('/auth/override', { cardCode: managerCard, pin: '9876', permission: 'sales.discount.override' });
    expect(ov.status).toBe(200);
    expect(ov.body.supervisor.name).toBe('Manny Manager');
    const wh = t.locations.warehouses[0]._id;
    const till = t.locations.tills[0]._id;
    await openShift(cashier, till);
    const p = await createProduct(t.client, { prices: { retail: 10000 }, openingStock: [{ warehouseId: wh, qty: 5 }] });
    const sale = await cashier.post('/sales', { clientRequestId: rid(), tillId: till, lines: [{ productId: p._id, qty: 1, discountBp: 3000 }], payments: [{ method: 'cash', amountCents: 7000 }], overrideToken: ov.body.overrideToken });
    expect(sale.status).toBe(201);
  });

  it('clocks staff in and out with the card', async () => {
    const a = await anon().post('/auth/clock', { code: cashierCard, pin: '1234' });
    expect(a.body.data).toMatchObject({ name: 'Cathy Cashier', kind: 'clock_in' });
    const b = await anon().post('/auth/clock', { code: cashierCard, pin: '1234' });
    expect(b.body.data.kind).toBe('clock_out');
    const att = (await t.client.get(`/attendance?userId=${cashierId}`)).body.data;
    expect(att.map((x: any) => x.method)).toEqual(['card', 'card']);
  });

  it('reissuing voids the old card; revoking stops it working', async () => {
    const fresh = (await t.client.post(`/settings/users/${cashierId}/card`, {})).body.data.code;
    expect((await anon().post('/auth/card-login', { code: cashierCard, pin: '1234' })).status).toBe(401);
    expect((await anon().post('/auth/card-login', { code: fresh, pin: '1234' })).status).toBe(200);
    expect((await t.client.delete(`/settings/users/${cashierId}/card`)).status).toBe(200);
    expect((await anon().post('/auth/card-login', { code: fresh, pin: '1234' })).status).toBe(401);
    expect((await t.client.get(`/settings/users/${cashierId}/card`)).status).toBe(404);
  });

  it('locks the account after repeated wrong PINs', async () => {
    for (let i = 0; i < 5; i++) await anon().post('/auth/card-login', { code: managerCard, pin: '0000' });
    expect((await anon().post('/auth/card-login', { code: managerCard, pin: '9876' })).body.error.code).toBe('ACCOUNT_LOCKED');
    await runAsPlatform(() => User.updateOne({ _id: managerId }, { $unset: { lockedUntil: 1 }, $set: { failedLogins: 0 } }));
  });
});

describe('fingerprint identification (touch only, no email)', () => {
  let deviceId: string;
  let key: string;
  const tplCash = Buffer.from('cashier-right-index').toString('base64');
  const tplMgr = Buffer.from('manager-right-index').toString('base64');
  const challenge = (purpose: string, email = '') => {
    const ts = Date.now();
    return anon().post('/biometrics/challenge', { deviceId, ...(email ? { email } : {}), purpose, ts, signature: hmacSha256(key, `challenge:${email}:${purpose}:${ts}`) });
  };

  beforeAll(async () => {
    const dev = await t.client.post('/biometrics/devices', { name: 'Till 1 reader', vendor: 'simulator' });
    deviceId = dev.body.data.id;
    key = dev.body.data.deviceKey;
    for (const [uid, tpl] of [[cashierId, tplCash], [managerId, tplMgr]]) {
      const r = await t.client.post('/biometrics/enroll', { userId: uid, deviceId, format: 'sim-v1', template: tpl, signature: hmacSha256(key, `enroll:${uid}:right_index:${tpl}`) });
      expect(r.status).toBe(201);
    }
    const enrolled = (await t.client.get('/biometrics/enrolled')).body.data;
    expect(enrolled).toHaveLength(2);
  });

  it('hands every enrolled staff template to the reader and signs in whoever matched', async () => {
    const ch = await challenge('login');
    expect(ch.body.data.mode).toBe('identify');
    expect(ch.body.data.templates.map((x: any) => x.userId).sort()).toEqual([cashierId, managerId].sort());
    const nonce = ch.body.data.nonce;
    // The signature covers the matched user, so a tampered userId is rejected.
    const forged = await anon().post('/biometrics/verify', { deviceId, nonce, matched: true, userId: managerId, signature: hmacSha256(key, `verify:${nonce}:1:${cashierId}`) });
    expect(forged.status).toBe(401);
    const ch2 = await challenge('login');
    const n2 = ch2.body.data.nonce;
    const ok = await anon().post('/biometrics/verify', { deviceId, nonce: n2, matched: true, userId: cashierId, score: 90, signature: hmacSha256(key, `verify:${n2}:1:${cashierId}`) });
    expect(ok.status).toBe(200);
    expect(ok.body.data.user.name).toBe('Cathy Cashier');
    const session = await anon().post('/auth/biometric-login', { loginToken: ok.body.data.loginToken });
    expect(session.status).toBe(200);
  });

  it('refuses a match for someone who was not offered to the reader', async () => {
    await t.client.patch(`/settings/users/${managerId}`, { status: 'disabled' });
    const ch = await challenge('login');
    expect(ch.body.data.templates.map((x: any) => x.userId)).toEqual([cashierId]);
    const n = ch.body.data.nonce;
    const r = await anon().post('/biometrics/verify', { deviceId, nonce: n, matched: true, userId: managerId, signature: hmacSha256(key, `verify:${n}:1:${managerId}`) });
    expect(r.status).toBe(401);
    await t.client.patch(`/settings/users/${managerId}`, { status: 'active' });
  });

  it('clocks in by fingerprint and approves overrides by identified supervisor', async () => {
    const ch = await challenge('attendance');
    const n = ch.body.data.nonce;
    const r = await anon().post('/biometrics/verify', { deviceId, nonce: n, matched: true, userId: managerId, signature: hmacSha256(key, `verify:${n}:1:${managerId}`) });
    expect(r.body.data).toMatchObject({ attendance: { kind: 'clock_in', method: 'fingerprint' }, user: { name: 'Manny Manager' } });
    const ch2 = await challenge('override');
    const n2 = ch2.body.data.nonce;
    const ov = await anon().post('/biometrics/verify', { deviceId, nonce: n2, matched: true, userId: managerId, permission: 'sales.void', forUserId: cashierId, signature: hmacSha256(key, `verify:${n2}:1:${managerId}`) });
    expect(ov.body.data.overrideToken).toBeTruthy();
    // A no-match is recorded and refused.
    const ch3 = await challenge('login');
    const n3 = ch3.body.data.nonce;
    expect((await anon().post('/biometrics/verify', { deviceId, nonce: n3, matched: false, signature: hmacSha256(key, `verify:${n3}:0`) })).status).toBe(401);
  });
});
