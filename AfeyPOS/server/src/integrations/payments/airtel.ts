/**
 * Airtel Money Africa Open API collections (USSD push).
 * Auth: OAuth2 client credentials. Charge: POST /merchant/v1/payments/. Verify: GET /standard/v1/payments/{id}
 * (status TS = success, TF = failed, TIP/TA = in progress). The status API does not return the amount; the
 * amount is the one we requested for our own transaction id.
 */
import { httpJson, IntegrationError } from '../http.js';
import type { ChargeInput, ChargeOutput, GatewayConfig, PaymentGateway, VerifyOutput, WebhookInput } from './types.js';
import { cachedToken, major, nationalNumber, requireSecret } from './util.js';

export const AIRTEL_COUNTRIES: Record<string, { currency: string; dial: string }> = {
  KE: { currency: 'KES', dial: '254' }, UG: { currency: 'UGX', dial: '256' }, TZ: { currency: 'TZS', dial: '255' }, RW: { currency: 'RWF', dial: '250' },
  ZM: { currency: 'ZMW', dial: '260' }, MW: { currency: 'MWK', dial: '265' }, CD: { currency: 'CDF', dial: '243' }, NG: { currency: 'NGN', dial: '234' },
};

export class AirtelGateway implements PaymentGateway {
  private clientId: string;
  private clientSecret: string;
  constructor(private cfg: GatewayConfig) {
    this.clientId = requireSecret(cfg.secrets, 'clientId', 'Airtel client ID');
    this.clientSecret = requireSecret(cfg.secrets, 'clientSecret', 'Airtel client secret');
  }

  get baseUrl() {
    return this.cfg.environment === 'production' ? 'https://openapi.airtel.africa' : 'https://openapiuat.airtel.africa';
  }

  get country() {
    const c = String(this.cfg.settings.country ?? 'KE').toUpperCase();
    return { code: c, ...(AIRTEL_COUNTRIES[c] ?? AIRTEL_COUNTRIES.KE) };
  }

  private async headers() {
    const token = await cachedToken(`airtel:${this.cfg.environment}:${this.clientId}`, async () => {
      const r = await httpJson(`${this.baseUrl}/auth/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: '*/*' },
        body: JSON.stringify({ client_id: this.clientId, client_secret: this.clientSecret, grant_type: 'client_credentials' }),
      });
      return { token: r?.access_token, expiresIn: Number(r?.expires_in ?? 180) };
    });
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: '*/*', 'X-Country': this.country.code, 'X-Currency': this.country.currency };
  }

  newReference() {
    // Airtel transaction ids: alphanumeric, kept short.
    return `AFY${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  }

  async charge(i: ChargeInput): Promise<ChargeOutput> {
    const { code, currency, dial } = this.country;
    if (i.currency !== currency) return { status: 'failed', message: `This Airtel account collects in ${currency}` };
    try {
      const r = await httpJson(`${this.baseUrl}/merchant/v1/payments/`, {
        method: 'POST',
        headers: await this.headers(),
        body: JSON.stringify({
          reference: i.description.slice(0, 30),
          subscriber: { country: code, currency, msisdn: nationalNumber(i.phone!, dial) },
          transaction: { amount: major(i.amountCents), country: code, currency, id: i.reference },
        }),
      });
      if (r?.status?.success === false) return { status: 'failed', message: r.status.message ?? 'Airtel rejected the request', raw: r };
      return { status: 'pending', providerRef: r?.data?.transaction?.id ?? i.reference, message: r?.status?.message, raw: r };
    } catch (err) {
      if (err instanceof IntegrationError && err.status && err.status < 500) return { status: 'failed', message: (err.body as any)?.status?.message ?? (err.body as any)?.error_description ?? 'Airtel rejected the request', raw: err.body };
      throw err;
    }
  }

  async verify(ref: { reference: string }): Promise<VerifyOutput> {
    const r = await httpJson(`${this.baseUrl}/standard/v1/payments/${encodeURIComponent(ref.reference)}`, { headers: await this.headers() });
    const t = r?.data?.transaction ?? {};
    const raw = { transaction: t, status: r?.status };
    switch (t.status) {
      case 'TS':
        return { status: 'succeeded', receiptNumber: t.airtel_money_id ?? t.id, message: t.message, raw };
      case 'TF':
        return { status: 'failed', message: t.message ?? 'Transaction failed', raw };
      case 'TE':
        return { status: 'expired', message: t.message ?? 'Transaction expired', raw };
      default:
        return { status: 'pending', message: t.message, raw }; // TIP, TA
    }
  }

  webhook(input: WebhookInput) {
    const id = input.body?.transaction?.id;
    return id ? { reference: String(id) } : {};
  }

  async testCredentials() {
    await this.headers();
    return `Airtel ${this.country.code} token obtained`;
  }
}
