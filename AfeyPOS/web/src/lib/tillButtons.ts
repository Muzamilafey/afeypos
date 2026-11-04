/**
 * How the till's buttons look (Settings > Till buttons): an icon, an uploaded picture, a label and colours per
 * button. Saved on the business and sent with the signed-in user's business settings.
 */
import { useEffect, useState } from 'react';
import { api } from './api';
import { useAuth } from './auth';

export interface TillButtonStyle { icon?: string; image?: string; label?: string; bg?: string; text?: string }
export type TillButtons = Partial<Record<string, TillButtonStyle>>;

export function useTillButtons(): TillButtons {
  const { me } = useAuth();
  return (me?.tenant.settings?.tillButtons ?? {}) as TillButtons;
}

// Uploaded pictures need the user's sign-in, so they are fetched once and shown from memory.
const cache = new Map<string, Promise<string | null>>();
export function fileImageUrl(id: string) {
  if (!cache.has(id)) {
    cache.set(id, api<Response>(`/files/${id}`, { raw: true }).then(async (r) => (r.ok ? URL.createObjectURL(await r.blob()) : null)).catch(() => null));
  }
  return cache.get(id)!;
}

export function useFileImage(id?: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (!id) { setUrl(null); return; }
    void fileImageUrl(id).then((u) => { if (live) setUrl(u); });
    return () => { live = false; };
  }, [id]);
  return url;
}
