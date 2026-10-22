import type { Request } from 'express';
import { AuditLog, PlatformAuditLog } from '../models/index.js';
import { currentContext } from './context.js';
import { logger } from './logger.js';

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
    actor: a ? { kind: a.kind === 'tenant' ? 'user' : a.kind, id: a.userId, name: a.name } : { kind: 'system', name: 'system' },
    supervisorId: input.supervisorId,
    supportGrantId: a?.supportGrantId,
    ip: req?.ip,
    details: input.details,
  });
}

export async function platformAudit(req: Request | null, action: string, details: Record<string, unknown> = {}, tenantId?: unknown) {
  const a = req?.auth;
  try {
    await PlatformAuditLog.create({ action, tenantId, actor: a ? { kind: a.kind, id: a.userId, name: a.name } : { kind: 'system' }, ip: req?.ip, details });
  } catch (err) {
    logger.error({ err, action, requestId: currentContext()?.requestId }, 'failed to write platform audit log');
  }
}
