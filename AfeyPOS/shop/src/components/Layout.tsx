import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { asset } from '../lib/api';
import { useCart } from '../lib/cart';
import { useStore } from '../lib/store';
import { useWishlist } from '../lib/wishlist';
import { Icon } from './Icon';

const external = (to: string) => /^(https?:|mailto:|tel:)/.test(to);

/** Studio links are shop paths (/shop?sort=new) or full web addresses. */
export function SmartLink({ to, className, children, ...rest }: { to: string; className?: string; children: ReactNode; 'aria-label'?: string }) {
  if (!to) return <span className={className}>{children}</span>;
  return external(to) ? <a href={to} className={className} target="_blank" rel="noreferrer" {...rest}>{children}</a> : <Link to={to} className={className} {...rest}>{children}</Link>;
}

export function Logo({ light = false }: { light?: boolean }) {
  const store = useStore();
  const src = store.studio.brand.logoUrl || store.logoUrl;
  return (
    <Link to="/" className="flex shrink-0 items-center gap-2.5" aria-label={`${store.name} home`}>
      {src ? <img src={asset(src)} alt="" className="h-11 w-11 rounded-full object-cover" />
        : <span className={`flex h-11 w-11 items-center justify-center rounded-full ${light ? 'bg-white/10 text-accent' : 'tint text-primary'}`}><Icon name="leaf" className="h-6 w-6" /></span>}
      <span className="leading-tight">
        <span className={`block text-xl font-extrabold tracking-tight ${light ? 'text-white' : 'text-primary'}`}>{store.name}</span>
        {store.studio.brand.tagline && <span className={`block text-[11px] font-medium ${light ? 'text-white/70' : 'text-ink-500'}`}>{store.studio.brand.tagline}</span>}
      </span>
    </Link>
  );
}

function TopBar() {
  const { studio, announcement } = useStore();
  const items = studio.topBar.enabled ? studio.topBar.items : [];
  if (!items.length && !announcement) return null;
  return (
    <div id="studio-topBar" className="bg-primary text-white">
      <div className="mx-auto flex max-w-shop items-center justify-center gap-x-10 gap-y-1 overflow-x-auto px-4 py-2 text-[12.5px] font-medium sm:justify-between">
        {announcement && !items.length && <span className="mx-auto">{announcement}</span>}
        {items.map((it, i) => (
          <span key={i} className={`flex shrink-0 items-center gap-2 ${i > 0 ? 'hidden md:flex' : ''}`}><Icon name={it.icon} className="h-4 w-4 text-accent" />{it.title}</span>
        ))}
      </div>
    </div>
  );
}

function HeaderAction({ to, icon, label, count, testId }: { to: string; icon: string; label: string; count?: number; testId?: string }) {
  return (
    <Link to={to} className="group flex flex-col items-center gap-0.5 text-ink-700 hover:text-primary" aria-label={label}>
      <span className="relative">
        <Icon name={icon} className="h-6 w-6" />
        {count !== undefined && <span data-testid={testId} className="absolute -right-2 -top-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-primary">{count}</span>}
      </span>
      <span className="hidden text-[11px] font-semibold sm:block">{label}</span>
    </Link>
  );
}

function SearchBox({ className = '' }: { className?: string }) {
  const nav = useNavigate();
  const loc = useLocation();
  const [q, setQ] = useState('');
  useEffect(() => setQ(new URLSearchParams(loc.search).get('q') ?? ''), [loc.search]);
  return (
    <form role="search" className={`relative ${className}`} onSubmit={(e) => { e.preventDefault(); nav(`/shop${q ? `?q=${encodeURIComponent(q)}` : ''}`); }}>
      <input className="w-full rounded-full border border-ink-200 bg-ink-50 py-3 pl-5 pr-14 text-sm placeholder:text-ink-400 focus:border-primary focus:bg-white focus:outline-none" type="search" placeholder="Search for products, brands and more…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search products" />
      <button className="absolute right-1.5 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-primary text-white" aria-label="Search"><Icon name="search" className="h-4 w-4" /></button>
    </form>
  );
}

