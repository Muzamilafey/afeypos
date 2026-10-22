import { env } from './config/env.js';
import { PlatformUser } from './models/index.js';
import { hashPassword } from './lib/crypto.js';
import { logger } from './lib/logger.js';
import { ensureDefaultPlans } from './modules/tenants/plans.js';

/** Idempotent startup tasks: default plans and the first platform owner (cloud). */
export async function bootstrap() {
  const e = env();
  await ensureDefaultPlans();
  if (e.DEPLOYMENT_MODE === 'cloud' && e.PLATFORM_OWNER_EMAIL && e.PLATFORM_OWNER_PASSWORD) {
    const exists = await PlatformUser.exists({});
    if (!exists) {
      await PlatformUser.create({ email: e.PLATFORM_OWNER_EMAIL, name: 'Platform owner', passwordHash: await hashPassword(e.PLATFORM_OWNER_PASSWORD), roles: ['platform_owner'] });
      logger.warn('Created initial platform owner from PLATFORM_OWNER_EMAIL. Remove PLATFORM_OWNER_PASSWORD from the environment now.');
    }
  }
}
