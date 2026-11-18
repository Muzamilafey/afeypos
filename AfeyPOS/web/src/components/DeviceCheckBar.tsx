/**
 * A short device check that runs when a till opens: it looks for the Afey device bridge, receipt printer,
 * barcode scanner and fingerprint reader, showing a progress bar that fills as it goes. The cashier can Skip it
 * for now, or choose "Run in the background" so it no longer shows and just checks quietly each time.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { bridgeConfigured, bridgeStatus } from '../lib/bridge';
import { cx } from './ui';
import { Icon } from './icons';

type State = 'checking' | 'ok' | 'warn' | 'off';
interface Step { key: string; label: string; state: State; detail: string }

const HIDE_KEY = 'afey.deviceCheck.hide';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs the checks once and returns the steps. Never throws. */
async function runChecks(onStep: (i: number, patch: Partial<Step>) => void) {
  const paired = bridgeConfigured();
  let status: Awaited<ReturnType<typeof bridgeStatus>> | null = null;
  // 1. Device bridge
  onStep(0, { state: 'checking' });
  if (paired) {
    try { status = await bridgeStatus(); onStep(0, { state: 'ok', detail: 'Connected' }); }
    catch { onStep(0, { state: 'warn', detail: 'Not responding — is it running?' }); }
  } else {
    onStep(0, { state: 'off', detail: 'Not set up (browser printing is used)' });
  }
  await sleep(250);
  // 2. Receipt printer
  onStep(1, { state: 'checking' });
  await sleep(200);
  if (status) {
    const n = status.printers?.length ?? 0;
    onStep(1, n > 0 ? { state: 'ok', detail: `${n} printer${n === 1 ? '' : 's'} found` } : { state: 'warn', detail: 'No printer on the bridge' });
  } else {
    onStep(1, { state: 'off', detail: 'Browser / network printing' });
  }
  await sleep(250);
  // 3. Barcode scanner (keyboard-wedge scanners type into the search box; nothing to detect)
  onStep(2, { state: 'checking' });
  await sleep(300);
  onStep(2, { state: 'ok', detail: 'Ready — scan into the search box' });
  await sleep(200);
  // 4. Fingerprint reader
  onStep(3, { state: 'checking' });
  await sleep(200);
  if (status) {
    onStep(3, status.fingerprint?.connected ? { state: 'ok', detail: status.fingerprint.model || 'Connected' } : { state: 'off', detail: 'No reader connected' });
  } else {
    onStep(3, { state: 'off', detail: 'Needs the device bridge' });
  }
  await sleep(200);
}

export function DeviceCheckBar() {
  const hidden = (() => { try { return localStorage.getItem(HIDE_KEY) === '1'; } catch { return false; } })();
  const [dismissed, setDismissed] = useState(false);
  const [done, setDone] = useState(false);
  const [steps, setSteps] = useState<Step[]>([
    { key: 'bridge', label: 'Device bridge', state: 'checking', detail: '' },
    { key: 'printer', label: 'Receipt printer', state: 'checking', detail: '' },
    { key: 'scanner', label: 'Barcode scanner', state: 'checking', detail: '' },
    { key: 'finger', label: 'Fingerprint reader', state: 'checking', detail: '' },
  ]);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const patch = (i: number, p: Partial<Step>) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, ...p } : x)));
    void runChecks(patch).then(() => setDone(true));
  }, []);

  // "Run in the background": it still checks (above), but nothing is shown now or next time.
  if (hidden || dismissed) return null;

  const checkedCount = steps.filter((s) => s.state !== 'checking').length;
  const progress = done ? 100 : Math.round((checkedCount / steps.length) * 100);
  const problems = steps.filter((s) => s.state === 'warn');
  const dot = (s: State) => (s === 'ok' ? 'bg-emerald-500' : s === 'warn' ? 'bg-red-500' : s === 'off' ? 'bg-ink-300' : 'bg-amber-400 animate-pulse');

  return (
    <div className="overflow-hidden rounded-xl border border-ink-100 bg-white shadow-sm dark:border-ink-800 dark:bg-ink-900" data-testid="device-check">
      <div className="h-1 bg-ink-100 dark:bg-ink-800">
        <div className={cx('h-1 transition-all duration-300', done && problems.length ? 'bg-red-500' : done ? 'bg-emerald-500' : 'bg-brand-500')} style={{ width: `${progress}%` }} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <Icon name={done ? (problems.length ? 'alert' : 'check') : 'activity'} className={cx('h-4 w-4', done ? (problems.length ? 'text-red-600' : 'text-emerald-600') : 'text-brand-600')} />
          {done ? (problems.length ? 'Some devices need attention' : 'Devices ready') : 'Checking your devices…'}
        </span>
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          {steps.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5" title={s.detail}>
              <span className={cx('inline-block h-2 w-2 shrink-0 rounded-full', dot(s.state))} />
              <span className="font-medium text-ink-700 dark:text-ink-200">{s.label}</span>
              {s.detail && <span className="text-ink-400">· {s.detail}</span>}
            </li>
          ))}
        </ul>
        <div className="ml-auto flex items-center gap-2">
          {done && problems.length > 0 && <Link to="/settings/hardware" className="text-xs font-semibold text-brand-600 hover:underline">Fix in Hardware</Link>}
          <button type="button" onClick={() => setDismissed(true)} className="rounded-md px-2 py-1 text-xs font-semibold text-ink-500 hover:bg-ink-50 dark:hover:bg-ink-800">Skip</button>
          <button type="button" onClick={() => { try { localStorage.setItem(HIDE_KEY, '1'); } catch { /* ignore */ } setDismissed(true); }}
            className="rounded-md border border-ink-200 px-2 py-1 text-xs font-semibold text-ink-600 hover:bg-ink-50 dark:border-ink-700 dark:text-ink-300 dark:hover:bg-ink-800" title="Keep checking quietly each time, without this bar">
            Run in the background
          </button>
        </div>
      </div>
    </div>
  );
}
