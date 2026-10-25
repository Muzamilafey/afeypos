import type { Request } from 'express';
import { AuditLog } from '../models/index.js';

export interface AuditInput {
  action: string;
  entity?: string;
  entityId?: unknown;
  details?: Record<string, unknown>;
  supervisorId?: unknown;
}

/** Writes a tenant audit entry within the current tenant context (and current transaction, if any). */
export async function audit(req: Request | null, input: AuditInput): Promise<void> {
  const a = req?.auth;
  await AuditLog.create({
    action: input.action,
    entity: input.entity,
    entityId: input.entityId ? String(input.entityId) : undefined,
    actor: a ? { kind: 'user', id: a.userId, name: a.name } : { kind: 'system', name: 'system' },
    supervisorId: input.supervisorId,
    ip: req?.ip,
    details: input.details,
  });
}
