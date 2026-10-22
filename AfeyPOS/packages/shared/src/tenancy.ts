import { MODULES, type ModuleKey } from './businessProfiles.js';

/** Subdomains that can never be claimed by a tenant. */
export const RESERVED_SUBDOMAINS = [
  'www', 'api', 'admin', 'platform', 'app', 'mail', 'smtp', 'ftp', 'static', 'cdn', 'assets', 'status',
  'help', 'support', 'docs', 'billing', 'auth', 'login', 'signup', 'register', 'dashboard', 'test', 'dev', 'staging',
];

export const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;

export function normalizeSubdomain(input: string): string {
  return input.trim().toLowerCase();
}

export function validateSubdomain(input: string): string | null {
  const s = normalizeSubdomain(input);
  if (!SUBDOMAIN_RE.test(s)) return 'Use 3-32 lowercase letters, numbers or hyphens; must start and end with a letter or number';
  if (s.includes('--')) return 'Consecutive hyphens are not allowed';
  if (RESERVED_SUBDOMAINS.includes(s)) return 'This address is reserved';
  return null;
}

/**
 * Extracts the tenant subdomain from a Host header for a given base domain.
 * `mandera.afeypos.com` with base `afeypos.com` => `mandera`.
 * Returns null for the bare domain, for nested subdomains and for unrelated hosts.
 */
export function subdomainFromHost(host: string | undefined, baseDomain: string): string | null {
  if (!host) return null;
  const hostname = host.split(':')[0].toLowerCase().replace(/\.$/, '');
  const base = baseDomain.toLowerCase();
  if (hostname === base || !hostname.endsWith('.' + base)) return null;
  const sub = hostname.slice(0, -(base.length + 1));
  if (sub.includes('.')) return null;
  return sub;
}

export interface PlanDefinition {
  code: string;
  name: string;
  priceMonthlyCents: number;
  currency: string;
  trialDays: number;
  limits: { branches: number; users: number; tills: number; products: number; smsPerMonth: number };
  /** Modules the plan allows; undefined means all. */
  modules?: ModuleKey[];
}

const STARTER_MODULES: ModuleKey[] = MODULES.filter(
  (m) => !['multiBranch', 'multiTill', 'biometrics', 'salesReps', 'loyalty', 'weighedItems'].includes(m),
);

export const DEFAULT_PLANS: PlanDefinition[] = [
  {
    code: 'starter',
    name: 'Starter',
    priceMonthlyCents: 150000,
    currency: 'KES',
    trialDays: 14,
    limits: { branches: 1, users: 3, tills: 1, products: 2000, smsPerMonth: 200 },
    modules: STARTER_MODULES,
  },
  {
    code: 'business',
    name: 'Business',
    priceMonthlyCents: 450000,
    currency: 'KES',
    trialDays: 14,
    limits: { branches: 3, users: 15, tills: 6, products: 20000, smsPerMonth: 2000 },
  },
  {
    code: 'enterprise',
    name: 'Enterprise',
    priceMonthlyCents: 1200000,
    currency: 'KES',
    trialDays: 30,
    limits: { branches: 50, users: 500, tills: 200, products: 500000, smsPerMonth: 20000 },
  },
];

export type TenantStatus = 'trial' | 'active' | 'past_due' | 'suspended' | 'cancelled';
