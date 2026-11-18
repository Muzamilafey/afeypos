import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

const BRIDGE_KEY = 'afey.attendance.bridge';

interface PublicConfig {
  tenant?: { name?: string; tagline?: string; logoUrl?: string } | null;
  setupRequired?: boolean;
}

interface BridgeConfig { url: string; token: string }
interface ClockResult { name: string; kind: 'clock_in' | 'clock_out'; at: string; method: 'Staff card' | 'Fingerprint' }
interface ApiFailure extends Error { code?: string }

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'include',
    headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data?.error?.message ?? `Request failed (${response.status})`) as ApiFailure;
    err.code = data?.error?.code;
    throw err;
  }
  return data as T;
}

function savedBridge(): BridgeConfig {
  try {
    const saved = JSON.parse(localStorage.getItem(BRIDGE_KEY) ?? '{}') as Partial<BridgeConfig> | null;
    return {
      url: typeof saved?.url === 'string' && saved.url ? saved.url : 'http://127.0.0.1:9123',
      token: typeof saved?.token === 'string' ? saved.token : '',
    };
  }
  catch { return { url: 'http://127.0.0.1:9123', token: '' }; }
}

async function bridgeRequest<T>(config: BridgeConfig, path: string, body?: unknown, timeoutMs = 8000): Promise<T> {
  if (!config.url || !config.token) throw new Error('Set the Afey device bridge address and pairing token first.');
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${config.url.replace(/\/$/, '')}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-Afey-Bridge-Token': config.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error ?? `Bridge returned ${response.status}`);
    return data as T;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw new Error('The fingerprint reader timed out. Check the device and try again.');
    throw err;
  } finally { window.clearTimeout(timer); }
}

function Mark({ src, className = '' }: { src?: string; className?: string }) {
  return <img src={src || '/logo.svg'} alt="" className={`object-contain ${className}`} onError={(e) => { e.currentTarget.src = '/logo.svg'; }} />;
}

