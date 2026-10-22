import { Types } from 'mongoose';
import { IntegrationConfig, type IntegrationConfigDoc } from '../../models/index.js';
import { decrypt, encrypt } from '../../lib/crypto.js';

export type IntegrationKind = 'mpesa' | 'sms' | 'email';

export function sealSecrets(id: Types.ObjectId, secrets: Record<string, unknown>): string {
  return encrypt(JSON.stringify(secrets), String(id));
}

export function openSecrets(cfg: Pick<IntegrationConfigDoc, '_id' | 'secretsEnc'>): Record<string, any> {
  if (!cfg.secretsEnc) return {};
  return JSON.parse(decrypt(cfg.secretsEnc, String(cfg._id)));
}

/** Picks the enabled config for a branch, falling back to the tenant default. */
export async function findActiveConfig(kind: IntegrationKind, branchId?: Types.ObjectId | null) {
  const configs = await IntegrationConfig.find({ kind, enabled: true }).sort({ isDefault: -1, createdAt: 1 });
  if (branchId) {
    const forBranch = configs.find((c) => c.branchIds.some((b) => String(b) === String(branchId)));
    if (forBranch) return forBranch;
  }
  return configs.find((c) => c.branchIds.length === 0) ?? configs[0] ?? null;
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
    settings: c.settings,
    secretsSet: secretKeys,
    lastTest: c.lastTest,
  };
}
