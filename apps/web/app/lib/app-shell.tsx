'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { clearSession, getSession, Session } from './auth';
import { LocationProvider, useLocation } from './location-context';
import { useOrderNotifications, OrderNotification } from './use-order-notifications';

function SidebarLink({ href, children, icon }: { href: string; children: React.ReactNode; icon: React.ReactNode }) {
  const pathname = usePathname();
  const isActive = pathname === href || (href !== '/' && pathname.startsWith(href));
  return (
    <Link href={href} className={`app-sidebar-link${isActive ? ' active' : ''}`}>
      <span className="app-sidebar-icon">{icon}</span>
      {children}
    </Link>
  );
}

const Icons = {
  dashboard: <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="1" width="6" height="6" rx="1.5" fill="currentColor"/><rect x="9" y="1" width="6" height="6" rx="1.5" fill="currentColor" opacity="0.5"/><rect x="1" y="9" width="6" height="6" rx="1.5" fill="currentColor" opacity="0.5"/><rect x="9" y="9" width="6" height="6" rx="1.5" fill="currentColor" opacity="0.5"/></svg>,
  schedule: <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="2" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1.5"/><path d="M5 1V4M11 1V4M1 7h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>,
  quickdrop: <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2v7M5 6l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M2 11v1a2 2 0 002 2h8a2 2 0 002-2v-1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>,
  neworder: <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5"/><path d="M8 5v6M5 8h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>,
  customers: <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="5" r="3" stroke="currentColor" strokeWidth="1.5"/><path d="M2 14c0-3.314 2.686-5 6-5s6 1.686 6 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>,
  allorders: <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M2 8h8M2 12h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>,
  pickup: <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="5" width="14" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5"/><path d="M4 5V4a4 4 0 018 0v1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>,
  settings: <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.5"/><path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3.05 3.05l1.06 1.06M11.89 11.89l1.06 1.06M3.05 12.95l1.06-1.06M11.89 4.11l1.06-1.06" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>,
  locations: <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1.5C5.515 1.5 3.5 3.515 3.5 6c0 3.75 4.5 8.5 4.5 8.5s4.5-4.75 4.5-8.5c0-2.485-2.015-4.5-4.5-4.5zm0 6a1.5 1.5 0 110-3 1.5 1.5 0 010 3z" fill="currentColor"/></svg>,
  catalog: <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="4" width="14" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5"/><path d="M4 4V3a1 1 0 011-1h6a1 1 0 011 1v1" stroke="currentColor" strokeWidth="1.5"/></svg>,
  users: <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="6" cy="5" r="2.5" stroke="currentColor" strokeWidth="1.5"/><path d="M1 13c0-2.761 2.239-4 5-4s5 1.239 5 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><path d="M11 7.5a2 2 0 100-4M15 13c0-2-1.5-3.5-4-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>,
  channels: <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="3" cy="8" r="2" stroke="currentColor" strokeWidth="1.5"/><circle cx="13" cy="3" r="2" stroke="currentColor" strokeWidth="1.5"/><circle cx="13" cy="13" r="2" stroke="currentColor" strokeWidth="1.5"/><path d="M5 7.5l6-3.5M5 8.5l6 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>,
  billing: <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="3" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="1.5"/><path d="M1 7h14" stroke="currentColor" strokeWidth="1.5"/><path d="M4 10.5h2M10 10.5h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>,
  loads: <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M1 11l4-8 3 5 2-3 5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  signout: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>,
  sun: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>,
  moon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>,
  pin: <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M8 1.5C5.515 1.5 3.5 3.515 3.5 6c0 3.75 4.5 8.5 4.5 8.5s4.5-4.75 4.5-8.5c0-2.485-2.015-4.5-4.5-4.5zm0 6a1.5 1.5 0 110-3 1.5 1.5 0 010 3z" fill="currentColor"/></svg>,
  chevron: <svg width="10" height="10" viewBox="0 0 16 16" fill="none" style={{ opacity: 0.4, marginLeft: 'auto' }}><path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  check: <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3 8l4 4 6-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  bell: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>,
};