function Header() {
  const { studio } = useStore();
  const cart = useCart();
  const wish = useWishlist();
  return (
    <header className="sticky top-0 z-30 border-b border-ink-100 bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-shop items-center gap-4 px-4 py-4 lg:gap-10">
        <Logo />
        <SearchBox className="hidden flex-1 md:block" />
        <nav className="ml-auto flex items-center gap-5 sm:gap-7" aria-label="Your shopping">
          <HeaderAction to="/account" icon="user" label="Account" />
          <HeaderAction to="/wishlist" icon="heart" label="Wishlist" count={wish.ids.length || undefined} />
          <HeaderAction to="/cart" icon="bag" label="Cart" count={cart.count} testId="cart-count" />
        </nav>
      </div>
      <div className="px-4 pb-3 md:hidden"><SearchBox /></div>
      <nav id="studio-nav" className="border-t border-ink-100" aria-label="Shop sections">
        <ul className="mx-auto flex max-w-shop items-center gap-7 overflow-x-auto px-4 text-sm font-semibold text-ink-700 md:justify-center md:gap-10">
          {studio.nav.map((l) => (
            <li key={`${l.label}-${l.to}`} className="shrink-0">
              {external(l.to) ? <a href={l.to} className="block border-b-2 border-transparent py-3 hover:text-primary" target="_blank" rel="noreferrer">{l.label}</a> : (
                <NavLink to={l.to} end className={({ isActive }) => `block border-b-2 py-3 hover:text-primary ${isActive && navMatches(l.to) ? 'border-accent text-primary' : 'border-transparent'}`}>{l.label}</NavLink>
              )}
            </li>
          ))}
        </ul>
      </nav>
    </header>
  );
}

/** NavLink ignores the query string; "/shop?sort=new" is only active with that query. */
function navMatches(to: string) {
  const [path, qs = ''] = to.split('?');
  return location.pathname === path && (qs ? location.search === `?${qs}` : !location.search || path !== '/shop');
}

const SOCIAL: [keyof ReturnType<typeof useStore>['studio']['footer']['social'], string, string][] = [
  ['facebook', 'facebook', 'Facebook'], ['instagram', 'instagram', 'Instagram'], ['youtube', 'youtube', 'YouTube'], ['pinterest', 'pinterest', 'Pinterest'], ['tiktok', 'tiktok', 'TikTok'], ['x', 'x', 'X'], ['whatsapp', 'whatsapp', 'WhatsApp'],
];

