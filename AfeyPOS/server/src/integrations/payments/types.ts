/**
 * Provider-agnostic payment gateway contract.
 *
 * Trust model: initiating a charge only ever creates a *pending* intent. A webhook is used solely as a
 * hint ("look at reference X"); it is authenticated (HMAC / shared secret / per-tenant callback token)
 * and then the payment is re-verified with an authenticated server-to-provider API call before the
 * intent can become "succeeded". Webhook bodies are never trusted for status or amount.
 */
import type { PaymentProviderKey } from '@afeypos/shared';

export type GatewayStatus = 'pending' | 'succeeded' | 'failed' | 'cancelled' | 'expired';

export interface GatewayConfig {
  provider: PaymentProviderKey;
  environment: 'sandbox' | 'production';
  settings: Record<string, any>;
  secrets: Record<string, any>;
}

export interface ChargeInput {
  /** Our unique reference for this attempt (also the provider's merchant/order reference). */
  reference: string;
  amountCents: number;
  currency: string;
  flow: 'push' | 'link';
  /** E.164 digits without '+', e.g. 254712345678. Required for push. */
  phone?: string;
  email: string;
  customerName?: string;
  channel?: string;
  description: string;
  /** Server-to-server webhook URL for this configuration. */
  callbackUrl: string;
  /** Where a hosted checkout page sends the customer afterwards. */
  redirectUrl: string;
}

export interface ChargeOutput {
  status: 'pending' | 'failed';
  providerRef?: string;
  checkoutUrl?: string;
  message?: string;
  raw?: unknown;
}

export interface VerifyOutput {
  status: GatewayStatus;
  /** Amount the provider reports as paid; undefined when its status API does not return one. */
  paidAmountCents?: number;
  currency?: string;
  receiptNumber?: string;
  payerName?: string;
  phone?: string;
  message?: string;
  raw?: unknown;
}

export interface WebhookInput {
  rawBody: Buffer;
  body: any;
  query: Record<string, any>;
  headers: Record<string, string | string[] | undefined>;
}

export interface WebhookKeys {
  reference?: string;
  providerRef?: string;
}

export interface PaymentGateway {
  charge(input: ChargeInput): Promise<ChargeOutput>;
  verify(ref: { reference: string; providerRef?: string; currency?: string }): Promise<VerifyOutput>;
  /**
   * Authenticates an inbound webhook and extracts lookup keys. Returns null when the request is not
   * authentic. The keys only select which intent to re-verify.
   */
  webhook(input: WebhookInput): WebhookKeys | null;
  /** Makes an authenticated call that does not move money; returns a human-readable confirmation. */
  testCredentials(): Promise<string>;
  /** Generates the reference for a new intent when the provider has format rules (e.g. UUID v4). */
  newReference?(): string;
}
