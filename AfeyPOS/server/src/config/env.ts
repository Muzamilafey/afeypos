import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(9999),
  HOST: z.string().default('0.0.0.0'),
  /**
   * One business per installation.
   * standalone: a single shop, one server and database.
   * hq: the online head-office server; admins work here and every branch syncs to it (also serves the online shop).
   * branch: the local server in one branch (own database, works offline) that syncs with HQ.
   * "local" is accepted as an alias of standalone for older .env files.
   */
  DEPLOYMENT_MODE: z
    .string()
    .default('standalone')
    .transform((v) => (v === 'local' ? 'standalone' : v))
    .pipe(z.enum(['standalone', 'hq', 'branch'], { message: 'DEPLOYMENT_MODE must be standalone, hq or branch (multi-tenant "cloud" mode was removed)' })),
  /** branch role: code of the branch this server runs (as created at HQ, e.g. "MSA-01"). */
  BRANCH_CODE: z.string().optional(),
  MONGODB_URI: z.string().min(1).default('mongodb://127.0.0.1:27017/afeypos?replicaSet=rs0'),
  MONGODB_REQUIRE_REPLICA_SET: bool(true),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),
  ENCRYPTION_KEY: z.string().min(1, 'ENCRYPTION_KEY is required (32 bytes, base64)'),
  PUBLIC_APP_URL: z.string().default('http://localhost:5173'),
  API_PUBLIC_URL: z.string().default('http://localhost:9999'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  TRUST_PROXY: z.string().default('loopback'),
  COOKIE_SECURE: bool(false),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().default('Afey POS <no-reply@afeypos.com>'),
  MPESA_ALLOWED_IPS: z.string().default(''),
  UPLOAD_DIR: z.string().default('./data/uploads'),
  BACKUP_DIR: z.string().default('./data/backups'),
  BACKUP_INTERVAL_HOURS: z.coerce.number().default(24),
  BACKUP_RETENTION: z.coerce.number().int().default(14),
  JOBS_ENABLED: bool(true),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SYNC_ENABLED: bool(false),
  /** branch role: HQ base URL, e.g. https://hq.myshop.co.ke */
  SYNC_HQ_URL: z.string().optional(),
  /** Older name of SYNC_HQ_URL. */
  SYNC_CLOUD_URL: z.string().optional(),
  /** branch role: the branch's sync token issued by HQ (Settings → Branches). */
  SYNC_TOKEN: z.string().optional(),
  WEB_DIST_DIR: z.string().optional(),
  /** Online shop website (shop/dist), served to requests for SHOP_HOSTNAMES (e.g. shop.mysupermarket.co.ke). */
  SHOP_DIST_DIR: z.string().optional(),
  SHOP_HOSTNAMES: z.string().default(''),
  /** Extra sites allowed to show the shop in a frame (the Store studio preview), besides CORS_ORIGINS and API_PUBLIC_URL. */
  SHOP_FRAME_ANCESTORS: z.string().default(''),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;
  const key = Buffer.from(env.ENCRYPTION_KEY, 'base64');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must decode (base64) to exactly 32 bytes');
  if (env.DEPLOYMENT_MODE === 'branch' && env.SYNC_ENABLED && !(env.SYNC_HQ_URL || env.SYNC_CLOUD_URL)) throw new Error('A branch server with SYNC_ENABLED needs SYNC_HQ_URL');
  if (env.NODE_ENV === 'production') {
    if (/change-me|placeholder/i.test(env.JWT_ACCESS_SECRET)) throw new Error('Replace the placeholder JWT_ACCESS_SECRET');
  }
  cached = env;
  return env;
}

export function env(): Env {
  return cached ?? loadEnv();
}

/** Test helper: reset cached env. */
export function resetEnv() {
  cached = null;
}
