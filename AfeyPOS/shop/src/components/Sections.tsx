import { useEffect, useState } from 'react';
import type { StoreStudio } from '@afeypos/shared';
import { api, asset, listProducts, type ProductQuery, type StoreProduct } from '../lib/api';
import { useStore } from '../lib/store';
import { Icon } from './Icon';
import { Container, SmartLink } from './Layout';
import { ProductCard } from './ProductCard';

/** Drawn basket of groceries, used until the owner uploads a hero picture. */
function HeroArt() {
  return (
    <svg viewBox="0 0 520 420" className="h-full w-full" role="img" aria-label="A basket of fresh groceries">
      <ellipse cx="270" cy="380" rx="210" ry="22" fill="#000" opacity="0.06" />
      <circle cx="400" cy="90" r="60" fill="var(--c-accent)" opacity="0.25" />
      <path d="M150 170c-10-60 20-110 60-120 10 40-10 90-60 120z" fill="#6aa84f" />
      <path d="M165 175c25-55 75-85 115-75-15 40-60 70-115 75z" fill="#8bc26a" />
      <rect x="235" y="70" width="60" height="120" rx="12" fill="#fff" stroke="var(--c-primary)" strokeWidth="5" />
      <rect x="245" y="50" width="40" height="26" rx="6" fill="var(--c-primary)" />
      <rect x="245" y="110" width="40" height="40" rx="6" fill="var(--c-accent)" opacity="0.8" />
      <circle cx="340" cy="160" r="38" fill="#e8625b" />
      <path d="M340 122c4-10 12-16 22-16" stroke="#5b8c3e" strokeWidth="6" fill="none" strokeLinecap="round" />
      <circle cx="195" cy="185" r="32" fill="#f3c24c" />
      <path d="M380 120c30-10 60 0 70 25-30 12-58 5-70-25z" fill="#f29f3d" />
      <path d="M90 200h340l-34 160H124z" fill="#c68a4c" />
      <path d="M90 200h340l-6 28H96z" fill="#a8703a" />
      {[0, 1, 2, 3, 4, 5, 6].map((i) => <path key={i} d={`M${130 + i * 45} 232 l${-4 + i * 1.5} 120`} stroke="#a8703a" strokeWidth="4" opacity="0.5" />)}
      <path d="M150 200c0-90 220-90 220 0" stroke="#8a5a2c" strokeWidth="12" fill="none" strokeLinecap="round" />
    </svg>
  );
}

