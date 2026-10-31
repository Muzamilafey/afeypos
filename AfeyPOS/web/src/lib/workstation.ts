/** Per-device settings (which till this computer is) kept in localStorage. */
const KEY = 'afey.workstation';

export interface Workstation {
  tillId?: string;
  theme?: 'light' | 'dark' | 'system';
  receiptWidth?: number;
  autoPrint?: boolean;
  /**
   * How receipts print on this computer. dialog: the browser's print window. silent: the browser prints at once
   * (Chrome/Edge started with --kiosk-printing). bridge: straight to the printer chosen in the device bridge.
   * network: the server sends it to the till's network printer.
   */
  printMode?: 'dialog' | 'silent' | 'bridge' | 'network' | 'server';
  /** 'server' mode: the printer on the Afey POS computer this till prints to (chosen per device). */
  serverPrinter?: string;
  openDrawerOnCash?: boolean;
  /** Afey device bridge on this PC, e.g. http://127.0.0.1:9123, and its pairing token. */
  bridgeUrl?: string;
  bridgeToken?: string;
}

export function getWorkstation(): Workstation {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    return {};
  }
}

export function setWorkstation(patch: Partial<Workstation>) {
  const next = { ...getWorkstation(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable */
  }
  return next;
}

export function applyTheme(theme: Workstation['theme'] = getWorkstation().theme ?? 'system') {
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}
