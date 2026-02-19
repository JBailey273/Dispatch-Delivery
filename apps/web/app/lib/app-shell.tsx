'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { clearSession, getSession } from './auth';

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const isActive = pathname === href || (href !== '/' && pathname.startsWith(href));
  return <Link href={href} className={`app-nav-link${isActive ? ' active' : ''}`}>{children}</Link>;
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const session = getSession();
  const isLogin = pathname === '/login';
  const isAdmin = session?.role === 'admin';
  const isDriver = session?.role === 'driver';

  if (!session || isLogin) return <>{children}</>;

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
