import { Logo } from '../components/Logo';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { BUSINESS_PROFILES, type BusinessType } from '@afeypos/shared';
import { useAuth } from '../lib/auth';
import { Icon } from '../components/icons';
import { cx, Badge } from '../components/ui';
import { applyTheme, getWorkstation, setWorkstation } from '../lib/workstation';
import { connectRealtime, disconnectRealtime, useRealtime } from '../lib/realtime';
import { useToast } from '../components/ui';
import { date } from '../lib/format';

const GROUPS: Record<string, string> = { sell: 'Sell', stock: 'Stock', parties: 'Customers & suppliers', finance: 'Finance', admin: 'Administration' };

export function AppShell() {
  const { me, logout } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState(getWorkstation().theme ?? 'system');

  useEffect(() => {
    connectRealtime();
    return () => disconnectRealtime();
  }, []);
  useRealtime('inventory.low_stock', (d) => toast.info(`Low stock: ${d.name} (${d.qty} left)`));

  if (!me) return null;
  const groups = Object.keys(GROUPS).map((g) => ({ g, items: me.navigation.filter((n) => n.group === g) })).filter((x) => x.items.length);
  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    setWorkstation({ theme: next });
    applyTheme(next);
  };

  return (
    <div className="flex min-h-screen">
      <aside className={cx('no-print fixed inset-y-0 left-0 z-40 w-64 transform border-r border-ink-200 bg-white transition dark:border-ink-800 dark:bg-ink-900 lg:static lg:translate-x-0', open ? 'translate-x-0' : '-translate-x-full')}>
        <div className="flex h-14 items-center gap-2 border-b border-ink-100 px-4 dark:border-ink-800">
          <Logo className="h-9 w-auto shrink-0" />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">Afey POS</div>
            <div className="truncate text-xs text-ink-500">{me.tenant.name}</div>
          </div>
        </div>
        <nav className="h-[calc(100vh-3.5rem)] overflow-y-auto px-2 py-3" aria-label="Main">
          {groups.map(({ g, items }) => (
            <div key={g} className="mb-4">
              <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-400">{GROUPS[g]}</div>
              {items.map((n) => (
                <NavLink key={n.key} to={n.path} end={n.path === '/' || n.path === '/inventory' || n.path === '/settings'} onClick={() => setOpen(false)}
                  className={({ isActive }) => cx('flex items-center gap-3 rounded-lg px-3 py-2 text-sm', isActive ? 'bg-brand-50 font-medium text-brand-800 dark:bg-white/10 dark:text-white' : 'text-ink-600 hover:bg-ink-100 dark:text-ink-300 dark:hover:bg-ink-800')}>
                  <Icon name={n.icon} className="h-4 w-4" />
                  {n.label}
                </NavLink>
              ))}
            </div>
          ))}
          <NavLink to="/account" className={({ isActive }) => cx('flex items-center gap-3 rounded-lg px-3 py-2 text-sm', isActive ? 'bg-brand-50 text-brand-800 dark:bg-white/10 dark:text-white' : 'text-ink-600 hover:bg-ink-100 dark:text-ink-300 dark:hover:bg-ink-800')}><Icon name="user" className="h-4 w-4" />My account</NavLink>
        </nav>
      </aside>
      {open && <div className="fixed inset-0 z-30 bg-ink-950/40 lg:hidden" onClick={() => setOpen(false)} />}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-ink-200 bg-white/90 px-4 backdrop-blur dark:border-ink-800 dark:bg-ink-900/90">
          <button className="rounded p-1.5 hover:bg-ink-100 lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu"><Icon name="menu" /></button>
          <div className="hidden text-sm text-ink-500 sm:block">{BUSINESS_PROFILES[me.tenant.businessType as BusinessType]?.name}</div>
          {me.tenant.status === 'trial' && <Badge tone="amber">Trial until {date(me.tenant.trialEndsAt)}</Badge>}
          {me.tenant.status === 'past_due' && <Badge tone="red">Payment overdue</Badge>}
          {me.user.kind === 'support' && <Badge tone="red">Afey support · read-only</Badge>}
          <div className="ml-auto flex items-center gap-2">
            <button onClick={toggleTheme} className="rounded p-1.5 text-ink-500 hover:bg-ink-100 dark:hover:bg-ink-800" aria-label="Toggle dark mode"><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button>
            <div className="hidden text-right sm:block">
              <div className="text-sm font-medium">{me.user.name}</div>
              <div className="text-xs text-ink-500">{me.user.roles.join(', ').replace(/_/g, ' ')}</div>
            </div>
            <button onClick={async () => { await logout(); nav('/login'); }} className="rounded p-1.5 text-ink-500 hover:bg-ink-100 dark:hover:bg-ink-800" aria-label="Sign out"><Icon name="logout" /></button>
          </div>
        </header>
        <main className="flex-1 p-4 lg:p-6"><Outlet /></main>
      </div>
    </div>
  );
}
