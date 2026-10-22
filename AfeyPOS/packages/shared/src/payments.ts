/**
 * Payment gateway catalogue shared by the server (validation, adapters) and the web app (settings forms,
 * checkout buttons). M-Pesa via Safaricom Daraja is configured separately (integration kind "mpesa");
 * everything here is integration kind "payment".
 */

export const PAYMENT_PROVIDERS = [
  'paystack',
  'flutterwave',
  'pawapay',
  'airtel',
  'kopokopo',
  'hubtel',
  'ipay',
  'zenopay',
  'africastalking',
  'julypay',
  'chipper',
  'simulator',
] as const;

export type PaymentProviderKey = (typeof PAYMENT_PROVIDERS)[number];

export interface PaymentProviderField {
  key: string;
  label: string;
  /** Stored encrypted, never returned by the API. */
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
}

export interface PaymentChannel {
  value: string;
  label: string;
  currency: string;
}

export interface PaymentProviderInfo {
  key: PaymentProviderKey;
  label: string;
  description: string;
  countries: string[];
  /** "available" adapters are implemented; "soon" providers are listed but cannot be configured yet. */
  availability: 'available' | 'soon';
  /** push: payment prompt on the customer's phone. link: hosted checkout page (shown as a QR code / link). */
  flows: ('push' | 'link')[];
  /** Networks the cashier picks at the till; empty when the provider detects the network from the number. */
  channels: PaymentChannel[];
  /** Currency used when the provider has no channel list. */
  defaultCurrency?: string;
  /** How inbound webhooks are authenticated before the payment is re-verified with the provider's API. */
  webhookAuth: 'hmac' | 'shared-secret' | 'callback-token';
  fields: PaymentProviderField[];
  docsUrl?: string;
  devOnly?: boolean;
}

const emailField: PaymentProviderField = {
  key: 'customerEmail',
  label: 'Fallback customer email',
  required: true,
  placeholder: 'payments@yourshop.co.ke',
  help: 'Used when a walk-in customer has no email; the gateway requires one.',
};

