/**
 * Which server owns which branch's stock.
 *
 * - standalone: everything.
 * - branch: only the warehouses of its own branch (BRANCH_CODE).
 * - hq: every warehouse except those of branches that run their own server (Branch.hasServer).
 *
 * Stock in a warehouse changes only on its owning server; other servers hold a read-only replica that
 * sync keeps up to date. This keeps quantities consistent without merging concurrent stock edits.
 */
import type { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { Branch, Warehouse } from '../../models/index.js';
import { AppError } from '../../lib/errors.js';
import { currentContext } from '../../lib/context.js';

let cache: { at: number; tenant: string; owned: Set<string>; serverBranches: Map<string, string> } | null = null;

export function invalidateOwnership() {
  cache = null;
}

async function load() {
  const tenant = String(currentContext()?.tenantId ?? '');
  if (cache && cache.tenant === tenant && Date.now() - cache.at < 15_000) return cache;
  const e = env();
  const branches = await Branch.find({}, { code: 1, hasServer: 1 }).lean();
  const warehouses = await Warehouse.find({}, { branchId: 1 }).lean();
  const ownedBranches = new Set(
    branches
      .filter((b) => (e.DEPLOYMENT_MODE === 'branch' ? b.code === e.BRANCH_CODE?.toUpperCase() : e.DEPLOYMENT_MODE === 'hq' ? !b.hasServer : true))
      .map((b) => String(b._id)),
  );
  const serverBranches = new Map(branches.filter((b) => b.hasServer).map((b) => [String(b._id), b.code]));
  cache = { at: Date.now(), tenant, owned: new Set(warehouses.filter((w) => ownedBranches.has(String(w.branchId))).map((w) => String(w._id))), serverBranches };
  // Warehouses created after the cache was filled are checked on demand below.
  return cache;
}

export async function ownsWarehouse(warehouseId: Types.ObjectId | string): Promise<boolean> {
  if (env().DEPLOYMENT_MODE === 'standalone') return true;
  const c = await load();
  if (c.owned.has(String(warehouseId))) return true;
  const w = await Warehouse.findById(warehouseId, { branchId: 1 }).lean();
  if (!w) return false;
  const b = await Branch.findById(w.branchId, { code: 1, hasServer: 1 }).lean();
  const e = env();
  const owned = e.DEPLOYMENT_MODE === 'branch' ? b?.code === e.BRANCH_CODE?.toUpperCase() : !b?.hasServer;
  if (owned) c.owned.add(String(warehouseId));
  return owned;
}

export async function assertWarehouseOwned(warehouseId: Types.ObjectId | string) {
  if (await ownsWarehouse(warehouseId)) return;
  const e = env();
  const w = await Warehouse.findById(warehouseId, { branchId: 1 }).lean();
  const b = w ? await Branch.findById(w.branchId, { name: 1, code: 1 }).lean() : null;
  if (!w || !b) {
    throw new AppError(409, 'STOCK_LOCATION_MISSING', 'This store (warehouse) or its branch is not on this server yet. Open Administration → Branch sync and press "Download everything again".');
  }
  throw new AppError(
    409,
    'STOCK_OWNED_ELSEWHERE',
    e.DEPLOYMENT_MODE === 'branch'
      ? `This till belongs to ${b.name} (${b.code}), but this server runs branch ${e.BRANCH_CODE?.toUpperCase()}. Choose one of branch ${e.BRANCH_CODE?.toUpperCase()}'s tills (Change till), or set BRANCH_CODE to ${b.code} if this PC is in ${b.name}.`
      : `${b.name} runs its own server; record its sales and stock changes on the branch system`,
  );
}

/** Branch server: this server's branch record (after the first sync). */
export async function localBranch() {
  const code = env().BRANCH_CODE?.toUpperCase();
  return code ? Branch.findOne({ code }).lean() : null;
}
