/**
 * ZenoPay (Tanzania mobile money). Auth: x-api-key header.
 * Charge: POST /api/payments/mobile_money_tanzania. Verify: GET /api/payments/order-status?order_id=.
 * Webhooks carry the same x-api-key header, then are re-verified with the status API.
 */
import { httpJson, IntegrationError } from '../http.js';
import type { ChargeInput, ChargeOutput, GatewayConfig, PaymentGateway, VerifyOutput, WebhookInput } from './types.js';
import { header, nationalNumber, requireSecret, secureCompare, toCents } from './util.js';

const BASE = 'https://zenoapi.com/api/payments';

export class ZenoPayGateway implements PaymentGateway {
  private apiKey: string;
  constructor(private cfg: GatewayConfig) {
    this.apiKey = requireSecret(cfg.secrets, 'apiKey', 'ZenoPay API key');
  }

  private headers() {
    return { 'x-api-key': this.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' };
  }

  async charge(i: ChargeInput): Promise<ChargeOutput> {
    if (i.currency !== 'TZS') return { status: 'failed', message: 'ZenoPay collects in TZS' };
    try {
      const r = await httpJson(`${BASE}/mobile_money_tanzania`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ order_id: i.reference, buyer_email: i.email, buyer_name: i.customerName ?? 'Customer', buyer_phone: `0${nationalNumber(i.phone!, '255')}`, amount: Math.round(i.amountCents / 100), webhook_url: i.callbackUrl }),
      });
      if (r?.status === 'success' || r?.resultcode === '000') return { status: 'pending', providerRef: r.order_id ?? i.reference, message: r.message, raw: r };
      return { status: 'failed', message: r?.message ?? 'ZenoPay rejected the request', raw: r };
    } catch (err) {
      if (err instanceof IntegrationError && err.status && err.status < 500) return { status: 'failed', message: (err.body as any)?.message ?? 'ZenoPay rejected the request', raw: err.body };
      throw err;
    }
  }

  async verify(ref: { reference: string }): Promise<VerifyOutput> {
    let r: any;
    try {
      r = await httpJson(`${BASE}/order-status?order_id=${encodeURIComponent(ref.reference)}`, { headers: this.headers() });
    } catch (err) {
      if (err instanceof IntegrationError && err.status === 404) return { status: 'pending', message: 'Order not found yet', raw: err.body };
      throw err;
    }
    const d = Array.isArray(r?.data) ? r.data[0] : r?.data;
    const raw = { result: r?.result, resultcode: r?.resultcode, data: d && { order_id: d.order_id, amount: d.amount, payment_status: d.payment_status, transid: d.transid, channel: d.channel, reference: d.reference } };
    if (!d) return { status: 'pending', message: r?.message, raw };
    if (d.order_id && d.order_id !== ref.reference) return { status: 'pending', message: 'Reference mismatch', raw };
    const st = String(d.payment_status ?? '').toUpperCase();
    if (st === 'COMPLETED' || st === 'SUCCESS') return { status: 'succeeded', paidAmountCents: toCents(d.amount), currency: 'TZS', receiptNumber: d.transid || d.reference, phone: d.msisdn, raw };
    if (st === 'FAILED' || st === 'CANCELLED') return { status: st === 'CANCELLED' ? 'cancelled' : 'failed', message: r?.message ?? st, raw };
    return { status: 'pending', message: st, raw };
  }

  webhook(input: WebhookInput) {
    if (!secureCompare(header(input, 'x-api-key'), this.apiKey)) return null;
    const ref = input.body?.order_id;
    return ref ? { reference: String(ref) } : {};
  }

  async testCredentials() {
    try {
      await httpJson(`${BASE}/order-status?order_id=afeypos-credential-test`, { headers: this.headers() });
    } catch (err) {
      if (err instanceof IntegrationError && (err.status === 401 || err.status === 403)) throw new IntegrationError('ZenoPay rejected the API key', err.status, err.body, false);
      if (!(err instanceof IntegrationError) || !err.status || err.status >= 500) throw err;
    }
    return 'ZenoPay API key accepted';
  }
}
