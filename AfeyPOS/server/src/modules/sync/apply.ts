/** Applies replicated records on either side: newest wins, plus the few side effects replication needs. */
import { BSON } from 'mongodb';
import { Types } from 'mongoose';
import { Customer, LedgerEntry, Supplier, SyncConflict } from '../../models/index.js';
import { adjustInTransit } from '../inventory/stock.js';
import { ownsWarehouse } from './ownership.js';
import type { SyncSpec } from './spec.js';

export const EJSON = BSON.EJSON;
export const toWire = (v: unknown) => EJSON.stringify(v, { relaxed: false });
export const fromWire = <T = any>(text: string): T => EJSON.parse(text, { relaxed: true }) as T;

export type ApplyOutcome = 'applied' | 'unchanged' | 'stale' | 'conflict';

/**
 * Replaces the local copy if the incoming one is at least as new (by the spec's timestamp field).
 * Uses the native driver so the record is stored exactly as received (ids, dates, fields).
 */
export async function applyRecord(spec: SyncSpec, doc: any, side: 'hq' | 'branch', branchCode?: string): Promise<{ outcome: ApplyOutcome; previous?: any }> {
  const coll = spec.model.collection;
  const t = doc[spec.field] ?? new Date(0);
  const previous = await coll.findOne({ _id: doc._id });
  if (previous && previous[spec.field] && previous[spec.field] > t) return { outcome: 'stale', previous };
  try {
    const r = await coll.replaceOne({ _id: doc._id }, doc, { upsert: true });
    return { outcome: r.upsertedCount || r.modifiedCount ? 'applied' : 'unchanged', previous };
  } catch (err: any) {
    await SyncConflict.create({ side, branchCode, collectionName: coll.collectionName, docId: doc._id, reason: String(err?.message ?? err).slice(0, 500) });
    return { outcome: 'conflict', previous };
  }
}

/**
 * A transfer replicated to the server that owns its destination: count the goods as in transit there when it
 * is dispatched (and undo that if it is cancelled). Receiving happens on that same server, which clears it.
 */
export async function afterTransferReplicated(previous: any, next: any) {
  if (!(await ownsWarehouse(next.toWarehouseId))) return;
  const was = previous?.status;
  const now = next.status;
  if (was !== 'in_transit' && now === 'in_transit') for (const l of next.lines ?? []) await adjustInTransit(l.productId, next.toWarehouseId, l.qty ?? 0);
  if (was === 'in_transit' && now === 'cancelled') for (const l of next.lines ?? []) await adjustInTransit(l.productId, next.toWarehouseId, -(l.qty ?? 0));
}

/** HQ: customer and supplier balances are the sum of their ledger, whichever servers posted the entries. */
export async function recomputeBalances(parties: { type: 'customer' | 'supplier'; id: string }[]) {
  const seen = new Set<string>();
  for (const p of parties) {
    const key = `${p.type}:${p.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const [row] = await LedgerEntry.aggregate([{ $match: { partyType: p.type, partyId: new Types.ObjectId(p.id) } }, { $group: { _id: null, total: { $sum: '$amountCents' } } }]);
    if (!row) continue; // never zero a balance that was not built from ledger entries
    const balance = row.total;
    const model = p.type === 'customer' ? Customer : Supplier;
    await (model as typeof Customer).updateOne({ _id: p.id, balanceCents: { $ne: balance } }, { $set: { balanceCents: balance } });
  }
}

/**
 * Branch: keep the local balance (and points) of a customer/supplier whose newer local ledger entries have not
 * reached HQ yet; HQ's figure would otherwise drop them until the next round trip.
 */
export async function mergePartyBalance(collection: 'customers' | 'suppliers', doc: any, previous: any, unsentSince: Date) {
  if (!previous) return doc;
  const pending = await LedgerEntry.exists({ partyType: collection === 'customers' ? 'customer' : 'supplier', partyId: doc._id, updatedAt: { $gt: unsentSince } });
  if (!pending) return doc;
  return { ...doc, balanceCents: previous.balanceCents, ...(collection === 'customers' ? { loyaltyPoints: previous.loyaltyPoints } : {}) };
}

