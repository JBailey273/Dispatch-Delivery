'use client';

import Link from 'next/link';
import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { ApiError, api, requireRole } from '../lib/auth';
import { useLocation } from '../lib/location-context';

/* ── Helpers ── */
const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function toKey(d: Date) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function fmtDate(d: Date) { return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}`; }
function fmtShortDate(dateStr: string): string {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T12:00:00');
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}
function fmtTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}
function capColor(u: number, t: number) {
  if (t === 0) return 'green';
  const p = u / t;
  return p >= 1 ? 'red' : p >= 0.75 ? 'amber' : 'green';
}

/* ── Types ── */
type LoadItem = { id: string; drop_id: string; status: string; material: string; qty: number; unit: string; customer_name?: string; address_short?: string; driver_name?: string; driver_user_id?: string | null; order_ref?: string; is_priority?: boolean };
type ScheduleData = {
  date: string;
  priority: { groups: Record<string, LoadItem[]>; load_count: number; warning?: string | null };
  windows: {
    A: { capacity: { used: number; total: number; remaining_capacity: number }; groups: Record<string, LoadItem[]>; disabled: boolean };
    B: { capacity: { used: number; total: number; remaining_capacity: number }; groups: Record<string, LoadItem[]>; disabled: boolean };
  };
};
type ThroughputDay = { date: string; drops_created: number; loads_created: number; loads_delivered: number; loads_exceptioned: number; loads_cancelled: number };
type NeedsAttentionItem = { drop_id: string; ref: string; customer_name: string; scheduled_date: string | null; scheduled_window: string | null; is_priority: boolean };
type UnscheduledItem = { drop_id: string; customer_name: string; address_short: string; source: string; created_at: string };
type PickupItem = { drop_id: string; order_number: number | null; external_order_id: string | null; customer_name: string; customer_phone: string | null; items: string[]; created_at: string; pickup_ready_sent_at: string | null };
type ExceptionItem = { timestamp: string; load_id: string; drop_id: string | null; customer_name: string | null; reason_code: string | null; notes: string | null };

const EXCEPTION_LABELS: Record<string, string> = {
  CUSTOMER_UNAVAILABLE: 'Not Home', ACCESS_BLOCKED: 'Access Blocked', SAFETY_RISK: 'Safety Risk',
  DAMAGED_GOODS: 'Damaged Material', OUT_OF_STOCK: 'Out of Stock', WRONG_ADDRESS: 'Wrong Address',
  CUSTOMER_REFUSED: 'Customer Refused', OTHER: 'Other',
};
const STATUS_COLORS: Record<string, string> = {
  NEW: 'var(--gray-500)', ASSIGNED: 'var(--blue-600)', LOADED_LEAVING: 'var(--amber-600)',
  DELIVERED: 'var(--green-600)', EXCEPTION: 'var(--red-600)', CANCELLED: 'var(--gray-400)',
  assigned: 'var(--blue-600)', loaded_leaving: 'var(--amber-600)',
  delivered: 'var(--green-600)', exception: 'var(--red-600)',
};
const STATUS_LABELS: Record<string, string> = {
  NEW: 'Pending', ASSIGNED: 'Assigned', LOADED_LEAVING: 'Out for Delivery',
  DELIVERED: 'Delivered', EXCEPTION: 'Exception', CANCELLED: 'Cancelled',
  assigned: 'Assigned', loaded_leaving: 'Out for Delivery',
  delivered: 'Delivered', exception: 'Exception',
};

export default function DashboardPage() {
  const today = useMemo(() => new Date(), []);
  const todayStr = toKey(today);

  const [schedule, setSchedule] = useState<ScheduleData | null>(null);
  const [throughput, setThroughput] = useState<ThroughputDay[]>([]);
  const [needsAttention, setNeedsAttention] = useState<NeedsAttentionItem[]>([]);
  const [unscheduled, setUnscheduled] = useState<UnscheduledItem[]>([]);
  const [pickups, setPickups] = useState<PickupItem[]>([]);
  const [exceptions, setExceptions] = useState<ExceptionItem[]>([]);
  const [capA, setCapA] = useState<{ used: number; total: number } | null>(null);
  const [capB, setCapB] = useState<{ used: number; total: number } | null>(null);
  const [loading, setLoading] = useState(true);

  const { activeLocation } = useLocation();
  const fetchAbortRef = useRef<number>(0);

  // Clear stale data on location switch
  useEffect(() => {
    if (!activeLocation) return;
    setLoading(true);
    setSchedule(null);
    setThroughput([]);
    setNeedsAttention([]);
    setUnscheduled([]);
    setPickups([]);
    setExceptions([]);
    setCapA(null);
    setCapB(null);
  }, [activeLocation?.id]);

  const fetchAll = useCallback(async () => {
    const token = ++fetchAbortRef.current;
    const loc = activeLocation?.id ? `&location_id=${activeLocation.id}` : '';
    const locQ = activeLocation?.id ? `?location_id=${activeLocation.id}` : '';
    setLoading(true);

    const rangeStart = new Date(today);
    rangeStart.setDate(rangeStart.getDate() - 3);
    const rangeEnd = new Date(today);
    rangeEnd.setDate(rangeEnd.getDate() + 7);

    const results = await Promise.allSettled([
      api(`/dispatch/schedule?day=${todayStr}${loc}`),
      api(`/ops/reports/throughput?start_date=${toKey(rangeStart)}&end_date=${toKey(rangeEnd)}${loc}`),
      api(`/dispatch/needs-attention${locQ}`),
      api(`/dispatch/unscheduled${locQ}`),
      api(`/pickup/queue${locQ}`),
      api(`/ops/reports/exceptions?start_date=${toKey(rangeStart)}&end_date=${toKey(rangeEnd)}${loc}`),
      api(`/availability?start_date=${todayStr}&days=1${loc}`),
    ]);

    if (token !== fetchAbortRef.current) return;

    if (results[0].status === 'fulfilled') setSchedule(results[0].value);
    if (results[1].status === 'fulfilled') setThroughput(results[1].value.per_day || []);
    if (results[2].status === 'fulfilled') setNeedsAttention(results[2].value.drops || []);
    if (results[3].status === 'fulfilled') setUnscheduled(results[3].value.drops || []);
    if (results[4].status === 'fulfilled') setPickups(results[4].value.drops || []);
    if (results[5].status === 'fulfilled') setExceptions(results[5].value.recent_exceptions || []);
    if (results[6].status === 'fulfilled') {
      const wins = results[6].value.windows || [];
      const a = wins.find((w: any) => w.date === todayStr && w.window === 'A');
      const b = wins.find((w: any) => w.date === todayStr && w.window === 'B');
      if (a) setCapA({ used: a.used, total: a.total });
      if (b) setCapB({ used: b.used, total: b.total });
    }
    setLoading(false);
  }, [today, todayStr, activeLocation?.id]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  /* ── Derived ── */
  const allDeliveries = useMemo(() => {
    if (!schedule) return [];
    const items: (LoadItem & { window: string })[] = [];
    for (const [, loads] of Object.entries(schedule.priority?.groups || {}))
      for (const load of loads) items.push({ ...load, window: 'P' });
    for (const win of ['A', 'B'] as const)
      for (const [, loads] of Object.entries(schedule.windows[win].groups))
        for (const load of loads) items.push({ ...load, window: win });
    const windowOrder: Record<string, number> = { P: 0, A: 1, B: 2 };
    const statusOrder: Record<string, number> = { EXCEPTION: 0, NEW: 1, ASSIGNED: 2, LOADED_LEAVING: 3, DELIVERED: 4, CANCELLED: 5 };
    items.sort((a, b) => {
      if (a.window !== b.window) return (windowOrder[a.window] ?? 3) - (windowOrder[b.window] ?? 3);
      return (statusOrder[a.status.toUpperCase()] ?? 3) - (statusOrder[b.status.toUpperCase()] ?? 3);
    });
    return items;
  }, [schedule]);

  const todayTP = throughput.find(d => d.date === todayStr);
  const totalLoadsToday = allDeliveries.length;
  const deliveredCount = todayTP?.loads_delivered ?? 0;
  const exceptionCount = todayTP?.loads_exceptioned ?? 0;
  const pendingCount = Math.max(0, totalLoadsToday - deliveredCount - exceptionCount - (todayTP?.loads_cancelled ?? 0));
  const unassignedToday = allDeliveries.filter(d => !d.driver_user_id);
  const weekDelivered = throughput.reduce((s, d) => s + d.loads_delivered, 0);
  const weekExceptions = throughput.reduce((s, d) => s + d.loads_exceptioned, 0);
  const weekDrops = throughput.reduce((s, d) => s + d.drops_created, 0);

  // Total action items count for the header badge
  const actionCount = needsAttention.length + unassignedToday.length + unscheduled.length + pickups.length;

  if (!requireRole(['dispatcher'])) return <div className="page"><p>Unauthorized</p></div>;

  return (
    <>
      <style>{dashStyles}</style>
      <div className="page dash-page">

        {/* ── Header ── */}
        <div className="dash-top">
          <div>
            <h1>Dashboard</h1>
            <p className="dash-date">{fmtDate(today)}</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-secondary btn-sm" onClick={fetchAll}>↻ Refresh</button>
            <Link href="/dispatch/new-order" className="btn btn-primary btn-sm" style={{ textDecoration: 'none' }}>+ New Order</Link>
          </div>
        </div>

        {loading && (
          <div style={{ textAlign: 'center', padding: 60 }}>
            <div className="spinner spinner-lg" style={{ margin: '0 auto' }} />
          </div>
        )}

        {!loading && (
          <>
            {/* ════════════════════════════════
                SECTION 1 — NEEDS ACTION
                ════════════════════════════════ */}
            <div className="dash-section-head">
              <span className="dash-section-title">Needs Action</span>
              {actionCount > 0
                ? <span className="dash-action-badge">{actionCount}</span>
                : <span className="dash-all-clear">✓ All Clear</span>}
            </div>

            {actionCount === 0 && (
              <div className="card dash-clear-card">
                <div className="dash-clear-inner">
                  <span className="dash-clear-icon">🌿</span>
                  <div>
                    <div className="dash-clear-title">Nothing needs attention right now</div>
                    <div className="dash-clear-sub">All orders are assigned, scheduled, and on track.</div>
                  </div>
                </div>
              </div>
            )}

            {/* Exceptions / Needs Reschedule */}
            {needsAttention.length > 0 && (
              <div className="card dash-action-card">
                <div className="dash-action-head dash-action-head--red">
                  <span className="dash-action-icon">🚨</span>
                  <span className="dash-action-label">Exceptions — Need Rescheduling</span>
                  <span className="dash-action-count">{needsAttention.length}</span>
                </div>
                {needsAttention.map((item, i) => (
                  <Link
                    key={item.drop_id}
                    href={`/dispatch/drops/${item.drop_id}`}
                    className={`dash-action-row ${i < needsAttention.length - 1 ? 'dash-action-row--border' : ''}`}
                  >
                    <div className="dash-action-row-main">
                      <div className="dash-action-row-name">{item.customer_name}</div>
                      <div className="dash-action-row-meta">
                        {item.scheduled_date ? fmtShortDate(item.scheduled_date) : 'Unscheduled'}
                        {item.scheduled_window === 'A' ? ' · Morning' : item.scheduled_window === 'B' ? ' · Afternoon' : ''}
                        {item.is_priority ? ' · ⚡ Priority' : ''}
                      </div>
                    </div>
                    <span className="dash-action-row-cta">View Exception →</span>
                  </Link>
                ))}
              </div>
            )}

            {/* Today unassigned */}
            {unassignedToday.length > 0 && (
              <div className="card dash-action-card">
                <div className="dash-action-head dash-action-head--amber">
                  <span className="dash-action-icon">🚚</span>
                  <span className="dash-action-label">Today's Deliveries — No Driver Assigned</span>
                  <span className="dash-action-count">{unassignedToday.length}</span>
                </div>
                {unassignedToday.map((load, i) => (
                  <Link
                    key={load.id}
                    href={`/dispatch/drops/${load.drop_id}`}
                    className={`dash-action-row ${i < unassignedToday.length - 1 ? 'dash-action-row--border' : ''}`}
                  >
                    <div className="dash-action-row-main">
                      <div className="dash-action-row-name">{load.customer_name || 'Unknown'}</div>
                      <div className="dash-action-row-meta">
                        {load.address_short || '—'} · {load.window === 'P' ? '⚡ Priority' : load.window === 'A' ? 'Morning' : 'Afternoon'}
                      </div>
                    </div>
                    <span className="dash-action-row-cta">Assign Driver →</span>
                  </Link>
                ))}
              </div>
            )}

            {/* Unscheduled delivery orders */}
            {unscheduled.length > 0 && (
              <div className="card dash-action-card">
                <div className="dash-action-head dash-action-head--blue">
                  <span className="dash-action-icon">📦</span>
                  <span className="dash-action-label">Delivery Orders — Awaiting Schedule</span>
                  <span className="dash-action-count">{unscheduled.length}</span>
                </div>
                {unscheduled.map((item, i) => (
                  <Link
                    key={item.drop_id}
                    href={`/dispatch-schedule?drop=${item.drop_id}`}
                    className={`dash-action-row ${i < unscheduled.length - 1 ? 'dash-action-row--border' : ''}`}
                  >
                    <div className="dash-action-row-main">
                      <div className="dash-action-row-name">{item.customer_name}</div>
                      <div className="dash-action-row-meta">
                        {item.address_short} · {item.source === 'woocommerce' ? 'Online Order' : 'Manual'} · Received {fmtTime(item.created_at)}
                      </div>
                    </div>
                    <span className="dash-action-row-cta">Schedule →</span>
                  </Link>
                ))}
              </div>
            )}

            {/* Pickup queue */}
            {pickups.length > 0 && (
              <div className="card dash-action-card">
                <div className="dash-action-head dash-action-head--green">
                  <span className="dash-action-icon">🛻</span>
                  <span className="dash-action-label">Pickup Orders — Awaiting Fulfillment</span>
                  <span className="dash-action-count">{pickups.length}</span>
                </div>
                {pickups.map((item, i) => {
                  const label = item.external_order_id ? `WC-${item.external_order_id}` : item.order_number ? `#${item.order_number}` : `#${item.drop_id.slice(0, 8).toUpperCase()}`;
                  return (
                    <Link
                      key={item.drop_id}
                      href="/pickup"
                      className={`dash-action-row ${i < pickups.length - 1 ? 'dash-action-row--border' : ''}`}
                    >
                      <div className="dash-action-row-main">
                        <div className="dash-action-row-name">
                          {item.customer_name}
                          <span className="dash-action-row-ref">{label}</span>
                        </div>
                        <div className="dash-action-row-meta">
                          {item.items.slice(0, 2).join(', ')}{item.items.length > 2 ? ` +${item.items.length - 2} more` : ''}
                          {item.pickup_ready_sent_at
                            ? <span className="dash-notified-badge">✓ Notified</span>
                            : <span className="dash-not-notified-badge">Not notified</span>}
                        </div>
                      </div>
                      <span className="dash-action-row-cta">View Queue →</span>
                    </Link>
                  );
                })}
              </div>
            )}

            {/* ════════════════════════════════
                SECTION 2 — TODAY
                ════════════════════════════════ */}
            <div className="dash-section-head" style={{ marginTop: 8 }}>
              <span className="dash-section-title">Today</span>
              <span className="dash-section-sub">{fmtShortDate(todayStr)}</span>
            </div>

            {/* Stat row + Capacity side by side */}
            <div className="dash-today-grid">
              {/* Stats */}
              <div className="card dash-stats-card">
                <div className="dash-stat-row">
                  <div className="dash-stat">
                    <div className="dash-stat-val">{totalLoadsToday}</div>
                    <div className="dash-stat-label">Deliveries</div>
                  </div>
                  <div className="dash-stat-divider" />
                  <div className="dash-stat">
                    <div className="dash-stat-val" style={{ color: 'var(--green-600)' }}>{deliveredCount}</div>
                    <div className="dash-stat-label">Delivered</div>
                  </div>
                  <div className="dash-stat-divider" />
                  <div className="dash-stat">
                    <div className="dash-stat-val" style={{ color: 'var(--amber-600)' }}>{pendingCount}</div>
                    <div className="dash-stat-label">Pending</div>
                  </div>
                  <div className="dash-stat-divider" />
                  <div className="dash-stat">
                    <div className="dash-stat-val" style={{ color: exceptionCount > 0 ? 'var(--red-600)' : 'var(--gray-300)' }}>{exceptionCount}</div>
                    <div className="dash-stat-label">Exceptions</div>
                  </div>
                </div>
                {/* Progress bar */}
                {totalLoadsToday > 0 && (
                  <div className="dash-progress-wrap">
                    <div className="dash-progress-bar">
                      <div
                        className="dash-progress-fill"
                        style={{ width: `${Math.round(deliveredCount / totalLoadsToday * 100)}%` }}
                      />
                    </div>
                    <span className="dash-progress-label">
                      {Math.round(deliveredCount / totalLoadsToday * 100)}% complete
                    </span>
                  </div>
                )}
              </div>

              {/* Capacity */}
              <div className="card">
                <div className="dash-card-head">Capacity</div>
                <div className="dash-card-body">
                  {(['A', 'B'] as const).map(w => {
                    const cap = w === 'A' ? capA : capB;
                    const winData = schedule?.windows[w];
                    const disabled = winData?.disabled;
                    const used = cap?.used ?? 0;
                    const total = cap?.total ?? 0;
                    const pct = total > 0 ? Math.round(used / total * 100) : 0;
                    const color = capColor(used, total);
                    return (
                      <div key={w} className="dash-cap-row">
                        <div className="dash-cap-label">
                          <span>{w === 'A' ? 'Morning' : 'Afternoon'}</span>
                          {disabled && <span className="pill pill-red" style={{ fontSize: 10, marginLeft: 6 }}>Blacked Out</span>}
                          <span className="dash-cap-num" style={{ marginLeft: 'auto' }}>{used}/{total}</span>
                        </div>
                        <div className="dash-cap-bar">
                          <div className={`dash-cap-fill cap-fill ${color}`} style={{ width: `${pct}%` }} />
                        </div>
                        <div className="dash-cap-remaining" style={{ color: `var(--${color === 'green' ? 'green-600' : color === 'amber' ? 'amber-600' : 'red-600'})` }}>
                          {total - used} slot{total - used !== 1 ? 's' : ''} remaining
                        </div>
                      </div>
                    );
                  })}
                  <Link href="/dispatch-schedule" className="btn btn-secondary btn-sm" style={{ textDecoration: 'none', marginTop: 12, display: 'inline-flex' }}>
                    Open Schedule →
                  </Link>
                </div>
              </div>
            </div>

            {/* Today's delivery list */}
            {allDeliveries.length > 0 && (
              <div className="card" style={{ marginBottom: 16 }}>
                <div className="dash-card-head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span>Today's Deliveries</span>
                  <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--gray-400)' }}>{allDeliveries.length} load{allDeliveries.length !== 1 ? 's' : ''}</span>
                </div>
                <div style={{ padding: 0 }}>
                  {allDeliveries.map(load => (
                    <Link key={load.id} href={`/dispatch/drops/${load.drop_id}`} className="dash-delivery-row">
                      <div className="dash-delivery-main">
                        <div className="dash-delivery-customer">{load.customer_name || 'Unknown'}</div>
                        <div className="dash-delivery-address">{load.address_short || '—'}</div>
                      </div>
                      <div className="dash-delivery-meta">
                        <span className="dash-delivery-window">
                          {load.window === 'P' ? '⚡ Priority' : load.window === 'A' ? 'Morning' : 'Afternoon'}
                        </span>
                        <span className="dash-delivery-status" style={{ color: STATUS_COLORS[load.status] || 'var(--gray-500)' }}>
                          {load.status === 'assigned' && !load.driver_user_id ? 'Pending' : STATUS_LABELS[load.status] || load.status}
                        </span>
                      </div>
                      <div className="dash-delivery-driver">
                        {load.driver_name
                          ? load.driver_name
                          : <span style={{ color: 'var(--amber-500)', fontWeight: 600 }}>Unassigned</span>}
                      </div>
                      <span className="dash-delivery-arrow">›</span>
                    </Link>
                  ))}
                </div>
              </div>
            )}

            {/* ════════════════════════════════
                SECTION 3 — THIS WEEK
                ════════════════════════════════ */}
            <div className="dash-section-head" style={{ marginTop: 8 }}>
              <span className="dash-section-title">This Week</span>
            </div>

            <div className="dash-grid-2">
              {/* Sparkbar chart */}
              <div className="card">
                <div className="dash-card-head">Delivery Volume</div>
                <div className="dash-card-body">
                  <div className="dash-week-stats">
                    <div className="dash-week-stat">
                      <span className="dash-ws-val">{weekDrops}</span>
                      <span className="dash-ws-label">Orders</span>
                    </div>
                    <div className="dash-week-stat">
                      <span className="dash-ws-val" style={{ color: 'var(--green-600)' }}>{weekDelivered}</span>
                      <span className="dash-ws-label">Delivered</span>
                    </div>
                    <div className="dash-week-stat">
                      <span className="dash-ws-val" style={{ color: weekExceptions > 0 ? 'var(--red-600)' : 'var(--gray-400)' }}>{weekExceptions}</span>
                      <span className="dash-ws-label">Exceptions</span>
                    </div>
                  </div>
                  <div className="dash-sparkbar-row">
                    {throughput.map(d => {
                      const max = Math.max(...throughput.map(t => t.loads_created), 1);
                      const h = Math.max(4, Math.round(d.loads_created / max * 60));
                      const isToday = d.date === todayStr;
                      const dayName = DAYS[new Date(d.date + 'T12:00:00').getDay()].slice(0, 3);
                      return (
                        <div key={d.date} className="dash-spark-col">
                          <div className="dash-spark-bars" style={{ height: 64 }}>
                            <div className={`dash-spark-bar${isToday ? ' today' : ''}`} style={{ height: h }} title={`${d.loads_created} loads`} />
                            {d.loads_exceptioned > 0 && (
                              <div className="dash-spark-bar exception" style={{ height: Math.max(3, Math.round(d.loads_exceptioned / max * 60)) }} title={`${d.loads_exceptioned} exceptions`} />
                            )}
                          </div>
                          <div className={`dash-spark-label${isToday ? ' today' : ''}`}>{dayName}</div>
                          <div className="dash-spark-count">{d.loads_created}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Recent exceptions */}
              <div className="card">
                <div className="dash-card-head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span>Recent Exceptions</span>
                  {exceptions.length === 0 && <span style={{ fontSize: 13, color: 'var(--green-600)', fontWeight: 600 }}>✓ None</span>}
                </div>
                {exceptions.length === 0 ? (
                  <div className="dash-card-body" style={{ color: 'var(--gray-400)', fontSize: 14 }}>
                    No exceptions in the past 10 days.
                  </div>
                ) : (
                  <div style={{ padding: 0 }}>
                    {exceptions.slice(0, 6).map((e, i) => {
                      const label = EXCEPTION_LABELS[e.reason_code || ''] || 'Exception';
                      const inner = (
                        <div className={`dash-exc-row ${i < Math.min(exceptions.length, 6) - 1 ? 'dash-exc-row--border' : ''}`}>
                          <div className="dash-exc-dot" />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div className="dash-exc-name">{e.customer_name || 'Unknown'}</div>
                            <div className="dash-exc-reason">{label}</div>
                            {e.notes && <div className="dash-exc-notes">{e.notes}</div>}
                          </div>
                          <div className="dash-exc-time">{fmtTime(e.timestamp)}</div>
                          {e.drop_id && <span style={{ fontSize: 13, color: 'var(--gray-300)' }}>›</span>}
                        </div>
                      );
                      return e.drop_id ? (
                        <Link key={i} href={`/dispatch/drops/${e.drop_id}`} style={{ display: 'block', textDecoration: 'none', color: 'inherit' }} className="dash-exc-link">
                          {inner}
                        </Link>
                      ) : <div key={i}>{inner}</div>;
                    })}
                  </div>
                )}
              </div>
            </div>

          </>
        )}
      </div>
    </>
  );
}

