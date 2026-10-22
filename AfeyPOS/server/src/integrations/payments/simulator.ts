/**
 * Offline gateway for training, development and automated tests. Never moves money.
 * Outcomes are set explicitly via POST /payments/gateways/simulate/:id (non-production only).
 */
import type { ChargeInput, ChargeOutput, PaymentGateway, VerifyOutput } from './types.js';

export class SimulatorGateway implements PaymentGateway {
  static charges: ChargeInput[] = [];
  static results = new Map<string, VerifyOutput>();

  async charge(i: ChargeInput): Promise<ChargeOutput> {
    SimulatorGateway.charges.push(i);
    if (i.phone?.endsWith('000000')) return { status: 'failed', message: 'Simulated rejection (number ends in 000000)' };
    return { status: 'pending', providerRef: `SIM-${i.reference.slice(-10)}`, checkoutUrl: i.flow === 'link' ? `${i.redirectUrl}${i.redirectUrl.includes('?') ? '&' : '?'}simulated=${i.reference}` : undefined };
  }

  async verify(ref: { reference: string }): Promise<VerifyOutput> {
    return SimulatorGateway.results.get(ref.reference) ?? { status: 'pending', message: 'Waiting for the simulated customer' };
  }

  webhook(input: { body: any }) {
    return input.body?.reference ? { reference: String(input.body.reference) } : {};
  }

  async testCredentials() {
    return 'Simulator ready (no money moves)';
  }
}
