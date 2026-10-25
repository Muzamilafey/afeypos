import { z } from 'zod';
import { BUSINESS_PROFILES, BUSINESS_TYPES } from '@afeypos/shared';
import { Branch, Category, Customer, Tenant, Till, User, Warehouse } from '../../models/index.js';
import { env } from '../../config/env.js';
import { hashPassword, randomToken } from '../../lib/crypto.js';
import { AppError, conflict } from '../../lib/errors.js';
import { runInTenant } from '../../lib/context.js';
import { withTransaction } from '../../db/connection.js';

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128)
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), 'Password must contain letters and numbers');

export const registrationSchema = z.object({
  businessName: z.string().trim().min(2).max(120),
  businessType: z.enum(BUSINESS_TYPES).default('supermarket'),
  ownerName: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email(),
  password: passwordSchema,
  phone: z.string().trim().max(30).optional(),
  country: z.string().length(2).default('KE'),
  currency: z.string().length(3).default('KES'),
  timezone: z.string().default('Africa/Nairobi'),
  taxPin: z.string().trim().toUpperCase().regex(/^[AP]\d{9}[A-Z]$/, 'KRA PIN looks like P051234567X').optional().or(z.literal('').transform(() => undefined)),
});

export type RegistrationInput = z.infer<typeof registrationSchema>;

/** URL-safe identifier derived from the business name (used in M-Pesa account references and file names). */
export function slugFor(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'business';
}

/**
 * One-time setup of the installation's business: default branch, warehouse, till, owner account,
 * suggested categories and a walk-in customer, all in one transaction.
 */
export async function provisionTenant(input: RegistrationInput) {
  const e = env();
  if (e.DEPLOYMENT_MODE === 'branch') throw new AppError(409, 'BRANCH_JOINS_HQ', 'Branch servers are set up by connecting to head office, not by creating a new business');
  if (await Tenant.exists({})) throw conflict('This installation is already set up', 'ALREADY_SETUP');
  const slug = slugFor(input.businessName);
  const passwordHash = await hashPassword(input.password);
  const profile = BUSINESS_PROFILES[input.businessType];

  return withTransaction(async () => {
    const [tenant] = await Tenant.create([
      {
        name: input.businessName,
        slug,
        businessType: input.businessType,
        status: 'active',
        contact: { email: input.email, phone: input.phone },
        settings: { currency: input.currency, country: input.country, timezone: input.timezone, taxPin: input.taxPin },
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
