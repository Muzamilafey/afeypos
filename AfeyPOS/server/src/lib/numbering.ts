import { Counter } from '../models/index.js';

/** Sequential, gap-tolerant document numbers per tenant (e.g. SAL-000123). Runs inside the caller's transaction. */
export async function nextNumber(key: string, prefix: string, pad = 6): Promise<string> {
  const c = await Counter.findOneAndUpdate({ key }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  return `${prefix}-${String(c!.seq).padStart(pad, '0')}`;
}
