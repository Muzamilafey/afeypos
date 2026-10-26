/**
 * Branch isolation for users limited to some branches (User.branchIds).
 *
 * When the request context carries a branch scope (set by `authenticate` for restricted users), every query and
 * aggregate on a branch-owned model is limited to records of those branches or their warehouses, and new records
 * outside them are refused. Like tenant isolation, this sits under the routes, so a route that forgets to filter
 * still cannot show or change another branch's sales, stock, shifts or orders.
 *
 * A model lists the fields that tie a record to a branch; a record is in scope when any of them is. Steps that must
 * legitimately touch another branch after the route has authorised them use runUnscoped().
 */
import type { Schema, Query, Aggregate } from 'mongoose';
import type { Types } from 'mongoose';
import { currentContext } from '../lib/context.js';
import { AppError } from '../lib/errors.js';

export type ScopeField = { path: string; kind: 'branch' | 'warehouse' };

const QUERY_OPS = ['countDocuments', 'deleteMany', 'deleteOne', 'distinct', 'find', 'findOne', 'findOneAndDelete', 'findOneAndReplace', 'findOneAndUpdate', 'replaceOne', 'updateMany', 'updateOne'] as const;

function scopeIds(f: ScopeField): Types.ObjectId[] | null {
  const s = currentContext()?.branchScope;
  if (!s) return null;
  return f.kind === 'branch' ? s.branchIds : s.warehouseIds;
}

function condition(fields: ScopeField[]) {
  const ors = fields.map((f) => ({ [f.path]: { $in: scopeIds(f)! } }));
  return ors.length === 1 ? ors[0]! : { $or: ors };
}

const inScope = (fields: ScopeField[], get: (path: string) => unknown) =>
  fields.some((f) => {
    const v = get(f.path);
    return v != null && scopeIds(f)!.some((id) => String(id) === String(v));
  });

/** A plain id in a filter (not an operator object such as { $in: [...] }). */
const isId = (v: unknown) => v != null && (typeof v !== 'object' || (v as { _bsontype?: string })._bsontype === 'ObjectId');

const outOfBranch = () => new AppError(403, 'BRANCH_FORBIDDEN', 'You do not have access to this branch');

export function branchScopePlugin(schema: Schema, opts: { fields: ScopeField[] }) {
  const { fields } = opts;
  for (const op of QUERY_OPS) {
    schema.pre(op as 'find', function (this: Query<unknown, unknown>) {
      if (!currentContext()?.branchScope) return;
      // An upsert must not create a record in another branch (the filter names its branch or warehouse).
      if (this.getOptions().upsert) {
        const filter = this.getFilter() as Record<string, unknown>;
        const named = fields.filter((f) => isId(filter[f.path]));
        if (named.length && !inScope(named, (p) => filter[p])) throw outOfBranch();
      }
      this.and([condition(fields)]);
    });
  }
  schema.pre('aggregate', function (this: Aggregate<unknown>) {
    if (!currentContext()?.branchScope) return;
    // Right after the tenant $match added by the tenant plugin (both are plain $match stages).
    this.pipeline().unshift({ $match: condition(fields) });
  });
  schema.pre('validate', function () {
    if (!currentContext()?.branchScope || !this.isNew) return;
    if (!inScope(fields, (p) => this.get(p))) throw outOfBranch();
  });
  schema.pre('insertMany', function (next: (err?: Error) => void, docs: any[]) {
    if (currentContext()?.branchScope && docs.some((d) => !inScope(fields, (p) => d?.[p]))) return next(outOfBranch());
    next();
  });
}
