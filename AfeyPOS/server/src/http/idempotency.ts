import type { RequestHandler } from 'express';
import { IdempotencyRecord } from '../models/index.js';
import { sha256 } from '../lib/crypto.js';
import { conflict, unprocessable } from '../lib/errors.js';
import { runInTenant } from '../lib/context.js';

/**
 * Idempotency-Key support for mutating endpoints. Retries with the same key and body replay the
 * stored response; the same key with a different body is rejected. Failed requests release the key.
 */
export function idempotent(scope: string): RequestHandler {
  return async (req, res, next) => {
    const key = req.get('idempotency-key');
    if (!key) return next();
    if (key.length > 200) throw unprocessable('Idempotency-Key is too long');
    const requestHash = sha256(JSON.stringify(req.body ?? {}));
    try {
      await IdempotencyRecord.create({ key, scope, requestHash });
    } catch (err: any) {
      if (err?.code !== 11000) throw err;
      const rec = await IdempotencyRecord.findOne({ key, scope }).lean();
      if (!rec) throw conflict('Request is being processed, retry shortly', 'IDEMPOTENCY_IN_PROGRESS');
      if (rec.requestHash !== requestHash) throw unprocessable('Idempotency-Key was reused with a different request', 'IDEMPOTENCY_MISMATCH');
      if (rec.status !== 'completed') throw conflict('Request is being processed, retry shortly', 'IDEMPOTENCY_IN_PROGRESS');
      res.setHeader('Idempotent-Replay', 'true');
      res.status(rec.responseStatus ?? 200).json(rec.responseBody);
      return;
    }
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      const status = res.statusCode;
      const tenantId = req.tenant!._id;
      const p = runInTenant(tenantId, () =>
        status < 300
          ? IdempotencyRecord.updateOne({ key, scope }, { $set: { status: 'completed', responseStatus: status, responseBody: JSON.parse(JSON.stringify(body ?? null)) } }).exec()
          : IdempotencyRecord.deleteOne({ key, scope }).exec(),
      );
      p.catch(() => undefined).finally(() => json(body));
      return res;
    };
    next();
  };
}
