import { AsyncLocalStorage } from 'node:async_hooks';
import { Types } from 'mongoose';

export interface RequestContext {
  tenantId?: Types.ObjectId;
  /** Explicit, audited escape hatch for platform-level operations that must see all tenants. */
  platform?: boolean;
  userId?: Types.ObjectId;
  requestId?: string;
  /** Set for users limited to some branches: branch-owned records outside these are invisible and read-only. */
  branchScope?: { branchIds: Types.ObjectId[]; warehouseIds: Types.ObjectId[] };
}

const als = new AsyncLocalStorage<RequestContext>();

export function currentContext(): RequestContext | undefined {
  return als.getStore();
}

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return als.run(ctx, fn);
}

/** Mongoose queries are lazy thenables: execute them inside the context, not when awaited later. */
function execInside<T>(fn: () => T): () => T {
  return () => {
    const r = fn() as any;
    return (r && typeof r.exec === 'function' ? r.exec() : r) as T;
  };
}

export function runInTenant<T>(tenantId: Types.ObjectId | string, fn: () => T): T {
  const parent = als.getStore();
  return als.run({ ...parent, tenantId: new Types.ObjectId(String(tenantId)), platform: false }, execInside(fn));
}

/**
 * Runs internal steps that legitimately touch another branch's records after the route has checked access
 * (e.g. receiving a stock transfer reduces the sending warehouse's in-transit stock).
 */
export function runUnscoped<T>(fn: () => T): T {
  const parent = als.getStore();
  return als.run({ ...parent, branchScope: undefined }, execInside(fn));
}

export function runAsPlatform<T>(fn: () => T): T {
  const parent = als.getStore();
  return als.run({ ...parent, tenantId: undefined, platform: true }, execInside(fn));
}

export class TenantContextError extends Error {
  constructor() {
    super('Tenant context is required for this operation');
  }
}

export function requireTenantId(): Types.ObjectId {
  const t = als.getStore()?.tenantId;
  if (!t) throw new TenantContextError();
  return t;
}
