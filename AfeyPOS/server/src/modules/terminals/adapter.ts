/**
 * Provider-independent contract for bank card terminals.
 *
 * Each provider adapter implements only what that provider's official SDK or documented protocol supports and
 * declares it in `capabilities`. Nothing in Afey POS may assume more: an operation the adapter lacks is shown
 * as unavailable, never faked.
 *
 * Trust model
 *  - Starting a sale only creates an open transaction. It becomes "approved" only when `query` (the provider's
 *    authenticated transaction status) reports approval with the same reference, amount and currency.
 *  - Notifications from a provider are authenticated by the adapter and then only trigger a `query`.
 *  - A device is trusted because it completed pairing and proves it on every call (adapter-specific keys and
 *    the device identity recorded at registration), never because it is visible on the network.
 */
import type { TerminalCapabilities, TerminalConnection, TerminalTxnStatus } from '@afeypos/shared';

export type TerminalErrorCode =
  | 'POWERED_OFF' | 'UNREACHABLE' | 'USB_DISCONNECTED' | 'PAIRING_REJECTED' | 'UNSUPPORTED_MODEL' | 'BAD_CONFIG'
  | 'CREDENTIALS_EXPIRED' | 'BUSY' | 'PROVIDER_UNAVAILABLE' | 'IDENTITY_MISMATCH' | 'TIMEOUT' | 'NOT_SUPPORTED';

export class TerminalError extends Error {
  /**
   * `mayHaveReachedTerminal`: the request could have been delivered (timeout, connection dropped mid-way).
   * A sale that fails this way stays open as "unknown" until the terminal's own record is checked.
   */
  constructor(public code: TerminalErrorCode, message: string, public mayHaveReachedTerminal = false) {
    super(message);
  }
}

export interface DeviceIdentity {
  model?: string;
  serialNumber?: string;
  providerTerminalId?: string;
  firmware?: string;
  os?: string;
}

export interface TerminalContext {
  tenantId: string;
  terminalId: string;
  mode: 'sandbox' | 'live';
  connection: TerminalConnection;
  connectionSettings: Record<string, any>;
  /** Identity recorded at registration; adapters must reject a device that answers with another identity. */
  device: DeviceIdentity;
  /** Decrypted pairing keys / credentials. */
  secrets: Record<string, string>;
}

export interface DiscoveredTerminal extends DeviceIdentity {
  deviceId: string;
  address?: string;
}

export interface TerminalProgress {
  status: Exclude<TerminalTxnStatus, 'created' | 'unknown'>;
  reference?: string;
  providerRef?: string;
  amountCents?: number;
  currency?: string;
  authCode?: string;
  cardScheme?: string;
  /** Last four digits only, if the provider reports them. */
  last4?: string;
  entryMode?: string;
  removeCard?: boolean;
  message?: string;
}

export interface TerminalStatus {
  online: boolean;
  ready: boolean;
  busy?: boolean;
  device?: DeviceIdentity;
  message?: string;
}

export interface TerminalAdapter {
  readonly capabilities: TerminalCapabilities;
  readonly integrationVersion: string;
  /** Lists devices found by the provider's discovery mechanism. */
  discover?(ctx: TerminalContext): Promise<DiscoveredTerminal[]>;
  /** Registers the device; may return a hint shown to the merchant (e.g. "enter the code shown on the terminal"). */
  register(ctx: TerminalContext, input: { deviceId?: string }): Promise<{ device: DeviceIdentity; pairingHint?: string; simulatedScreen?: string }>;
  /** Completes pairing; returns the credentials to keep (encrypted). */
  pair(ctx: TerminalContext, input: { pairingCode: string }): Promise<{ secrets: Record<string, string> }>;
  /** Connection and readiness. Throws TerminalError when the device cannot be used. */
  status(ctx: TerminalContext): Promise<TerminalStatus>;
  startSale(ctx: TerminalContext, input: { reference: string; amountCents: number; currency: string; kind: 'sale' | 'test' }): Promise<TerminalProgress>;
  /** Authoritative transaction status from the terminal / provider. */
  query(ctx: TerminalContext, input: { reference: string; providerRef?: string }): Promise<TerminalProgress>;
  cancel?(ctx: TerminalContext, input: { reference: string; providerRef?: string }): Promise<void>;
  refund?(ctx: TerminalContext, input: { reference: string; originalReference: string; originalProviderRef?: string; amountCents: number; currency: string }): Promise<TerminalProgress>;
  /** Authenticates a provider notification. Returns the reference to re-check, or null when not authentic. */
  verifyNotification?(ctx: TerminalContext, input: { rawBody: Buffer; headers: Record<string, string | string[] | undefined>; body: any }): { reference: string } | null;
}
