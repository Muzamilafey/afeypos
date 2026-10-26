/**
 * Card terminal payments: start, follow, cancel, refund and reconcile, provider-independently.
 *
 * Guarantees
 *  - One open transaction per terminal (unique `lockKey`): a terminal never gets a second charge while the
 *    outcome of the first is open or unknown.
 *  - `clientRequestId` makes starting idempotent: a retried request returns the same transaction.
 *  - "approved" is set only from the adapter's transaction status (`query`/`startSale` result) after the
 *    reference, amount and currency match; the cashier, a timeout or a notification body can never set it.
 *  - A timeout leaves the transaction "unknown" (still locked); background checks keep asking the terminal.
 *    Only a reconciler can close an unknown one, and only as "not charged" after checking the terminal's report.
 *  - Checkout links an approved transaction to exactly one sale with an atomic claim.
 */
import crypto from 'node:crypto';
import type { Request } from 'express';
import { Types } from 'mongoose';
import { TERMINAL_ERROR_MESSAGES, terminalTxnOpen, type TerminalTxnStatus } from '@afeypos/shared';
import { env } from '../../config/env.js';
import { PaymentTerminal, TerminalTransaction, Till, type PaymentTerminalDoc, type TerminalTransactionDoc } from '../../models/index.js';
import { AppError, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { decrypt, encrypt } from '../../lib/crypto.js';
import { audit } from '../../lib/audit.js';
import { logger } from '../../lib/logger.js';
import { assertBranchAccess, can } from '../../http/auth.js';
import { enqueue, registerJob } from '../../jobs/queue.js';
import { emitToTenant, emitToTill } from '../../realtime/socket.js';
import { TerminalError, type TerminalAdapter, type TerminalContext, type TerminalProgress } from './adapter.js';
import { adapterFor, providerAvailability } from './registry.js';

// ---------------- secrets & context ----------------

export const sealTerminalSecrets = (id: Types.ObjectId | string, secrets: Record<string, string>) => encrypt(JSON.stringify(secrets), `terminal:${id}`);
export function openTerminalSecrets(t: { _id: unknown; secretsEnc?: string | null }): Record<string, string> {
  if (!t.secretsEnc) return {};
  try {
    return JSON.parse(decrypt(t.secretsEnc, `terminal:${t._id}`));
  } catch {
    return {};
  }
}

export async function loadTerminal(id: unknown) {
  const t = await PaymentTerminal.findOne({ _id: id, removedAt: { $exists: false } }).select('+secretsEnc');
  if (!t) throw notFound('Card terminal');
  return t;
}

export function contextOf(t: PaymentTerminalDoc): TerminalContext {
  return {
    tenantId: String(t.tenantId),
    terminalId: String(t._id),
    mode: t.mode as 'sandbox' | 'live',
    connection: t.connection as TerminalContext['connection'],
    connectionSettings: (t.connectionSettings as Record<string, any>) ?? {},
    device: { model: t.device?.model ?? undefined, serialNumber: t.device?.serialNumber ?? undefined, providerTerminalId: t.device?.providerTerminalId ?? undefined },
    secrets: openTerminalSecrets(t),
  };
}

export const terminalErrorMessage = (e: unknown) => (e instanceof TerminalError ? TERMINAL_ERROR_MESSAGES[e.code] ?? e.message : (e as Error)?.message ?? 'Terminal error');

/** Records the outcome of talking to the terminal on its health panel. */
export async function recordHealth(t: PaymentTerminalDoc, outcome: { ok: true; ready?: boolean } | { ok: false; error: unknown }) {
  const now = new Date();
  const set: Record<string, unknown> = { 'health.lastCheckAt': now };
  if (outcome.ok) Object.assign(set, { 'health.online': true, 'health.ready': outcome.ready ?? true, 'health.lastSuccessAt': now });
  else {
    const code = outcome.error instanceof TerminalError ? outcome.error.code : 'ERROR';
    Object.assign(set, { 'health.online': !['POWERED_OFF', 'UNREACHABLE', 'USB_DISCONNECTED'].includes(code), 'health.ready': false, 'health.lastError': { code, message: terminalErrorMessage(outcome.error), at: now } });
  }
  await PaymentTerminal.updateOne({ _id: t._id }, { $set: set });
  emitToTenant(t.tenantId, 'terminal.health', { id: String(t._id) });
}

// ---------------- presentation ----------------

export function presentTerminal(t: any) {
  return {
    id: t._id, name: t.name, provider: t.provider, mode: t.mode, branchId: t.branchId, tillIds: t.tillIds ?? [], connection: t.connection,
    connectionSettings: t.connectionSettings ?? {}, device: t.device ?? {}, integrationVersion: t.integrationVersion, status: t.status,
    checks: t.checks ?? {}, health: t.health ?? {}, enabledAt: t.enabledAt, createdAt: t.createdAt, updatedAt: t.updatedAt,
    paired: Boolean(t.checks?.paired?.ok),
  };
}

export function presentTxn(x: any) {
  return {
    id: x._id, terminalId: x.terminalId, provider: x.provider, branchId: x.branchId, tillId: x.tillId, kind: x.kind, reference: x.reference,
    amountCents: x.amountCents, currency: x.currency, status: x.status, open: terminalTxnOpen(x.status), sandbox: x.sandbox, verified: x.verified,
    verifiedAt: x.verifiedAt, providerRef: x.providerRef, authCode: x.authCode, cardScheme: x.cardScheme, last4: x.last4, entryMode: x.entryMode,
    message: x.message, removeCard: x.removeCard, connectionLost: x.connectionLost, saleId: x.saleId, saleNumber: x.saleNumber,
    originalTxnId: x.originalTxnId, refundedCents: x.refundedCents ?? 0, resolution: x.resolution, events: x.events ?? [],
    initiatedBy: x.initiatedBy, createdAt: x.createdAt, completedAt: x.completedAt,
  };
}

function broadcast(x: TerminalTransactionDoc) {
  const view = presentTxn(x.toObject ? x.toObject() : x);
  if (x.tillId) emitToTill(x.tenantId, x.tillId, 'terminal.updated', view);
  emitToTenant(x.tenantId, 'terminal.txn', { id: String(x._id), status: x.status });
}

// ---------------- applying terminal results ----------------

const FINAL: TerminalTxnStatus[] = ['approved', 'declined', 'cancelled', 'failed'];

/**
 * Applies what the terminal reported. Idempotent: repeating the same result (duplicate responses or
 * notifications) changes nothing. Approval needs the same reference, amount and currency.
 */
export async function applyProgress(txnId: Types.ObjectId, p: TerminalProgress, source: 'start' | 'query' | 'notification'): Promise<TerminalTransactionDoc> {
  // The answer to "start" is not the confirmation: an approval is accepted only from the status query.
  if (source !== 'query' && p.status === 'approved') p = { ...p, status: 'processing', message: 'Terminal reports approval; confirming the transaction…', authCode: undefined, last4: undefined, cardScheme: undefined };
  for (let attempt = 0; attempt < 3; attempt++) {
    const x = await TerminalTransaction.findById(txnId);
    if (!x) throw notFound('Card payment');
    const now = new Date();
    if (x.status === 'approved') return x; // approval is final: duplicates and later answers change nothing
    const finalBefore = FINAL.includes(x.status as TerminalTxnStatus);
    if (finalBefore && p.status !== 'approved') return x;

    const set: Record<string, unknown> = { connectionLost: false, lastQueriedAt: now };
    const unset: Record<string, 1> = {};
    let status: TerminalTxnStatus = p.status;
    let message = p.message;
    if (p.providerRef) set.providerRef = p.providerRef;
    if (p.status === 'approved') {
      const refOk = !p.reference || p.reference === x.reference;
      const amountOk = p.amountCents === undefined ? false : p.amountCents === x.amountCents;
      const currencyOk = !p.currency || p.currency.toUpperCase() === x.currency.toUpperCase();
      if (!refOk || !amountOk || !currencyOk) {
        // Never trust an approval that does not match what was asked: keep it open for a reconciler.
        status = 'unknown';
        message = `Terminal reported approval that does not match this payment (expected ${x.currency} ${x.amountCents / 100}, reference ${x.reference}). Check the terminal report.`;
      } else {
        Object.assign(set, { verified: true, verifiedAt: now, authCode: p.authCode, cardScheme: p.cardScheme, entryMode: p.entryMode, removeCard: p.removeCard ?? false });
        if (p.last4 && /^\d{4}$/.test(p.last4)) set.last4 = p.last4;
        if (finalBefore) message = `Late approval after "${x.status}": the card was charged. Link it to a sale or refund it.`;
      }
    }
    set.status = status;
    if (message !== undefined) set.message = message;
    if (FINAL.includes(status)) {
      set.completedAt = now;
      unset.lockKey = 1;
    }
    if (status === x.status && (!p.providerRef || p.providerRef === x.providerRef) && (message === undefined || message === x.message)) {
      await TerminalTransaction.updateOne({ _id: x._id }, { $set: { lastQueriedAt: now, connectionLost: false } });
      return (await TerminalTransaction.findById(x._id))!;
    }
    const r = await TerminalTransaction.updateOne(
      { _id: x._id, status: x.status },
      { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}), $push: { events: { status, at: now, source, message } } },
    );
    if (!r.modifiedCount) continue; // another check applied a result at the same moment: re-read and re-apply
    const fresh = (await TerminalTransaction.findById(x._id))!;
    await afterFinal(fresh);
    broadcast(fresh);
    return fresh;
  }
  return (await TerminalTransaction.findById(txnId))!;
}

