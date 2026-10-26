/**
 * Pesapal API 3.0: hosted checkout (cards, M-Pesa, Airtel Money and bank) shown at the till as a QR code or link.
 * Auth: POST /api/Auth/RequestToken with the consumer key and secret (token valid ~5 minutes).
 * Orders: POST /api/Transactions/SubmitOrderRequest needs a registered IPN id (registered automatically for this
 * configuration's webhook URL). Verify: GET /api/Transactions/GetTransactionStatus?orderTrackingId=.
 * The IPN is only a hint: the status API decides (status_code 1 = completed, 2 = failed, 3 = reversed).
 */
import { httpJson, IntegrationError } from '../http.js';
import type { ChargeInput, ChargeOutput, GatewayConfig, PaymentGateway, VerifyOutput, WebhookInput } from './types.js';
import { major, requireSecret, toCents } from './util.js';

const tokens = new Map<string, { token: string; expiresAt: number }>();
const ipnIds = new Map<string, string>();

export class PesapalGateway implements PaymentGateway {
  private key: string;
  private secret: string;
  constructor(private cfg: GatewayConfig) {
    this.key = requireSecret(cfg.secrets, 'consumerKey', 'Pesapal consumer key');
    this.secret = requireSecret(cfg.secrets, 'consumerSecret', 'Pesapal consumer secret');
  }

  get base() {
    return this.cfg.environment === 'production' ? 'https://pay.pesapal.com/v3' : 'https://cybqa.pesapal.com/pesapalv3';
  }

  private async token(): Promise<string> {
    const cacheKey = `${this.base}:${this.key}`;
    const c = tokens.get(cacheKey);
    if (c && c.expiresAt > Date.now() + 20_000) return c.token;
    const r = await httpJson(`${this.base}/api/Auth/RequestToken`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ consumer_key: this.key, consumer_secret: this.secret }),
    });
    if (!r?.token) throw new IntegrationError(`Pesapal refused the keys: ${r?.error?.message ?? r?.message ?? 'no token returned'}`, undefined, r, false);
    const expires = r.expiryDate ? Date.parse(r.expiryDate) : NaN;
    tokens.set(cacheKey, { token: r.token, expiresAt: Number.isFinite(expires) ? expires : Date.now() + 4 * 60_000 });
    return r.token;
  }

  private async call(path: string, init: { method?: string; body?: unknown } = {}) {
    const token = await this.token();
    return httpJson(`${this.base}${path}`, {
      method: init.method ?? 'GET',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  }

  /** The IPN id for this webhook URL: the configured one, or registered once and remembered. */
  private async ipnId(url: string): Promise<string> {
    if (this.cfg.settings.ipnId) return String(this.cfg.settings.ipnId);
    const known = ipnIds.get(url);
    if (known) return known;
    const list = await this.call('/api/URLSetup/GetIpnList').catch(() => []);
    const found = Array.isArray(list) ? list.find((x: any) => x?.url === url) : null;
    const id = found?.ipn_id ?? (await this.call('/api/URLSetup/RegisterIPN', { method: 'POST', body: { url, ipn_notification_type: 'GET' } }))?.ipn_id;
    if (!id) throw new IntegrationError('Pesapal did not register the notification (IPN) URL', undefined, undefined, false);
    ipnIds.set(url, id);
    return id;
  }

  async charge(i: ChargeInput): Promise<ChargeOutput> {
    const notificationId = await this.ipnId(i.callbackUrl);
    const [first, ...rest] = (i.customerName ?? 'Customer').split(' ');
    const r = await this.call('/api/Transactions/SubmitOrderRequest', {
      method: 'POST',
      body: {
        id: i.reference.slice(0, 50), currency: i.currency, amount: major(i.amountCents), description: i.description.slice(0, 100),
        callback_url: i.redirectUrl, notification_id: notificationId, redirect_mode: 'TOP_WINDOW',
        billing_address: { email_address: i.email, phone_number: i.phone ?? '', country_code: this.cfg.settings.countryCode || 'KE', first_name: first, last_name: rest.join(' ') },
      },
    });
    if (r?.error || !r?.redirect_url) return { status: 'failed', message: r?.error?.message ?? r?.message ?? 'Pesapal did not return a payment page', raw: r };
    return { status: 'pending', providerRef: r.order_tracking_id, checkoutUrl: r.redirect_url, raw: { order_tracking_id: r.order_tracking_id, merchant_reference: r.merchant_reference } };
  }

  async verify(ref: { reference: string; providerRef?: string }): Promise<VerifyOutput> {
    if (!ref.providerRef) return { status: 'pending', message: 'Waiting for Pesapal' };
    const d = await this.call(`/api/Transactions/GetTransactionStatus?orderTrackingId=${encodeURIComponent(ref.providerRef)}`);
    const raw = { status_code: d?.status_code, payment_status_description: d?.payment_status_description, merchant_reference: d?.merchant_reference, amount: d?.amount, currency: d?.currency, confirmation_code: d?.confirmation_code, payment_method: d?.payment_method };
    if (d?.merchant_reference && d.merchant_reference !== ref.reference.slice(0, 50)) return { status: 'pending', message: 'Reference mismatch', raw };
    const code = Number(d?.status_code);
    if (code === 1) return { status: 'succeeded', paidAmountCents: toCents(d.amount), currency: d.currency, receiptNumber: d.confirmation_code || ref.providerRef, phone: d.payment_account, message: `${d.payment_method ?? 'Pesapal'} ${d.payment_status_description ?? ''}`.trim(), raw };
    if (code === 2 || code === 3) return { status: 'failed', message: d.payment_status_description ?? 'Failed', raw };
    return { status: 'pending', message: d?.payment_status_description ?? d?.description, raw };
  }

  /** Pesapal calls the per-configuration URL (secret token in the path) with OrderTrackingId and OrderMerchantReference. */
  webhook(input: WebhookInput) {
    const q = { ...input.query, ...(input.body && typeof input.body === 'object' ? input.body : {}) };
    const tracking = q.OrderTrackingId ?? q.orderTrackingId;
    const reference = q.OrderMerchantReference ?? q.orderMerchantReference;
    if (!tracking && !reference) return {};
    return { providerRef: tracking ? String(tracking) : undefined, reference: reference ? String(reference) : undefined };
  }

  async testCredentials() {
    await this.token();
    return `Pesapal ${this.cfg.environment === 'production' ? 'live' : 'sandbox'} keys accepted`;
  }
}
