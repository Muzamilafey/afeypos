/**
 * Paystack: mobile money charge (push) or hosted checkout (link).
 * Verify: GET /transaction/verify/:reference. Webhooks: x-paystack-signature = HMAC-SHA512(raw body, secret key).
 * Amounts are in the currency subunit, which matches our integer cents.
 */
import { httpJson, IntegrationError } from '../http.js';
import type { ChargeInput, ChargeOutput, GatewayConfig, PaymentGateway, VerifyOutput, WebhookInput } from './types.js';
import { header, hmacHex, requireSecret, secureCompare } from './util.js';

const BASE = 'https://api.paystack.co';

export class PaystackGateway implements PaymentGateway {
  private secretKey: string;
  constructor(private cfg: GatewayConfig) {
    this.secretKey = requireSecret(cfg.secrets, 'secretKey', 'Paystack secret key');
  }

  private headers() {
    return { Authorization: `Bearer ${this.secretKey}`, 'Content-Type': 'application/json' };
  }

  async charge(i: ChargeInput): Promise<ChargeOutput> {
    const metadata = { source: 'afeypos', description: i.description };
    if (i.flow === 'link') {
      const r = await httpJson(`${BASE}/transaction/initialize`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ email: i.email, amount: i.amountCents, currency: i.currency, reference: i.reference, callback_url: i.redirectUrl, metadata }),
      });
      if (!r?.status || !r.data?.authorization_url) return { status: 'failed', message: r?.message ?? 'Paystack did not return a checkout link', raw: r };
      return { status: 'pending', providerRef: r.data.access_code, checkoutUrl: r.data.authorization_url, raw: r };
    }
    // Kenyan M-Pesa numbers are sent as +254…; Ghana networks take the local 0… format.
    const phone = i.currency === 'GHS' ? `0${i.phone!.slice(3)}` : `+${i.phone}`;
    try {
      const r = await httpJson(`${BASE}/charge`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ email: i.email, amount: i.amountCents, currency: i.currency, reference: i.reference, mobile_money: { phone, provider: i.channel }, metadata }),
      });
      const st = r?.data?.status;
      if (!r?.status || st === 'failed') return { status: 'failed', message: r?.data?.message ?? r?.message ?? 'Charge failed', raw: r };
      return { status: 'pending', providerRef: r.data?.reference ?? i.reference, message: r.data?.display_text ?? r.data?.message, raw: r };
    } catch (err) {
      if (err instanceof IntegrationError && err.status === 400) return { status: 'failed', message: (err.body as any)?.message ?? 'Paystack rejected the charge', raw: err.body };
      throw err;
    }
  }

  async verify(ref: { reference: string }): Promise<VerifyOutput> {
    let r: any;
    try {
      r = await httpJson(`${BASE}/transaction/verify/${encodeURIComponent(ref.reference)}`, { headers: this.headers() });
    } catch (err) {
      // Unknown reference: the customer has not started paying yet.
      if (err instanceof IntegrationError && (err.status === 404 || err.status === 400)) return { status: 'pending', message: (err.body as any)?.message, raw: err.body };
      throw err;
    }
    const d = r?.data ?? {};
    const raw = { status: d.status, reference: d.reference, amount: d.amount, currency: d.currency, id: d.id, channel: d.channel, gateway_response: d.gateway_response };
    switch (d.status) {
      case 'success':
        return {
          status: 'succeeded', paidAmountCents: Number(d.amount), currency: d.currency, receiptNumber: d.receipt_number || String(d.id ?? d.reference),
          phone: d.authorization?.mobile_money_number, payerName: [d.customer?.first_name, d.customer?.last_name].filter(Boolean).join(' ') || undefined, message: d.gateway_response, raw,
        };
      case 'failed':
      case 'reversed':
        return { status: 'failed', message: d.gateway_response ?? d.status, raw };
      default:
        // ongoing, pending, processing, queued, abandoned (customer may still complete a checkout link)
        return { status: 'pending', message: d.gateway_response, raw };
    }
  }

  webhook(input: WebhookInput) {
    const sig = header(input, 'x-paystack-signature');
    if (!sig || !secureCompare(hmacHex('sha512', this.secretKey, input.rawBody), sig)) return null;
    const reference = input.body?.data?.reference;
    return reference ? { reference: String(reference) } : {};
  }

  async testCredentials() {
    await httpJson(`${BASE}/transaction?perPage=1`, { headers: this.headers() });
    return `Paystack ${this.secretKey.startsWith('sk_live_') ? 'live' : 'test'} key accepted`;
  }
}