/** Side effects of a final result: refunds reduce the original; setup tests update the terminal's checks. */
async function afterFinal(x: TerminalTransactionDoc) {
  if (x.kind === 'refund' && x.status === 'approved' && x.verified && x.originalTxnId) {
    const ok = await TerminalTransaction.updateOne(
      { _id: x.originalTxnId, $expr: { $lte: [{ $add: ['$refundedCents', x.amountCents] }, '$amountCents'] } },
      { $inc: { refundedCents: x.amountCents } },
    );
    if (!ok.modifiedCount) logger.error({ txn: String(x._id) }, 'card refund approved above the refundable amount');
  }
  if (x.kind === 'test' && FINAL.includes(x.status as TerminalTxnStatus)) {
    const ok = x.status === 'approved' && x.verified;
    await PaymentTerminal.updateOne({ _id: x.terminalId }, {
      $set: { 'checks.test': { at: new Date(), ok, message: ok ? `Test ${x.sandbox ? 'sandbox ' : ''}payment approved and verified (${x.reference})` : `Test payment ${x.status}${x.message ? `: ${x.message}` : ''}` } },
    });
    if (ok) await PaymentTerminal.updateOne({ _id: x.terminalId, status: 'paired' }, { $set: { status: 'ready' } });
  }
}

function timedOut(x: TerminalTransactionDoc) {
  return Date.now() - new Date(x.createdAt as unknown as Date).getTime() > env().TERMINAL_PAYMENT_TIMEOUT_SECONDS * 1000;
}

