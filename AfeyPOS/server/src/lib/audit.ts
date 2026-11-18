import type { Request } from 'express';
import type { Types } from 'mongoose';
import { AuditLog, Counter } from '../models/index.js';
import { env } from '../config/env.js';
import { currentContext } from './context.js';
import { hmacSha256 } from './crypto.js';

export interface AuditInput {
  action: string;
  entity?: string;
  entityId?: unknown;
  details?: Record<string, unknown>;
  supervisorId?: unknown;
}

/** Which server wrote an entry: each numbers its own entries (branch servers sync theirs up to head office). */
export const auditOrigin = () => (env().DEPLOYMENT_MODE === 'branch' && env().BRANCH_CODE ? env().BRANCH_CODE!.toUpperCase() : 'main');

/** The signed text of an entry. Anything changed in it afterwards no longer matches its signature. */
export function auditSigningText(e: { tenantId?: unknown; origin?: string | null; seq?: number | null; action: string; entity?: string | null; entityId?: string | null; actor?: { kind?: string | null; id?: unknown; name?: string | null } | null; supervisorId?: unknown; at: Date; details?: unknown }) {
  return JSON.stringify([String(e.tenantId ?? ''), e.origin ?? '', e.seq ?? 0, e.action, e.entity ?? null, e.entityId ?? null, e.actor?.kind ?? null, e.actor?.id ? String(e.actor.id) : null, e.actor?.name ?? null, e.supervisorId ? String(e.supervisorId) : null, new Date(e.at).toISOString(), e.details ?? null]);
}

export const auditSignature = (text: string) => hmacSha256(env().ENCRYPTION_KEY, text);

/** Writes a tenant audit entry within the current tenant context (and current transaction, if any). */
export async function audit(req: Request | null, input: AuditInput): Promise<void> {
  const a = req?.auth;
  const origin = auditOrigin();
  const c = await Counter.findOneAndUpdate({ key: `audit:${origin}` }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  // Round-trip through JSON so the signed details are exactly what is stored and read back.
  const details = input.details === undefined ? undefined : JSON.parse(JSON.stringify(input.details));
  const entry = {
    action: input.action,
    entity: input.entity,
    entityId: input.entityId ? String(input.entityId) : undefined,
    actor: a ? { kind: 'user', id: a.userId, name: a.name } : { kind: 'system', name: 'system' },
    supervisorId: input.supervisorId as Types.ObjectId | undefined,
    ip: req?.ip,
    details,
    at: new Date(),
    origin,
    seq: c!.seq,
  };
  const sig = auditSignature(auditSigningText({ ...entry, tenantId: currentContext()?.tenantId }));
  await AuditLog.create({ ...entry, sig });
}
