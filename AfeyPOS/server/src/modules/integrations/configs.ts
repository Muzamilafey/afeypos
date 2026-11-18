import { Types } from 'mongoose';
import { IntegrationConfig, type IntegrationConfigDoc } from '../../models/index.js';
import { decrypt, encrypt } from '../../lib/crypto.js';

export type IntegrationKind = 'mpesa' | 'payment' | 'etims' | 'sms' | 'email';

export function sealSecrets(id: Types.ObjectId, secrets: Record<string, unknown>): string {
  return encrypt(JSON.stringify(secrets), String(id));
}

export function openSecrets(cfg: Pick<IntegrationConfigDoc, '_id' | 'secretsEnc'>): Record<string, any> {
  if (!cfg.secretsEnc) return {};
  return JSON.parse(decrypt(cfg.secretsEnc, String(cfg._id)));
}

/**
 * Picks the enabled config for a till or branch: one set up for that till, else its branch's (shared by all the
 * branch's tills), else the one for every branch. A till or branch never borrows another branch's own config.
 * Without a branch (e.g. salary payouts) the default config is used.
 */
export async function findActiveConfig(kind: IntegrationKind, branchId?: Types.ObjectId | null, tillId?: Types.ObjectId | string | null) {
  const configs = await IntegrationConfig.find({ kind, enabled: true }).sort({ isDefault: -1, createdAt: 1 });
  const same = (a: unknown, b: unknown) => String(a) === String(b);
  if (tillId) {
    const forTill = configs.find((c) => (c.tillIds ?? []).some((t) => same(t, tillId)));
    if (forTill) return forTill;
  }
  const general = configs.filter((c) => !(c.tillIds ?? []).length);
  if (branchId) {
    const forBranch = general.find((c) => c.branchIds.some((b) => same(b, branchId)));
    if (forBranch) return forBranch;
    return general.find((c) => c.branchIds.length === 0) ?? null;
  }
  return general.find((c) => c.branchIds.length === 0) ?? general[0] ?? null;
}

/** Every M-Pesa account a till may use: its own, then its branch's, then the ones for all branches. */
export async function configsForTill(kind: IntegrationKind, branchId?: Types.ObjectId | null, tillId?: Types.ObjectId | string | null) {
  const configs = await IntegrationConfig.find({ kind, enabled: true }).sort({ isDefault: -1, createdAt: 1 });
  const same = (a: unknown, b: unknown) => String(a) === String(b);
  const own = tillId ? configs.filter((c) => (c.tillIds ?? []).some((t) => same(t, tillId))) : [];
  const general = configs.filter((c) => !(c.tillIds ?? []).length);
  const branch = branchId ? general.filter((c) => c.branchIds.some((b) => same(b, branchId))) : [];
  const all = general.filter((c) => c.branchIds.length === 0);
  // A till's own account comes first, then its branch's, then the shared ones; the first is the default.
  const seen = new Set<string>();
  return [...own, ...branch, ...all].filter((c) => !seen.has(String(c._id)) && seen.add(String(c._id)));
}

/** API representation: never exposes secrets, only which secret fields are set. */
export function presentConfig(c: IntegrationConfigDoc) {
  const secretKeys = Object.keys(openSecrets(c));
  return {
    id: c._id,
    kind: c.kind,
    provider: c.provider,
    name: c.name,
    enabled: c.enabled,
    isDefault: c.isDefault,
    environment: c.environment,
    branchIds: c.branchIds,
    tillIds: c.tillIds ?? [],
    settings: c.settings,
    secretsSet: secretKeys,
    lastTest: c.lastTest,
    ...(c.kind === 'mpesa' ? { c2bRegistration: c.c2bRegistration?.at ? c.c2bRegistration : null } : {}),
  };
}