/** Asks the terminal for the authoritative status of an open transaction. */
export async function refreshTransaction(x: TerminalTransactionDoc, source: 'query' | 'notification' = 'query'): Promise<TerminalTransactionDoc> {
  // Payments a reconciler closed as "not charged" are still asked about, so a late approval is never missed.
  if (!terminalTxnOpen(x.status) && x.resolution !== 'not_charged') return x;
  const t = await PaymentTerminal.findById(x.terminalId).select('+secretsEnc');
  if (!t) return x;
  let adapter: TerminalAdapter;
  try {
    adapter = adapterFor(t.provider);
  } catch {
    return x;
  }
  await TerminalTransaction.updateOne({ _id: x._id }, { $inc: { queryAttempts: 1 } });
  try {
    const p = await adapter.query(contextOf(t), { reference: x.reference, providerRef: x.providerRef ?? undefined });
    await recordHealth(t, { ok: true });
    return applyProgress(x._id, p, source);
  } catch (err) {
    await recordHealth(t, { ok: false, error: err });
    if (!terminalTxnOpen(x.status)) return x;
    const set: Record<string, unknown> = { connectionLost: true, lastQueriedAt: new Date() };
    const becameUnknown = x.status !== 'unknown' && (timedOut(x) || ['processing', 'awaiting_pin'].includes(x.status));
    if (becameUnknown) Object.assign(set, { status: 'unknown', message: `Lost contact with the terminal: ${terminalErrorMessage(err)}` });
    await TerminalTransaction.updateOne({ _id: x._id }, {
      $set: set,
      $push: { events: { status: becameUnknown ? 'unknown' : x.status, at: new Date(), source: 'system', message: `Connection problem: ${terminalErrorMessage(err)}` } },
    });
    const fresh = (await TerminalTransaction.findById(x._id))!;
    broadcast(fresh);
    return fresh;
  }
}