export function Hero() {
  const { studio } = useStore();
  const h = studio.hero;
  if (!h.enabled) return null;
  return (
    <section id="studio-hero" className="pt-6">
      <Container>
        <div className="relative grid items-center gap-8 overflow-hidden rounded-box px-6 py-10 sm:px-12 md:grid-cols-2 md:py-14" style={{ background: h.background }}>
          <div className="relative z-10">
            {h.eyebrow && <p className="mb-4 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-accent"><Icon name="sparkle" className="h-4 w-4" />{h.eyebrow}</p>}
            <h1 className="text-4xl font-extrabold leading-[1.08] tracking-tight sm:text-5xl lg:text-[56px]">{h.title}</h1>
            {h.subtitle && <p className="mt-5 max-w-md text-base leading-relaxed text-ink-600">{h.subtitle}</p>}
            {h.buttonText && <SmartLink to={h.buttonLink || '/shop'} className="btn-primary mt-8 px-8 py-3.5">{h.buttonText}<Icon name="arrow" className="h-4 w-4" /></SmartLink>}
            {h.features.length > 0 && (
              <ul className="mt-10 flex flex-wrap gap-x-8 gap-y-4">
                {h.features.map((f, i) => (
                  <li key={i} className="flex items-center gap-3">
                    <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white text-primary shadow-sm"><Icon name={f.icon} className="h-5 w-5" /></span>
                    <span className="text-sm leading-tight"><span className="block font-bold text-primary">{f.title}</span>{f.text && <span className="text-ink-500">{f.text}</span>}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="relative h-72 sm:h-96">
            {h.imageUrl ? <img src={asset(h.imageUrl)} alt="" className="h-full w-full rounded-box object-cover" /> : <HeroArt />}
            {h.note && <span className="absolute -bottom-1 right-4 rotate-[-6deg] rounded-xl bg-white/90 px-4 py-1.5 font-hand text-2xl text-primary shadow-sm">{h.note}</span>}
          </div>
        </div>
      </Container>
    </section>
  );
}

export function SectionHead({ title, more, moreLabel = 'View All' }: { title: string; more?: string; moreLabel?: string }) {
  return (
    <div className="mb-6 flex items-end justify-between gap-4">
      <h2 className="section-title">{title}</h2>
      {more && <SmartLink to={more} className="link-more shrink-0">{moreLabel}<Icon name="arrow" className="h-4 w-4" /></SmartLink>}
    </div>
  );
}

const CIRCLE = ['#e8f1e4', '#fdf0d8', '#fde4e1', '#e3eefa', '#efe6f8', '#e0f3f1', '#f6eadf', '#eef0f3'];

/** Studio categories, or the shop's categories with soft colours when none were set up. */
export function useCategoryTiles(): StoreStudio['categories']['items'] {
  const { studio, categories } = useStore();
  if (studio.categories.items.length) return studio.categories.items;
  return categories.map((c, i) => ({ categoryId: c.id, label: c.name, color: CIRCLE[i % CIRCLE.length]!, icon: 'basket' as const }));
}

export function CategoryCircle({ c }: { c: StoreStudio['categories']['items'][number] }) {
  return (
    <SmartLink to={c.categoryId ? `/shop?c=${c.categoryId}` : '/shop'} className="group flex w-28 shrink-0 flex-col items-center gap-3 text-center">
      <span className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-full transition group-hover:scale-105 group-hover:shadow-md" style={{ background: c.color }}>
        {c.imageUrl ? <img src={asset(c.imageUrl)} alt="" className="h-full w-full object-cover" /> : <Icon name={c.icon ?? 'basket'} className="h-10 w-10 text-primary" />}
      </span>
      <span className="text-sm font-semibold text-ink-800 group-hover:text-primary">{c.label}</span>
    </SmartLink>
  );
}

export function CategoryStrip() {
  const { studio } = useStore();
  const tiles = useCategoryTiles();
  if (!studio.categories.enabled || !tiles.length) return null;
  return (
    <section id="studio-categories" className="pt-14">
      <Container>
        <SectionHead title={studio.categories.title || 'Shop by Category'} more="/categories" />
        <div className="-mx-1 flex justify-between gap-4 overflow-x-auto px-1 pb-2">{tiles.slice(0, 8).map((c, i) => <CategoryCircle key={i} c={c} />)}</div>
      </Container>
    </section>
  );
}

const RAILS: Record<keyof StoreStudio['sections'], { query: ProductQuery; more: string }> = {
  featured: { query: { featured: true }, more: '/shop' },
  newArrivals: { query: { sort: 'new' }, more: '/shop?sort=new' },
  bestSellers: { query: { sort: 'best' }, more: '/shop?sort=best' },
  deals: { query: { deals: true }, more: '/shop?deals=1' },
};

export function ProductRail({ section }: { section: keyof StoreStudio['sections'] }) {
  const { studio } = useStore();
  const cfg = studio.sections[section];
  const [rows, setRows] = useState<StoreProduct[] | null>(null);
  useEffect(() => {
    if (!cfg.enabled) return;
    let live = true;
    listProducts({ ...RAILS[section].query, limit: 5 }).then((r) => live && setRows(r.data)).catch(() => live && setRows([]));
    return () => {
      live = false;
    };
  }, [cfg.enabled, section]);
  if (!cfg.enabled || (rows && !rows.length)) return null;
  return (
    <section id={`studio-${section}`} className="pt-14">
      <Container>
        <SectionHead title={cfg.title} more={RAILS[section].more} />
        {!rows ? <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="h-64 animate-pulse rounded-box bg-soft" />)}</div>
          : <div className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-5">{rows.map((p) => <ProductCard key={p.id} p={p} />)}</div>}
      </Container>
    </section>
  );
}

export function Banners() {
  const { studio } = useStore();
  const b = studio.banners;
  if (!b.enabled || !b.items.length) return null;
  return (
    <section id="studio-banners" className="pt-14">
      <Container className={`grid gap-5 ${b.items.length > 1 ? 'md:grid-cols-2' : ''}`}>
        {b.items.map((it, i) => (
          <div key={i} className={`relative flex min-h-[220px] items-center overflow-hidden rounded-box p-8 sm:p-10 ${it.dark ? 'text-white' : ''}`} style={{ background: it.background }}>
            {it.imageUrl && <img src={asset(it.imageUrl)} alt="" className="absolute inset-y-0 right-0 h-full w-1/2 object-cover" />}
            <div className="relative z-10 max-w-[60%]">
              <h3 className={`text-2xl font-extrabold leading-tight sm:text-3xl ${it.dark ? 'text-white' : ''}`}>{it.title}</h3>
              {it.text && <p className={`mt-2 text-sm ${it.dark ? 'text-white/80' : 'text-ink-600'}`}>{it.text}</p>}
              {it.buttonText && <SmartLink to={it.link || '/shop'} className={`${it.dark ? 'btn bg-white text-primary' : 'btn-primary'} btn-sm mt-5`}>{it.buttonText}<Icon name="arrow" className="h-3.5 w-3.5" /></SmartLink>}
            </div>
          </div>
        ))}
      </Container>
    </section>
  );
}

export function WhyUs() {
  const { studio } = useStore();
  const w = studio.why;
  if (!w.enabled || !w.items.length) return null;
  return (
    <section id="studio-why" className="pt-14">
      <Container>
        <div className="rounded-box bg-soft px-6 py-10 sm:px-10">
          <h2 className="section-title mb-8 text-center">{w.title}</h2>
          <ul className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-5">
            {w.items.map((it, i) => (
              <li key={i} className="flex flex-col items-center gap-3 text-center">
                <span className="flex h-14 w-14 items-center justify-center rounded-full bg-white text-primary shadow-sm"><Icon name={it.icon} className="h-6 w-6" /></span>
                <span className="text-sm"><span className="block font-bold text-primary">{it.title}</span>{it.text && <span className="text-ink-500">{it.text}</span>}</span>
              </li>
            ))}
          </ul>
        </div>
      </Container>
    </section>
  );
}

export function Newsletter() {
  const { studio } = useStore();
  const n = studio.newsletter;
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'done' | string>('idle');
  if (!n.enabled) return null;
  return (
    <section id="studio-newsletter" className="pt-14">
      <Container>
        <div className="relative grid items-center gap-6 overflow-hidden rounded-box bg-primary px-6 py-10 text-white sm:px-12 md:grid-cols-2">
          <div>
            <h2 className="text-3xl font-extrabold text-white">{n.title}</h2>
            <p className="mt-2 max-w-md text-sm text-white/75">{n.text}</p>
            {n.note && <p className="mt-3 font-hand text-2xl text-accent">{n.note}</p>}
          </div>
          {state === 'done' ? <p className="flex items-center gap-2 text-lg font-semibold" role="status"><Icon name="check" className="h-6 w-6 text-accent" />Thank you! You are on the list.</p> : (
            <form className="flex flex-col flex-wrap gap-2 sm:flex-row" onSubmit={async (e) => {
              e.preventDefault();
              setState('busy');
              try {
                await api('/subscribe', { body: { email } });
                setState('done');
              } catch (err) {
                setState((err as Error).message);
              }
            }}>
              <label className="sr-only" htmlFor="newsletter-email">Email address</label>
              <input id="newsletter-email" type="email" required className="flex-1 rounded-full border-0 bg-white px-5 py-3.5 text-sm text-ink-800 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-accent" placeholder="Enter your email address" value={email} onChange={(e) => setEmail(e.target.value)} />
              <button className="btn-accent px-7" disabled={state === 'busy'}>{n.buttonText || 'Subscribe'}</button>
              {!['idle', 'busy'].includes(state) && <p className="w-full text-sm text-red-200" role="alert">{state}</p>}
            </form>
          )}
        </div>
      </Container>
    </section>
  );
}
