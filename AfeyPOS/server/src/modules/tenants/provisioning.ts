import { z } from 'zod';
import { BUSINESS_PROFILES, BUSINESS_TYPES, normalizeSubdomain, validateSubdomain } from '@afeypos/shared';
import { Branch, Category, Customer, Tenant, Till, User, Warehouse } from '../../models/index.js';
import { env } from '../../config/env.js';
import { hashPassword, randomToken } from '../../lib/crypto.js';
import { badRequest, conflict } from '../../lib/errors.js';
import { runInTenant } from '../../lib/context.js';
import { withTransaction } from '../../db/connection.js';
import { getPlan } from './plans.js';

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128)
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), 'Password must contain letters and numbers');

export const registrationSchema = z.object({
  businessName: z.string().trim().min(2).max(120),
  businessType: z.enum(BUSINESS_TYPES),
  subdomain: z.string().trim().toLowerCase().optional(),
  ownerName: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email(),
  password: passwordSchema,
  phone: z.string().trim().max(30).optional(),
  country: z.string().length(2).default('KE'),
  currency: z.string().length(3).default('KES'),
  timezone: z.string().default('Africa/Nairobi'),
  planCode: z.string().default('starter'),
});

export type RegistrationInput = z.infer<typeof registrationSchema>;

export async function isSubdomainAvailable(slug: string): Promise<{ available: boolean; reason?: string }> {
  const err = validateSubdomain(slug);
  if (err) return { available: false, reason: err };
  const exists = await Tenant.exists({ slug: normalizeSubdomain(slug) });
  return exists ? { available: false, reason: 'This address is already taken' } : { available: true };
}

/**
 * Creates a tenant with a default branch, warehouse, till, owner account, suggested categories
 * and a walk-in customer, all in one transaction.
 */
export async function provisionTenant(input: RegistrationInput) {
  const e = env();
  let slug: string;
  if (e.DEPLOYMENT_MODE === 'local') {
    if (await Tenant.exists({})) throw conflict('This installation is already set up', 'ALREADY_SETUP');
    slug = normalizeSubdomain(input.subdomain || 'local');
  } else {
    if (!input.subdomain) throw badRequest('Choose a subdomain for your business');
    slug = normalizeSubdomain(input.subdomain);
    const avail = await isSubdomainAvailable(slug);
    if (!avail.available) throw conflict(avail.reason!, 'SUBDOMAIN_UNAVAILABLE');
  }
  const plan = e.DEPLOYMENT_MODE === 'cloud' ? await getPlan(input.planCode) : null;
  if (e.DEPLOYMENT_MODE === 'cloud' && !plan) throw badRequest('Unknown plan');
  const passwordHash = await hashPassword(input.password);
  const profile = BUSINESS_PROFILES[input.businessType];

  return withTransaction(async () => {
    const [tenant] = await Tenant.create([
      {
        name: input.businessName,
        slug,
        businessType: input.businessType,
        status: e.DEPLOYMENT_MODE === 'cloud' ? 'trial' : 'active',
        planCode: e.DEPLOYMENT_MODE === 'cloud' ? plan!.code : 'local',
        trialEndsAt: plan ? new Date(Date.now() + plan.trialDays * 86400_000) : undefined,
        contact: { email: input.email, phone: input.phone },
        settings: { currency: input.currency, country: input.country, timezone: input.timezone },
        callbackToken: randomToken(24),
      },
    ]);
    return runInTenant(tenant._id, async () => {
      const [branch] = await Branch.create([{ name: 'Main branch', code: 'MAIN' }]);
      const [warehouse] = await Warehouse.create([{ branchId: branch._id, name: 'Main store', code: 'MAIN', isDefault: true }]);
      const [till] = await Till.create([{ branchId: branch._id, warehouseId: warehouse._id, name: 'Till 1', code: 'T1' }]);
      const [owner] = await User.create([{ email: input.email, name: input.ownerName, phone: input.phone, passwordHash, roles: ['tenant_owner'] }]);
      await Category.insertMany(profile.suggestedCategories.map((name, i) => ({ name, sortOrder: i })));
      await Customer.create([{ code: 'WALKIN', name: 'Walk-in customer', kind: 'walk_in' }]);
      return { tenant, owner, branch, warehouse, till };
    });
  });
}
