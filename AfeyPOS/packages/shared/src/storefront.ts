/**
 * Online shop "Studio": everything about the shop's look and content that the owner edits in the POS
 * (Settings → Store studio) and the shop website renders. Saved as one document; missing parts fall back
 * to these defaults, so older shops and partial edits always render.
 */

export const STUDIO_ICONS = ['truck', 'return', 'gift', 'leaf', 'heart', 'star', 'shield', 'smile', 'tag', 'phone', 'clock', 'bag', 'home', 'sparkle', 'basket', 'card'] as const;
export type StudioIcon = (typeof STUDIO_ICONS)[number];

export interface StudioLink { label: string; to: string }
export interface StudioIconText { icon: StudioIcon; title: string; text?: string }

export interface StoreStudio {
  brand: { tagline: string; logoUrl?: string; primary: string; accent: string; soft: string; footer: string; radius: 'soft' | 'round' | 'square' };
  topBar: { enabled: boolean; items: StudioIconText[] };
  nav: StudioLink[];
  hero: {
    enabled: boolean; eyebrow: string; title: string; subtitle: string; buttonText: string; buttonLink: string; imageUrl?: string; background: string;
    /** Handwritten note on the picture ("Small choices, big impact"). */
    note?: string;
    features: StudioIconText[];
  };
  categories: { enabled: boolean; title?: string; items: { categoryId?: string; label: string; imageUrl?: string; icon?: StudioIcon; color: string }[] };
  sections: Record<'featured' | 'newArrivals' | 'bestSellers' | 'deals', { enabled: boolean; title: string }>;
  banners: { enabled: boolean; items: { title: string; text: string; buttonText: string; link: string; imageUrl?: string; background: string; dark: boolean }[] };
  why: { enabled: boolean; title: string; items: StudioIconText[] };
  newsletter: { enabled: boolean; title: string; text: string; buttonText: string; note?: string };
  footer: {
    about: string;
    social: { facebook?: string; instagram?: string; youtube?: string; pinterest?: string; tiktok?: string; whatsapp?: string; x?: string };
    apps: { android?: string; ios?: string };
    columns: { title: string; links: StudioLink[] }[];
    copyright?: string;
  };
  pages: { slug: string; title: string; body: string }[];
  seo: { title?: string; description?: string };
}