function Footer() {
  const store = useStore();
  const f = store.studio.footer;
  const social = SOCIAL.filter(([k]) => f.social[k]);
  const hasPage = (slug: string) => store.studio.pages.some((p) => p.slug === slug);
  return (
    <footer id="studio-footer" className="mt-16 bg-foot text-white/80">
      <div className="mx-auto grid max-w-shop gap-10 px-4 py-14 md:grid-cols-[1.4fr_repeat(3,1fr)_1.2fr]">
        <div>
          <Logo light />
          <p className="mt-4 max-w-xs text-sm leading-relaxed">{f.about}</p>
          {social.length > 0 && (
            <div className="mt-5 flex gap-2.5">
              {social.map(([k, icon, label]) => (
                <a key={k} href={k === 'whatsapp' ? `https://wa.me/${String(f.social[k]).replace(/\D/g, '')}` : f.social[k]} target="_blank" rel="noreferrer" aria-label={label} className="flex h-9 w-9 items-center justify-center rounded-full border border-white/20 text-white hover:bg-white/10"><Icon name={icon} className="h-4 w-4" /></a>
              ))}
            </div>
          )}
          {(store.contactPhone || store.hours) && <p className="mt-5 space-y-1 text-sm">{store.contactPhone && <span className="flex items-center gap-2"><Icon name="phone" className="h-4 w-4 text-accent" />{store.contactPhone}</span>}{store.hours && <span className="flex items-center gap-2"><Icon name="clock" className="h-4 w-4 text-accent" />{store.hours}</span>}</p>}
        </div>
        {f.columns.map((c) => (
          <div key={c.title}>
            <h3 className="mb-4 text-sm font-bold text-white">{c.title}</h3>
            <ul className="space-y-2.5 text-sm">{c.links.map((l) => <li key={`${l.label}${l.to}`}><SmartLink to={l.to} className="hover:text-white">{l.label}</SmartLink></li>)}</ul>
          </div>
        ))}
        {(f.apps.android || f.apps.ios) && (
          <div>
            <h3 className="mb-4 text-sm font-bold text-white">Get the app</h3>
            <div className="flex flex-col gap-2.5">
              {f.apps.android && <a href={f.apps.android} target="_blank" rel="noreferrer" className="flex w-44 items-center gap-2.5 rounded-xl border border-white/20 bg-black/30 px-3 py-2 hover:bg-black/40"><Icon name="play" className="h-6 w-6" filled /><span className="leading-tight"><span className="block text-[10px]">GET IT ON</span><span className="block text-sm font-bold text-white">Google Play</span></span></a>}
              {f.apps.ios && <a href={f.apps.ios} target="_blank" rel="noreferrer" className="flex w-44 items-center gap-2.5 rounded-xl border border-white/20 bg-black/30 px-3 py-2 hover:bg-black/40"><Icon name="apple" className="h-6 w-6" filled /><span className="leading-tight"><span className="block text-[10px]">Download on the</span><span className="block text-sm font-bold text-white">App Store</span></span></a>}
            </div>
          </div>
        )}
      </div>
      <div className="border-t border-white/10">
        <div className="mx-auto flex max-w-shop flex-col items-center justify-between gap-2 px-4 py-5 text-xs sm:flex-row">
          <span>{f.copyright || `© ${new Date().getFullYear()} ${store.name}. All rights reserved.`}</span>
          <span className="flex gap-5">
            {hasPage('privacy') && <Link to="/page/privacy" className="hover:text-white">Privacy Policy</Link>}
            {hasPage('terms') && <Link to="/page/terms" className="hover:text-white">Terms of Service</Link>}
            <Link to="/track" className="hover:text-white">Track an order</Link>
          </span>
        </div>
      </div>
    </footer>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { preview } = useStore();
  const loc = useLocation();
  useEffect(() => window.scrollTo(0, 0), [loc.pathname]);
  return (
    <div className="flex min-h-screen flex-col">
      {preview && <div className="fixed bottom-3 left-3 z-50 rounded-full bg-black/75 px-3 py-1 text-xs font-semibold text-white">Studio preview</div>}
      <TopBar />
      <Header />
      <main className="flex-1">{children}</main>
      <Footer />
    </div>
  );
}

/** Page body width with the usual padding. */
export function Container({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto w-full max-w-shop px-4 ${className}`}>{children}</div>;
}

export function Crumbs({ items }: { items: { label: string; to?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5 py-5 text-xs text-ink-500">
      <Link to="/" className="hover:text-primary">Home</Link>
      {items.map((it) => <span key={it.label} className="flex items-center gap-1.5"><Icon name="chevron" className="h-3 w-3" />{it.to ? <Link to={it.to} className="hover:text-primary">{it.label}</Link> : <span className="font-semibold text-ink-700">{it.label}</span>}</span>)}
    </nav>
  );
}

export function QtyStepper({ value, onChange, max, label, small = false }: { value: number; onChange: (n: number) => void; max: number | null; label: string; small?: boolean }) {
  const size = small ? 'h-8 w-8' : 'h-10 w-10';
  return (
    <div className="inline-flex items-center rounded-full border border-ink-200 bg-white">
      <button type="button" className={`${size} flex items-center justify-center rounded-full hover:bg-ink-50`} aria-label={`Fewer ${label}`} onClick={() => onChange(value - 1)}><Icon name="minus" className="h-4 w-4" /></button>
      <span className="w-7 text-center text-sm font-bold tabular-nums">{value}</span>
      <button type="button" className={`${size} flex items-center justify-center rounded-full hover:bg-ink-50 disabled:opacity-40`} aria-label={`More ${label}`} disabled={max !== null && value >= max} onClick={() => onChange(value + 1)}><Icon name="plus" className="h-4 w-4" /></button>
    </div>
  );
}
