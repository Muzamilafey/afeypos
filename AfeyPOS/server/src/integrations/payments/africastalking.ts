/**
 * Africa's Talking Payments mobile checkout.
 * Charge: POST /mobile/checkout/request. Verify: GET /query/transaction/find?username=&transactionId=.
 * Notifications are authenticated by the callback token in the URL and re-verified with the find API.
 */
import { httpJson, IntegrationError } from '../http.js';
import type { ChargeInput, ChargeOutput, GatewayConfig, PaymentGateway, VerifyOutput, WebhookInput } from './types.js';
import { major, requireSecret, toCents } from './util.js';

/** "KES 100.0000" -> { currency: 'KES', cents: 10000 } */
export function parseAtValue(v: unknown): { currency?: string; cents?: number } {
  const m = /^([A-Z]{3})\s+([\d.]+)$/.exec(String(v ?? '').trim());
  return m ? { currency: m[1], cents: toCents(m[2]) } : {};
}

export class AfricasTalkingGateway implements PaymentGateway {
  private apiKey: string;
  private username: string;
  constructor(private cfg: GatewayConfig) {
    this.apiKey = requireSecret(cfg.secrets, 'apiKey', "Africa's Talking API key");
    this.username = String(cfg.settings.username ?? (cfg.environment === 'sandbox' ? 'sandbox' : ''));
  }

  get baseUrl() {
    return this.cfg.environment === 'production' ? 'https://payments.africastalking.com' : 'https://payments.sandbox.africastalking.com';
  }

  private headers() {
    return { apiKey: this.apiKey, Accept: 'application/json', 'Content-Type': 'application/json' };
  }

  async charge(i: ChargeInput): Promise<ChargeOutput> {
    try {
      const r = await httpJson(`${this.baseUrl}/mobile/checkout/request`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ username: this.username, productName: this.cfg.settings.productName, phoneNumber: `+${i.phone}`, currencyCode: i.currency, amount: major(i.amountCents), metadata: { reference: i.reference } }),
      });
      if (r?.status === 'PendingConfirmation' && r.transactionId) return { status: 'pending', providerRef: r.transactionId, message: r.description, raw: r };
      return { status: 'failed', message: r?.description ?? r?.errorMessage ?? `Africa's Talking: ${r?.status}`, raw: r };
    } catch (err) {
      if (err instanceof IntegrationError && err.status && err.status < 500) return { status: 'failed', message: typeof err.body === 'string' ? err.body : ((err.body as any)?.description ?? "Africa's Talking rejected the request"), raw: err.body };
      throw err;
    }
  }

  async verify(ref: { reference: string; providerRef?: string }): Promise<VerifyOutput> {
    if (!ref.providerRef) return { status: 'pending', message: 'No transaction id' };
    const r = await httpJson(`${this.baseUrl}/query/transaction/find?username=${encodeURIComponent(this.username)}&transactionId=${encodeURIComponent(ref.providerRef)}`, { headers: this.headers() });
    const d = r?.data ?? {};
    const v = parseAtValue(d.value);
    const raw = { status: r?.status, data: { status: d.status, value: d.value, transactionId: d.transactionId, providerRefId: d.providerRefId, requestMetadata: d.requestMetadata, description: d.description } };
    if (d.requestMetadata?.reference && d.requestMetadata.reference !== ref.reference) return { status: 'pending', message: 'Reference mismatch', raw };
    if (d.status === 'Success') return { status: 'succeeded', paidAmountCents: v.cents, currency: v.currency, receiptNumber: d.providerRefId || d.transactionId, phone: String(d.source ?? '').replace(/^\+/, '') || undefined, raw };
    if (d.status === 'Failed') return { status: 'failed', message: d.description ?? 'Payment failed', raw };
    return { status: 'pending', message: d.description, raw };
  }

  webhook(input: WebhookInput) {
    const b = input.body ?? {};
    return { providerRef: b.transactionId ? String(b.transactionId) : undefined, reference: b.requestMetadata?.reference ? String(b.requestMetadata.reference) : undefined };
  }

  async testCredentials() {
    const r = await httpJson(`${this.baseUrl}/query/wallet/balance?username=${encodeURIComponent(this.username)}`, { headers: this.headers() });
    if (r?.status && r.status !== 'Success') throw new IntegrationError(`Africa's Talking: ${r.errorMessage ?? r.status}`, undefined, r, false);
    return `Africa's Talking payments wallet: ${r?.balance ?? 'reachable'}`;
  }
}
