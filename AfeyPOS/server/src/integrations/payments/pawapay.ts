/**
 * pawaPay deposits (mobile money collection). depositId must be a UUID v4 and is our reference.
 * Verify: GET /deposits/{depositId}. Callbacks are authenticated by the per-tenant callback token in the URL
 * and then re-verified with the status API.
 */
import { randomUUID } from 'node:crypto';
import { httpJson, IntegrationError } from '../http.js';
import type { ChargeInput, ChargeOutput, GatewayConfig, PaymentGateway, VerifyOutput, WebhookInput } from './types.js';
import { alnum, majorString, requireSecret, toCents } from './util.js';

export class PawapayGateway implements PaymentGateway {
  private token: string;
  constructor(private cfg: GatewayConfig) {
    this.token = requireSecret(cfg.secrets, 'apiToken', 'pawaPay API token');
  }

  get baseUrl() {
    const override = String(this.cfg.settings.baseUrl ?? '').trim().replace(/\/$/, '');
    if (override) return override;
    return this.cfg.environment === 'production' ? 'https://api.pawapay.io' : 'https://api.sandbox.pawapay.io';
  }

  private headers() {
    return { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' };
  }

  newReference() {
    return randomUUID();
  }

  async charge(i: ChargeInput): Promise<ChargeOutput> {
    if (!i.channel) return { status: 'failed', message: 'Select the mobile network' };
    const description = alnum(i.description, 22).padEnd(4, 'X');
    try {
      const r = await httpJson(`${this.baseUrl}/deposits`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          depositId: i.reference, amount: majorString(i.amountCents), currency: i.currency, correspondent: i.channel,
          payer: { type: 'MSISDN', address: { value: i.phone } }, customerTimestamp: new Date().toISOString(), statementDescription: description,
        }),
      });
      if (r?.status === 'ACCEPTED' || r?.status === 'DUPLICATE_IGNORED') return { status: 'pending', providerRef: r.depositId ?? i.reference, raw: r };
      return { status: 'failed', message: r?.rejectionReason?.rejectionMessage ?? r?.rejectionReason?.rejectionCode ?? 'Deposit rejected', raw: r };
    } catch (err) {
      if (err instanceof IntegrationError && err.status === 400) return { status: 'failed', message: (err.body as any)?.rejectionReason?.rejectionMessage ?? (err.body as any)?.errorMessage ?? 'pawaPay rejected the deposit', raw: err.body };
      throw err;
    }
  }

  async verify(ref: { reference: string }): Promise<VerifyOutput> {
    const r = await httpJson<any[]>(`${this.baseUrl}/deposits/${encodeURIComponent(ref.reference)}`, { headers: this.headers() });
    const d = Array.isArray(r) ? r[0] : (r as any)?.data ?? r;
    if (!d?.status) return { status: 'pending', message: 'Deposit not found yet', raw: r };
    const raw = { depositId: d.depositId, status: d.status, requestedAmount: d.requestedAmount, depositedAmount: d.depositedAmount, currency: d.currency, correspondent: d.correspondent, failureReason: d.failureReason };
    if (d.depositId && d.depositId !== ref.reference) return { status: 'pending', message: 'Reference mismatch', raw };
    if (d.status === 'COMPLETED') {
      const ids = d.correspondentIds ? Object.values(d.correspondentIds).filter(Boolean).map(String) : [];
      return { status: 'succeeded', paidAmountCents: toCents(d.depositedAmount ?? d.requestedAmount), currency: d.currency, receiptNumber: ids[0] ?? d.depositId, phone: d.payer?.address?.value, raw };
    }
    if (d.status === 'FAILED' || d.status === 'REJECTED') return { status: 'failed', message: d.failureReason?.failureMessage ?? d.failureReason?.failureCode ?? 'Deposit failed', raw };
    return { status: 'pending', raw }; // ACCEPTED, SUBMITTED, ENQUEUED
  }

  webhook(input: WebhookInput) {
    const id = input.body?.depositId;
    return id ? { reference: String(id) } : {};
  }

  async testCredentials() {
    await httpJson(`${this.baseUrl}/active-conf`, { headers: this.headers() });
    return `pawaPay ${this.cfg.environment} token accepted`;
  }
}
