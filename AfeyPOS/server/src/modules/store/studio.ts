/**
 * Store studio: the look and content of the online shop (brand, hero, sections, banners, footer, pages) and
 * which payment accounts the shop uses. Edited in the POS (Settings → Store studio), read by the shop through
 * /store/config. The document is validated strictly; anything left out falls back to STUDIO_DEFAULTS.
 */
import { Router } from 'express';
import { z } from 'zod';
import { PAYMENT_PROVIDER_INFO, STUDIO_DEFAULTS, STUDIO_ICONS, mergeStudio, type PaymentProviderKey, type StoreStudio } from '@afeypos/shared';
import { IntegrationConfig, Tenant } from '../../models/index.js';
import { parse } from '../../http/validate.js';
import { requirePermission } from '../../http/auth.js';
import { audit } from '../../lib/audit.js';
import { runAsPlatform } from '../../lib/context.js';
import { env } from '../../config/env.js';

const text = (max: number) => z.string().trim().max(max);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #1f3d2b');
/** Uploaded files (POST /files) or an https address. */
const image = z.string().trim().max(300).regex(/^(\/api\/v1\/files\/[a-f0-9]{32}\.(png|jpg|webp)|https:\/\/\S+)$/, 'Upload an image or use an https:// address').or(z.literal('')).optional();
/** Links stay on the shop (/path) or go to a full web address. */
const link = z.string().trim().max(300).regex(/^(\/[^\s]*|https?:\/\/\S+|mailto:\S+|tel:\S+)$/, 'Links start with / or https://').or(z.literal(''));
const icon = z.enum(STUDIO_ICONS);
const iconText = z.object({ icon, title: text(60), text: text(80).optional() });
const navLink = z.object({ label: text(40).min(1), to: link });
const url = z.string().trim().max(300).regex(/^https:\/\/\S+$/, 'Use an https:// address').or(z.literal('')).optional();

export const studioSchema = z.object({
  brand: z.object({ tagline: text(80), logoUrl: image, primary: color, accent: color, soft: color, footer: color, radius: z.enum(['soft', 'round', 'square']) }),
  topBar: z.object({ enabled: z.boolean(), items: z.array(iconText).max(4) }),
  nav: z.array(navLink).max(10),
  hero: z.object({
    enabled: z.boolean(), eyebrow: text(40), title: text(90), subtitle: text(240), buttonText: text(30), buttonLink: link, imageUrl: image, background: color,
    note: text(40).optional(), features: z.array(iconText).max(4),
  }),
  categories: z.object({ enabled: z.boolean(), title: text(60).optional(), items: z.array(z.object({ categoryId: z.string().regex(/^[a-f0-9]{24}$/).optional().or(z.literal('')), label: text(40).min(1), imageUrl: image, icon: icon.optional(), color })).max(16) }),
  sections: z.object({
    featured: z.object({ enabled: z.boolean(), title: text(60) }),
    newArrivals: z.object({ enabled: z.boolean(), title: text(60) }),
    bestSellers: z.object({ enabled: z.boolean(), title: text(60) }),
    deals: z.object({ enabled: z.boolean(), title: text(60) }),
  }),
  banners: z.object({ enabled: z.boolean(), items: z.array(z.object({ title: text(60), text: text(160), buttonText: text(30), link, imageUrl: image, background: color, dark: z.boolean() })).max(4) }),
  why: z.object({ enabled: z.boolean(), title: text(60), items: z.array(iconText).max(6) }),
  newsletter: z.object({ enabled: z.boolean(), title: text(60), text: text(200), buttonText: text(30), note: text(60).optional() }),
  footer: z.object({
    about: text(240),
    social: z.object({ facebook: url, instagram: url, youtube: url, pinterest: url, tiktok: url, x: url, whatsapp: z.string().trim().max(20).regex(/^\+?\d*$/, 'WhatsApp number, digits only').optional() }),
    apps: z.object({ android: url, ios: url }),
    columns: z.array(z.object({ title: text(40), links: z.array(navLink).max(8) })).max(4),
    copyright: text(120).optional(),
  }),
  pages: z.array(z.object({ slug: z.string().regex(/^[a-z0-9-]{1,40}$/, 'Page address: lowercase letters, numbers and dashes'), title: text(80).min(1), body: text(10_000) })).max(20)
    .refine((ps) => new Set(ps.map((p) => p.slug)).size === ps.length, 'Two pages have the same address'),
  seo: z.object({ title: text(70).optional(), description: text(160).optional() }),
});

