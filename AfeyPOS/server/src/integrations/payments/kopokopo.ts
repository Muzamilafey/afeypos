/**
 * Kopo Kopo: M-Pesa STK push to an online payments till (K-number).
 * Charge: POST /api/v1/incoming_payments -> 201 + Location. Verify: GET the Location URL.
 * Webhooks: X-KopoKopo-Signature = HMAC-SHA256(raw body, API key).
 */
import { httpJson, httpRaw, IntegrationError } from '../http.js';
import type { ChargeInput, ChargeOutput, GatewayConfig, PaymentGateway, VerifyOutput, WebhookInput } from './types.js';
import { cachedToken, header, hmacHex, major, requireSecret, secureCompare, splitName, toCents } from './util.js';

export class KopoKopoGateway implements PaymentGateway {
  private clientId: string;
  private clientSecret: string;
  constructor(private cfg: GatewayConfig) {
    this.clientId = requireSecret(cfg.secrets, 'clientId', 'Kopo Kopo client ID');
    this.clientSecret = requireSecret(cfg.secrets, 'clientSecret', 'Kopo Kopo client secret');
  }

  get baseUrl() {
    return this.cfg.environment === 'production' ? 'https://api.kopokopo.com' : 'https://sandbox.kopokopo.com';
  }

  private async headers() {
    const token = await cachedToken(`kopokopo:${this.cfg.environment}:${this.clientId}`, async () => {
      const r = await httpJson(`${this.baseUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: this.clientId, client_secret: this.clientSecret }).toString(),
      });
      return { token: r?.access_token, expiresIn: Number(r?.expires_in ?? 3600) };
    });
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' };
  }

  async charge(i: ChargeInput): Promise<ChargeOutput> {
    const till = String(this.cfg.settings.tillNumber ?? '');
    if (!till) return { status: 'failed', message: 'Kopo Kopo till number is not configured' };
    const name = splitName(i.customerName);
    try {
      const r = await httpRaw(`${this.baseUrl}/api/v1/incoming_payments`, {
        method: 'POST',
        headers: await this.headers(),
        body: JSON.stringify({
          payment_channel: 'M-PESA STK Push', till_number: till,
          subscriber: { first_name: name.first, last_name: name.last, phone_number: `+${i.phone}`, email: i.email },
          amount: { currency: i.currency, value: major(i.amountCents) },
          metadata: { reference: i.reference, notes: i.description.slice(0, 50) },
          _links: { callback_url: i.callbackUrl },
        }),
      });
      const location = r.headers.get('location');
      if (!location) return { status: 'failed', message: 'Kopo Kopo did not return a payment location', raw: r.body };
      return { status: 'pending', providerRef: location, raw: r.body };
    } catch (err) {
      if (err instanceof IntegrationError && err.status && err.status < 500) return { status: 'failed', message: (err.body as any)?.error_message ?? 'Kopo Kopo rejected the request', raw: err.body };
      throw err;
    }
  }

  async verify(ref: { reference: string; providerRef?: string }): Promise<VerifyOutput> {
    // Only follow Location URLs on the configured Kopo Kopo host (never an arbitrary URL).
    if (!ref.providerRef || new URL(ref.providerRef).origin !== new URL(this.baseUrl).origin) return { status: 'pending', message: 'No Kopo Kopo payment location' };
    const r = await httpJson(ref.providerRef, { headers: await this.headers() });
    const a = r?.data?.attributes ?? {};
    const res = a.event?.resource ?? {};
    const raw = { id: r?.data?.id, status: a.status, metadata: a.metadata, resource: { reference: res.reference, amount: res.amount, currency: res.currency, status: res.status }, errors: a.event?.errors };
    if (a.metadata?.reference && a.metadata.reference !== ref.reference) return { status: 'pending', message: 'Reference mismatch', raw };
    if (a.status === 'Success') {
      return { status: 'succeeded', paidAmountCents: toCents(res.amount), currency: res.currency, receiptNumber: res.reference, phone: String(res.sender_phone_number ?? '').replace(/^\+/, '') || undefined, payerName: [res.sender_first_name, res.sender_last_name].filter(Boolean).join(' ') || undefined, raw };
    }
    if (a.status === 'Failed') return { status: 'failed', message: typeof a.event?.errors === 'string' ? a.event.errors : 'Payment failed', raw };
    return { status: 'pending', raw };
  }

  webhook(input: WebhookInput) {
    const key = this.cfg.secrets.apiKey ? String(this.cfg.secrets.apiKey) : '';
    const sig = header(input, 'x-kopokopo-signature');
    if (!key || !sig || !secureCompare(hmacHex('sha256', key, input.rawBody), sig)) return null;
    const a = input.body?.data?.attributes ?? {};
    return { reference: a.metadata?.reference ? String(a.metadata.reference) : undefined, providerRef: a._links?.self ? String(a._links.self) : undefined };
  }

  async testCredentials() {
    await this.headers();
    return 'Kopo Kopo access token obtained';
  }
}