export const STUDIO_DEFAULTS: StoreStudio = {
  brand: { tagline: 'Good Things. A Brighter You.', primary: '#1f3d2b', accent: '#e8a33d', soft: '#f5f1ea', footer: '#1f3328', radius: 'soft' },
  topBar: {
    enabled: true,
    items: [
      { icon: 'truck', title: 'Free delivery on orders over KES 2,000' },
      { icon: 'return', title: 'Easy returns within 7 days' },
      { icon: 'gift', title: 'Pay with M-Pesa or on delivery' },
    ],
  },
  nav: [
    { label: 'Home', to: '/' },
    { label: 'Shop', to: '/shop' },
    { label: 'New Arrivals', to: '/shop?sort=new' },
    { label: 'Best Sellers', to: '/shop?sort=best' },
    { label: 'Deals', to: '/shop?deals=1' },
    { label: 'Categories', to: '/categories' },
  ],
  hero: {
    enabled: true,
    eyebrow: 'Fresh Every Day',
    title: 'Groceries for a Brighter Tomorrow',
    subtitle: 'Discover thoughtfully chosen products for a happier, healthier and more inspired home.',
    buttonText: 'Shop Now',
    buttonLink: '/shop',
    background: '#efe9df',
    note: 'Small choices, big impact',
    features: [
      { icon: 'leaf', title: 'Fresh', text: 'Choices' },
      { icon: 'heart', title: 'Curated', text: 'with Care' },
      { icon: 'star', title: 'Loved by', text: 'Neighbours' },
    ],
  },
  categories: { enabled: true, items: [] },
  sections: {
    featured: { enabled: true, title: 'Featured Products' },
    newArrivals: { enabled: true, title: 'New Arrivals' },
    bestSellers: { enabled: true, title: 'Best Sellers' },
    deals: { enabled: false, title: 'Deals of the Week' },
  },
  banners: {
    enabled: true,
    items: [
      { title: 'Refresh Your Kitchen', text: 'Everyday essentials for a calmer, happier home.', buttonText: 'Shop Home', link: '/shop', background: '#e9e4da', dark: false },
      { title: 'Glow Naturally', text: 'Personal care that loves your skin back.', buttonText: 'Shop Beauty', link: '/shop', background: '#f6dfe4', dark: false },
    ],
  },
  why: {
    enabled: true,
    title: 'Why Shop With Us?',
    items: [
      { icon: 'truck', title: 'Fast Delivery', text: 'Free over KES 2,000' },
      { icon: 'shield', title: 'Secure Payments', text: 'M-Pesa protected' },
      { icon: 'return', title: 'Easy Returns', text: '7-day policy' },
      { icon: 'leaf', title: 'Fresh & Local', text: 'Better for tomorrow' },
      { icon: 'heart', title: 'Happy Customers', text: 'Trusted by thousands' },
    ],
  },
  newsletter: { enabled: true, title: 'Join Our Community', text: 'Be the first to know about new arrivals, exclusive deals, and special offers.', buttonText: 'Subscribe', note: 'Good people, brighter days' },
  footer: {
    about: 'Good Things. A Brighter You.',
    social: {},
    apps: {},
    columns: [
      { title: 'Shop', links: [{ label: 'All Products', to: '/shop' }, { label: 'New Arrivals', to: '/shop?sort=new' }, { label: 'Best Sellers', to: '/shop?sort=best' }, { label: 'Deals', to: '/shop?deals=1' }] },
      { title: 'Help', links: [{ label: 'Track Your Order', to: '/track' }, { label: 'Returns & Refunds', to: '/page/returns' }, { label: 'Delivery Info', to: '/page/delivery' }, { label: 'FAQ', to: '/page/faq' }] },
      { title: 'Company', links: [{ label: 'About Us', to: '/page/about' }, { label: 'Contact', to: '/page/contact' }] },
    ],
  },
  pages: [
    { slug: 'about', title: 'About Us', body: 'We are your neighbourhood shop, now online. Order from home and we deliver, or pick up at the shop.' },
    { slug: 'returns', title: 'Returns & Refunds', body: 'Something not right? Bring it back within 7 days with your receipt and we will replace it or refund you.' },
    { slug: 'delivery', title: 'Delivery Info', body: 'We deliver every day. Delivery fees depend on your area and are shown at checkout.' },
    { slug: 'faq', title: 'FAQ', body: 'How do I pay?\nWith M-Pesa when you order, by card where offered, or when your order arrives.\n\nCan I change my order?\nCall us as soon as possible and we will help.' },
    { slug: 'contact', title: 'Contact', body: 'Call or WhatsApp us during opening hours.' },
    { slug: 'privacy', title: 'Privacy Policy', body: 'We use your details only to process your orders and, if you agree, to send you offers. We never sell your data.' },
    { slug: 'terms', title: 'Terms of Service', body: 'Prices include VAT. Orders are confirmed when we accept them; we will contact you if an item is unavailable.' },
  ],
  seo: {},
};

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Deep-merges a saved (possibly partial) studio over the defaults. Arrays replace, objects merge. */
export function mergeStudio(saved: unknown, base: StoreStudio = STUDIO_DEFAULTS): StoreStudio {
  const merge = (a: any, b: any): any => {
    if (!isObj(b)) return b === undefined ? a : b;
    const out: Record<string, unknown> = { ...(isObj(a) ? a : {}) };
    for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(out[k]) ? merge(out[k], v) : v === undefined ? out[k] : v;
    return out;
  };
  return merge(base, saved) as StoreStudio;
}
