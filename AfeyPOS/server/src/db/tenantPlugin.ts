/**
 * Server-side tenant isolation.
 *
 * Every tenant-owned schema uses this plugin. It adds an immutable `tenantId` and, for every
 * query, aggregate, insert and save, injects/validates the tenant from the async request context.
 * If no tenant context exists the operation fails closed with TenantContextError - unless the
 * caller explicitly entered platform scope with runAsPlatform() (used by audited platform
 * operations and the job scheduler, which then re-enters a specific tenant per job).
 */
import { Schema, Types, type Query, type Aggregate } from 'mongoose';
import { currentContext, TenantContextError } from '../lib/context.js';

const QUERY_OPS = [
  'countDocuments', 'deleteMany', 'deleteOne', 'distinct', 'find', 'findOne', 'findOneAndDelete',
  'findOneAndReplace', 'findOneAndUpdate', 'replaceOne', 'updateMany', 'updateOne',
] as const;

function scope(): { tenantId?: Types.ObjectId; platform: boolean } {
  const ctx = currentContext();
  if (ctx?.tenantId) return { tenantId: ctx.tenantId, platform: false };
  if (ctx?.platform) return { platform: true };
  throw new TenantContextError();
}

export function tenantPlugin(schema: Schema) {
  schema.add({ tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, immutable: true, index: true } });

  for (const op of QUERY_OPS) {
    schema.pre(op as 'find', function (this: Query<unknown, unknown>) {
      const s = scope();
      if (s.tenantId) {
        const existing = this.getFilter().tenantId;
        if (existing && String(existing) !== String(s.tenantId)) throw new TenantContextError();
        this.where({ tenantId: s.tenantId });
        const update = this.getUpdate() as Record<string, any> | null;
        if (update && !Array.isArray(update)) {
          for (const k of ['$set', '$setOnInsert']) if (update[k]?.tenantId && String(update[k].tenantId) !== String(s.tenantId)) throw new TenantContextError();
          if ((op as string) === 'findOneAndUpdate' || (op as string) === 'updateOne' || (op as string) === 'updateMany') {
            // Upserts must create the document inside the current tenant.
            if (this.getOptions().upsert) this.setUpdate({ ...update, $setOnInsert: { ...(update.$setOnInsert ?? {}), tenantId: s.tenantId } });
          }
        }
      }
    });
  }

  schema.pre('aggregate', function (this: Aggregate<unknown>) {
    const s = scope();
    if (s.tenantId) this.pipeline().unshift({ $match: { tenantId: s.tenantId } });
  });

  schema.pre('validate', function () {
    const s = scope();
    if (s.tenantId) {
      if (!this.get('tenantId')) this.set('tenantId', s.tenantId);
      else if (String(this.get('tenantId')) !== String(s.tenantId)) throw new TenantContextError();
    }
  });

  schema.pre('insertMany', function (next: (err?: Error) => void, docs: any[]) {
    try {
      const s = scope();
      if (s.tenantId) {
        for (const d of docs) {
          if (!d.tenantId) d.tenantId = s.tenantId;
          else if (String(d.tenantId) !== String(s.tenantId)) throw new TenantContextError();
        }
      }
      next();
    } catch (e) {
      next(e as Error);
    }
  });

  schema.pre('bulkWrite', function () {
    // bulkWrite bypasses per-operation scoping; forbid it inside tenant context.
    if (scope().tenantId) throw new Error('bulkWrite is not allowed on tenant-scoped models');
  });
}
