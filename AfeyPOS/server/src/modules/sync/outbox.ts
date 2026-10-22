import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { SyncOutbox } from '../../models/index.js';

/**
 * Hybrid mode: records a durable, idempotent outbox entry in the same transaction as the business change.
 * The sync job later pushes pending entries to the cloud with their idempotency keys.
 */
export async function recordOutbox(entity: 'sale' | 'stock_movement' | 'customer_payment', entityId: Types.ObjectId, idempotencyKey: string, payload: unknown) {
  if (!env().SYNC_ENABLED) return;
  await SyncOutbox.create([{ entity, entityId, idempotencyKey, payload: JSON.parse(JSON.stringify(payload)) }]);
}