/** Every uploaded file the studio shows (the shop may serve these publicly). */
export function studioImages(studio: StoreStudio): string[] {
  return [studio.brand.logoUrl, studio.hero.imageUrl, ...studio.categories.items.map((c) => c.imageUrl), ...studio.banners.items.map((b) => b.imageUrl)]
    .filter((s): s is string => Boolean(s) && s!.startsWith('/api/v1/files/'));
}

/** Rewrites private upload paths to the public shop image route. */
export function publicStudio(studio: StoreStudio, toPublic: (src: string) => string): StoreStudio {
  const img = (s?: string) => (s ? toPublic(s) : s);
  return {
    ...studio,
    brand: { ...studio.brand, logoUrl: img(studio.brand.logoUrl) },
    hero: { ...studio.hero, imageUrl: img(studio.hero.imageUrl) },
    categories: { ...studio.categories, items: studio.categories.items.map((c) => ({ ...c, imageUrl: img(c.imageUrl) })) },
    banners: { ...studio.banners, items: studio.banners.items.map((b) => ({ ...b, imageUrl: img(b.imageUrl) })) },
  };
}

export const studioRoutes = Router();

/** The studio document, the defaults (for "reset") and the payment accounts the shop can use. */
studioRoutes.get('/settings/store-studio', requirePermission('settings.manage'), async (req, res) => {
  const s: any = req.tenant!.settings?.store ?? {};
  const configs = await IntegrationConfig.find({ kind: { $in: ['mpesa', 'payment'] }, enabled: true }, { kind: 1, provider: 1, name: 1, environment: 1, isDefault: 1, settings: 1 }).sort({ createdAt: 1 }).lean();
  const mpesa = configs.filter((c) => c.kind === 'mpesa').map((c) => ({ id: c._id, name: c.name, environment: c.environment, shortcode: (c.settings as any)?.tillNumber ?? (c.settings as any)?.shortCode ?? '', isDefault: Boolean(c.isDefault) }));
  const gateways = configs
    .filter((c) => c.kind === 'payment' && PAYMENT_PROVIDER_INFO[c.provider as PaymentProviderKey]?.flows.includes('link'))
    .filter((c) => !(PAYMENT_PROVIDER_INFO[c.provider as PaymentProviderKey].devOnly && env().NODE_ENV === 'production' && c.environment === 'production'))
    .map((c) => ({ id: c._id, name: c.name, provider: c.provider, label: PAYMENT_PROVIDER_INFO[c.provider as PaymentProviderKey].label, environment: c.environment }));
  res.json({
    data: {
      studio: mergeStudio(s.studio), defaults: STUDIO_DEFAULTS, saved: Boolean(s.studio),
      payments: { mpesaConfigId: s.mpesaConfigId ?? null, gatewayConfigId: s.gatewayConfigId ?? null, publicUrl: s.publicUrl ?? '' },
      options: { mpesa, gateways },
    },
  });
});

studioRoutes.put('/settings/store-studio', requirePermission('settings.manage'), async (req, res) => {
  const studio = parse(studioSchema, req.body?.studio);
  await runAsPlatform(() => Tenant.updateOne({ _id: req.tenant!._id }, { $set: { 'settings.store.studio': studio } }));
  await audit(req, { action: 'store.studio_saved', entity: 'Tenant', entityId: req.tenant!._id, details: { pages: studio.pages.length } });
  res.json({ data: { studio: mergeStudio(studio) } });
});
