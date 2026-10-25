/** Per-device settings (which till this computer is) kept in localStorage. */
const KEY = 'afey.workstation';

export interface Workstation {
  tillId?: string;
  theme?: 'light' | 'dark' | 'system';
  receiptWidth?: number;
  autoPrint?: boolean;
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
