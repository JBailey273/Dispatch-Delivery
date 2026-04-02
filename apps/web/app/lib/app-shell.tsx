'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { clearSession, getSession, Session } from './auth';
import { LocationProvider, useLocation } from './location-context';

function SidebarLink({ href, icon, children }: { href: string; icon: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const isActive = pathname === href || (href !== '/' && pathname.startsWith(href));
  return (
    <Link href={href} className={`app-sidebar-link${isActive ? ' active' : ''}`}>
      <span className="app-sidebar-icon">{icon}</span>
      {children}
    </Link>
  );
}

function LocationSwitcher() {
  const { locations, activeLocation, setActiveLocation } = useLocation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  if (locations.length <= 1) {
    if (!activeLocation) return null;
    return (
      <div className="nav-location-static">
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
          <path d="M8 1.5C5.515 1.5 3.5 3.515 3.5 6c0 3.75 4.5 8.5 4.5 8.5s4.5-4.75 4.5-8.5c0-2.485-2.015-4.5-4.5-4.5zm0 6a1.5 1.5 0 110-3 1.5 1.5 0 010 3z" fill="currentColor"/>
        </svg>
        {activeLocation.name}
      </div>
    );
  }

  return (
    <div className="nav-location-switcher" ref={ref}>
      <button className="nav-location-btn" onClick={() => setOpen(o => !o)}>
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
          <path d="M8 1.5C5.515 1.5 3.5 3.515 3.5 6c0 3.75 4.5 8.5 4.5 8.5s4.5-4.75 4.5-8.5c0-2.485-2.015-4.5-4.5-4.5zm0 6a1.5 1.5 0 110-3 1.5 1.5 0 010 3z" fill="currentColor"/>
        </svg>
        <span>{activeLocation?.name ?? 'Select location'}</span>
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" style={{ opacity: 0.5, marginLeft: 'auto' }}>
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      {open && (
        <div className="nav-location-dropdown" role="listbox">
          {locations.map(loc => (
            <button
              key={loc.id}
              className={`nav-location-option${activeLocation?.id === loc.id ? ' active' : ''}`}
              onClick={() => { setActiveLocation(loc); setOpen(false); }}
            >
              {loc.name}
              {activeLocation?.id === loc.id && (
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                  <path d="M3 8l4 4 6-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const isDark = saved ? saved === 'dark' : prefersDark;
    setDark(isDark);
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.setAttribute('data-theme', next ? 'dark' : 'light');
    localStorage.setItem('theme', next ? 'dark' : 'light');
  };

  return (
    <button className="app-sidebar-footer-btn" onClick={toggle} title={dark ? 'Light mode' : 'Dark mode'}>
      {dark ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
        </svg>
      )}
    </button>
  );
}

function ShellInner({ children, session }: { children: React.ReactNode; session: Session }) {
  const isAdmin = session.role === 'admin';
  const isDriver = session.role === 'driver';
  const router = useRouter();

  const initials = session.role.slice(0, 2).toUpperCase();

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        {/* Brand */}
        <Link href={isDriver ? '/driver/loads' : '/ops-dashboard'} className="app-sidebar-brand">
          <div className="app-sidebar-brand-icon">EM</div>
          <div className="app-sidebar-brand-text">
            <span className="app-sidebar-brand-name">{session.tenant_name || 'East Meadow'}</span>
            <span className="app-sidebar-brand-sub">Dispatch</span>
          </div>
        </Link>

        {/* Nav */}
        <nav className="app-sidebar-nav">
          {!isDriver && (
            <>
              <SidebarLink href="/ops-dashboard" icon="⬡">Dashboard</SidebarLink>
              <SidebarLink href="/dispatch-schedule" icon="📅">Schedule</SidebarLink>
              <SidebarLink href="/new-drop" icon="⚡">Quick Drop</SidebarLink>
              <SidebarLink href="/dispatch/new-order" icon="＋">New Order</SidebarLink>
              <SidebarLink href="/customer-search" icon="👤">Customers</SidebarLink>
              <SidebarLink href="/all-orders" icon="📋">All Orders</SidebarLink>
              <SidebarLink href="/pickup" icon="🏪">Pickup Queue</SidebarLink>
            </>
          )}

          {isDriver && (
            <SidebarLink href="/driver/loads" icon="🚚">My Loads</SidebarLink>
          )}

          {isAdmin && (
            <>
              <div className="app-sidebar-divider" />
              <div className="app-sidebar-section-label">Admin</div>
              <SidebarLink href="/admin/tenant" icon="⚙">Settings</SidebarLink>
              <SidebarLink href="/admin/locations" icon="📍">Locations</SidebarLink>
              <SidebarLink href="/admin/catalog" icon="📦">Catalog</SidebarLink>
              <SidebarLink href="/admin/users" icon="👥">Users</SidebarLink>
              <SidebarLink href="/admin/channels" icon="🔗">Channels</SidebarLink>
              <SidebarLink href="/admin/billing" icon="💳">Billing</SidebarLink>
            </>
          )}
        </nav>

        {/* Footer */}
        <div className="app-sidebar-footer">
          {!isDriver && <LocationSwitcher />}

          <div className="app-sidebar-user">
            <div className="app-sidebar-user-avatar">{initials}</div>
            <div className="app-sidebar-user-info">
              <div className="app-sidebar-user-role">{session.role}</div>
            </div>
          </div>

          <div className="app-sidebar-footer-actions">
            <ThemeToggle />
            <button
              className="app-sidebar-signout"
              onClick={() => { clearSession(); router.push('/login'); }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
              </svg>
              Sign out
            </button>
          </div>
        </div>
      </aside>

      <main className="app-content">
        {children}
      </main>
    </div>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => { setMounted(true); }, []);

  const isPublic = pathname === '/login' || pathname === '/schedule' || pathname === '/schedule-embed';

  useEffect(() => {
    if (!mounted) return;
    if (isPublic) return;
    const nextSession = getSession();
    if (!nextSession) { router.replace('/login'); return; }
    setSession(nextSession);
  }, [mounted, pathname, router, isPublic]);

  if (!mounted) return null;
  if (isPublic) return <>{children}</>;
  if (!session) return null;

  const isDispatcherOrAdmin = session.role === 'dispatcher' || session.role === 'admin';

  return (
    <LocationProvider enabled={isDispatcherOrAdmin}>
      <ShellInner session={session}>{children}</ShellInner>
    </LocationProvider>
  );
}
