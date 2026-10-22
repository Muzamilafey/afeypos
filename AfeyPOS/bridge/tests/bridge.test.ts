import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { createBridgeServer, hmac } from '../src/server.js';
import { displayFrame, parseScaleFrame } from '../src/adapters/serial.js';
import { SimulatorAdapter } from '../src/adapters/fingerprint.js';
import type { BridgeConfig } from '../src/config.js';

const received: Buffer[] = [];
let printer: net.Server;
let base: string;
let server: ReturnType<typeof createBridgeServer>;
const calls: { path: string; body: any }[] = [];
const sim = new SimulatorAdapter();

beforeAll(async () => {
  printer = net.createServer((s) => s.on('data', (d) => received.push(d)));
  await new Promise<void>((r) => printer.listen(0, '127.0.0.1', () => r()));
  const cfg: BridgeConfig = {
    port: 0, host: '127.0.0.1', allowedOrigins: ['http://pos.local'], pairingToken: 'x'.repeat(32), server: { url: 'http://server.test' },
    biometricDevice: { deviceId: 'dev1', deviceKey: 'k'.repeat(43) },
    printers: { receipt: { type: 'network', host: '127.0.0.1', port: (printer.address() as AddressInfo).port } },
  };
  const enrolled = await sim.capture();
  const fakeFetch = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ path: new URL(url).pathname, body });
    if (url.endsWith('/challenge')) return new Response(JSON.stringify({ data: { nonce: 'n1', templates: [enrolled] } }), { status: 200 });
    return new Response(JSON.stringify({ data: { overrideToken: 'tok' } }), { status: 200 });
  }) as unknown as typeof fetch;
  server = createBridgeServer(cfg, { fingerprint: sim, fetchImpl: fakeFetch });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  printer.close();
});

const H = { 'X-Afey-Bridge-Token': 'x'.repeat(32), 'Content-Type': 'application/json' };

describe('device bridge', () => {
  it('rejects requests without the pairing token or from other origins', async () => {
    expect((await fetch(`${base}/status`)).status).toBe(401);
    expect((await fetch(`${base}/status`, { headers: { ...H, Origin: 'https://evil.example' } })).status).toBe(403);
    expect((await fetch(`${base}/status`, { headers: { ...H, Origin: 'http://pos.local' } })).status).toBe(200);
  });

  it('prints raw ESC/POS to a network printer and kicks the drawer', async () => {
    const r = await fetch(`${base}/print/raw`, { method: 'POST', headers: H, body: JSON.stringify({ base64: Buffer.from([0x1b, 0x40, 0x48, 0x69]).toString('base64') }) });
    expect(r.status).toBe(200);
    await fetch(`${base}/drawer/open`, { method: 'POST', headers: H, body: '{}' });
    await new Promise((res) => setTimeout(res, 50));
    const all = Buffer.concat(received);
    expect(all.subarray(0, 4)).toEqual(Buffer.from([0x1b, 0x40, 0x48, 0x69]));
    expect(all.includes(Buffer.from([0x1b, 0x70]))).toBe(true);
  });

  it('signs enrolment captures and runs the challenge/verify protocol with the server', async () => {
    const e = await (await fetch(`${base}/fingerprint/enroll-capture`, { method: 'POST', headers: H, body: JSON.stringify({ userId: 'u1' }) })).json();
    expect(e.signature).toBe(hmac('k'.repeat(43), `enroll:u1:right_index:${e.template}`));
    const v = await (await fetch(`${base}/fingerprint/verify`, { method: 'POST', headers: H, body: JSON.stringify({ email: 'Sup@Shop.test', purpose: 'override', permission: 'sales.void', forUserId: 'c1' }) })).json();
    expect(v.data.overrideToken).toBe('tok');
    const verify = calls.find((c) => c.path.endsWith('/verify'))!;
    expect(verify.body.matched).toBe(true);
    expect(verify.body.signature).toBe(hmac('k'.repeat(43), 'verify:n1:1'));
    const ch = calls.find((c) => c.path.endsWith('/challenge'))!;
    expect(ch.body.signature).toBe(hmac('k'.repeat(43), `challenge:sup@shop.test:override:${ch.body.ts}`));
  });

  it('parses scale frames and formats pole display text', () => {
    expect(parseScaleFrame('ST,GS,+  1.250kg')).toEqual({ weightKg: 1.25, stable: true });
    expect(parseScaleFrame('US,GS,+  0.400kg')?.stable).toBe(false);
    expect(parseScaleFrame('  350 g')?.weightKg).toBe(0.35);
    expect(displayFrame('Total', 'KES 130.00').length).toBe(41);
  });
});
