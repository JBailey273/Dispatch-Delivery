'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { clearSession, getSession, Session } from './auth';

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const isActive = pathname === href || (href !== '/' && pathname.startsWith(href));
  return <Link href={href} className={`app-nav-link${isActive ? ' active' : ''}`}>{children}</Link>;
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    if (pathname === '/login') return;

    const nextSession = getSession();
    if (!nextSession) {
      router.replace('/login');
      return;
    }

    setSession(nextSession);
  }, [mounted, pathname, router]);

  const isLogin = pathname === '/login';
  if (!mounted) return null;
  if (isLogin) return <>{children}</>;
  if (!session) return null;

  const isAdmin = session.role === 'admin';
  const isDriver = session.role === 'driver';

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
            <NavLink href="/admin/catalog">Catalog</NavLink>
            <NavLink href="/admin/users">Users</NavLink>
            <NavLink href="/admin/channels">Channels</NavLink>
            <NavLink href="/admin/billing">Billing</NavLink>
          </>
        )}

        <div className="app-nav-spacer" />
        <div className="app-nav-user">
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
