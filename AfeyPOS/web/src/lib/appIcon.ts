/**
 * The installed app's icon (desktop shortcut, taskbar, phone home screen) is the business logo. The browser draws
 * the logo onto square PNGs when it is saved in Settings (any image type, any shape), and the server's manifest
 * points to them. The tab icon follows too.
 */
import { api } from './api';

async function draw(img: ImageBitmap, size: number, inset: number, background: string | null): Promise<string> {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d')!;
  if (background) {
    g.fillStyle = background;
    g.fillRect(0, 0, size, size);
  }
  const box = size * (1 - inset * 2);
  const scale = Math.min(box / img.width, box / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
  return c.toDataURL('image/png').split(',')[1]!;
}

const upload = async (base64: string) => (await api<{ data: { id: string } }>('/files', { body: { base64, purpose: 'attachment' } })).data.id;

/** Makes and uploads the app icons for a logo file; returns what Settings stores as `appIcon`. */
export async function makeAppIcons(logoFileId: string) {
  const res = await api<Response>(`/files/${logoFileId}`, { raw: true });
  if (!res.ok) throw new Error('Could not read the logo');
  const img = await createImageBitmap(await res.blob());
  // "any": the logo on a white tile with a small margin; "maskable": the logo inside the safe circle.
  const [a192, a512, m512] = await Promise.all([draw(img, 192, 0.08, '#ffffff'), draw(img, 512, 0.08, '#ffffff'), draw(img, 512, 0.2, '#ffffff')]);
  const [i192, i512, mm] = await Promise.all([upload(a192), upload(a512), upload(m512)]);
  return { source: logoFileId, i192, i512, m512: mm };
}

/** Tab / window icon: the business's app icon when it has one. */
export async function applyFavicon() {
  try {
    const cfg = await api<{ tenant: { appIconUrl?: string | null } | null }>('/public/config');
    const url = cfg.tenant?.appIconUrl;
    if (!url) return;
    for (const rel of ['icon', 'apple-touch-icon']) {
      let link = document.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
      if (!link) {
        link = document.createElement('link');
        link.rel = rel;
        document.head.appendChild(link);
      }
      link.type = 'image/png';
      link.href = url;
    }
  } catch {
    /* offline: keep the default icon */
  }
}
