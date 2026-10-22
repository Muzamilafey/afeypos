import { PAYMENT_PROVIDER_INFO, type PaymentProviderKey } from '@afeypos/shared';
import { IntegrationError } from '../http.js';
import { AfricasTalkingGateway } from './africastalking.js';
import { AirtelGateway } from './airtel.js';
import { FlutterwaveGateway } from './flutterwave.js';
import { HubtelGateway } from './hubtel.js';
import { IpayGateway } from './ipay.js';
import { KopoKopoGateway } from './kopokopo.js';
import { PawapayGateway } from './pawapay.js';
import { PaystackGateway } from './paystack.js';
import { SimulatorGateway } from './simulator.js';
import { ZenoPayGateway } from './zenopay.js';
import type { GatewayConfig, PaymentGateway } from './types.js';

export * from './types.js';
export { SimulatorGateway };

const FACTORIES: Partial<Record<PaymentProviderKey, (cfg: GatewayConfig) => PaymentGateway>> = {
  paystack: (c) => new PaystackGateway(c),
  flutterwave: (c) => new FlutterwaveGateway(c),
  pawapay: (c) => new PawapayGateway(c),
  airtel: (c) => new AirtelGateway(c),
  kopokopo: (c) => new KopoKopoGateway(c),
  hubtel: (c) => new HubtelGateway(c),
  ipay: (c) => new IpayGateway(c),
  zenopay: (c) => new ZenoPayGateway(c),
  africastalking: (c) => new AfricasTalkingGateway(c),
  simulator: () => new SimulatorGateway(),
};

export function createPaymentGateway(cfg: GatewayConfig): PaymentGateway {
  const info = PAYMENT_PROVIDER_INFO[cfg.provider];
  const factory = FACTORIES[cfg.provider];
  if (!info || info.availability !== 'available' || !factory) throw new IntegrationError(`${info?.label ?? cfg.provider} is not available yet`, undefined, undefined, false);
  return factory(cfg);
}

export const implementedProviders = () => Object.keys(FACTORIES) as PaymentProviderKey[];