/** Open transactions past the timeout are shown as "unknown" (still open and locked) until the terminal answers. */
async function markUnknownIfStale(x: TerminalTransactionDoc) {
  if (x.status === 'unknown' || !terminalTxnOpen(x.status) || !timedOut(x)) return x;
  const r = await TerminalTransaction.updateOne({ _id: x._id, status: x.status }, {
    $set: { status: 'unknown', message: 'No final answer from the terminal in time. Checking the transaction…' },
    $push: { events: { status: 'unknown', at: new Date(), source: 'system', message: 'Timed out waiting for the terminal' } },
  });
  const fresh = (await TerminalTransaction.findById(x._id))!;
  if (r.modifiedCount) broadcast(fresh);
  return fresh;
}

async function scheduleCheck(x: TerminalTransactionDoc, delayMs: number) {
  const n = (x.queryAttempts ?? 0) + 1;
  await enqueue('terminals.check', { txnId: String(x._id) }, { runAt: new Date(Date.now() + delayMs), dedupeKey: `terminals.check:${x._id}:${n}`, tenantId: x.tenantId as Types.ObjectId });
}

registerJob('terminals.check', async ({ txnId }: { txnId: string }) => {
  let x = await TerminalTransaction.findById(txnId);
  if (!x || !terminalTxnOpen(x.status)) return;
  x = await refreshTransaction(x);
  x = await markUnknownIfStale(x);
  // Keep checking while open: every few seconds at first, then every half minute.
  if (terminalTxnOpen(x.status)) await scheduleCheck(x, (x.queryAttempts ?? 0) < 30 ? 2000 : 30_000);
});

// ---------------- starting payments ----------------

