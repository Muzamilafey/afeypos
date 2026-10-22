/**
 * Hubtel Receive Money (Ghana mobile money).
 * Charge: POST rmp.hubtel.com/merchantaccount/merchants/{POS Sales ID}/receive/mobilemoney (Basic auth).
 * Verify: GET api-txnstatus.hubtel.com/transactions/{POS Sales ID}/status?clientReference= (Hubtel requires the
 * server IP to be whitelisted for this endpoint).
 */
import { httpJson, IntegrationError } from '../http.js';
import type { ChargeInput, ChargeOutput, GatewayConfig, PaymentGateway, VerifyOutput, WebhookInput } from './types.js';
import { major, requireSecret, toCents } from './util.js';

export class HubtelGateway implements PaymentGateway {
  private auth: string;
  private merchant: string;
  constructor(private cfg: GatewayConfig) {
    const id = requireSecret(cfg.secrets, 'clientId', 'Hubtel API ID');
    const key = requireSecret(cfg.secrets, 'clientSecret', 'Hubtel API key');
    this.auth = `Basic ${Buffer.from(`${id}:${key}`).toString('base64')}`;
    this.merchant = encodeURIComponent(String(cfg.settings.merchantAccountNumber ?? ''));
  }

  private headers() {
    return { Authorization: this.auth, 'Content-Type': 'application/json', Accept: 'application/json' };
  }

  async charge(i: ChargeInput): Promise<ChargeOutput> {
    if (!this.merchant) return { status: 'failed', message: 'Hubtel POS Sales ID is not configured' };
    try {
      const r = await httpJson(`https://rmp.hubtel.com/merchantaccount/merchants/${this.merchant}/receive/mobilemoney`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          CustomerName: i.customerName ?? 'Customer', CustomerMsisdn: i.phone, CustomerEmail: i.email, Channel: i.channel,
          Amount: major(i.amountCents), PrimaryCallbackUrl: i.callbackUrl, Description: i.description.slice(0, 100), ClientReference: i.reference,
        }),
      });
      if (r?.ResponseCode === '0001' || r?.ResponseCode === '0000') return { status: 'pending', providerRef: r.Data?.TransactionId, message: r.Data?.Description ?? r.Message, raw: r };
      return { status: 'failed', message: r?.Message ?? r?.Data?.Description ?? `Hubtel response ${r?.ResponseCode}`, raw: r };
    } catch (err) {
      if (err instanceof IntegrationError && err.status && err.status < 500) return { status: 'failed', message: (err.body as any)?.Message ?? 'Hubtel rejected the request', raw: err.body };
      throw err;
    }
  }

  async verify(ref: { reference: string }): Promise<VerifyOutput> {
    let r: any;
    try {
      r = await httpJson(`https://api-txnstatus.hubtel.com/transactions/${this.merchant}/status?clientReference=${encodeURIComponent(ref.reference)}`, { headers: this.headers() });
    } catch (err) {
      if (err instanceof IntegrationError && err.status === 404) return { status: 'pending', message: 'Transaction not found yet', raw: err.body };
      throw err;
    }
    const d = r?.data ?? r?.Data ?? {};
    const raw = { responseCode: r?.responseCode, data: { status: d.status, amount: d.amount, currencyCode: d.currencyCode, clientReference: d.clientReference, transactionId: d.transactionId, externalTransactionId: d.externalTransactionId } };
    if (d.clientReference && d.clientReference !== ref.reference) return { status: 'pending', message: 'Reference mismatch', raw };
    if (d.status === 'Paid') return { status: 'succeeded', paidAmountCents: toCents(d.amount), currency: d.currencyCode, receiptNumber: d.externalTransactionId || d.transactionId, raw };
    if (d.status === 'Refunded' || d.status === 'Failed') return { status: 'failed', message: d.status, raw };
    return { status: 'pending', message: d.status, raw }; // Unpaid
  }

  webhook(input: WebhookInput) {
    const ref = input.body?.Data?.ClientReference ?? input.body?.data?.clientReference;
    return ref ? { reference: String(ref) } : {};
  }

  async testCredentials() {
    try {
      await this.verify({ reference: 'afeypos-credential-test' });
    } catch (err) {
      if (err instanceof IntegrationError && (err.status === 401 || err.status === 403)) throw new IntegrationError('Hubtel rejected the API credentials (or this server IP is not whitelisted)', err.status, err.body, false);
      throw err;
    }
    return 'Hubtel credentials accepted';
  }
}
