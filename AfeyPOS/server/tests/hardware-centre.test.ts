import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HARDWARE_CATALOG } from '@afeypos/shared';
import { setupApp, teardown, registerTenant, type Ctx } from './helpers.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'hwshop', 'supermarket');
});
afterAll(teardown);

describe('hardware compatibility centre', () => {
  it('only marks entries verified with a verification date, and lists every category', async () => {
    for (const e of HARDWARE_CATALOG) {
      if (e.status === 'verified') expect(e.lastVerified, e.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      else expect(e.lastVerified, e.id).toBeNull();
    }
    const cat = (await t.client.get('/hardware/catalog')).body.data;
    expect(cat.categories.map((c: any) => c.key)).toEqual(expect.arrayContaining(['barcode_scanner', 'scale', 'label_scale', 'receipt_printer', 'label_printer', 'cash_drawer', 'customer_display', 'fingerprint_reader', 'card_terminal']));
    expect(cat.statuses.unverified.label).toBe('Not yet verified');
  });

  it('a device is only healthy after a real test, and keeps its last success and last error', async () => {
    const d = (await t.client.post('/hardware/devices', { kind: 'barcode_scanner', name: 'Till 1 scanner', connection: 'keyboard_wedge', catalogId: 'honeywell-1250g', manufacturer: 'Honeywell', model: 'Voyager 1250g', tillId: t.locations.tills[0]._id })).body.data;
    expect((await t.client.post('/hardware/devices', { kind: 'barcode_scanner', name: 'X', connection: 'usb', catalogId: 'made-up' })).status).toBe(400);
    // Not testable from the server: it does not pretend it worked.
    const srv = (await t.client.post(`/hardware/devices/${d._id}/test`)).body.data;
    expect(srv).toMatchObject({ ok: false, needsClientTest: true });
    let health = (await t.client.get('/hardware/health')).body;
    expect(health.data.find((r: any) => r.name === 'Till 1 scanner')).toMatchObject({ state: 'untested', model: 'Honeywell Voyager 1250g' });

    await t.client.post(`/hardware/devices/${d._id}/test-result`, { ok: true, method: 'scan', message: 'Scanned 5901234123457' });
    await t.client.post(`/hardware/devices/${d._id}/test-result`, { ok: false, method: 'scan', message: 'No scan received' });
    health = (await t.client.get('/hardware/health')).body;
    const row = health.data.find((r: any) => r.name === 'Till 1 scanner');
    expect(row.state).toBe('error');
    expect(row.lastSuccessAt).toBeTruthy();
    expect(row.lastError.message).toMatch(/No scan received/);
    expect(health.summary).toMatchObject({ total: 1, error: 1 });
  });
});
