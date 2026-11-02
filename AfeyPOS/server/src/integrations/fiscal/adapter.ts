/**
 * Manufacturer-neutral fiscal device layer.
 *
 * Every fiscal device or service (KRA eTIMS OSCU, a VSCU on the shop network, a TIMS ETR device reached through
 * its maker's program, the simulators) is wrapped in a FiscalAdapter. Each adapter states what it can actually do
 * in getCapabilities(); operations it cannot do throw FiscalUnsupportedError instead of pretending. Nothing here
 * sends a command a device's documentation does not describe.
 */
import { IntegrationError } from '../http.js';
import type { EtimsSale, EtimsSignature } from '../etims/client.js';

/** What a device or service can do. Only what its documentation (or our own simulator) supports is true. */
export interface FiscalCapabilities {
  submitInvoice: boolean;
  submitCreditNote: boolean;
  submitDebitNote: boolean;
  cancelTransaction: boolean;
  /** Can be asked whether it already recorded a given invoice (used before any retry of an uncertain send). */
  transactionStatus: boolean;
  lastFiscalReceipt: boolean;
  deviceInfo: boolean;
  initialize: boolean;
  itemRegistration: boolean;
  /**
   * Sending the same invoice again cannot create a second fiscal record: the device or KRA refuses the same
   * invoice number, or the exchange itself never re-sends (folder exchange).
   */
  safeResend: boolean;
  /** Reached from this computer only (USB / serial / local program), so only the shop's server can use it. */
  localOnly: boolean;
}

export type FiscalKind = 'oscu' | 'vscu' | 'etr_http' | 'etr_folder' | 'etr_simulator' | 'mock';

/** Fiscal states of a sale or credit note. "signed" is the stored value for Fiscalized (kept for older records). */
export const FISCAL_STATUSES = ['pending', 'processing', 'signed', 'rejected', 'failed', 'awaiting_confirmation', 'device_disconnected', 'requires_reconciliation'] as const;
export type FiscalStatus = (typeof FISCAL_STATUSES)[number];
/** Still on its way: the job queue keeps working on these. */
export const FISCAL_OPEN: FiscalStatus[] = ['pending', 'processing', 'awaiting_confirmation', 'device_disconnected'];
/** Need a person: KRA/device refused it, it could not be sent, or nobody can tell whether it was recorded. */
export const FISCAL_NEEDS_ATTENTION: FiscalStatus[] = ['rejected', 'failed', 'requires_reconciliation'];

export interface DeviceStatus {
  state: 'online' | 'offline' | 'unknown';
  message: string;
}

export interface DeviceInfo {
  kind: FiscalKind;
  label: string;
  serial?: string;
  sdcId?: string;
  mrcNo?: string;
  taxpayer?: string;
  branch?: string;
  /** Where Afey POS reaches it (address or folder). Never contains a key. */
  endpoint?: string;
}

/** The fiscal answer: what the device or KRA returned. Never made up by Afey POS. */
export type FiscalSignature = EtimsSignature & { cuInvoiceNo?: string; cuSerial?: string; qrUrl?: string };

/** The result of asking whether an invoice was already recorded. */
export type StatusAnswer = { found: true; signature: FiscalSignature; raw?: unknown } | { found: false; raw?: unknown };

export interface FiscalAdapter {
  readonly kind: FiscalKind;
  getCapabilities(): FiscalCapabilities;
  /** No-op for devices reached per request (HTTP, folder); kept so session-based SDKs fit the same shape. */
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  validateConfiguration(): string[];
  getDeviceInfo(): Promise<DeviceInfo>;
  getStatus(): Promise<DeviceStatus>;
  testConnection(): Promise<DeviceStatus>;
  submitInvoice(sale: EtimsSale): Promise<FiscalSignature>;
  submitCreditNote(note: EtimsSale): Promise<FiscalSignature>;
  submitDebitNote(note: EtimsSale): Promise<FiscalSignature>;
  getTransactionStatus(sale: EtimsSale): Promise<StatusAnswer>;
  getLastFiscalReceipt(): Promise<FiscalSignature | null>;
  cancelTransaction(sale: EtimsSale): Promise<void>;
}

