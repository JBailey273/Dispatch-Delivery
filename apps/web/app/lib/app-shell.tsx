'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { clearSession, getSession } from './auth';

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const session = getSession();
  const isAdmin = session?.role === 'admin';
  return (
    <>
      {session && pathname !== '/login' && (
        <header style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <strong>{session.tenant_name || session.tenant_slug || session.tenant_id}</strong>
          <Link href="/dispatch-schedule">Operations</Link>
          <Link href="/ops-dashboard">Ops Dashboard</Link>
          {isAdmin && (
            <>
              <Link href="/admin/tenant">Administration</Link>
              <Link href="/admin/catalog">Catalog</Link>
              <Link href="/admin/users">Users</Link>
              <Link href="/admin/channels">Channels</Link>
            </>
          )}
          <button onClick={() => { clearSession(); router.push('/login'); }}>Logout</button>
        </header>
      )}
      {children}
    </>
  );
}
