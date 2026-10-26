import type { ErrorRequestHandler } from 'express';
import mongoose from 'mongoose';
import { AppError } from '../lib/errors.js';
import { TenantContextError } from '../lib/context.js';
import { logger } from '../lib/logger.js';
import { audit } from '../lib/audit.js';

// One audit entry per user, rule and path per minute is enough to see attempts without flooding the log.
const lastDenied = new Map<string, number>();
function recordDenied(req: Parameters<ErrorRequestHandler>[1], err: AppError) {
  const a = req.auth;
  if (!a) return;
  const key = `${a.userId}:${err.code}:${err.message}:${req.method} ${req.route?.path ?? req.path}`;
  const now = Date.now();
  if ((lastDenied.get(key) ?? 0) > now - 60_000) return;
  lastDenied.set(key, now);
  if (lastDenied.size > 5000) lastDenied.clear();
  audit(req, { action: 'access.denied', details: { reason: err.message, code: err.code, method: req.method, path: req.originalUrl.split('?')[0] } }).catch((e) => logger.warn({ err: e }, 'could not record denied access'));
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof AppError) {
    if (err.status === 403 && err.code !== 'MODULE_DISABLED') recordDenied(req, err);
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details, requestId: req.id } });
    return;
  }
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON body', requestId: req.id } });
    return;
  }
  if (err?.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'TOO_LARGE', message: 'Request body too large', requestId: req.id } });
    return;
  }
  if (err?.code === 11000) {
    const fields = Object.keys(err.keyPattern ?? {}).filter((k) => k !== 'tenantId');
    res.status(409).json({ error: { code: 'DUPLICATE', message: `A record with the same ${fields.join(', ') || 'value'} already exists`, details: { fields }, requestId: req.id } });
    return;
  }
  if (err instanceof mongoose.Error.ValidationError) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Validation failed', details: Object.values(err.errors).map((e) => ({ path: e.path, message: e.message })), requestId: req.id } });
    return;
  }
  if (err instanceof mongoose.Error.CastError) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: `Invalid value for ${err.path}`, requestId: req.id } });
    return;
  }
  if (err instanceof TenantContextError) {
    logger.error({ err, requestId: req.id, path: req.path }, 'tenant context violation');
    res.status(403).json({ error: { code: 'TENANT_SCOPE', message: 'Tenant scope violation', requestId: req.id } });
    return;
  }
  logger.error({ err, requestId: req.id, path: req.path }, 'unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL', message: 'An unexpected error occurred', requestId: req.id } });
};
