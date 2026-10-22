/**
 * Flutterwave v3: direct mobile money charge (push) or hosted payment link (link).
 * Verify: GET /transactions/verify_by_reference?tx_ref=. Webhooks: `verif-hash` header equals the secret hash
 * configured in the dashboard.
 */
import { httpJson, IntegrationError } from '../http.js';
import type { ChargeInput, ChargeOutput, GatewayConfig, PaymentGateway, VerifyOutput, WebhookInput } from './types.js';
import { header, major, requireSecret, secureCompare, toCents } from './util.js';

const BASE = 'https://api.flutterwave.com/v3';

export class FlutterwaveGateway implements PaymentGateway {
  private secretKey: string;
  constructor(private cfg: GatewayConfig) {
    this.secretKey = requireSecret(cfg.secrets, 'secretKey', 'Flutterwave secret key');
  }

  private headers() {
    return { Authorization: `Bearer ${this.secretKey}`, 'Content-Type': 'application/json' };
  }

  async charge(i: ChargeInput): Promise<ChargeOutput> {
    try {
      if (i.flow === 'link') {
        const r = await httpJson(`${BASE}/payments`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({
            tx_ref: i.reference, amount: major(i.amountCents), currency: i.currency, redirect_url: i.redirectUrl,
            customer: { email: i.email, phonenumber: i.phone, name: i.customerName ?? 'Customer' }, customizations: { title: i.description.slice(0, 50) },
          }),
        });
        if (r?.status !== 'success' || !r.data?.link) return { status: 'failed', message: r?.message ?? 'Flutterwave did not return a payment link', raw: r };
        return { status: 'pending', checkoutUrl: r.data.link, raw: r };
      }
      const [type, network] = (i.channel ?? 'mpesa').split(':');
      const r = await httpJson(`${BASE}/charges?type=${encodeURIComponent(type)}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ tx_ref: i.reference, amount: major(i.amountCents), currency: i.currency, email: i.email, phone_number: i.phone, fullname: i.customerName ?? 'Customer', ...(network ? { network } : {}) }),
      });
      if (r?.status !== 'success') return { status: 'failed', message: r?.message ?? 'Charge failed', raw: r };
      // Some networks (Uganda, Ghana, francophone) need the customer to open an authorisation page.
      const redirect = r.meta?.authorization?.redirect;
      return { status: 'pending', providerRef: r.data?.flw_ref ?? (r.data?.id ? String(r.data.id) : undefined), checkoutUrl: redirect, message: r.meta?.authorization?.note ?? r.message, raw: r };
    } catch (err) {
      if (err instanceof IntegrationError && err.status === 400) return { status: 'failed', message: (err.body as any)?.message ?? 'Flutterwave rejected the charge', raw: err.body };
      throw err;
    }
  }

  async verify(ref: { reference: string }): Promise<VerifyOutput> {
    let r: any;
    try {
      r = await httpJson(`${BASE}/transactions/verify_by_reference?tx_ref=${encodeURIComponent(ref.reference)}`, { headers: this.headers() });
    } catch (err) {
      if (err instanceof IntegrationError && (err.status === 400 || err.status === 404)) return { status: 'pending', message: (err.body as any)?.message, raw: err.body };
      throw err;
    }
    const d = r?.data ?? {};
    const raw = { status: d.status, tx_ref: d.tx_ref, flw_ref: d.flw_ref, id: d.id, amount: d.amount, currency: d.currency, processor_response: d.processor_response };
    if (d.tx_ref && d.tx_ref !== ref.reference) return { status: 'pending', message: 'Reference mismatch', raw };
    if (d.status === 'successful') {
      return { status: 'succeeded', paidAmountCents: toCents(d.amount), currency: d.currency, receiptNumber: d.flw_ref ?? String(d.id), phone: d.customer?.phone_number, payerName: d.customer?.name, message: d.processor_response, raw };
    }
    if (d.status === 'failed' || d.status === 'cancelled') return { status: d.status === 'cancelled' ? 'cancelled' : 'failed', message: d.processor_response ?? d.status, raw };
    return { status: 'pending', message: d.processor_response, raw };
  }

  webhook(input: WebhookInput) {
    const expected = this.cfg.secrets.webhookHash ? String(this.cfg.secrets.webhookHash) : '';
    if (!expected || !secureCompare(header(input, 'verif-hash'), expected)) return null;
    const ref = input.body?.data?.tx_ref ?? input.body?.txRef ?? input.body?.tx_ref;
    return ref ? { reference: String(ref) } : {};
  }

  async testCredentials() {
    await httpJson(`${BASE}/balances`, { headers: this.headers() });
    return 'Flutterwave secret key accepted';
  }
}
