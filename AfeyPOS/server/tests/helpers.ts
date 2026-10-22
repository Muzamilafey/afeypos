import { inject } from 'vitest';
import supertest from 'supertest';
import mongoose from 'mongoose';
import crypto from 'node:crypto';
import { loadEnv, resetEnv } from '../src/config/env.js';
import { connectDatabase, disconnectDatabase } from '../src/db/connection.js';
import { bootstrap } from '../src/bootstrap.js';
import { createApp } from '../src/app.js';

export const BASE = 'afeypos.test';

export interface Ctx {
  api: supertest.Agent;
  app: ReturnType<typeof createApp>;
}

export async function setupApp(overrides: Record<string, string> = {}): Promise<Ctx> {
  const dbName = `t_${crypto.randomBytes(6).toString('hex')}`;
  const uri = inject('mongoUri').replace(/\/\?/, `/${dbName}?`).replace(/\/$/, `/${dbName}`);
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DEPLOYMENT_MODE: 'cloud',
    BASE_DOMAIN: BASE,
    MONGODB_URI: uri.includes(dbName) ? uri : `${uri.split('?')[0].replace(/\/$/, '')}/${dbName}?${uri.split('?')[1] ?? ''}`,
    JWT_ACCESS_SECRET: 'test-secret-that-is-long-enough-to-pass-validation-0123456789',
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    ALLOW_TENANT_HEADER: 'false',
    JOBS_ENABLED: 'false',
    SYNC_ENABLED: 'false',
    PLATFORM_OWNER_EMAIL: 'owner@afeypos.test',
    PLATFORM_OWNER_PASSWORD: 'PlatformPass123',
    BACKUP_DIR: `/tmp/afeypos-test-backups/${dbName}`,
    ...overrides,
  });
  resetEnv();
  const e = loadEnv();
  await connectDatabase(e.MONGODB_URI, { requireReplicaSet: true });
  await bootstrap();
  const app = createApp();
  return { app, api: supertest.agent(app) };
}

export async function teardown() {
  await mongoose.connection.db?.dropDatabase().catch(() => undefined);
  await disconnectDatabase();
}

export function host(slug: string) {
  return `${slug}.${BASE}`;
}

export class Client {
  token = '';
  constructor(public api: supertest.Agent, public slug: string) {}
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

export async function registerTenant(api: supertest.Agent, slug: string, businessType = 'minimart', extra: Record<string, unknown> = {}) {
  const r = await api.post('/api/v1/public/register').set('Host', BASE).send({
    businessName: `${slug} shop`, businessType, subdomain: slug, ownerName: 'Owner Person', email: `owner@${slug}.test`, password: OWNER_PASSWORD, phone: '0712345678', ...extra,
  });
  if (r.status !== 201) throw new Error(`register failed ${r.status} ${JSON.stringify(r.body)}`);
  const c = new Client(api, slug);
  await c.login(`owner@${slug}.test`, OWNER_PASSWORD);
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