export function AttendanceApp() {
  const [publicConfig, setPublicConfig] = useState<PublicConfig | null>(null);
  const [bridgeConfig, setBridgeConfig] = useState(savedBridge);
  const [bridgeStatus, setBridgeStatus] = useState<{ fingerprint?: { connected: boolean; model?: string; vendor?: string }; biometricDevicePaired?: boolean } | null>(null);
  const [bridgeMessage, setBridgeMessage] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [card, setCard] = useState('');
  const [pin, setPin] = useState('');
  const [pinRequired, setPinRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fingerBusy, setFingerBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ClockResult | null>(null);
  const cardRef = useRef<HTMLInputElement>(null);
  const pinRef = useRef<HTMLInputElement>(null);
  const clockLock = useRef(false);
  const businessName = publicConfig?.tenant?.name || 'Afey POS';

  useEffect(() => { api<PublicConfig>('/public/config').then(setPublicConfig).catch(() => undefined); }, []);
  useEffect(() => {
    if (!showSettings && !pinRequired && !busy && !fingerBusy) cardRef.current?.focus();
  }, [showSettings, pinRequired, busy, fingerBusy, result]);

  const saveBridgeConfig = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(''); setBridgeMessage(''); setBridgeStatus(null);
    try {
      const parsed = new URL(bridgeConfig.url);
      if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(parsed.hostname)) throw new Error('Use a local bridge address such as http://127.0.0.1:9123.');
      if (!bridgeConfig.token.trim()) throw new Error('Enter the bridge pairing token from config.json.');
      const next = { url: parsed.origin, token: bridgeConfig.token.trim() };
      localStorage.setItem(BRIDGE_KEY, JSON.stringify(next));
      setBridgeConfig(next);
      setBridgeMessage('Saved for this browser. Testing the bridge…');
      void testBridge(next);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const testBridge = useCallback(async (config = bridgeConfig) => {
    setBridgeMessage('Connecting to the local reader…'); setError('');
    try {
      const status = await bridgeRequest<NonNullable<typeof bridgeStatus>>(config, '/status');
      setBridgeStatus(status);
      setBridgeMessage(status.biometricDevicePaired
        ? `${status.fingerprint?.model ?? status.fingerprint?.vendor ?? 'Fingerprint reader'} ${status.fingerprint?.connected ? 'is ready' : 'is not connected'}.`
        : 'Bridge is reachable, but no fingerprint reader is registered to it yet.');
    } catch (e) { setBridgeMessage(''); setError(e instanceof Error ? e.message : String(e)); }
  }, [bridgeConfig]);

  // The downloaded Windows launcher can transfer the local bridge pairing through
  // the URL fragment. Fragments are not sent to the server; remove it immediately
  // after saving the pairing in this browser's local storage.
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const url = params.get('bridgeUrl');
    const token = params.get('bridgeToken');
    if (!url || !token) return;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(parsed.hostname) || token.length < 24) return;
      const next = { url: parsed.origin, token };
      localStorage.setItem(BRIDGE_KEY, JSON.stringify(next));
      setBridgeConfig(next);
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
      setBridgeMessage('Attendance terminal connected to this computer’s Afey bridge. Checking the fingerprint reader…');
      void testBridge(next);
    } catch {
      // Ignore malformed or non-local launcher settings.
    }
  }, [testBridge]);

  const accept = (name: string, kind: 'clock_in' | 'clock_out', at: string, method: ClockResult['method']) => {
    setResult({ name, kind, at, method });
    setCard(''); setPin(''); setPinRequired(false); setError('');
  };

  const clockWithCard = async (e?: FormEvent, scannedCode = card) => {
    e?.preventDefault();
    if (clockLock.current || !scannedCode.trim()) return;
    clockLock.current = true;
    setBusy(true); setError('');
    try {
      const r = await api<{ data: { name: string; kind: 'clock_in' | 'clock_out'; at: string } }>('/auth/clock', { code: scannedCode.trim().toUpperCase(), ...(pin ? { pin } : {}) });
      accept(r.data.name, r.data.kind, r.data.at, 'Staff card');
    } catch (e) {
      const err = e as ApiFailure;
      if (err.code === 'PIN_REQUIRED') { setPinRequired(true); setTimeout(() => pinRef.current?.focus(), 0); }
      else setError(err.message);
    } finally { clockLock.current = false; setBusy(false); }
  };

  const clockWithFingerprint = async () => {
    if (fingerBusy || clockLock.current) return;
    if (!bridgeConfig.token) { setShowSettings(true); return; }
    clockLock.current = true;
    setFingerBusy(true); setError(''); setResult(null);
    try {
      const r = await bridgeRequest<{ data: { attendance: { kind: 'clock_in' | 'clock_out'; at: string }; user: { name: string } } }>(bridgeConfig, '/fingerprint/identify', { purpose: 'attendance' }, 45_000);
      accept(r.data.user.name, r.data.attendance.kind, r.data.attendance.at, 'Fingerprint');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { clockLock.current = false; setFingerBusy(false); }
  };

  const time = result ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(result.at)) : '';

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-ink-950 p-3 sm:p-6">
      <div aria-hidden="true" className="auth-wallpaper absolute inset-0" />
      <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-b from-black/45 via-black/20 to-black/55" />
      <div className="relative grid w-full max-w-6xl overflow-hidden rounded-3xl bg-white shadow-2xl ring-1 ring-black/5 dark:bg-ink-900 lg:grid-cols-[1.15fr_1fr]">
        <section className="flex flex-col px-5 py-6 sm:px-10 sm:py-9">
          <header className="mb-7 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3"><Mark className="h-9 w-9" /><span className="text-sm font-semibold tracking-tight text-brand-700 dark:text-brand-100">Afey POS</span></div>
            <button type="button" onClick={() => { setShowSettings(true); setError(''); }} className="rounded-lg p-2 text-ink-500 transition hover:bg-ink-100 hover:text-ink-800 dark:hover:bg-ink-800" aria-label="Attendance terminal settings" title="Fingerprint reader settings">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path strokeLinecap="round" strokeLinejoin="round" d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-1.7 2.94-.09-.03a1.7 1.7 0 0 0-1.82.56l-.06.07h-3.4l-.02-.09a1.7 1.7 0 0 0-1.38-1.31l-.1-.02-1.7-2.94.06-.07A1.7 1.7 0 0 0 9.93 14l-.09-.04v-3.4l.09-.03a1.7 1.7 0 0 0 1.31-1.38l.02-.1 2.94-1.7.07.06a1.7 1.7 0 0 0 1.88.34l.06-.04 2.94 1.7-.03.09a1.7 1.7 0 0 0 .56 1.82l.07.06v3.4l-.09.02A1.7 1.7 0 0 0 19.4 15Z" transform="translate(-2 -1)"/></svg>
            </button>
          </header>

          <div className="mb-4 flex items-center gap-3 lg:hidden">
            <Mark src={publicConfig?.tenant?.logoUrl} className="h-12 w-12 rounded-xl bg-white p-1 shadow ring-1 ring-ink-100" />
            <div className="min-w-0"><div className="truncate font-semibold">{businessName}</div><div className="truncate text-xs text-ink-500">Attendance terminal</div></div>
          </div>

          <div className="mb-6">
            <h1 className="inline-block border-b-2 border-brand-600 pb-2 text-xl font-semibold text-brand-700 dark:text-brand-100">Clock in / out</h1>
            <p className="mt-3 text-sm text-ink-500">Scan a staff card or use the fingerprint reader.</p>
          </div>

          {result && (
            <div className={`mb-4 rounded-2xl border p-4 ${result.kind === 'clock_in' ? 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-100' : 'border-brand-200 bg-brand-50 text-brand-900 dark:border-brand-900 dark:bg-brand-950/30 dark:text-brand-100'}`} role="status" aria-live="polite">
              <div className="text-xs font-semibold uppercase tracking-wide">{result.kind === 'clock_in' ? 'Clocked in' : 'Clocked out'} · {time}</div>
              <div className="mt-1 text-lg font-bold">{result.name}</div>
              <div className="mt-0.5 text-xs opacity-75">Verified by {result.method}</div>
            </div>
          )}

          <form onSubmit={clockWithCard} className="space-y-3">
            <label className="block text-xs font-semibold text-ink-600 dark:text-ink-300" htmlFor="staff-card">Staff card</label>
            <div className="relative">
              <svg className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-ink-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h4" strokeLinecap="round"/></svg>
              <input id="staff-card" ref={cardRef} type="password" autoComplete="off" autoFocus={!pinRequired} disabled={busy || pinRequired} value={card} onChange={(e) => { const value = e.target.value; setCard(value); if (/^AFE[A-Z2-7]{13}$/i.test(value.trim())) void clockWithCard(undefined, value); }} onKeyDown={(e) => { if (e.key === 'Enter' && !pinRequired) { e.preventDefault(); void clockWithCard(); } }} placeholder="Scan card here" aria-label="Scan staff card" className="block w-full rounded-xl border border-ink-200 bg-ink-50/70 py-3.5 pl-12 pr-4 text-base shadow-sm placeholder-ink-400 focus:border-brand-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-200 disabled:opacity-60 dark:border-ink-700 dark:bg-ink-950 dark:focus:ring-brand-700" />
            </div>
            {pinRequired && <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-900 dark:bg-amber-950/20">
              <p className="text-sm font-semibold text-amber-900 dark:text-amber-100">Enter the PIN for this staff card</p>
              <input ref={pinRef} type="password" inputMode="numeric" autoComplete="off" maxLength={8} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void clockWithCard(); } }} placeholder="4-8 digit PIN" aria-label="PIN for staff card" className="block w-full rounded-lg border border-ink-200 bg-white px-3 py-3 text-lg tracking-[.35em] shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200 dark:border-ink-700 dark:bg-ink-900" />
            </div>}
            {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-200" role="alert">{error}</p>}
            <div className="flex flex-col gap-2 pt-1 sm:flex-row">
              {pinRequired
                ? <button type="submit" disabled={busy || pin.length < 4} className="flex-1 rounded-xl bg-brand-600 px-5 py-3 text-sm font-semibold text-white shadow transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50">{busy ? 'Checking…' : 'Clock with card'}</button>
                : <button type="submit" disabled={busy || !card.trim()} className="flex-1 rounded-xl bg-brand-600 px-5 py-3 text-sm font-semibold text-white shadow transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50">{busy ? 'Checking…' : 'Clock with card'}</button>}
              <button type="button" onClick={clockWithFingerprint} disabled={fingerBusy} className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-ink-200 bg-white px-5 py-3 text-sm font-semibold text-ink-700 transition hover:bg-ink-50 disabled:opacity-60 dark:border-ink-700 dark:bg-ink-900 dark:text-ink-100 dark:hover:bg-ink-800">
                <svg viewBox="0 0 24 24" className="h-5 w-5 text-brand-600" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path strokeLinecap="round" d="M12 11v2m-3-2v2a3 3 0 0 0 6 0v-3a3 3 0 0 0-6 0m-3 0v3a6 6 0 0 0 12 0v-3a6 6 0 0 0-12 0Zm-3 0a9 9 0 0 1 18 0v2"/></svg>
                {fingerBusy ? 'Place finger…' : 'Use fingerprint'}
              </button>
            </div>
          </form>

          <p className="mt-5 text-xs leading-relaxed text-ink-500">USB barcode scanners in keyboard mode work automatically. Complete card codes submit as they are scanned; if the business requires a PIN, the screen will ask for it.</p>
          {bridgeStatus?.fingerprint && <p className="mt-2 text-xs text-ink-400">Fingerprint: {bridgeStatus.fingerprint.model ?? bridgeStatus.fingerprint.vendor} · {bridgeStatus.fingerprint.connected ? 'ready' : 'not connected'}</p>}
        </section>

        <aside className="relative hidden flex-col items-center justify-center overflow-hidden bg-brand-600 px-10 py-12 text-center text-white lg:flex">
          <div aria-hidden="true" className="absolute -right-40 -top-32 h-[34rem] w-[34rem] rounded-full bg-white/[.05]" />
          <div aria-hidden="true" className="absolute -bottom-40 -right-16 h-[30rem] w-[30rem] rounded-full bg-white/[.06]" />
          <div aria-hidden="true" className="absolute -bottom-24 -left-24 h-72 w-72 rounded-full bg-black/10" />
          <div className="relative flex h-40 w-40 items-center justify-center rounded-full bg-white p-5 shadow-2xl ring-8 ring-white/10"><Mark src={publicConfig?.tenant?.logoUrl} className="h-full w-full" /></div>
          <h2 className="relative mt-8 text-2xl font-semibold leading-tight">{businessName}</h2>
          <p className="relative mt-2 max-w-xs text-sm text-white/75">{publicConfig?.tenant?.tagline || 'Attendance terminal'}</p>
          <p className="absolute bottom-6 text-xs text-white/50">Attendance is saved to this Afey POS database</p>
        </aside>
      </div>

      {showSettings && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-3" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowSettings(false); }}>
        <section className="w-full max-w-xl rounded-2xl bg-white p-5 shadow-2xl dark:bg-ink-900" role="dialog" aria-modal="true" aria-labelledby="reader-settings-title">
          <div className="flex items-start justify-between gap-4"><div><h2 id="reader-settings-title" className="text-lg font-semibold">Fingerprint reader</h2><p className="mt-1 text-sm text-ink-500">Connect this browser to the Afey device bridge on the attendance computer.</p></div><button type="button" onClick={() => setShowSettings(false)} aria-label="Close" className="rounded-lg px-2 py-1 text-xl text-ink-400 hover:bg-ink-100 dark:hover:bg-ink-800">×</button></div>
          <form onSubmit={saveBridgeConfig} className="mt-4 space-y-3">
            <label className="block"><span className="mb-1 block text-xs font-semibold text-ink-600 dark:text-ink-300">Bridge address</span><input value={bridgeConfig.url} onChange={(e) => setBridgeConfig({ ...bridgeConfig, url: e.target.value })} placeholder="http://127.0.0.1:9123" className="block w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200 dark:border-ink-700 dark:bg-ink-950" /></label>
            <label className="block"><span className="mb-1 block text-xs font-semibold text-ink-600 dark:text-ink-300">Pairing token</span><input type="password" autoComplete="off" value={bridgeConfig.token} onChange={(e) => setBridgeConfig({ ...bridgeConfig, token: e.target.value })} placeholder="From the bridge config.json" className="block w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200 dark:border-ink-700 dark:bg-ink-950" /></label>
            <p className="rounded-lg bg-ink-50 p-3 text-xs leading-relaxed text-ink-600 dark:bg-ink-800 dark:text-ink-300">Use the same bridge configured under Hardware → This computer in Afey POS. Add <code>http://127.0.0.1:5175</code> to the bridge's <code>allowedOrigins</code> and register the fingerprint reader there. These settings stay in this browser only.</p>
            {bridgeMessage && <p className="text-xs text-ink-600 dark:text-ink-300" role="status">{bridgeMessage}</p>}
            {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-200" role="alert">{error}</p>}
            <div className="flex flex-wrap justify-end gap-2 pt-1"><button type="button" onClick={() => void testBridge()} className="rounded-lg border border-ink-200 px-3 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50 dark:border-ink-700 dark:text-ink-200 dark:hover:bg-ink-800">Test saved bridge</button><button type="submit" className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">Save and test</button></div>
          </form>
        </section>
      </div>}
    </main>
  );
}
