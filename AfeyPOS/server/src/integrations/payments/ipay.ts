/**
 * iPay Africa (Kenya) C2B REST API: initiate a transaction, then trigger an M-Pesa STK push.
 * Requests are signed with HMAC-SHA256(hash key) over the concatenated fields.
 * Verify: POST /transaction/search { oid, vid, hash }.
 */
import { httpJson, IntegrationError } from '../http.js';
import type { ChargeInput, ChargeOutput, GatewayConfig, PaymentGateway, VerifyOutput, WebhookInput } from './types.js';
import { hmacHex, majorString, requireSecret, toCents } from './util.js';

const BASE = 'https://apis.ipayafrica.com/payments/v2';

export class IpayGateway implements PaymentGateway {
  private hashKey: string;
  private vid: string;
  constructor(private cfg: GatewayConfig) {
    this.hashKey = requireSecret(cfg.secrets, 'hashKey', 'iPay hash key');
    this.vid = String(cfg.settings.vendorId ?? '');
  }

  private sign(...parts: string[]) {
    return hmacHex('sha256', this.hashKey, parts.join(''));
  }

  private post(path: string, body: Record<string, string>) {
    return httpJson(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
  }

  async charge(i: ChargeInput): Promise<ChargeOutput> {
    if (!this.vid) return { status: 'failed', message: 'iPay vendor ID is not configured' };
    const f = {
      live: this.cfg.environment === 'production' ? '1' : '0', oid: i.reference, inv: i.reference, amount: majorString(i.amountCents), tel: i.phone!, eml: i.email,
      vid: this.vid, curr: i.currency, p1: '', p2: '', p3: '', p4: '', cbk: i.callbackUrl, cst: '1', crl: '0',
    };
    try {
      const init = await this.post('/transact', { ...f, hash: this.sign(f.live, f.oid, f.inv, f.amount, f.tel, f.eml, f.vid, f.curr, f.p1, f.p2, f.p3, f.p4, f.cbk, f.cst, f.crl) });
      const sid = init?.data?.sid;
      if (String(init?.status) !== '1' || !sid) return { status: 'failed', message: init?.text ?? init?.error?.[0]?.text ?? 'iPay did not start the transaction', raw: init };
      const push = await this.post('/transact/push/mpesa', { phone: f.tel, sid, vid: this.vid, hash: this.sign(f.tel, this.vid, sid) });
      if (String(push?.status) !== '1') return { status: 'failed', message: push?.text ?? 'iPay could not send the M-Pesa prompt', raw: push };
      return { status: 'pending', providerRef: sid, message: push?.text, raw: { init, push } };
    } catch (err) {
      if (err instanceof IntegrationError && err.status && err.status < 500) return { status: 'failed', message: (err.body as any)?.error?.[0]?.text ?? (err.body as any)?.text ?? 'iPay rejected the request', raw: err.body };
      throw err;
    }
  }

  async verify(ref: { reference: string }): Promise<VerifyOutput> {
    let r: any;
    try {
      r = await this.post('/transaction/search', { oid: ref.reference, vid: this.vid, hash: this.sign(ref.reference, this.vid) });
    } catch (err) {
      if (err instanceof IntegrationError && (err.status === 400 || err.status === 404)) return { status: 'pending', message: (err.body as any)?.error?.[0]?.text ?? 'Not paid yet', raw: err.body };
      throw err;
    }
    const d = r?.data ?? {};
    const raw = { status: r?.status, data: { transaction_code: d.transaction_code, transaction_amount: d.transaction_amount, payment_mode: d.payment_mode, oid: d.oid } };
    if (String(r?.status) === '1' && d.transaction_code) {
      return { status: 'succeeded', paidAmountCents: toCents(d.transaction_amount), receiptNumber: d.transaction_code, phone: d.telephone, payerName: [d.firstname, d.lastname].filter(Boolean).join(' ') || undefined, raw };
    }
    return { status: 'pending', message: r?.text, raw };
  }

  webhook(input: WebhookInput) {
    // iPay calls back with query/form parameters; `id` is our order id.
    const ref = input.query?.id ?? input.body?.id ?? input.body?.oid;
    return ref ? { reference: String(ref) } : {};
  }

  async testCredentials() {
    try {
      await this.post('/transaction/search', { oid: 'afeypos-test', vid: this.vid, hash: this.sign('afeypos-test', this.vid) });
    } catch (err) {
      const text = JSON.stringify((err as IntegrationError).body ?? '').toLowerCase();
      if (err instanceof IntegrationError && (err.status === 401 || err.status === 403 || text.includes('hash') || text.includes('vendor'))) throw new IntegrationError('iPay rejected the vendor ID or hash key', err.status, err.body, false);
      if (!(err instanceof IntegrationError) || !err.status || err.status >= 500) throw err;
    }
    return 'iPay vendor credentials accepted';
  }
}
