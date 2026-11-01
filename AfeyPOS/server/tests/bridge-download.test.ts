import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, type Ctx } from './helpers.js';

let ctx: Ctx;
let root: string;

beforeAll(async () => {
  ctx = await setupApp();
  // A stand-in Afey POS folder: the bridge as this server's build leaves it, and the installer script.
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'afey-app-'));
  fs.mkdirSync(path.join(root, 'bridge', 'dist', 'adapters'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bridge', 'dist', 'index.js'), 'console.log("bridge")');
  fs.writeFileSync(path.join(root, 'bridge', 'dist', 'adapters', 'printer.js'), 'export {}');
  fs.writeFileSync(path.join(root, 'bridge', 'dist', 'index.js.map'), '{}');
  fs.writeFileSync(path.join(root, 'bridge', 'package.json'), '{"type":"module"}');
  fs.mkdirSync(path.join(root, 'installer', 'windows'), { recursive: true });
  fs.writeFileSync(path.join(root, 'installer', 'windows', 'install-bridge.ps1'), 'param([string]$ServerUrl)');
  process.env.AFEY_APP_ROOT = root;
});
afterAll(async () => {
  delete process.env.AFEY_APP_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
  await teardown();
});

describe('installing the device bridge from this server', () => {
  it('hands out the installer and the built bridge without signing in', async () => {
    const ps = await ctx.api.get('/api/v1/public/bridge/install.ps1');
    expect(ps.status).toBe(200);
    expect(ps.text).toContain('param([string]$ServerUrl)');
    const files = await ctx.api.get('/api/v1/public/bridge/files');
    expect(files.status).toBe(200);
    expect(Object.keys(files.body.files).sort()).toEqual(['dist/adapters/printer.js', 'dist/index.js', 'package.json']);
  });

  it('says so when the bridge is not built on this server', async () => {
    fs.rmSync(path.join(root, 'bridge', 'dist'), { recursive: true });
    const files = await ctx.api.get('/api/v1/public/bridge/files');
    expect(files.status).toBe(404);
    expect(files.body.error.code).toBe('BRIDGE_NOT_BUILT');
  });
});