const newReference = () => `AFY${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

export interface StartInput {
  terminalId: string | Types.ObjectId;
  tillId?: string | Types.ObjectId;
  amountCents: number;
  clientRequestId: string;
  kind: 'sale' | 'test';
}

/** Can this terminal take payments of this kind (provider allowed here, set up, mode)? */
function assertUsable(t: PaymentTerminalDoc, kind: 'sale' | 'test' | 'refund') {
  const a = providerAvailability(t.provider as any);
  if (t.mode === 'live' && a !== 'available') throw unprocessable('This provider is not certified for live payments', 'TERMINAL_PROVIDER_NOT_LIVE');
  if (kind === 'test') {
    if (!['paired', 'ready', 'enabled', 'disabled'].includes(t.status)) throw conflict('Pair the terminal before a test payment', 'TERMINAL_NOT_PAIRED');
  } else if (t.status !== 'enabled') throw conflict('This card terminal is not enabled for payments', 'TERMINAL_NOT_ENABLED');
}

export async function startTerminalPayment(req: Request, input: StartInput) {
  const existing = await TerminalTransaction.findOne({ clientRequestId: input.clientRequestId });
  if (existing) {
    if (String(existing.terminalId) !== String(input.terminalId) || existing.amountCents !== input.amountCents) throw conflict('This request id was already used for another card payment', 'IDEMPOTENCY_MISMATCH');
    return { txn: existing, replay: true };
  }
  const t = await loadTerminal(input.terminalId);
  assertBranchAccess(req, t.branchId);
  assertUsable(t, input.kind);
  let tillId: Types.ObjectId | undefined;
  if (input.kind === 'sale') {
    const till = input.tillId ? await Till.findOne({ _id: input.tillId, active: true }) : null;
    if (!till) throw notFound('Till');
    if (String(till.branchId) !== String(t.branchId) || !t.tillIds.some((id) => String(id) === String(till._id))) throw forbidden('This card terminal is not assigned to this till', 'TERMINAL_NOT_ASSIGNED');
    tillId = till._id;
  }
  const adapter = adapterFor(t.provider);
  const sandbox = t.mode === 'sandbox';
  let x: TerminalTransactionDoc;
  try {
    x = await TerminalTransaction.create({
      terminalId: t._id, provider: t.provider, branchId: t.branchId, tillId, kind: input.kind, reference: newReference(), clientRequestId: input.clientRequestId,
      amountCents: input.amountCents, currency: (req.tenant!.settings?.currency ?? 'KES').toUpperCase(), sandbox, lockKey: t._id, initiatedBy: req.auth!.userId,
      events: [{ status: 'created', at: new Date(), source: 'start' }],
    });
  } catch (err: any) {
    if (err?.code === 11000 && err?.keyPattern?.clientRequestId) return { txn: (await TerminalTransaction.findOne({ clientRequestId: input.clientRequestId }))!, replay: true };
    if (err?.code === 11000 && err?.keyPattern?.lockKey) {
      const open = await TerminalTransaction.findOne({ lockKey: t._id });
      throw new AppError(409, 'TERMINAL_HAS_OPEN_PAYMENT', 'This terminal has a card payment that is not finished. Finish, cancel or reconcile it before starting another.', { transactionId: open?._id, status: open?.status, amountCents: open?.amountCents });
    }
    throw err;
  }
  await audit(req, { action: input.kind === 'test' ? 'terminal.test_started' : 'terminal.payment_started', entity: 'TerminalTransaction', entityId: x._id, details: { reference: x.reference, amountCents: x.amountCents, terminal: t.name, sandbox } });
  try {
    const p = await adapter.startSale(contextOf(t), { reference: x.reference, amountCents: x.amountCents, currency: x.currency, kind: input.kind });
    await recordHealth(t, { ok: true });
    x = await applyProgress(x._id, p, 'start');
    if (p.status === 'approved') x = await refreshTransaction(x);
  } catch (err) {
    await recordHealth(t, { ok: false, error: err });
    const reached = !(err instanceof TerminalError) || err.mayHaveReachedTerminal;
    const message = terminalErrorMessage(err);
    // Known not delivered: nothing can have been charged, the terminal is free again.
    // Possibly delivered: the outcome is unknown until the terminal's record is checked.
    await TerminalTransaction.updateOne({ _id: x._id }, {
      $set: reached ? { status: 'unknown', connectionLost: true, message } : { status: 'failed', message, completedAt: new Date() },
      ...(reached ? {} : { $unset: { lockKey: 1 } }),
      $push: { events: { status: reached ? 'unknown' : 'failed', at: new Date(), source: 'start', message } },
    });
    x = (await TerminalTransaction.findById(x._id))!;
    broadcast(x);
  }
  if (terminalTxnOpen(x.status)) await scheduleCheck(x, 1500);
  return { txn: x, replay: false };
}

// ---------------- cancel, reconcile, refund ----------------

export async function cancelTerminalPayment(req: Request, x: TerminalTransactionDoc) {
  assertBranchAccess(req, x.branchId);
  const own = String(x.initiatedBy) === String(req.auth!.userId);
  if (!own && !can(req, 'terminals.reconcile')) throw forbidden('Only the cashier who started this card payment, or a reconciler, can cancel it');
  if (!terminalTxnOpen(x.status)) throw conflict(`This card payment is already ${x.status}`, 'TERMINAL_TXN_FINAL');
  const t = await loadTerminal(x.terminalId);
  const adapter = adapterFor(t.provider);
  if (!adapter.cancel || !adapter.capabilities.cancel) throw unprocessable('This terminal cannot be cancelled from Afey POS: press Cancel on the terminal itself', 'TERMINAL_CANCEL_NOT_SUPPORTED');
  await TerminalTransaction.updateOne({ _id: x._id }, { $set: { cancelRequestedAt: new Date(), cancelRequestedBy: req.auth!.userId }, $push: { events: { status: x.status, at: new Date(), source: 'cashier', message: 'Cancel requested' } } });
  try {
    await adapter.cancel(contextOf(t), { reference: x.reference, providerRef: x.providerRef ?? undefined });
  } catch (err) {
    throw new AppError(409, 'TERMINAL_CANCEL_FAILED', `The terminal did not accept the cancel: ${terminalErrorMessage(err)}`);
  }
  await audit(req, { action: 'terminal.payment_cancel_requested', entity: 'TerminalTransaction', entityId: x._id, details: { reference: x.reference } });
  // Cancelled only once the terminal itself says so.
  return refreshTransaction((await TerminalTransaction.findById(x._id))!);
}

/**
 * Closing an "unknown" payment that the terminal cannot answer for: allowed only to a reconciler, only after
 * a fresh check, and only as "not charged" (confirmed on the terminal's own report). Approval is never manual.
 */
export async function resolveAsNotCharged(req: Request, x: TerminalTransactionDoc, note: string) {
  assertBranchAccess(req, x.branchId);
  x = await refreshTransaction(x);
  if (!terminalTxnOpen(x.status)) return x;
  if (x.status !== 'unknown' && !timedOut(x)) throw conflict('The terminal is still working on this payment', 'TERMINAL_TXN_IN_PROGRESS');
  const r = await TerminalTransaction.updateOne({ _id: x._id, status: x.status }, {
    $set: { status: 'failed', resolution: 'not_charged', resolvedBy: req.auth!.userId, message: `Marked not charged by a reconciler: ${note}`, completedAt: new Date() },
    $unset: { lockKey: 1 },
    $push: { events: { status: 'failed', at: new Date(), source: 'manager', message: `Not charged (checked on the terminal report): ${note}` } },
  });
  if (!r.modifiedCount) throw conflict('The payment changed while you were reconciling it; check it again', 'TERMINAL_TXN_CHANGED');
  await audit(req, { action: 'terminal.payment_resolved_not_charged', entity: 'TerminalTransaction', entityId: x._id, details: { reference: x.reference, amountCents: x.amountCents, note } });
  const fresh = (await TerminalTransaction.findById(x._id))!;
  broadcast(fresh);
  return fresh;
}

export async function refundTerminalPayment(req: Request, original: TerminalTransactionDoc, input: { amountCents: number; clientRequestId: string; reason: string }) {
  assertBranchAccess(req, original.branchId);
  const existing = await TerminalTransaction.findOne({ clientRequestId: input.clientRequestId });
  if (existing) return existing;
  if (original.kind !== 'sale' || original.status !== 'approved' || !original.verified) throw unprocessable('Only an approved, verified card payment can be refunded', 'TERMINAL_REFUND_NOT_ALLOWED');
  if (input.amountCents <= 0 || input.amountCents > original.amountCents - (original.refundedCents ?? 0)) throw unprocessable('The refund is more than what is left to refund on this payment', 'TERMINAL_REFUND_TOO_MUCH');
  const t = await loadTerminal(original.terminalId);
  assertUsable(t, 'refund');
  const adapter = adapterFor(t.provider);
  if (!adapter.refund || !adapter.capabilities.refund) throw unprocessable('This integration cannot refund from Afey POS: refund on the terminal itself, following the bank’s procedure', 'TERMINAL_REFUND_NOT_SUPPORTED');
  let x: TerminalTransactionDoc;
  try {
    x = await TerminalTransaction.create({
      terminalId: t._id, provider: t.provider, branchId: original.branchId, tillId: original.tillId, kind: 'refund', reference: newReference(), clientRequestId: input.clientRequestId,
      amountCents: input.amountCents, currency: original.currency, sandbox: original.sandbox, lockKey: t._id, originalTxnId: original._id, initiatedBy: req.auth!.userId,
      message: input.reason, events: [{ status: 'created', at: new Date(), source: 'start', message: `Refund: ${input.reason}` }],
    });
  } catch (err: any) {
    if (err?.code === 11000 && err?.keyPattern?.lockKey) throw new AppError(409, 'TERMINAL_HAS_OPEN_PAYMENT', 'This terminal has a card payment that is not finished. Finish or reconcile it first.');
    throw err;
  }
  await audit(req, { action: 'terminal.refund_started', entity: 'TerminalTransaction', entityId: x._id, details: { reference: x.reference, original: original.reference, amountCents: input.amountCents, reason: input.reason, saleNumber: original.saleNumber } });
  try {
    const p = await adapter.refund(contextOf(t), { reference: x.reference, originalReference: original.reference, originalProviderRef: original.providerRef ?? undefined, amountCents: x.amountCents, currency: x.currency });
    x = await applyProgress(x._id, p, 'start');
    if (p.status === 'approved') x = await refreshTransaction(x);
  } catch (err) {
    const reached = !(err instanceof TerminalError) || err.mayHaveReachedTerminal;
    await TerminalTransaction.updateOne({ _id: x._id }, {
      $set: reached ? { status: 'unknown', connectionLost: true, message: terminalErrorMessage(err) } : { status: 'failed', message: terminalErrorMessage(err), completedAt: new Date() },
      ...(reached ? {} : { $unset: { lockKey: 1 } }),
    });
    x = (await TerminalTransaction.findById(x._id))!;
  }
  if (terminalTxnOpen(x.status)) await scheduleCheck(x, 1500);
  return x;
}

// ---------------- checkout ----------------

/**
 * Links an approved, verified terminal payment to a sale (inside the checkout transaction). Each payment can
 * be claimed once; a second sale trying the same payment fails.
 */
export async function claimForSale(input: { txnId: string | Types.ObjectId; amountCents: number; tillId: Types.ObjectId; saleId: Types.ObjectId; saleNumber: string }) {
  const x = await TerminalTransaction.findOneAndUpdate(
    { _id: input.txnId, kind: 'sale', status: 'approved', verified: true, amountCents: input.amountCents, tillId: input.tillId, saleId: { $exists: false } },
    { $set: { saleId: input.saleId, saleNumber: input.saleNumber, linkedAt: new Date() }, $push: { events: { status: 'approved', at: new Date(), source: 'system', message: `Linked to sale ${input.saleNumber}` } } },
    { new: true },
  );
  if (!x) throw unprocessable('This card payment is not approved, does not match the amount, or has already been used for a sale', 'CARD_PAYMENT_NOT_AVAILABLE');
  return x;
}

// ---------------- health monitoring ----------------

export async function checkTerminalHealth(t: PaymentTerminalDoc) {
  try {
    const s = await adapterFor(t.provider).status(contextOf(t));
    await recordHealth(t, { ok: true, ready: s.ready });
    return { ok: true as const, status: s };
  } catch (err) {
    await recordHealth(t, { ok: false, error: err });
    return { ok: false as const, error: err };
  }
}

registerJob('terminals.health', async () => {
  for (const t of await PaymentTerminal.find({ status: 'enabled', removedAt: { $exists: false } }).select('+secretsEnc').limit(500)) await checkTerminalHealth(t);
  // Safety net: open transactions whose check jobs were lost (e.g. the server restarted mid-payment).
  const stale = await TerminalTransaction.find({ status: { $in: ['created', 'connecting', 'awaiting_card', 'awaiting_pin', 'processing', 'unknown'] }, updatedAt: { $lt: new Date(Date.now() - 60_000) } }).limit(200);
  for (const x of stale) await scheduleCheck(x, 0);
  // Payments closed as "not charged" in the last day: ask the terminal again in case it approved them after all.
  const resolved = await TerminalTransaction.find({ resolution: 'not_charged', status: 'failed', completedAt: { $gt: new Date(Date.now() - 24 * 3600_000) } }).limit(100);
  for (const x of resolved) await refreshTransaction(x).catch(() => undefined);
});