/** The request may have reached the device or KRA, but no answer came back: never re-send blindly. */
export class FiscalUncertainError extends IntegrationError {
  readonly fiscal = 'uncertain';
  constructor(message: string, body?: unknown) {
    super(message, undefined, body, true);
  }
}
/** The device, its program or KRA could not be reached at all: nothing was sent, safe to retry. */
export class FiscalDisconnectedError extends IntegrationError {
  readonly fiscal = 'disconnected';
  constructor(message: string, body?: unknown) {
    super(message, undefined, body, true);
  }
}
/** The device or KRA says this invoice is already recorded, without giving its signature back. */
export class FiscalDuplicateError extends IntegrationError {
  readonly fiscal = 'duplicate';
  constructor(message: string, body?: unknown) {
    super(message, 409, body, false);
  }
}
/** The operation is not offered by this device (or not documented by its maker). */
export class FiscalUnsupportedError extends IntegrationError {
  readonly fiscal = 'unsupported';
  constructor(operation: string, kind: string) {
    super(`${operation} is not supported for ${kind} devices`, 501, undefined, false);
  }
}

const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ENOENT', 'EACCES', 'UND_ERR_CONNECT_TIMEOUT']);

/**
 * Sorts a transport error from fetch: could not connect (nothing sent) or timed out / dropped after sending
 * (it may have been recorded).
 */
export function classifyTransportError(err: any, what: string): IntegrationError {
  if (err instanceof FiscalUncertainError || err instanceof FiscalDisconnectedError || err instanceof FiscalDuplicateError) return err;
  const cause = err?.cause ?? err;
  const code = cause?.code ?? cause?.cause?.code;
  if (code && NOT_SENT.has(String(code))) return new FiscalDisconnectedError(`${what} not reachable (${code})`);
  if (err instanceof IntegrationError && !String(err.message).startsWith('Timeout') && !String(err.message).startsWith('Network error')) return err;
  const timeout = cause?.name === 'AbortError' || cause?.name === 'TimeoutError' || /timeout/i.test(String(err?.message));
  return new FiscalUncertainError(timeout ? `${what} did not answer in time; it may have recorded the invoice` : `${what}: connection dropped after sending (${err?.message ?? 'no answer'}); it may have recorded the invoice`);
}

/** The fiscal status an error leads to. */
export function statusForError(err: unknown): { status: FiscalStatus; retry: boolean } {
  if (err instanceof FiscalUncertainError) return { status: 'awaiting_confirmation', retry: true };
  if (err instanceof FiscalDisconnectedError) return { status: 'device_disconnected', retry: true };
  if (err instanceof FiscalDuplicateError) return { status: 'requires_reconciliation', retry: false };
  if (err instanceof IntegrationError && !err.retryable) return { status: 'rejected', retry: false };
  return { status: 'pending', retry: true };
}

/** Request and response bodies as stored in the transaction log: no keys, bounded size. */
export function sanitizeForLog(v: unknown, max = 20_000): unknown {
  if (v == null) return v;
  const SECRET = /key|secret|token|password|auth|cmc/i;
  const walk = (x: any, depth: number): any => {
    if (depth > 8) return '[…]';
    if (Array.isArray(x)) return x.slice(0, 200).map((y) => walk(y, depth + 1));
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, SECRET.test(k) ? '[hidden]' : walk(y, depth + 1)]));
    return typeof x === 'string' && x.length > 2000 ? `${x.slice(0, 2000)}…` : x;
  };
  const out = walk(v, 0);
  const text = JSON.stringify(out);
  return text.length > max ? { truncated: true, text: text.slice(0, max) } : out;
}
