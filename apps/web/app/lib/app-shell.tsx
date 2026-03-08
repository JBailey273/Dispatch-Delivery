'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { clearSession, getSession, Session } from './auth';
import { LocationProvider, useLocation } from './location-context';

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const isActive = pathname === href || (href !== '/' && pathname.startsWith(href));
  return <Link href={href} className={`app-nav-link${isActive ? ' active' : ''}`}>{children}</Link>;
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

  // Single location — show static label, no dropdown
  if (locations.length <= 1) {
    if (!activeLocation) return null;
    return (
      <div className="nav-location-static">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
          <path d="M8 1.5C5.515 1.5 3.5 3.515 3.5 6c0 3.75 4.5 8.5 4.5 8.5s4.5-4.75 4.5-8.5c0-2.485-2.015-4.5-4.5-4.5zm0 6a1.5 1.5 0 110-3 1.5 1.5 0 010 3z" fill="currentColor"/>
        </svg>
        {activeLocation.name}
      </div>
    );
  }

  return (
    <div className="nav-location-switcher" ref={ref}>
      <button
        className="nav-location-btn"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
          <path d="M8 1.5C5.515 1.5 3.5 3.515 3.5 6c0 3.75 4.5 8.5 4.5 8.5s4.5-4.75 4.5-8.5c0-2.485-2.015-4.5-4.5-4.5zm0 6a1.5 1.5 0 110-3 1.5 1.5 0 010 3z" fill="currentColor"/>
        </svg>
        <span>{activeLocation?.name ?? 'Select location'}</span>
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" style={{ opacity: 0.6 }}>
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {open && (
        <div className="nav-location-dropdown" role="listbox">
          {locations.map(loc => (
            <button
              key={loc.id}
              className={`nav-location-option${activeLocation?.id === loc.id ? ' active' : ''}`}
              role="option"
              aria-selected={activeLocation?.id === loc.id}
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

function ShellInner({ children, session }: { children: React.ReactNode; session: Session }) {
  const isAdmin = session.role === 'admin';
  const isDriver = session.role === 'driver';
  const router = useRouter();

  return (
    <>
      <nav className="app-nav">
        <Link href={isDriver ? '/driver/loads' : '/ops-dashboard'} className="app-nav-brand">
          <span className="app-nav-brand-icon">D</span>
          {session.tenant_name || session.tenant_slug || 'Dispatch'}
        </Link>

        {!isDriver && (
          <>
            <NavLink href="/ops-dashboard">Dashboard</NavLink>
            <NavLink href="/dispatch-schedule">Schedule</NavLink>
            <NavLink href="/new-drop">New Order</NavLink>
            <NavLink href="/customer-search">Customers</NavLink>
            <NavLink href="/all-orders">All Orders</NavLink>
          </>
        )}
        {isDriver && (
          <NavLink href="/driver/loads">My Loads</NavLink>
        )}

        {isAdmin && (
          <>
            <div className="app-nav-sep" />
            <NavLink href="/admin/tenant">Settings</NavLink>
            <NavLink href="/admin/locations">Locations</NavLink>
            <NavLink href="/admin/catalog">Catalog</NavLink>
            <NavLink href="/admin/users">Users</NavLink>
            <NavLink href="/admin/channels">Channels</NavLink>
            <NavLink href="/admin/billing">Billing</NavLink>
          </>
        )}

        <div className="app-nav-spacer" />

        <div className="app-nav-user">
          {!isDriver && <LocationSwitcher />}
          <span className="app-nav-role">{session.role}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => { clearSession(); router.push('/login'); }}>
            Sign out
          </button>
        </div>
      </nav>
      {children}
    </>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (!mounted) return;
    if (pathname === '/login') return;
    const nextSession = getSession();
    if (!nextSession) { router.replace('/login'); return; }
    setSession(nextSession);
  }, [mounted, pathname, router]);

  const isLogin = pathname === '/login';
  if (!mounted) return null;
  if (isLogin) return <>{children}</>;
  if (!session) return null;

  const isDispatcherOrAdmin = session.role === 'dispatcher' || session.role === 'admin';

  return (
    <LocationProvider enabled={isDispatcherOrAdmin}>
      <ShellInner session={session}>{children}</ShellInner>
    </LocationProvider>
  );
}
