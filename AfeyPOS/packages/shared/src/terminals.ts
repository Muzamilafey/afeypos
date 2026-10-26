/**
 * Bank card terminals connected to Afey POS (integrated / semi-integrated card payments).
 *
 * Afey POS never reads cards or PINs: the certified terminal does. Afey POS sends the amount and a unique
 * reference, follows the terminal's progress, and treats a payment as approved only when the provider's
 * authenticated transaction status says so.
 *
 * The catalogue below is deliberately honest. A provider is "available" only when an adapter built from the
 * provider's own documentation exists and has been tested on real hardware. Banks that have not published an
 * integration specification are listed as "provider_access_required": the merchant can see what is needed,
 * but cannot enable them for payments.
 */

export const TERMINAL_CONNECTIONS = ['lan', 'usb', 'serial', 'cloud'] as const;
export type TerminalConnection = (typeof TERMINAL_CONNECTIONS)[number];

export const TERMINAL_CONNECTION_LABELS: Record<TerminalConnection, string> = {
  lan: 'LAN / Wi-Fi',
  usb: 'USB',
  serial: 'Serial (COM port)',
  cloud: 'Approved cloud connection',
};

export const TERMINAL_PROVIDERS = ['simulator', 'equity', 'kcb', 'coop', 'ncba', 'absa', 'nexo'] as const;
export type TerminalProviderKey = (typeof TERMINAL_PROVIDERS)[number];

/**
 * available                 = adapter implemented and certified with real hardware; usable for real payments.
 * sandbox                   = test-only adapter; never moves money and is never shown as a real payment.
 * provider_access_required  = the provider has to supply its specification/SDK, credentials and test terminal first.
 * not_supported             = listed for information; no adapter yet.
 */
export type TerminalAvailability = 'available' | 'sandbox' | 'provider_access_required' | 'not_supported';

export interface TerminalCapabilities {
  discovery: boolean;
  pairing: boolean;
  statusEvents: boolean;
  query: boolean;
  cancel: boolean;
  refund: boolean;
  /** The provider sends signed transaction notifications (used as a hint, always re-checked by query). */
  notifications: boolean;
  /** The terminal reports that the customer can remove the card. */
  removeCardEvent: boolean;
}

export interface TerminalModelInfo {
  name: string;
  os: string;
  connections: TerminalConnection[];
  notes?: string;
}

export interface TerminalProviderInfo {
  key: TerminalProviderKey;
  label: string;
  bank?: string;
  availability: TerminalAvailability;
  description: string;
  /** Connection methods this integration actually supports. Others are never offered as working options. */
  connections: TerminalConnection[];
  models: TerminalModelInfo[];
  capabilities: TerminalCapabilities;
  /** What the merchant installs or prepares (shown in the wizard). */
  installSteps: string[];
  /** What it takes to get the provider supported (shown for providers that are not available yet). */
  accessSteps?: string[];
  integrationVersion?: string;
  docsUrl?: string;
}

const NONE: TerminalCapabilities = { discovery: false, pairing: false, statusEvents: false, query: false, cancel: false, refund: false, notifications: false, removeCardEvent: false };

const BANK_ACCESS_STEPS = (bank: string) => [
  `Ask ${bank} (merchant acquiring / card services) for its ECR or semi-integrated POS integration specification or SDK.`,
  'Ask which terminal models and firmware support it, and which connection methods (LAN, USB, serial or a cloud API) are allowed.',
  'Ask for sandbox or test credentials and a test terminal with test cards (a "test kit").',
  'Agree the certification process: the bank (or its terminal vendor) must certify the integration before live payments.',
  'Send the documentation to your Afey POS provider so an adapter can be built from it. Nothing is guessed: no adapter is written without the official documentation.',
];

export const TERMINAL_PROVIDER_INFO: Record<TerminalProviderKey, TerminalProviderInfo> = {
  simulator: {
    key: 'simulator',
    label: 'Afey terminal simulator',
    availability: 'sandbox',
    description: 'A simulated card terminal for training, demonstrations and automated tests. It never moves money; payments made with it are marked SIMULATED on the sale and receipt.',
    connections: ['cloud'],
    models: [{ name: 'Afey Simulated Terminal', os: 'Simulated (runs inside Afey POS)', connections: ['cloud'], notes: 'Test amounts: ending in .51 declines, .52 the customer cancels, .53 the connection drops before approval, .54 waits until you finish it from the simulator panel.' }],
    capabilities: { discovery: true, pairing: true, statusEvents: true, query: true, cancel: true, refund: true, notifications: true, removeCardEvent: true },
    installSteps: ['Nothing to install: the simulator runs inside Afey POS.', 'Use it to train cashiers and to try the checkout flow. Switch to a real provider before taking real card payments.'],
    integrationVersion: 'sim-1',
  },
  equity: {
    key: 'equity',
    label: 'Equity Bank Kenya',
    bank: 'Equity Bank',
    availability: 'provider_access_required',
    description: 'Equity Bank card terminals. Equity has not published an ECR / semi-integrated POS specification; an adapter will be added through this framework once Equity provides the specification, credentials and a test terminal.',
    connections: [],
    models: [],
    capabilities: NONE,
    installSteps: [],
    accessSteps: BANK_ACCESS_STEPS('Equity Bank'),
  },
  kcb: {
    key: 'kcb', label: 'KCB Bank Kenya', bank: 'KCB Bank', availability: 'provider_access_required',
    description: 'KCB card terminals. Needs KCB’s integration specification and a test terminal before it can be supported.',
    connections: [], models: [], capabilities: NONE, installSteps: [], accessSteps: BANK_ACCESS_STEPS('KCB Bank'),
  },
  coop: {
    key: 'coop', label: 'Co-operative Bank of Kenya', bank: 'Co-operative Bank', availability: 'provider_access_required',
    description: 'Co-op Bank card terminals. Needs the bank’s integration specification and a test terminal before it can be supported.',
    connections: [], models: [], capabilities: NONE, installSteps: [], accessSteps: BANK_ACCESS_STEPS('Co-operative Bank'),
  },
  ncba: {
    key: 'ncba', label: 'NCBA Bank Kenya', bank: 'NCBA Bank', availability: 'provider_access_required',
    description: 'NCBA card terminals. Needs the bank’s integration specification and a test terminal before it can be supported.',
    connections: [], models: [], capabilities: NONE, installSteps: [], accessSteps: BANK_ACCESS_STEPS('NCBA Bank'),
  },
  absa: {
    key: 'absa', label: 'Absa Bank Kenya', bank: 'Absa Bank Kenya', availability: 'provider_access_required',
    description: 'Absa card terminals. Needs the bank’s integration specification and a test terminal before it can be supported.',
    connections: [], models: [], capabilities: NONE, installSteps: [], accessSteps: BANK_ACCESS_STEPS('Absa Bank Kenya'),
  },
  nexo: {
    key: 'nexo',
    label: 'nexo Retailer (ISO 20022 CASP) terminals',
    availability: 'not_supported',
    description: 'Some terminal vendors and acquirers support the open nexo Retailer protocol (published by ISO as the Card Sale to POI Protocol). It still needs the acquirer’s approval, its terminal configuration and certification. Not yet supported.',
    connections: [],
    models: [],
    capabilities: NONE,
    installSteps: [],
    accessSteps: [
      'Confirm with your bank that your terminal and acquirer support nexo Retailer (and which version).',
      'Get the bank’s permission and test terminal to certify an integration.',
      'Contact your Afey POS provider: a nexo adapter can be added through this framework after it is certified.',
    ],
    docsUrl: 'https://nexo-standards.org/standards/nexo-retailer-protocol',
  },
};