export const PAYMENT_PROVIDER_INFO: Record<PaymentProviderKey, PaymentProviderInfo> = {
  paystack: {
    key: 'paystack',
    label: 'Paystack',
    description: 'Cards, bank and mobile money (M-Pesa, MTN, AirtelTigo, Telecel) in Nigeria, Ghana, Kenya, South Africa and Côte d’Ivoire.',
    countries: ['NG', 'GH', 'KE', 'ZA', 'CI'],
    availability: 'available',
    flows: ['push', 'link'],
    channels: [
      { value: 'mpesa', label: 'M-Pesa (Kenya)', currency: 'KES' },
      { value: 'mtn', label: 'MTN MoMo (Ghana)', currency: 'GHS' },
      { value: 'atl', label: 'AirtelTigo (Ghana)', currency: 'GHS' },
      { value: 'vod', label: 'Telecel (Ghana)', currency: 'GHS' },
    ],
    webhookAuth: 'hmac',
    fields: [
      { key: 'secretKey', label: 'Secret key', secret: true, required: true, placeholder: 'sk_test_…' },
      { key: 'currency', label: 'Currency for card / link payments', placeholder: 'KES' },
      emailField,
    ],
    docsUrl: 'https://paystack.com/docs/api/',
  },
  flutterwave: {
    key: 'flutterwave',
    label: 'Flutterwave',
    description: 'Cards, M-Pesa and mobile money across Africa via hosted checkout or direct charge.',
    countries: ['NG', 'KE', 'GH', 'UG', 'TZ', 'RW', 'ZM', 'ZA', 'CM', 'CI', 'SN'],
    availability: 'available',
    flows: ['push', 'link'],
    channels: [
      { value: 'mpesa', label: 'M-Pesa (Kenya)', currency: 'KES' },
      { value: 'mobile_money_ghana:MTN', label: 'MTN MoMo (Ghana)', currency: 'GHS' },
      { value: 'mobile_money_ghana:VODAFONE', label: 'Telecel (Ghana)', currency: 'GHS' },
      { value: 'mobile_money_ghana:TIGO', label: 'AirtelTigo (Ghana)', currency: 'GHS' },
      { value: 'mobile_money_uganda', label: 'Mobile money (Uganda)', currency: 'UGX' },
      { value: 'mobile_money_rwanda', label: 'Mobile money (Rwanda)', currency: 'RWF' },
      { value: 'mobile_money_zambia', label: 'Mobile money (Zambia)', currency: 'ZMW' },
      { value: 'mobile_money_tanzania', label: 'Mobile money (Tanzania)', currency: 'TZS' },
      { value: 'mobile_money_franco', label: 'Mobile money (Francophone, XAF/XOF)', currency: 'XAF' },
    ],
    webhookAuth: 'shared-secret',
    fields: [
      { key: 'secretKey', label: 'Secret key', secret: true, required: true, placeholder: 'FLWSECK_TEST-…' },
      { key: 'webhookHash', label: 'Webhook secret hash', secret: true, required: true, help: 'Set the same value under Settings → Webhooks in the Flutterwave dashboard.' },
      { key: 'currency', label: 'Currency for card / link payments', placeholder: 'KES' },
      emailField,
    ],
    docsUrl: 'https://developer.flutterwave.com/docs',
  },
  pawapay: {
    key: 'pawapay',
    label: 'pawaPay',
    description: 'Mobile money deposits across 20+ African markets through one API (M-Pesa, MTN, Airtel, Vodacom, Orange…).',
    countries: ['KE', 'UG', 'TZ', 'RW', 'ZM', 'GH', 'CM', 'CI', 'SN', 'BJ', 'CD', 'MW', 'MZ', 'SL', 'NG'],
    availability: 'available',
    flows: ['push'],
    channels: [
      { value: 'MPESA_KEN', label: 'M-Pesa (Kenya)', currency: 'KES' },
      { value: 'MTN_MOMO_UGA', label: 'MTN (Uganda)', currency: 'UGX' },
      { value: 'AIRTEL_OAPI_UGA', label: 'Airtel (Uganda)', currency: 'UGX' },
      { value: 'VODACOM_TZA', label: 'Vodacom M-Pesa (Tanzania)', currency: 'TZS' },
      { value: 'AIRTEL_TZA', label: 'Airtel (Tanzania)', currency: 'TZS' },
      { value: 'TIGO_TZA', label: 'Tigo / Mixx (Tanzania)', currency: 'TZS' },
      { value: 'HALOTEL_TZA', label: 'Halotel (Tanzania)', currency: 'TZS' },
      { value: 'MTN_MOMO_RWA', label: 'MTN (Rwanda)', currency: 'RWF' },
      { value: 'AIRTEL_RWA', label: 'Airtel (Rwanda)', currency: 'RWF' },
      { value: 'MTN_MOMO_ZMB', label: 'MTN (Zambia)', currency: 'ZMW' },
      { value: 'AIRTEL_OAPI_ZMB', label: 'Airtel (Zambia)', currency: 'ZMW' },
      { value: 'MTN_MOMO_GHA', label: 'MTN (Ghana)', currency: 'GHS' },
      { value: 'VODAFONE_GHA', label: 'Telecel (Ghana)', currency: 'GHS' },
      { value: 'AIRTELTIGO_GHA', label: 'AirtelTigo (Ghana)', currency: 'GHS' },
      { value: 'MTN_MOMO_CMR', label: 'MTN (Cameroon)', currency: 'XAF' },
      { value: 'ORANGE_CMR', label: 'Orange (Cameroon)', currency: 'XAF' },
      { value: 'VODACOM_MPESA_COD', label: 'Vodacom M-Pesa (DR Congo)', currency: 'CDF' },
      { value: 'AIRTEL_MWI', label: 'Airtel (Malawi)', currency: 'MWK' },
    ],
    webhookAuth: 'callback-token',
    fields: [
      { key: 'apiToken', label: 'API token', secret: true, required: true },
      { key: 'baseUrl', label: 'API base URL (optional override)', placeholder: 'https://api.sandbox.pawapay.io', help: 'Leave empty to use the default sandbox / production URL.' },
    ],
    docsUrl: 'https://docs.pawapay.io/',
  },
  airtel: {
    key: 'airtel',
    label: 'Airtel Money',
    description: 'Airtel Africa Open API collections (USSD push) in Kenya, Uganda, Tanzania, Rwanda, Zambia, Malawi, DRC and more.',
    countries: ['KE', 'UG', 'TZ', 'RW', 'ZM', 'MW', 'CD', 'CG', 'GA', 'NE', 'TD', 'MG', 'SC', 'NG'],
    availability: 'available',
    flows: ['push'],
    channels: [],
    webhookAuth: 'callback-token',
    fields: [
      { key: 'clientId', label: 'Client ID', secret: true, required: true },
      { key: 'clientSecret', label: 'Client secret', secret: true, required: true },
      {
        key: 'country',
        label: 'Country',
        required: true,
        options: [
          { value: 'KE', label: 'Kenya (KES)' },
          { value: 'UG', label: 'Uganda (UGX)' },
          { value: 'TZ', label: 'Tanzania (TZS)' },
          { value: 'RW', label: 'Rwanda (RWF)' },
          { value: 'ZM', label: 'Zambia (ZMW)' },
          { value: 'MW', label: 'Malawi (MWK)' },
          { value: 'CD', label: 'DR Congo (CDF)' },
          { value: 'NG', label: 'Nigeria (NGN)' },
        ],
      },
    ],
    docsUrl: 'https://developers.airtel.africa/',
  },
  kopokopo: {
    key: 'kopokopo',
    label: 'Kopo Kopo',
    description: 'M-Pesa STK push to your Kopo Kopo till (Kenya), with signed webhooks.',
    countries: ['KE'],
    availability: 'available',
    flows: ['push'],
    channels: [],
    defaultCurrency: 'KES',
    webhookAuth: 'hmac',
    fields: [
      { key: 'clientId', label: 'Client ID', secret: true, required: true },
      { key: 'clientSecret', label: 'Client secret', secret: true, required: true },
      { key: 'apiKey', label: 'API key (webhook signature)', secret: true, required: true },
      { key: 'tillNumber', label: 'Online payments till number', required: true, placeholder: 'K000000' },
    ],
    docsUrl: 'https://api-docs.kopokopo.com/',
  },
  hubtel: {
    key: 'hubtel',
    label: 'Hubtel',
    description: 'Receive mobile money in Ghana (MTN, Telecel, AirtelTigo).',
    countries: ['GH'],
    availability: 'available',
    flows: ['push'],
    channels: [
      { value: 'mtn-gh', label: 'MTN MoMo', currency: 'GHS' },
      { value: 'vodafone-gh', label: 'Telecel Cash', currency: 'GHS' },
      { value: 'tigo-gh', label: 'AirtelTigo Money', currency: 'GHS' },
    ],
    webhookAuth: 'callback-token',
    fields: [
      { key: 'clientId', label: 'API ID (username)', secret: true, required: true },
      { key: 'clientSecret', label: 'API key', secret: true, required: true },
      { key: 'merchantAccountNumber', label: 'POS Sales ID (merchant account number)', required: true },
    ],
    docsUrl: 'https://developers.hubtel.com/',
  },
  ipay: {
    key: 'ipay',
    label: 'iPay',
    description: 'iPay Africa M-Pesa STK push (Kenya).',
    countries: ['KE'],
    availability: 'available',
    flows: ['push'],
    channels: [],
    defaultCurrency: 'KES',
    webhookAuth: 'callback-token',
    fields: [
      { key: 'vendorId', label: 'Vendor ID', required: true },
      { key: 'hashKey', label: 'Hash key', secret: true, required: true },
    ],
    docsUrl: 'https://dev.ipayafrica.com/',
  },
  zenopay: {
    key: 'zenopay',
    label: 'ZenoPay',
    description: 'Tanzanian mobile money (M-Pesa, Mixx by Yas, Airtel Money, Halopesa).',
    countries: ['TZ'],
    availability: 'available',
    flows: ['push'],
    channels: [],
    defaultCurrency: 'TZS',
    webhookAuth: 'shared-secret',
    fields: [{ key: 'apiKey', label: 'API key', secret: true, required: true }],
    docsUrl: 'https://zenoapi.com/',
  },
  africastalking: {
    key: 'africastalking',
    label: "Africa's Talking",
    description: "Africa's Talking Payments mobile checkout (Kenya, Uganda, Tanzania, Rwanda…).",
    countries: ['KE', 'UG', 'TZ', 'RW', 'MW', 'ZM'],
    availability: 'available',
    flows: ['push'],
    channels: [],
    defaultCurrency: 'KES',
    webhookAuth: 'callback-token',
    fields: [
      { key: 'username', label: 'Username', required: true, placeholder: 'sandbox' },
      { key: 'apiKey', label: 'API key', secret: true, required: true },
      { key: 'productName', label: 'Payment product name', required: true },
      { key: 'currency', label: 'Currency', placeholder: 'KES' },
    ],
    docsUrl: 'https://developers.africastalking.com/docs/payments/overview',
  },
  julypay: {
    key: 'julypay',
    label: 'JulyPay',
    description: 'Coming soon: waiting for merchant API documentation and sandbox access.',
    countries: [],
    availability: 'soon',
    flows: ['push'],
    channels: [],
    webhookAuth: 'callback-token',
    fields: [],
  },
  chipper: {
    key: 'chipper',
    label: 'Chipper',
    description: 'Coming soon: Chipper Cash merchant collections require partner API access.',
    countries: [],
    availability: 'soon',
    flows: ['link'],
    channels: [],
    webhookAuth: 'callback-token',
    fields: [],
  },
  simulator: {
    key: 'simulator',
    label: 'Payment simulator',
    description: 'Offline test gateway for training and development. Never moves money; disabled in production.',
    countries: [],
    availability: 'available',
    flows: ['push', 'link'],
    channels: [],
    webhookAuth: 'callback-token',
    fields: [{ key: 'currency', label: 'Currency', placeholder: 'KES' }],
    devOnly: true,
  },
};

export function paymentProviderLabel(key: string | undefined | null): string {
  return (key && PAYMENT_PROVIDER_INFO[key as PaymentProviderKey]?.label) || 'Online payment';
}

/** Currency for a charge: the channel's currency, else the configured one, else the provider default. */
export function paymentCurrency(provider: PaymentProviderKey, channel: string | undefined, configured?: string, fallback = 'KES'): string {
  const info = PAYMENT_PROVIDER_INFO[provider];
  const ch = channel ? info.channels.find((c) => c.value === channel) : undefined;
  return (ch?.currency ?? (configured || info.defaultCurrency || fallback)).toUpperCase();
}