const dashStyles = `
  .dash-page { max-width: 960px; }
  .dash-top { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 24px; flex-wrap: wrap; gap: 12px; }
  .dash-top h1 { font-size: 28px; font-weight: 800; letter-spacing: -0.02em; margin: 0; }
  .dash-date { color: var(--gray-500); font-size: 15px; margin-top: 2px; }

  /* Section headers */
  .dash-section-head {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 12px;
    padding-bottom: 8px;
    border-bottom: 2px solid var(--border-light);
  }
  .dash-section-title {
    font-family: var(--font-heading);
    font-size: 13px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--gray-500);
  }
  .dash-section-sub { font-size: 13px; color: var(--gray-400); font-weight: 500; }
  .dash-action-badge {
    background: var(--red-500);
    color: #fff;
    font-size: 11px;
    font-weight: 800;
    border-radius: 10px;
    padding: 1px 8px;
    min-width: 22px;
    text-align: center;
  }
  .dash-all-clear {
    font-size: 13px;
    font-weight: 700;
    color: var(--green-600);
  }

  /* All clear card */
  .dash-clear-card { margin-bottom: 16px; }
  .dash-clear-inner {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 20px 24px;
  }
  .dash-clear-icon { font-size: 28px; flex-shrink: 0; }
  .dash-clear-title { font-size: 15px; font-weight: 700; color: var(--gray-700); }
  .dash-clear-sub { font-size: 13px; color: var(--gray-400); margin-top: 2px; }

  /* Action cards */
  .dash-action-card { margin-bottom: 12px; overflow: hidden; }
  .dash-action-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 11px 16px;
    border-bottom: 1px solid var(--border-light);
  }
  .dash-action-head--red { background: rgba(220,38,38,0.08); border-bottom: 1px solid rgba(220,38,38,0.12); }
  .dash-action-head--red .dash-action-label { color: var(--red-600); }
  .dash-action-head--amber { background: rgba(217,119,6,0.08); border-bottom: 1px solid rgba(217,119,6,0.12); }
  .dash-action-head--amber .dash-action-label { color: var(--amber-700); }
  .dash-action-head--blue { background: rgba(37,99,235,0.08); border-bottom: 1px solid rgba(37,99,235,0.10); }
  .dash-action-head--blue .dash-action-label { color: var(--blue-600); }
  .dash-action-head--green { background: rgba(74,112,82,0.08); border-bottom: 1px solid rgba(74,112,82,0.10); }
  .dash-action-head--green .dash-action-label { color: var(--brand); }
  .dash-action-icon { font-size: 15px; flex-shrink: 0; }
  .dash-action-label {
    flex: 1;
    font-family: var(--font-heading);
    font-size: 13px;
    font-weight: 700;
    color: var(--gray-800);
  }
  .dash-action-count {
    font-size: 11px;
    font-weight: 800;
    background: var(--gray-200);
    color: var(--gray-600);
    border-radius: 10px;
    padding: 1px 8px;
  }

  .dash-action-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    text-decoration: none;
    color: inherit;
    transition: background 0.12s;
    cursor: pointer;
  }
  .dash-action-row:hover { background: var(--gray-50); }
  .dash-action-row--border { border-bottom: 1px solid var(--border-light); }
  .dash-action-row-main { flex: 1; min-width: 0; }
  .dash-action-row-name {
    font-size: 14px;
    font-weight: 700;
    color: var(--gray-900);
    display: flex;
    align-items: center;
    gap: 8px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dash-action-row-ref {
    font-size: 11px;
    font-weight: 700;
    color: var(--gray-400);
    background: var(--gray-100);
    border-radius: 4px;
    padding: 1px 6px;
    flex-shrink: 0;
  }
  .dash-action-row-meta {
    font-size: 12px;
    color: var(--gray-500);
    margin-top: 2px;
    display: flex;
    align-items: center;
    gap: 8px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dash-action-row-cta {
    font-size: 12px;
    font-weight: 700;
    color: var(--green-700);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .dash-notified-badge {
    font-size: 11px;
    font-weight: 700;
    color: var(--green-700);
    background: var(--green-50);
    border-radius: 4px;
    padding: 1px 6px;
    flex-shrink: 0;
  }
  .dash-not-notified-badge {
    font-size: 11px;
    font-weight: 700;
    color: var(--amber-700);
    background: #fffbeb;
    border-radius: 4px;
    padding: 1px 6px;
    flex-shrink: 0;
  }

  /* Today grid */
  .dash-today-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
  @media (max-width: 700px) { .dash-today-grid { grid-template-columns: 1fr; } }

  /* Stats card */
  .dash-stats-card { display: flex; flex-direction: column; justify-content: center; }
  .dash-stat-row {
    display: flex;
    align-items: stretch;
    padding: 20px 0;
  }
  .dash-stat {
    flex: 1;
    text-align: center;
    padding: 0 12px;
  }
  .dash-stat-val {
    font-family: var(--font-heading);
    font-size: 36px;
    font-weight: 800;
    color: var(--gray-900);
    line-height: 1;
    letter-spacing: -0.02em;
  }
  .dash-stat-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--gray-400);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-top: 6px;
  }
  .dash-stat-divider {
    width: 1px;
    background: var(--border-light);
    flex-shrink: 0;
    margin: 8px 0;
  }
  .dash-progress-wrap {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 20px 20px;
  }
  .dash-progress-bar {
    flex: 1;
    height: 6px;
    background: var(--gray-100);
    border-radius: 3px;
    overflow: hidden;
  }
  .dash-progress-fill {
    height: 100%;
    background: var(--green-500);
    border-radius: 3px;
    transition: width 0.4s var(--ease-out);
  }
  .dash-progress-label { font-size: 12px; font-weight: 600; color: var(--gray-500); white-space: nowrap; }

  /* Card internals */
  .card { background: var(--surface); border: 1px solid var(--border-light); border-radius: var(--radius-lg); box-shadow: var(--shadow-xs); overflow: hidden; margin-bottom: 16px; }
  .dash-card-head { padding: 14px 20px; font-size: 15px; font-weight: 700; color: var(--gray-800); border-bottom: 1px solid var(--border-light); }
  .dash-card-body { padding: 16px 20px; }

  /* Capacity */
  .dash-cap-row { margin-bottom: 14px; }
  .dash-cap-row:last-of-type { margin-bottom: 0; }
  .dash-cap-label { display: flex; align-items: center; margin-bottom: 6px; font-size: 14px; color: var(--gray-700); font-weight: 600; }
  .dash-cap-num { font-weight: 700; font-size: 13px; color: var(--gray-500); }
  .dash-cap-bar { height: 8px; border-radius: 4px; background: var(--gray-100); overflow: hidden; }
  .dash-cap-fill { height: 100%; border-radius: 4px; transition: width 0.3s; }
  .cap-fill.green { background: var(--green-500); }
  .cap-fill.amber { background: var(--amber-400); }
  .cap-fill.red { background: var(--red-500); }
  .dash-cap-remaining { font-size: 12px; font-weight: 600; margin-top: 4px; }

  /* Today deliveries */
  .dash-delivery-row {
    display: grid;
    grid-template-columns: 1fr auto auto 20px;
    align-items: center;
    gap: 12px;
    padding: 11px 20px;
    border-bottom: 1px solid var(--border-light);
    text-decoration: none;
    color: inherit;
    transition: background 0.12s;
    cursor: pointer;
  }
  .dash-delivery-row:last-child { border-bottom: none; }
  .dash-delivery-row:hover { background: var(--gray-50); }
  .dash-delivery-customer { font-size: 14px; font-weight: 600; color: var(--gray-900); }
  .dash-delivery-address { font-size: 12px; color: var(--gray-500); margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 300px; }
  .dash-delivery-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
  .dash-delivery-window { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--gray-500); }
  .dash-delivery-status { font-size: 12px; font-weight: 600; }
  .dash-delivery-driver { font-size: 13px; color: var(--gray-600); text-align: right; white-space: nowrap; }
  .dash-delivery-arrow { color: var(--gray-300); font-size: 18px; }

  /* Week */
  .dash-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
  @media (max-width: 700px) { .dash-grid-2 { grid-template-columns: 1fr; } }
  .dash-week-stats { display: flex; gap: 24px; margin-bottom: 16px; }
  .dash-week-stat { display: flex; flex-direction: column; align-items: center; }
  .dash-ws-val { font-size: 24px; font-weight: 800; letter-spacing: -0.01em; }
  .dash-ws-label { font-size: 12px; font-weight: 600; color: var(--gray-400); text-transform: uppercase; letter-spacing: 0.04em; }
  .dash-sparkbar-row { display: flex; gap: 6px; align-items: flex-end; justify-content: space-between; }
  .dash-spark-col { display: flex; flex-direction: column; align-items: center; flex: 1; }
  .dash-spark-bars { display: flex; flex-direction: column; justify-content: flex-end; align-items: center; gap: 2px; }
  .dash-spark-bar { width: 100%; max-width: 40px; border-radius: 4px 4px 0 0; background: var(--green-400); transition: height 0.3s; min-width: 16px; }
  .dash-spark-bar.today { background: var(--green-600); }
  .dash-spark-bar.exception { background: var(--red-400); border-radius: 0; }
  .dash-spark-label { font-size: 11px; font-weight: 700; color: var(--gray-400); margin-top: 4px; text-transform: uppercase; }
  .dash-spark-label.today { color: var(--green-700); }
  .dash-spark-count { font-size: 11px; font-weight: 600; color: var(--gray-500); }

  /* Exceptions */
  .dash-exc-link:hover { background: var(--gray-50); }
  .dash-exc-row { display: flex; align-items: flex-start; gap: 10px; padding: 12px 20px; }
  .dash-exc-row--border { border-bottom: 1px solid var(--border-light); }
  .dash-exc-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--red-500); margin-top: 5px; flex-shrink: 0; }
  .dash-exc-name { font-size: 14px; font-weight: 700; color: var(--gray-900); }
  .dash-exc-reason { font-size: 13px; color: var(--red-600); font-weight: 600; margin-top: 1px; }
  .dash-exc-notes { font-size: 12px; color: var(--gray-500); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 240px; }
  .dash-exc-time { font-size: 12px; color: var(--gray-400); white-space: nowrap; flex-shrink: 0; margin-left: auto; }

  .pill-red { background: var(--red-50); color: var(--red-700); }

  @media (max-width: 600px) {
    .dash-stat-val { font-size: 28px; }
    .dash-delivery-driver { display: none; }
    .dash-delivery-row { grid-template-columns: 1fr auto 20px; }
  }
`;
