import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { applyUpdate, installApp, usePwa } from '../lib/pwa';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { NavItem } from '@afeypos/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Logo } from '../components/Logo';
import { Icon } from '../components/icons';
import { cx, QueryRefreshCtx, useToast } from '../components/ui';
import { applyTheme, getWorkstation, setWorkstation } from '../lib/workstation';
import { connectRealtime, disconnectRealtime, useRealtime } from '../lib/realtime';

const GROUPS: Record<string, string> = { sell: 'Sales', stock: 'Inventory', buy: 'Suppliers & purchasing', parties: 'Customers & marketing', people: 'People', finance: 'Finance', admin: 'Administration' };

const GROUP_ICONS: Record<string, string> = { sell: 'cart', stock: 'box', buy: 'truck', parties: 'users', people: 'user', finance: 'wallet', admin: 'settings' };

const ago = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');

function matchLength(path: string, location: string) {
  if (path === '/') return location === '/' ? 1 : 0;
  const base = path.split('?')[0];
  return location === base || location.startsWith(`${base}/`) ? base.length : 0;
}

export function AppShell() {
  const { me, logout, can, has } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const toast = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [mini, setMini] = useState(() => {
    try {
      return localStorage.getItem('afey.sidebar') === 'mini';
    } catch {
      return false;
    }
  });
  const [theme, setTheme] = useState(getWorkstation().theme ?? 'system');
  const [menu, setMenu] = useState(false);
  const [search, setSearch] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const sync = useQuery({ queryKey: ['sync-indicator'], queryFn: () => api<{ data: { role: string; online?: boolean; lastSuccessAt?: string | null; lastError?: string | null } }>('/sync/indicator').then((r) => r.data), enabled: me?.deploymentMode === 'branch', refetchInterval: 15_000 });
  const alerts = useQuery({ queryKey: ['stock-alert-count'], queryFn: () => api<{ data: { counts: { total: number } } }>('/inventory/alerts', { query: { summary: 'true' } }).then((r) => r.data.counts.total), enabled: Boolean(me) && can('inventory.read') && has('inventory'), refetchInterval: 120_000 });
  const dashboard = useQuery({ queryKey: ['dashboard'], queryFn: () => api<{ data: any }>('/reports/dashboard').then((r) => r.data), enabled: Boolean(me) && can('reports.read') && has('reports'), refetchInterval: 60_000 });

  useEffect(() => {
    connectRealtime();
    return () => disconnectRealtime();
  }, []);
  useRealtime('inventory.low_stock', (d) => toast.info(`Low stock: ${d.name} (${d.qty} left)`));
  useEffect(() => {
    const close = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const current = useMemo(() => {
    let best: NavItem | null = null;
    let len = 0;
    for (const n of me?.navigation ?? []) {
      const l = matchLength(n.path, loc.pathname);
      if (l > len) {
        best = n;
        len = l;
      }
    }
    return best;
  }, [me, loc.pathname]);

  // Sidebar groups fold open and closed (remembered on this computer); the group of the open page stays open.
  const [folded, setFolded] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem('afey.nav.folded') ?? '{}'); } catch { return {}; }
  });
  const toggleGroup = (g: string) => setFolded((f) => {
    const next = { ...f, [g]: !f[g] };
    try { localStorage.setItem('afey.nav.folded', JSON.stringify(next)); } catch { /* ignore */ }
    return next;
  });
  const pwa = usePwa();
  // Checkout rules can hide pages from cashiers: send them to checkout instead.
  const blocked = me?.blockedPaths ?? [];
  const isBlocked = (path: string) => blocked.some((b) => (b === '/' ? path === '/' : path === b || path.startsWith(`${b}/`)));
  useEffect(() => {
    if (me && isBlocked(loc.pathname)) nav('/pos', { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, loc.pathname]);
  if (!me) return null;
  const groups = Object.keys(GROUPS).map((g) => ({ g, items: me.navigation.filter((n) => n.group === g && n.key !== 'dashboard') })).filter((x) => x.items.length);
  const dark = theme === 'dark' || (theme === 'system' && document.documentElement.classList.contains('dark'));
  const toggleTheme = () => {
    const next = dark ? 'light' : 'dark';
    setTheme(next);
    setWorkstation({ theme: next });
    applyTheme(next);
  };
  const toggleMini = () => {
    setMini((v) => {
      try {
        localStorage.setItem('afey.sidebar', v ? 'full' : 'mini');
      } catch {
        /* storage unavailable */
      }
      return !v;
    });
  };
  const close = () => setOpen(false);
  const d = dashboard.data;
  const lowStock = d?.lowStockCount ?? 0;
  const inStockPct = d && d.productsCount ? Math.round(((d.productsCount - d.outOfStockCount) / d.productsCount) * 100) : null;
  const pageLabel = loc.pathname === '/' ? 'Dashboard' : loc.pathname === '/account' ? 'My account' : loc.pathname === '/support' ? 'Support' : current?.label ?? '';
  const groupLabel = current && loc.pathname !== '/' ? GROUPS[current.group] : null;
  const onSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const q = search.trim();
    if (!q) return;
    if (/^(RCP|RTN|WEB)-/i.test(q) && can('sales.read')) nav(`/sales?q=${encodeURIComponent(q)}`);
    else if (can('products.read')) nav(`/products?q=${encodeURIComponent(q)}`);
    else if (can('customers.read')) nav(`/customers?q=${encodeURIComponent(q)}`);
  };
  const badges: Record<string, number> = { stockAlerts: alerts.data ?? 0 };
  const child = (n: { key: string; path: string; label: string }) => (
    <NavLink key={n.key} to={n.path} end={n.path === '/inventory' || n.path === '/settings'} onClick={close}
      className={({ isActive }) => cx('flex items-center gap-2 border-l-[3px] py-[7px] pl-11 pr-3 text-[12.5px] transition-colors', isActive ? 'border-brand-500 bg-side-active font-semibold text-white' : 'border-transparent text-side-text hover:bg-side-hover hover:text-white')}>
      <span className="truncate">{n.label}</span>
      {badges[n.key] ? <span className="ml-auto min-w-[20px] rounded-full bg-brand-500 px-1.5 text-center text-[10px] font-bold leading-5 text-white" aria-label={`${badges[n.key]} alerts`}>{badges[n.key]}</span> : null}
    </NavLink>
  );
  const item = (n: { key: string; path: string; icon: string; label: string }, end = false) => (
    <NavLink key={n.key} to={n.path} end={end || n.path === '/inventory' || n.path === '/settings'} onClick={close} title={mini ? n.label : undefined}
      className={({ isActive }) => cx('flex items-center gap-2.5 border-l-[3px] py-[7px] text-[12.5px] transition-colors', mini ? 'justify-center px-0' : 'pl-4 pr-3', isActive ? 'border-brand-500 bg-side-active font-semibold text-white' : 'border-transparent text-side-text hover:bg-side-hover hover:text-white')}>
      <Icon name={n.icon} className="h-[15px] w-[15px] shrink-0" />
      {!mini && <span className="truncate">{n.label}</span>}
    </NavLink>
  );
  const label = (text: string) => (mini ? <div className="mx-3 my-2 border-t border-white/10" /> : <div className="px-4 pb-1.5 pt-4 text-[10px] font-bold uppercase tracking-[0.08em] text-side-muted">{text}</div>);
  const bar = (name: string, pct: number, color: string) => (
    <div className="mb-3 px-4">
      <div className="mb-1 flex justify-between text-[11px] text-side-text"><span>{name}</span><span>{pct}%</span></div>
      <div className="h-1.5 rounded-full bg-white/10"><div className={cx('h-1.5 rounded-full', color)} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} /></div>
    </div>
  );

  // Checkout is full screen: no sidebar or breadcrumbs, and a Go back button to leave it.
  const pos = loc.pathname === '/pos';
  const goBack = () => {
    if ((window.history.state?.idx ?? 0) > 0) nav(-1);
    else nav(me?.navigation.find((n) => n.key !== 'pos')?.path ?? '/', { replace: true });
  };

  return (
    <QueryRefreshCtx.Provider value={() => qc.invalidateQueries()}>
      <div className="flex min-h-screen bg-canvas text-[13px] dark:bg-canvas-dark">
        {!pos && <aside className={cx('no-print fixed inset-y-0 left-0 z-40 flex transform flex-col bg-side text-side-text transition-all dark:bg-[#1b1e23] lg:sticky lg:top-0 lg:h-screen lg:translate-x-0', mini ? 'w-16' : 'w-56', open ? 'translate-x-0' : '-translate-x-full')}>
          <div className={cx('flex h-12 shrink-0 items-center gap-2 bg-side-top', mini ? 'justify-center' : 'px-3')}>
            {!mini && <Link to="/" className="flex min-w-0 flex-1 items-center gap-2"><Logo className="h-7 w-auto shrink-0" /><span className="truncate text-[14px] font-bold text-white">Afey<span className="font-normal text-side-text">POS</span></span></Link>}
            <button onClick={toggleMini} className="hidden rounded p-1 text-side-text hover:bg-side-hover hover:text-white lg:block" aria-label={mini ? 'Expand sidebar' : 'Collapse sidebar'}><Icon name="menu" className="h-4 w-4" /></button>
          </div>
          <nav className="flex-1 overflow-y-auto pb-3 [scrollbar-width:thin]" aria-label="Main">
            {label('Menu')}
            {!isBlocked('/') && item({ key: 'dashboard', path: '/', icon: 'home', label: 'Dashboard' }, true)}
            {!isBlocked('/support') && item({ key: 'support', path: '/support', icon: 'headset', label: 'Support' })}
            {groups.map(({ g, items }) => {
              if (mini) return <div key={g}>{label(GROUPS[g])}{items.map((n) => item(n))}</div>;
              const here = current?.group === g && current.key !== 'dashboard';
              const openGroup = here || !folded[g];
              return (
                <div key={g} className="mt-1">
                  <button type="button" onClick={() => toggleGroup(g)} aria-expanded={openGroup}
                    className={cx('flex w-full items-center gap-2.5 py-2 pl-4 pr-3 text-left text-[13px] font-semibold transition-colors hover:bg-side-hover hover:text-white', here ? 'text-white' : 'text-side-text')}>
                    <Icon name={GROUP_ICONS[g] ?? 'grid'} className="h-[17px] w-[17px] shrink-0" />
                    <span className="flex-1 truncate">{GROUPS[g]}</span>
                    {here && <span className="h-1.5 w-1.5 rounded-full bg-brand-500" aria-hidden="true" />}
                    <Icon name="chevron" className={cx('h-3 w-3 shrink-0 transition-transform', openGroup ? '-rotate-90' : 'rotate-90')} />
                  </button>
                  {openGroup && <div className="border-l border-white/5 ml-0">{items.map((n) => child(n))}</div>}
                </div>
              );
            })}
            {label('You')}
            {item({ key: 'account', path: '/account', icon: 'user', label: 'My account' })}
            {!mini && d && <>
              {label('Shop stats')}
              {inStockPct !== null && bar('Products in stock', inStockPct, inStockPct < 90 ? 'bg-tile-yellow' : 'bg-tile-green')}
              {d.sales.grossCents > 0 && can('reports.financial') && bar('Gross margin today', Math.round((d.grossProfitCents / Math.max(1, d.sales.grossCents)) * 100), 'bg-brand-500')}
            </>}
          </nav>
        </aside>}
        {open && !pos && <div className="fixed inset-0 z-30 bg-ink-950/40 lg:hidden" onClick={close} />}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="no-print sticky top-0 z-20 flex h-12 items-center gap-2 border-b border-[#e1e4e8] bg-white px-3 dark:border-ink-800 dark:bg-ink-900">
            {pos ? (
              <>
                <button type="button" onClick={goBack} className="inline-flex items-center gap-1.5 rounded-md border border-[#d5d9de] bg-white px-3 py-1.5 text-[13px] font-semibold text-ink-700 shadow-sm transition hover:border-brand-400 hover:bg-brand-50 hover:text-brand-700 dark:border-ink-700 dark:bg-ink-900 dark:text-ink-200 dark:hover:bg-ink-800">
                  <Icon name="chevron" className="h-3.5 w-3.5 rotate-180" />Go back
                </button>
                <Link to="/" className="ml-1 hidden items-center gap-2 sm:flex" aria-label="Afey POS home"><Logo className="h-6 w-auto" /><span className="text-[14px] font-bold text-ink-800 dark:text-white">Checkout</span></Link>
              </>
            ) : <button className="rounded p-1.5 text-ink-600 hover:bg-ink-100 lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu"><Icon name="menu" className="h-5 w-5" /></button>}
            <div className={cx('hidden items-center gap-1 text-ink-500', !pos && 'sm:flex')}>
              {can('sales.create') && has('pos') && <Link to="/pos" className="rounded p-1.5 hover:bg-ink-100 hover:text-ink-800 dark:hover:bg-ink-800" title="Checkout" aria-label="Open checkout"><Icon name="cart" className="h-4 w-4" /></Link>}
              {can('sales.read') && <Link to="/returns" className="rounded p-1.5 hover:bg-ink-100 hover:text-ink-800 dark:hover:bg-ink-800" title="Returns" aria-label="Open returns"><Icon name="undo" className="h-4 w-4" /></Link>}
              {can('reports.read') && has('reports') && <Link to="/reports" className="rounded p-1.5 hover:bg-ink-100 hover:text-ink-800 dark:hover:bg-ink-800" title="Reports" aria-label="Open reports"><Icon name="chart" className="h-4 w-4" /></Link>}
            </div>
            <form onSubmit={onSearch} className={cx('ml-1 hidden w-56 items-center', !pos && 'md:flex')} role="search">
              <Icon name="search" className="-mr-6 h-3.5 w-3.5 text-ink-400" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search..." aria-label="Search products, receipts or customers" className="w-full rounded-sm border border-transparent bg-transparent py-1 pl-7 pr-2 text-[12.5px] outline-none placeholder:text-ink-400 focus:border-[#d5d9de] focus:bg-white dark:focus:bg-ink-950" />
            </form>
            <div className="ml-auto flex items-center gap-1">
              {me.deploymentMode === 'hq' && <span className="mr-1 hidden rounded-sm bg-brand-50 px-2 py-0.5 text-[11px] font-semibold text-brand-700 sm:inline">Head office</span>}
              {me.deploymentMode === 'branch' && sync.data && (
                // Branch server: sales are always saved here; this says whether head office is up to date.
                <span role="status" title={sync.data.lastError ?? undefined} className={cx('mr-1 inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold', sync.data.online ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200' : 'bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200')}>
                  <span className={cx('h-2 w-2 rounded-full', sync.data.online ? 'bg-emerald-500' : 'bg-amber-500')} />
                  {sync.data.online ? `Online · synced ${sync.data.lastSuccessAt ? ago(sync.data.lastSuccessAt) : 'now'}` : 'Offline · saved here, syncs when back'}
                </span>
              )}
              {pwa.canInstall && <button onClick={() => installApp()} className="mr-1 hidden items-center gap-1.5 rounded-md border border-brand-200 bg-brand-50 px-2.5 py-1 text-[12px] font-semibold text-brand-700 hover:bg-brand-100 sm:inline-flex dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-200" aria-label="Install Afey POS as an app"><Icon name="download" className="h-3.5 w-3.5" />Install app</button>}
              <button onClick={toggleTheme} className="rounded p-1.5 text-ink-500 hover:bg-ink-100 dark:hover:bg-ink-800" aria-label="Toggle dark mode"><Icon name={dark ? 'sun' : 'moon'} className="h-4 w-4" /></button>
              <button onClick={() => nav(can('inventory.read') ? '/inventory?belowReorder=true' : '/')} className="relative rounded p-1.5 text-ink-500 hover:bg-ink-100 dark:hover:bg-ink-800" aria-label={lowStock ? `${lowStock} products low on stock` : 'Notifications'}>
                <Icon name="bell" className="h-4 w-4" />
                {lowStock > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-[16px] rounded-full bg-tile-red px-1 text-center text-[9px] font-bold leading-4 text-white">{lowStock > 99 ? '99+' : lowStock}</span>}
              </button>
              <span className="mx-1 hidden items-center gap-1 text-[12px] text-ink-500 sm:flex"><Icon name="flag" className="h-3.5 w-3.5" />KE</span>
              <div ref={menuRef} className="relative">
                <button onClick={() => setMenu((v) => !v)} className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-ink-100 dark:hover:bg-ink-800" aria-haspopup="menu" aria-expanded={menu}>
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-500 text-[11px] font-bold text-white">{initials(me.user.name)}</span>
                  <span className="hidden text-[12.5px] font-semibold text-ink-700 dark:text-ink-200 sm:block">{me.user.name.split(' ')[0]}</span>
                  <Icon name="chevron" className="hidden h-3 w-3 rotate-90 text-ink-400 sm:block" />
                </button>
                {menu && (
                  <div role="menu" className="absolute right-0 mt-1 w-56 rounded-sm border border-[#e1e4e8] bg-white py-1 text-[13px] shadow-lg dark:border-ink-700 dark:bg-ink-900">
                    <div className="border-b border-[#f0f1f3] px-3 py-2 dark:border-ink-800"><div className="font-semibold">{me.user.name}</div><div className="truncate text-[11px] text-ink-500">{me.user.email}</div><div className="text-[11px] text-ink-500">{me.user.roles.join(', ').replace(/_/g, ' ')}</div></div>
                    <Link role="menuitem" to="/account" onClick={() => setMenu(false)} className="flex items-center gap-2 px-3 py-2 hover:bg-[#f5f6f8] dark:hover:bg-ink-800"><Icon name="user" className="h-4 w-4" />My account</Link>
                    <Link role="menuitem" to="/support" onClick={() => setMenu(false)} className="flex items-center gap-2 px-3 py-2 hover:bg-[#f5f6f8] dark:hover:bg-ink-800"><Icon name="headset" className="h-4 w-4" />Support</Link>
                    {pwa.canInstall && <button role="menuitem" onClick={() => { setMenu(false); installApp(); }} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[#f5f6f8] dark:hover:bg-ink-800"><Icon name="download" className="h-4 w-4" />Install app</button>}
                    <button role="menuitem" onClick={async () => { await logout(); nav('/login'); }} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[#f5f6f8] dark:hover:bg-ink-800"><Icon name="logout" className="h-4 w-4" />Sign out</button>
                  </div>
                )}
              </div>
            </div>
          </header>
          {!pwa.online && <div role="alert" className="no-print flex items-center gap-2 bg-amber-100 px-4 py-1.5 text-[12.5px] font-semibold text-amber-900 dark:bg-amber-900/50 dark:text-amber-100"><Icon name="info" className="h-4 w-4" />Offline: no connection to the server. Sales and changes need the connection back.</div>}
          {pwa.updateReady && <div role="status" className="no-print flex items-center gap-3 bg-brand-500 px-4 py-1.5 text-[12.5px] text-white"><span className="font-semibold">A new version of Afey POS is ready.</span><button onClick={applyUpdate} className="rounded bg-white/20 px-2.5 py-0.5 font-semibold hover:bg-white/30">Update now</button></div>}
          {!pos && <div className="no-print flex min-h-[42px] flex-wrap items-center gap-2 border-b border-[#e1e4e8] bg-[#f7f8fa] px-4 py-1.5 dark:border-ink-800 dark:bg-ink-900/60">
            <span className="text-[15px] font-semibold text-ink-800 dark:text-white">{pageLabel}</span>
            <span className="h-4 border-l border-[#d5d9de]" />
            <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-[12px] text-ink-500">
              <Link to="/" aria-label="Home" className="hover:text-brand-600"><Icon name="home" className="h-3.5 w-3.5" /></Link>
              <span>/</span><Link to="/" className="hover:text-brand-600">Home</Link>
              {groupLabel && <><span>/</span><span>{groupLabel}</span></>}
              <span>/</span><span className="text-ink-700 dark:text-ink-300">{pageLabel}</span>
            </nav>
            <div className="ml-auto flex items-center gap-2 text-[12px] text-ink-500">
              <span className="hidden sm:inline">{new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</span>
              {can('sales.create') && has('pos') && <Link to="/pos" className="rounded-sm bg-brand-500 px-2.5 py-1 font-semibold text-white hover:bg-brand-600">New sale</Link>}
            </div>
          </div>}
          <main className="flex-1 p-3 lg:p-4"><Outlet /></main>
          {!pos && <footer className="no-print flex justify-between border-t border-[#e1e4e8] px-4 py-2 text-[11px] text-ink-400 dark:border-ink-800">
            <span>© {new Date().getFullYear()} {me.tenant.name}</span><span>Afey POS</span>
          </footer>}
        </div>
      </div>
    </QueryRefreshCtx.Provider>
  );
}
