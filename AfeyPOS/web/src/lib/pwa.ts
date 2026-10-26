/**
 * Progressive web app: registers the service worker (production builds only) and tracks whether the app can be
 * installed, whether a new version is waiting, and whether the browser is offline.
 * Browsers only allow service workers on HTTPS or localhost, so a till on http://192.168.x.x runs it as a normal page.
 */
import { useSyncExternalStore } from 'react';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

interface PwaState {
  canInstall: boolean;
  installed: boolean;
  updateReady: boolean;
  online: boolean;
}

let state: PwaState = {
  canInstall: false,
  installed: typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone === true),
  updateReady: false,
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
};
const listeners = new Set<() => void>();
const set = (patch: Partial<PwaState>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};
let deferred: InstallPromptEvent | null = null;
let waiting: ServiceWorker | null = null;

export function initPwa() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    set({ canInstall: true });
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    set({ canInstall: false, installed: true });
  });
  window.addEventListener('online', () => set({ online: true }));
  window.addEventListener('offline', () => set({ online: false }));

  if (!import.meta.env.PROD || !('serviceWorker' in navigator) || !window.isSecureContext) return;
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      const track = (sw: ServiceWorker | null) => {
        if (!sw) return;
        const check = () => {
          // A new worker installed while an old one controls the page: an update is ready.
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            waiting = sw;
            set({ updateReady: true });
          }
        };
        check();
        sw.addEventListener('statechange', check);
      };
      track(reg.waiting ?? reg.installing);
      reg.addEventListener('updatefound', () => track(reg.installing));
      // Tills stay open all day: look for a new release every hour.
      setInterval(() => reg.update().catch(() => undefined), 60 * 60 * 1000);
      // Reload only when an update takes over; the very first install just starts controlling the page.
      let firstInstall = !navigator.serviceWorker.controller;
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (firstInstall) {
          firstInstall = false;
          return;
        }
        if (reloading) return;
        reloading = true;
        window.location.reload();
      });
    } catch {
      /* not fatal: the app works without it */
    }
  });
}

export async function installApp(): Promise<boolean> {
  if (!deferred) return false;
  await deferred.prompt();
  const { outcome } = await deferred.userChoice;
  deferred = null;
  set({ canInstall: false });
  return outcome === 'accepted';
}

export function applyUpdate() {
  if (waiting) waiting.postMessage('skipWaiting');
  else window.location.reload();
}

export function usePwa(): PwaState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}
