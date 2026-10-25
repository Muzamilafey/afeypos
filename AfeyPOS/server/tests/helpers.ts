import { inject } from 'vitest';
import supertest from 'supertest';
import mongoose from 'mongoose';
import crypto from 'node:crypto';
import { loadEnv, resetEnv } from '../src/config/env.js';
import { connectDatabase, disconnectDatabase } from '../src/db/connection.js';
import { bootstrap } from '../src/bootstrap.js';
import { createApp } from '../src/app.js';

export const BASE = 'afeypos.test';
export type Api = ReturnType<typeof supertest>;

export interface Ctx {
  api: Api;
  app: ReturnType<typeof createApp>;
}

export async function setupApp(overrides: Record<string, string> = {}): Promise<Ctx> {
  const dbName = `t_${crypto.randomBytes(6).toString('hex')}`;
  const uri = inject('mongoUri').replace(/\/\?/, `/${dbName}?`).replace(/\/$/, `/${dbName}`);
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DEPLOYMENT_MODE: 'standalone',
    MONGODB_URI: uri.includes(dbName) ? uri : `${uri.split('?')[0].replace(/\/$/, '')}/${dbName}?${uri.split('?')[1] ?? ''}`,
    JWT_ACCESS_SECRET: 'test-secret-that-is-long-enough-to-pass-validation-0123456789',
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    JOBS_ENABLED: 'false',
    SYNC_ENABLED: 'false',
    BACKUP_DIR: `/tmp/afeypos-test-backups/${dbName}`,
    ...overrides,
  });
  resetEnv();
  const e = loadEnv();
  await connectDatabase(e.MONGODB_URI, { requireReplicaSet: true });
  await bootstrap();
  const app = createApp();
  return { app, api: supertest(app) };
}

export async function teardown() {
  await mongoose.connection.db?.dropDatabase().catch(() => undefined);
  await disconnectDatabase();
}

/** Single-business installation: every request reaches the same business whatever the Host header. */
export function host(_slug: string) {
  return BASE;
}

export class Client {
  token = '';
  constructor(public api: Api, public slug: string) {}
  private h(r: supertest.Test, extra: Record<string, string> = {}) {
    r.set('Host', host(this.slug));
    if (this.token) r.set('Authorization', `Bearer ${this.token}`);
    for (const [k, v] of Object.entries(extra)) r.set(k, v);
    return r;
  }
  get(path: string) {
    return this.h(this.api.get(`/api/v1${path}`));
  }
  post(path: string, body: unknown = {}, headers: Record<string, string> = {}) {
    return this.h(this.api.post(`/api/v1${path}`), headers).send(body as object);
  }
  put(path: string, body: unknown = {}) {
    return this.h(this.api.put(`/api/v1${path}`)).send(body as object);
  }
  patch(path: string, body: unknown = {}) {
    return this.h(this.api.patch(`/api/v1${path}`)).send(body as object);
  }
  delete(path: string) {
    return this.h(this.api.delete(`/api/v1${path}`));
  }
  async login(email: string, password: string) {
    const r = await this.post('/auth/login', { email, password });
    if (r.status !== 200) throw new Error(`login failed ${r.status} ${JSON.stringify(r.body)}`);
    this.token = r.body.accessToken;
    return r;
  }
  as(token: string) {
    const c = new Client(this.api, this.slug);
    c.token = token;
    return c;
  }
}

export const OWNER_PASSWORD = 'OwnerPass123';

/**
 * Retired business types expressed as the optional modules they used to enable, so feature tests can
 * still exercise them on a supermarket.
 */
const LEGACY_TYPES: Record<string, { type: 'minimart' | 'supermarket'; modules: string[] }> = {
  retail: { type: 'minimart', modules: [] },
  wholesale: { type: 'supermarket', modules: ['customerPricing', 'salesReps'] },
  hardware: { type: 'supermarket', modules: ['customerPricing', 'fractionalQuantities'] },
  liquor: { type: 'supermarket', modules: ['ageVerification'] },
  pharmacy: { type: 'supermarket', modules: ['prescriptions'] },
  electronics: { type: 'supermarket', modules: ['serialNumbers', 'warranty', 'repairs'] },
};

/** Empties every collection (indexes stay), so a test can set the installation up again. */
export async function resetInstallation() {
  const db = mongoose.connection.db!;
  for (const c of await db.collections()) await c.deleteMany({});
}

/**
 * Runs the one-time installation setup. An installation holds one business, so this first clears any
 * business a previous test in the same file created.
 */
export async function registerTenant(api: Api, slug: string, requestedType = 'minimart', extra: Record<string, unknown> = {}, modules: string[] = []) {
  await resetInstallation();
  const legacy = LEGACY_TYPES[requestedType];
  const businessType = legacy?.type ?? requestedType;
  const r = await api.post('/api/v1/public/register').set('Host', BASE).send({
    businessName: `${slug} shop`, businessType, ownerName: 'Owner Person', email: `owner@${slug}.test`, password: OWNER_PASSWORD, phone: '0712345678', ...extra,
  });
  if (r.status !== 201) throw new Error(`register failed ${r.status} ${JSON.stringify(r.body)}`);
  const c = new Client(api, slug);
  await c.login(`owner@${slug}.test`, OWNER_PASSWORD);
  const enable = [...(legacy?.modules ?? []), ...modules];
  if (enable.length) {
    const m = await c.put('/settings/modules', { enabled: enable });
    if (m.status !== 200) throw new Error(`modules failed ${m.status} ${JSON.stringify(m.body)}`);
  }
  const loc = await c.get('/settings/locations');
  return { client: c, tenant: r.body.tenant, locations: loc.body.data as { branches: any[]; warehouses: any[]; tills: any[] } };
}

export async function createProduct(c: Client, data: Record<string, unknown>) {
  const r = await c.post('/products', { name: 'Item', sku: `SKU-${crypto.randomBytes(3).toString('hex')}`, prices: { retail: 10000 }, costCents: 6000, ...data });
  if (r.status !== 201) throw new Error(`product failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data;
}

export async function openShift(c: Client, tillId: string, floatCents = 0) {
  const r = await c.post('/shifts', { tillId, openingFloatCents: floatCents });
  if (r.status !== 201) throw new Error(`shift failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data;
}

export function rid() {
  return crypto.randomUUID();
}