const LogoMark = () => (
  <svg width="20" height="20" viewBox="0 0 22 22" fill="none">
    <circle cx="4" cy="15" r="2.5" fill="white"/>
    <circle cx="11" cy="7" r="2.5" fill="white"/>
    <circle cx="18" cy="12" r="2.5" fill="white"/>
    <path d="M6 14L9.5 8.5M13 8L16 11.5" stroke="white" strokeWidth="1.8" strokeLinecap="round"/>
  </svg>
);

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
        {Icons.pin}
        {activeLocation.name}
      </div>
    );
  }

  return (
    <div className="nav-location-switcher" ref={ref}>
      <button className="nav-location-btn" onClick={() => setOpen(o => !o)}>
        {Icons.pin}
        <span>{activeLocation?.name ?? 'Select location'}</span>
        {Icons.chevron}
      </button>
      {open && (
        <div className="nav-location-dropdown">
          {locations.map(loc => (
            <button
              key={loc.id}
              className={`nav-location-option${activeLocation?.id === loc.id ? ' active' : ''}`}
              onClick={() => { setActiveLocation(loc); setOpen(false); }}
            >
              {loc.name}
              {activeLocation?.id === loc.id && Icons.check}
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
      {dark ? Icons.sun : Icons.moon}
    </button>
  );
}

/* ── Toast Card ── */
function ToastCard({ notif, onDismiss }: { notif: OrderNotification; onDismiss: (id: string) => void }) {
  const isPickup = notif.type === 'pickup';
  return (
    <div className={`notif-toast ${isPickup ? 'notif-toast--pickup' : 'notif-toast--delivery'}`}>
      <div className={`notif-toast-bar ${isPickup ? 'notif-toast-bar--pickup' : 'notif-toast-bar--delivery'}`} />
      <div className="notif-toast-body">
        <div className="notif-toast-title">
          <span className={`notif-dot ${isPickup ? 'notif-dot--pickup' : 'notif-dot--delivery'}`} />
          {isPickup ? 'New pickup order' : 'New delivery order'}
          <span className={`notif-badge ${isPickup ? 'notif-badge--pickup' : 'notif-badge--delivery'}`}>
            {isPickup ? 'Pickup' : 'Delivery'}
          </span>
        </div>
        <div className="notif-toast-row"><span className="notif-toast-label">Customer</span><span className="notif-toast-val">{notif.customer_name}</span></div>
        <div className="notif-toast-row"><span className="notif-toast-label">Address</span><span className="notif-toast-val">{notif.address_short}</span></div>
        <div className="notif-toast-row"><span className="notif-toast-label">Materials</span><span className="notif-toast-val">{notif.materials}</span></div>
        <div className="notif-toast-row"><span className="notif-toast-label">Date</span><span className="notif-toast-val">{notif.date_label}</span></div>
      </div>
      <button className="notif-toast-dismiss" onClick={() => onDismiss(notif.id)}>✕</button>
    </div>
  );
}

/* ── Notification Log Panel ── */
function NotifPanel({ log, unreadCount, onMarkAllRead, onClose }: {
  log: OrderNotification[];
  unreadCount: number;
  onMarkAllRead: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="notif-panel-backdrop" onClick={onClose} />
      <div className="notif-panel">
        <div className="notif-panel-head">
          <span className="notif-panel-title">New Orders</span>
          {unreadCount > 0 && (
            <button className="notif-panel-clear" onClick={onMarkAllRead}>Mark all read</button>
          )}
          <button className="notif-panel-close" onClick={onClose}>✕</button>
        </div>
        {log.length === 0 ? (
          <div className="notif-panel-empty">No new orders this session</div>
        ) : (
          <div className="notif-panel-list">
            {log.map(n => (
              <div key={n.id} className={`notif-panel-item ${n.read ? 'notif-panel-item--read' : ''}`}>
                <div className="notif-panel-item-head">
                  {!n.read && <span className={`notif-dot ${n.type === 'pickup' ? 'notif-dot--pickup' : 'notif-dot--delivery'}`} style={{ flexShrink: 0 }} />}
                  <span className="notif-panel-customer">{n.customer_name}</span>
                  <span className={`notif-badge ${n.type === 'pickup' ? 'notif-badge--pickup' : 'notif-badge--delivery'}`} style={{ marginLeft: 'auto', flexShrink: 0 }}>
                    {n.type === 'pickup' ? 'Pickup' : 'Delivery'}
                  </span>
                </div>
                <div className="notif-panel-meta">{n.address_short} · {n.materials}</div>
                <div className="notif-panel-date">{n.date_label}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function ShellInner({ children, session }: { children: React.ReactNode; session: Session }) {
  const isAdmin = session.role === 'admin';
  const isDriver = session.role === 'driver';
  const isDispatcherOrAdmin = session.role === 'dispatcher' || isAdmin;
  const router = useRouter();
  const name = session.name || session.role;
  const initials = name.split(' ').map((w: string) => w[0]).slice(0, 2).join('').toUpperCase();

  const { activeLocation } = useLocation();
  const { toasts, log, unreadCount, dismissToast, markAllRead } = useOrderNotifications(
    isDispatcherOrAdmin,
    activeLocation?.id ?? null,
  );

  const [panelOpen, setPanelOpen] = useState(false);

  return (
    <div className="app-shell">
      <style>{notifStyles}</style>
      <aside className="app-sidebar">
        <Link href={isDriver ? '/driver/loads' : '/ops-dashboard'} className="app-sidebar-brand">
          <div className="app-sidebar-brand-icon">
            <LogoMark />
          </div>
          <div className="app-sidebar-brand-text">
            <span className="app-sidebar-brand-name">Loadout</span>
            <span className="app-sidebar-brand-sub">Dispatch Platform</span>
          </div>
        </Link>

        <nav className="app-sidebar-nav">
          {!isDriver && (
            <>
              <SidebarLink href="/ops-dashboard" icon={Icons.dashboard}>Dashboard</SidebarLink>
              <SidebarLink href="/dispatch-schedule" icon={Icons.schedule}>Schedule</SidebarLink>
              <SidebarLink href="/new-drop" icon={Icons.quickdrop}>Quick Drop</SidebarLink>
              <SidebarLink href="/dispatch/new-order" icon={Icons.neworder}>New Order</SidebarLink>
              <SidebarLink href="/customer-search" icon={Icons.customers}>Customers</SidebarLink>
              <SidebarLink href="/all-orders" icon={Icons.allorders}>All Orders</SidebarLink>
              <SidebarLink href="/pickup" icon={Icons.pickup}>Pickup Queue</SidebarLink>
              <SidebarLink href="/dispatch/billing" icon={Icons.billing}>Billing</SidebarLink>
            </>
          )}
          {isDriver && (
            <SidebarLink href="/driver/loads" icon={Icons.loads}>My Loads</SidebarLink>
          )}
          {isAdmin && (
            <>
              <div className="app-sidebar-divider" />
              <div className="app-sidebar-section-label">Admin</div>
              <SidebarLink href="/admin/tenant" icon={Icons.settings}>Settings</SidebarLink>
              <SidebarLink href="/admin/locations" icon={Icons.locations}>Locations</SidebarLink>
              <SidebarLink href="/admin/catalog" icon={Icons.catalog}>Catalog</SidebarLink>
              <SidebarLink href="/admin/users" icon={Icons.users}>Users</SidebarLink>
              <SidebarLink href="/admin/delivery-availability" icon={Icons.schedule}>Availability</SidebarLink>
              <SidebarLink href="/admin/channels" icon={Icons.channels}>Channels</SidebarLink>
              <SidebarLink href="/admin/billing" icon={Icons.billing}>Billing</SidebarLink>
            </>
          )}
        </nav>

        <div className="app-sidebar-footer">
          {!isDriver && <LocationSwitcher />}

          {/* ── Notification Bell ── */}
          {isDispatcherOrAdmin && (
            <button
              className={`notif-bell-btn${unreadCount > 0 ? ' notif-bell-btn--active' : ''}`}
              onClick={() => setPanelOpen(o => !o)}
              title="New orders"
            >
              {Icons.bell}
              <span className="notif-bell-label">New Orders</span>
              {unreadCount > 0 && (
                <span className="notif-bell-badge">{unreadCount}</span>
              )}
            </button>
          )}

          <div className="app-sidebar-user">
            <div className="app-sidebar-user-avatar">{initials}</div>
            <div className="app-sidebar-user-name">{session.name || session.role}</div>
          </div>
          <div className="app-sidebar-footer-actions">
            <ThemeToggle />
            <button className="app-sidebar-signout" onClick={() => { clearSession(); router.push('/login'); }}>
              {Icons.signout}
              Sign out
            </button>
          </div>
        </div>
      </aside>

      <main className="app-content">
        {children}
      </main>

      {/* ── Toast Stack ── */}
      {toasts.length > 0 && (
        <div className="notif-toast-stack">
          {toasts.map(t => (
            <ToastCard key={t.id} notif={t} onDismiss={dismissToast} />
          ))}
        </div>
      )}

      {/* ── Notification Panel ── */}
      {panelOpen && (
        <NotifPanel
          log={log}
          unreadCount={unreadCount}
          onMarkAllRead={markAllRead}
          onClose={() => setPanelOpen(false)}
        />
      )}
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

const notifStyles = `
  /* ── Toast Stack ── */
  .notif-toast-stack {
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 9999;
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-width: 360px;
    width: calc(100vw - 48px);
  }
  .notif-toast {
    display: flex;
    background: var(--surface);
    border: 1px solid var(--border-light);
    border-radius: 12px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.12);
    overflow: hidden;
    position: relative;
    animation: notif-slide-in 0.2s ease-out;
  }
  @keyframes notif-slide-in {
    from { opacity: 0; transform: translateY(12px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .notif-toast-bar {
    width: 4px;
    flex-shrink: 0;
  }
  .notif-toast-bar--delivery { background: #1D9E75; }
  .notif-toast-bar--pickup   { background: #378ADD; }
  .notif-toast-body {
    flex: 1;
    padding: 12px 14px;
    min-width: 0;
  }
  .notif-toast-title {
    font-size: 13px;
    font-weight: 700;
    color: var(--gray-900);
    display: flex;
    align-items: center;
    gap: 7px;
    margin-bottom: 7px;
    flex-wrap: wrap;
  }
  .notif-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .notif-dot--delivery { background: #1D9E75; }
  .notif-dot--pickup   { background: #378ADD; }
  .notif-badge {
    font-size: 11px;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 999px;
  }
  .notif-badge--delivery { background: #E1F5EE; color: #0F6E56; }
  .notif-badge--pickup   { background: #E6F1FB; color: #185FA5; }
  .notif-toast-row {
    display: flex;
    gap: 6px;
    font-size: 12px;
    color: var(--gray-500);
    margin-bottom: 2px;
    min-width: 0;
  }
  .notif-toast-label { flex-shrink: 0; }
  .notif-toast-val {
    color: var(--gray-900);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .notif-toast-dismiss {
    position: absolute;
    top: 8px;
    right: 8px;
    background: none;
    border: none;
    color: var(--gray-400);
    cursor: pointer;
    font-size: 13px;
    padding: 2px 5px;
    line-height: 1;
    border-radius: 4px;
    font-family: inherit;
  }
  .notif-toast-dismiss:hover { background: var(--gray-100); color: var(--gray-700); }

  /* ── Bell Button ── */
  .notif-bell-btn {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    padding: 8px 12px;
    background: none;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    color: rgba(255,255,255,0.55);
    font-size: 13px;
    font-weight: 600;
    font-family: inherit;
    transition: background 0.15s, color 0.15s;
    position: relative;
    margin-bottom: 4px;
  }
  .notif-bell-btn:hover { background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.9); }
  .notif-bell-btn--active { color: rgba(255,255,255,0.9); }
  .notif-bell-label { flex: 1; text-align: left; }
  .notif-bell-badge {
    background: #e11d48;
    color: #fff;
    font-size: 10px;
    font-weight: 800;
    border-radius: 999px;
    padding: 1px 6px;
    min-width: 18px;
    text-align: center;
    flex-shrink: 0;
  }

  /* ── Log Panel ── */
  .notif-panel-backdrop {
    position: fixed;
    inset: 0;
    z-index: 999;
  }
  .notif-panel {
    position: fixed;
    bottom: 80px;
    left: 216px;
    width: 340px;
    max-height: 480px;
    background: var(--surface);
    border: 1px solid var(--border-light);
    border-radius: 14px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.14);
    z-index: 1000;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    animation: notif-slide-in 0.15s ease-out;
  }
  .notif-panel-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 14px 16px 12px;
    border-bottom: 1px solid var(--border-light);
    flex-shrink: 0;
  }
  .notif-panel-title {
    font-size: 14px;
    font-weight: 700;
    color: var(--gray-900);
    flex: 1;
  }
  .notif-panel-clear {
    font-size: 12px;
    font-weight: 600;
    color: var(--green-700);
    background: none;
    border: none;
    cursor: pointer;
    font-family: inherit;
    padding: 2px 4px;
  }
  .notif-panel-clear:hover { text-decoration: underline; }
  .notif-panel-close {
    background: none;
    border: none;
    color: var(--gray-400);
    cursor: pointer;
    font-size: 13px;
    padding: 2px 5px;
    font-family: inherit;
    border-radius: 4px;
  }
  .notif-panel-close:hover { background: var(--gray-100); color: var(--gray-700); }
  .notif-panel-empty {
    padding: 32px 16px;
    text-align: center;
    font-size: 13px;
    color: var(--gray-400);
  }
  .notif-panel-list {
    overflow-y: auto;
    flex: 1;
  }
  .notif-panel-item {
    padding: 12px 16px;
    border-bottom: 1px solid var(--border-light);
    transition: background 0.1s;
  }
  .notif-panel-item:last-child { border-bottom: none; }
  .notif-panel-item--read { opacity: 0.55; }
  .notif-panel-item-head {
    display: flex;
    align-items: center;
    gap: 7px;
    margin-bottom: 4px;
  }
  .notif-panel-customer {
    font-size: 13px;
    font-weight: 700;
    color: var(--gray-900);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .notif-panel-meta {
    font-size: 12px;
    color: var(--gray-500);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .notif-panel-date {
    font-size: 11px;
    color: var(--gray-400);
    margin-top: 2px;
  }

  @media (max-width: 768px) {
    .notif-toast-stack {
      bottom: 16px;
      right: 16px;
      left: 16px;
      width: auto;
      max-width: none;
    }
    .notif-panel {
      left: 16px;
      right: 16px;
      width: auto;
      bottom: 70px;
    }
  }
`;
