import { Counter } from '../models/index.js';
import { env } from '../config/env.js';

/**
 * Sequential, gap-tolerant document number (e.g. RCP-000123); runs inside the caller's transaction. Branch servers number independently, so their numbers carry
 * the branch code (RCP-MSA01-000123) and never collide with head office or other branches after sync.
 */
export async function nextNumber(key: string, prefix: string, pad = 6): Promise<string> {
  const c = await Counter.findOneAndUpdate({ key }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  const e = env();
  const branch = e.DEPLOYMENT_MODE === 'branch' && e.BRANCH_CODE ? `${e.BRANCH_CODE.toUpperCase()}-` : '';
  return `${prefix}-${branch}${String(c!.seq).padStart(pad, '0')}`;
}
