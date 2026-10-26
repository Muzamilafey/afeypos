import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { mergeStudio, type StoreStudio } from '@afeypos/shared';
import { api, type StoreConfig } from './api';
import { setCurrency } from './format';

const Ctx = createContext<(StoreConfig & { preview: boolean }) | null>(null);

const RADIUS: Record<StoreStudio['brand']['radius'], [string, string]> = { soft: ['1.25rem', '0.875rem'], round: ['2rem', '1.25rem'], square: ['0.375rem', '0.25rem'] };

function applyTheme(s: StoreStudio) {
  const root = document.documentElement.style;
  root.setProperty('--c-primary', s.brand.primary);
  root.setProperty('--c-accent', s.brand.accent);
  root.setProperty('--c-soft', s.brand.soft);
  root.setProperty('--c-footer', s.brand.footer);
  const [box, tile] = RADIUS[s.brand.radius] ?? RADIUS.soft;
  root.setProperty('--r-box', box);
  root.setProperty('--r-tile', tile);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', s.brand.primary);
}

/**
 * Store studio preview: the POS opens the shop with ?studio=1 (in a frame or a new window) and sends the
 * unsaved design with postMessage. Only the window that opened or framed the shop is listened to, and the
 * draft only changes what this browser shows.
 */
function usePreview(onDraft: (s: StoreStudio, images: Record<string, string>) => void) {
  const [preview] = useState(() => {
    try {
      const on = new URLSearchParams(location.search).has('studio') || sessionStorage.getItem('afey.studio') === '1';
      if (on) sessionStorage.setItem('afey.studio', '1');
      return on;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (!preview) return;
    const editor = window.parent !== window ? window.parent : window.opener;
    if (!editor) return;
    const onMessage = (e: MessageEvent) => {
      if (e.source !== editor || !e.data || typeof e.data !== 'object') return;
      if (e.data.type === 'afey-studio' && e.data.studio) onDraft(mergeStudio(e.data.studio), e.data.images ?? {});
      if (e.data.type === 'afey-studio-goto' && typeof e.data.section === 'string') document.getElementById(`studio-${e.data.section}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    window.addEventListener('message', onMessage);
    editor.postMessage({ type: 'afey-studio-ready' }, '*');
    return () => window.removeEventListener('message', onMessage);
  }, [preview, onDraft]);
  return preview;
}

/** Uploaded but unsaved pictures are not public yet; the editor sends them along as data URLs. */
function withImages(s: StoreStudio, images: Record<string, string>): StoreStudio {
  const img = (u?: string) => (u && images[u]) || u;
  return {
    ...s,
    brand: { ...s.brand, logoUrl: img(s.brand.logoUrl) },
    hero: { ...s.hero, imageUrl: img(s.hero.imageUrl) },
    categories: { ...s.categories, items: s.categories.items.map((c) => ({ ...c, imageUrl: img(c.imageUrl) })) },
    banners: { ...s.banners, items: s.banners.items.map((b) => ({ ...b, imageUrl: img(b.imageUrl) })) },
  };
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [cfg, setCfg] = useState<StoreConfig | null>(null);
  const [draft, setDraft] = useState<StoreStudio | null>(null);
  const [error, setError] = useState('');
  const [onDraft] = useState(() => (s: StoreStudio, images: Record<string, string>) => setDraft(withImages(s, images)));
  const preview = usePreview(onDraft);
  useEffect(() => {
    api<{ data: StoreConfig }>('/config')
      .then((r) => {
        setCurrency(r.data.currency);
        setCfg({ ...r.data, studio: mergeStudio(r.data.studio) });
      })
      .catch((e) => setError(e.message));
  }, []);
  const studio = draft ?? cfg?.studio;
  useEffect(() => {
    if (!studio || !cfg) return;
    applyTheme(studio);
    document.title = studio.seo.title || `${cfg.name}${studio.brand.tagline ? ` · ${studio.brand.tagline}` : ''}`;
    if (studio.seo.description) document.querySelector('meta[name="description"]')?.setAttribute('content', studio.seo.description);
  }, [studio, cfg]);
  if (error) return <div className="mx-auto max-w-md p-10 text-center"><h1 className="text-xl font-bold">The shop is closed</h1><p className="mt-2 text-ink-500">{error}</p></div>;
  if (!cfg || !studio) return <div className="flex h-screen items-center justify-center text-ink-400">Loading…</div>;
  return <Ctx.Provider value={{ ...cfg, studio, preview }}>{children}</Ctx.Provider>;
}

export function useStore() {
  const c = useContext(Ctx);
  if (!c) throw new Error('StoreProvider missing');
  return c;
}
