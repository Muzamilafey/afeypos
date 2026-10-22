import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),
  DEPLOYMENT_MODE: z.enum(['local', 'cloud']).default('local'),
  MONGODB_URI: z.string().min(1).default('mongodb://127.0.0.1:27017/afeypos?replicaSet=rs0'),
  MONGODB_REQUIRE_REPLICA_SET: bool(true),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),
  ENCRYPTION_KEY: z.string().min(1, 'ENCRYPTION_KEY is required (32 bytes, base64)'),
  BASE_DOMAIN: z.string().default('afeypos.com'),
  PLATFORM_SUBDOMAIN: z.string().default('admin'),
  PUBLIC_APP_URL: z.string().default('http://localhost:5173'),
  API_PUBLIC_URL: z.string().default('http://localhost:4000'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  ALLOW_TENANT_HEADER: bool(false),
  TRUST_PROXY: z.string().default('loopback'),
  COOKIE_SECURE: bool(false),
  PLATFORM_OWNER_EMAIL: z.string().email().optional().or(z.literal('').transform(() => undefined)),
  PLATFORM_OWNER_PASSWORD: z.string().optional(),
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
  SYNC_CLOUD_URL: z.string().optional(),
  SYNC_TOKEN: z.string().optional(),
  WEB_DIST_DIR: z.string().optional(),
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
  if (env.NODE_ENV === 'production') {
    if (env.ALLOW_TENANT_HEADER) throw new Error('ALLOW_TENANT_HEADER must be false in production');
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