export const terminalProviderLabel = (key: string | undefined | null) => (key && TERMINAL_PROVIDER_INFO[key as TerminalProviderKey]?.label) || 'Card terminal';

// ---- transactions ----

export const TERMINAL_TXN_STATUSES = ['created', 'connecting', 'awaiting_card', 'awaiting_pin', 'processing', 'approved', 'declined', 'cancelled', 'failed', 'unknown'] as const;
export type TerminalTxnStatus = (typeof TERMINAL_TXN_STATUSES)[number];

/** Still open: the terminal may yet charge the card. A terminal with an open transaction takes no other. */
export const TERMINAL_OPEN_STATUSES: readonly TerminalTxnStatus[] = ['created', 'connecting', 'awaiting_card', 'awaiting_pin', 'processing', 'unknown'];
export const terminalTxnOpen = (s: string) => (TERMINAL_OPEN_STATUSES as readonly string[]).includes(s);

/** What the cashier sees for each status. */
export function terminalStatusMessage(t: { status: string; removeCard?: boolean; sandbox?: boolean; connectionLost?: boolean; message?: string | null }): { title: string; tone: 'info' | 'wait' | 'ok' | 'bad' | 'warn' } {
  if (t.connectionLost && terminalTxnOpen(t.status)) return { title: 'Connection lost — checking the transaction with the terminal', tone: 'warn' };
  switch (t.status) {
    case 'created':
    case 'connecting': return { title: 'Connecting to terminal…', tone: 'wait' };
    case 'awaiting_card': return { title: 'Ready for card — insert, tap or present the card', tone: 'wait' };
    case 'awaiting_pin': return { title: 'Enter PIN on the terminal', tone: 'wait' };
    case 'processing': return { title: 'Processing payment…', tone: 'wait' };
    case 'approved': return { title: t.removeCard ? 'Payment approved — please remove your card' : 'Payment approved', tone: 'ok' };
    case 'declined': return { title: 'Payment declined', tone: 'bad' };
    case 'cancelled': return { title: 'Transaction cancelled', tone: 'bad' };
    case 'failed': return { title: t.message ? `Payment not started: ${t.message}` : 'Payment not started', tone: 'bad' };
    case 'unknown': return { title: 'Payment status unknown — checking transaction', tone: 'warn' };
    default: return { title: t.status, tone: 'info' };
  }
}

/** Terminal and connection problems, in words a cashier or manager can act on. */
export const TERMINAL_ERROR_MESSAGES: Record<string, string> = {
  POWERED_OFF: 'The terminal is switched off. Switch it on and wait for its home screen.',
  UNREACHABLE: 'The terminal cannot be reached on the network. Check its Wi-Fi/cable, and that it is on the same network as this till.',
  ADDRESS_CHANGED: 'The terminal answered from a new address. Afey POS reconnected to it after checking its identity.',
  USB_DISCONNECTED: 'The terminal’s USB cable is unplugged. Plug it in again.',
  PAIRING_REJECTED: 'The terminal rejected pairing. Check the pairing code shown on the terminal and try again.',
  UNSUPPORTED_MODEL: 'This terminal model or firmware is not supported by this integration.',
  BAD_CONFIG: 'The terminal settings are incorrect. Open Bank card terminals and check the connection details.',
  CREDENTIALS_EXPIRED: 'The terminal’s pairing or credentials have expired. Pair the terminal again.',
  BUSY: 'The terminal is busy with another transaction. Finish or cancel it on the terminal first.',
  PROVIDER_UNAVAILABLE: 'The payment provider’s service is not available right now. Try again shortly or use another way to pay.',
  IDENTITY_MISMATCH: 'A device answered at this address but its identity does not match the paired terminal. It was not trusted.',
  TIMEOUT: 'The terminal did not answer in time.',
};
