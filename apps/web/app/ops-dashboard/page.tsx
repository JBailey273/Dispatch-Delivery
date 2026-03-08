'use client';

import Link from 'next/link';
import { useEffect, useState, useMemo, useCallback } from 'react';
import { ApiError, api, requireRole } from '../lib/auth';
import { useLocation } from '../lib/location-context';

/* ── Helpers ── */
const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function toKey(d: Date) { return d.toISOString().slice(0, 10); }
function fmtDate(d: Date) { return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}`; }
function capColor(u: number, t: number) { if (t === 0) return 'green'; const p = u / t; return p >= 1 ? 'red' : p >= 0.75 ? 'amber' : 'green'; }

type LoadItem = { id: string; drop_id: string; status: string; material: string; qty: number; unit: string; customer_name?: string; address_short?: string; driver_name?: string; driver_user_id?: string | null; order_ref?: string; is_priority?: boolean };
type ScheduleData = {
  date: string;
  priority: {
    groups: Record<string, LoadItem[]>;
    load_count: number;
    warning?: string | null;
  };
  windows: {
    A: { capacity: { used: number; total: number; remaining_capacity: number }; groups: Record<string, LoadItem[]>; disabled: boolean };
    B: { capacity: { used: number; total: number; remaining_capacity: number }; groups: Record<string, LoadItem[]>; disabled: boolean };
  };
};
type ThroughputDay = { date: string; drops_created: number; loads_created: number; loads_delivered: number; loads_exceptioned: number; loads_cancelled: number };
type Anomaly = { type: string; [key: string]: any };
type ExceptionItem = { timestamp: string; load_id: string; drop_id: string | null; customer_name: string | null; reason_code: string | null; notes: string | null };

/* ── Plain-English anomaly messages ── */
function anomalyMessage(a: Anomaly): string {
  switch (a.type) {
    case 'load_stuck_assigned':
      return `A delivery on ${fmtShortDate(a.route_date)} (${a.route_window === 'A' ? 'Morning' : 'Afternoon'} window) was assigned to a driver but never completed. It may need to be rescheduled or marked as delivered.`;
    case 'capacity_overrun':
      return `The ${a.window === 'A' ? 'Morning' : 'Afternoon'} window on ${fmtShortDate(a.service_date)} has more deliveries scheduled (${a.capacity_used}) than its capacity allows (${a.capacity_total}).`;
    case 'drop_without_loads':
      return `Order scheduled for ${fmtShortDate(a.scheduled_date)} was created but has no delivery loads attached. It may need to be recreated.`;
    case 'expired_hold_not_released':
      return `A checkout hold for ${fmtShortDate(a.service_date)} (${a.window === 'A' ? 'Morning' : 'Afternoon'}) expired without being cleaned up.${a.auto_fixed ? ' This has been automatically resolved.' : ''}`;
    default:
      return `System issue detected: ${a.type.replace(/_/g, ' ')}. Please contact support if this persists.`;
  }
}

function fmtShortDate(dateStr: string): string {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T12:00:00');
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/* ── Status display helpers ── */
const STATUS_LABELS: Record<string, string> = {
  NEW: 'New',
  ASSIGNED: 'Assigned',
  LOADED_LEAVING: 'Out for Delivery',
  DELIVERED: 'Delivered',
  EXCEPTION: 'Exception',
  CANCELLED: 'Cancelled',
};
const STATUS_COLORS: Record<string, string> = {
  NEW: 'var(--gray-500)',
  ASSIGNED: 'var(--blue-600)',
  LOADED_LEAVING: 'var(--amber-600)',
  DELIVERED: 'var(--green-600)',
  EXCEPTION: 'var(--red-600)',
  CANCELLED: 'var(--gray-400)',
};
const EXCEPTION_LABELS: Record<string, string> = {
  CUSTOMER_UNAVAILABLE: 'Not Home',
  ACCESS_BLOCKED: 'Access Blocked',
  SAFETY_RISK: 'Safety Risk',
  DAMAGED_GOODS: 'Damaged Material',
  OUT_OF_STOCK: 'Out of Stock',
  WRONG_ADDRESS: 'Wrong Address',
  CUSTOMER_REFUSED: 'Customer Refused',
  OTHER: 'Other',
};


/* ── Dismissed alerts persistence (sessionStorage for day-only persistence) ── */
function getDismissedKey(): string {
  return `dismissed_alerts_${toKey(new Date())}`;
}
function getDismissedAlerts(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = sessionStorage.getItem(getDismissedKey());
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch { return new Set(); }
}
function saveDismissedAlerts(dismissed: Set<string>) {
  if (typeof window === 'undefined') return;
  sessionStorage.setItem(getDismissedKey(), JSON.stringify([...dismissed]));
}

export default function DashboardPage() {
  const today = useMemo(() => new Date(), []);
  const todayStr = toKey(today);

  const [schedule, setSchedule] = useState<ScheduleData | null>(null);
  const [throughput, setThroughput] = useState<ThroughputDay[]>([]);
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [exceptions, setExceptions] = useState<ExceptionItem[]>([]);
  const [capA, setCapA] = useState<{ used: number; total: number } | null>(null);
  const [capB, setCapB] = useState<{ used: number; total: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [dismissedAlerts, setDismissedAlerts] = useState<Set<string>>(new Set());

  // Load dismissed state on mount
  useEffect(() => {
    setDismissedAlerts(getDismissedAlerts());
  }, []);

  const dismissAlert = (id: string) => {
    setDismissedAlerts(prev => {
      const next = new Set(prev);
      next.add(id);
      saveDismissedAlerts(next);
      return next;
    });
  };

  const { activeLocation } = useLocation();
  const locationParam = activeLocation ? `&location_id=${activeLocation.id}` : '';

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const rangeStart = new Date(today);
    rangeStart.setDate(rangeStart.getDate() - 3);
    const rangeEnd = new Date(today);
    rangeEnd.setDate(rangeEnd.getDate() + 3);

    const results = await Promise.allSettled([
      api(`/dispatch/schedule?day=${todayStr}${locationParam}`),
      api(`/ops/reports/throughput?start_date=${toKey(rangeStart)}&end_date=${toKey(rangeEnd)}${locationParam}`),
      api(`/admin/diagnostics/anomalies?auto_fix=false${locationParam}`),
      api(`/ops/reports/exceptions?start_date=${toKey(rangeStart)}&end_date=${toKey(rangeEnd)}${locationParam}`),
      api(`/availability?start_date=${todayStr}&days=1${locationParam}`),
    ]);

    if (results[0].status === 'fulfilled') setSchedule(results[0].value);
    if (results[1].status === 'fulfilled') setThroughput(results[1].value.per_day || []);
    if (results[2].status === 'fulfilled') setAnomalies(results[2].value.anomalies || []);
    if (results[3].status === 'fulfilled') setExceptions(results[3].value.recent_exceptions || []);
    if (results[4].status === 'fulfilled') {
      const wins = results[4].value.windows || [];
      const a = wins.find((w: any) => w.date === todayStr && w.window === 'A');
      const b = wins.find((w: any) => w.date === todayStr && w.window === 'B');
      if (a) setCapA({ used: a.used, total: a.total });
      if (b) setCapB({ used: b.used, total: b.total });
    }
    setLoading(false);
  }, [today, todayStr, locationParam]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  /* ── Derived data ── */
  const todayTP = throughput.find(d => d.date === todayStr);

  // Flatten all loads (priority + windowed) into a sorted delivery list
  const allDeliveries = useMemo(() => {
    if (!schedule) return [];
    const items: (LoadItem & { window: string })[] = [];

    for (const [_driver, loads] of Object.entries(schedule.priority?.groups || {})) {
      for (const load of loads) {
        items.push({ ...load, window: 'P' });
      }
    }

    for (const win of ['A', 'B'] as const) {
      for (const [_driver, loads] of Object.entries(schedule.windows[win].groups)) {
        for (const load of loads) {
          items.push({ ...load, window: win });
        }
      }
    }

    // Sort: Priority first, then AM, then PM; then by status priority.
    const windowOrder: Record<string, number> = { P: 0, A: 1, B: 2 };
    const statusOrder: Record<string, number> = { EXCEPTION: 0, NEW: 1, ASSIGNED: 2, LOADED_LEAVING: 3, DELIVERED: 4, CANCELLED: 5 };
    items.sort((a, b) => {
      if (a.window !== b.window) return (windowOrder[a.window] ?? 3) - (windowOrder[b.window] ?? 3);
      return (statusOrder[a.status.toUpperCase()] ?? 3) - (statusOrder[b.status.toUpperCase()] ?? 3);
    });
    return items;
  }, [schedule]);

  const totalLoadsToday = allDeliveries.length;
  const loadToDropMap = useMemo(() => {
    const mapping: Record<string, string> = {};
    for (const load of allDeliveries) {
      mapping[load.id] = load.drop_id;
    }
    return mapping;
  }, [allDeliveries]);
  const unassignedCount = allDeliveries.filter(d => !d.driver_user_id).length;
  const deliveredCount = todayTP?.loads_delivered ?? 0;
  const exceptionCount = todayTP?.loads_exceptioned ?? 0;
  const pendingCount = totalLoadsToday - deliveredCount - exceptionCount - (todayTP?.loads_cancelled ?? 0);

  // 7-day trend
  const weekDelivered = throughput.reduce((s, d) => s + d.loads_delivered, 0);
  const weekExceptions = throughput.reduce((s, d) => s + d.loads_exceptioned, 0);
  const weekDrops = throughput.reduce((s, d) => s + d.drops_created, 0);

  // Filter out dismissed anomalies
  const visibleAnomalies = anomalies.filter(a => {
    const id = `${a.type}_${a.load_id || a.drop_id || a.hold_token || a.service_date || ''}`;
    return !dismissedAlerts.has(id);
  });

  const getAnomalyDropHref = useCallback((anomaly: Anomaly) => {
      if (anomaly.drop_id) return `/dispatch/drops/${anomaly.drop_id}`;
      if (anomaly.load_id) {
        if (loadToDropMap[anomaly.load_id]) return `/dispatch/drops/${loadToDropMap[anomaly.load_id]}`;
        // For loads from past days not in today's schedule, link to all-orders filtered by date
        if (anomaly.route_date) return `/all-orders?date=${anomaly.route_date}`;
      }
      return null;
    }, [loadToDropMap]);

  if (!requireRole(['dispatcher'])) return <div className="page"><p>Unauthorized</p></div>;

  return (
    <>
      <style>{dashStyles}</style>
      <div className="page dash-page">
        <div className="dash-top">
          <div>
            <h1>Dashboard</h1>
            <p className="dash-date">{fmtDate(today)}</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-secondary btn-sm" onClick={fetchAll}>↻ Refresh</button>
            <Link href="/new-drop" className="btn btn-primary btn-sm" style={{ textDecoration: 'none' }}>+ New Order</Link>
          </div>
        </div>

        {loading && <div style={{ textAlign: 'center', padding: 40 }}><div className="spinner spinner-lg" style={{ margin: '0 auto' }} /></div>}

        {!loading && (
          <>
            {/* ── Unassigned alert ── */}
            {unassignedCount > 0 && !dismissedAlerts.has('unassigned_today') && (
              <div className="alert alert-warning dash-alert">
                <span>⚠️</span>
                <div style={{ flex: 1 }}>
                  <strong>{unassignedCount} delivery{unassignedCount !== 1 ? 's' : ''} still need{unassignedCount === 1 ? 's' : ''} a driver assigned</strong> for today.
                  <Link href="/dispatch-schedule" style={{ marginLeft: 8, fontWeight: 700, color: 'var(--amber-700)', textDecoration: 'underline' }}>Open Schedule →</Link>
                </div>
                <button className="dash-alert-dismiss" onClick={() => dismissAlert('unassigned_today')} title="Dismiss">✕</button>
              </div>
            )}

            {/* ── Anomaly alerts — plain English, dismissable ── */}
            {visibleAnomalies.map((a, i) => {
              const id = `${a.type}_${a.load_id || a.drop_id || a.hold_token || a.service_date || ''}`;
              const dropHref = getAnomalyDropHref(a);
              return (
                <div key={i} className="alert alert-error dash-alert">
                  <span>⚠️</span>
                  <div style={{ flex: 1, fontSize: 14 }}>
                    {dropHref ? (
                      <Link href={dropHref} className="dash-alert-link" title="Open drop details">
                        {anomalyMessage(a)}
                        <span className="dash-alert-link-cta">Open drop details →</span>
                      </Link>
                    ) : (
                      anomalyMessage(a)
                    )}
                  </div>
                  <button className="dash-alert-dismiss" onClick={() => dismissAlert(id)} title="Dismiss">✕</button>
                </div>
              );
            })}

            {/* ── Stat cards ── */}
            <div className="dash-stats">
              <div className="stat-card">
                <div className="stat-label">Today's Deliveries</div>
                <div className="stat-value">{totalLoadsToday}</div>
                <div className="stat-sub">{todayTP?.drops_created ?? 0} orders</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Delivered</div>
                <div className="stat-value" style={{ color: 'var(--green-600)' }}>{deliveredCount}</div>
                <div className="stat-sub">{totalLoadsToday > 0 ? Math.round(deliveredCount / totalLoadsToday * 100) : 0}% complete</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Pending</div>
                <div className="stat-value" style={{ color: 'var(--amber-600)' }}>{Math.max(0, pendingCount)}</div>
                <div className="stat-sub">in progress</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Exceptions</div>
                <div className="stat-value" style={{ color: exceptionCount > 0 ? 'var(--red-600)' : 'var(--gray-400)' }}>{exceptionCount}</div>
                <div className="stat-sub">{exceptionCount > 0 ? 'needs attention' : 'all clear'}</div>
              </div>
            </div>

            {/* ── Two-column layout: Capacity + Today's Deliveries ── */}
            <div className="dash-grid-2">
              {/* Capacity */}
              <div className="card">
                <div className="dash-card-head">Today's Capacity</div>
                <div className="dash-card-body">
                  {['A', 'B'].map(w => {
                    const cap = w === 'A' ? capA : capB;
                    const winData = schedule?.windows[w as 'A' | 'B'];
                    const disabled = winData?.disabled;
                    const used = cap?.used ?? 0;
                    const total = cap?.total ?? 0;
                    const pct = total > 0 ? Math.round(used / total * 100) : 0;
                    const color = capColor(used, total);
                    return (
                      <div key={w} className="dash-cap-row">
                        <div className="dash-cap-label">
                          <span style={{ fontWeight: 700 }}>{w === 'A' ? 'Morning Delivery (9am - 1pm)' : 'Afternoon Delivery (1pm - 5pm)'}</span>
                          {disabled && <span className="pill pill-red" style={{ fontSize: 10, marginLeft: 6 }}>Blacked Out</span>}
                          <span className="dash-cap-num">{used}/{total}</span>
                        </div>
                        <div className="dash-cap-bar">
                          <div className={`dash-cap-fill cap-fill ${color}`} style={{ width: `${pct}%` }} />
                        </div>
                        <div className="dash-cap-remaining" style={{ color: `var(--${color === 'green' ? 'green-600' : color === 'amber' ? 'amber-600' : 'red-600'})` }}>
                          {total - used} remaining
                        </div>
                      </div>
                    );
                  })}
                  <Link href="/dispatch-schedule" className="btn btn-secondary btn-sm" style={{ textDecoration: 'none', marginTop: 12, display: 'inline-flex' }}>View Full Schedule →</Link>
                </div>
              </div>

              {/* 7-Day Overview (moved to second column) */}
              <div className="card">
                <div className="dash-card-head">This Week</div>
                <div className="dash-card-body">
                  <div className="dash-week-stats">
                    <div className="dash-week-stat"><span className="dash-ws-val">{weekDrops}</span><span className="dash-ws-label">Orders</span></div>
                    <div className="dash-week-stat"><span className="dash-ws-val" style={{ color: 'var(--green-600)' }}>{weekDelivered}</span><span className="dash-ws-label">Delivered</span></div>
                    <div className="dash-week-stat"><span className="dash-ws-val" style={{ color: weekExceptions > 0 ? 'var(--red-600)' : 'var(--gray-400)' }}>{weekExceptions}</span><span className="dash-ws-label">Exceptions</span></div>
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
            </div>

            {/* ── Today's Deliveries list ── */}
            <div className="card">
              <div className="dash-card-head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>Today's Deliveries</span>
                <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--gray-400)' }}>{allDeliveries.length} load{allDeliveries.length !== 1 ? 's' : ''}</span>
              </div>
              <div className="dash-card-body" style={{ padding: 0 }}>
                {allDeliveries.length === 0 ? (
                  <div style={{ padding: '24px 20px', textAlign: 'center', color: 'var(--gray-400)', fontSize: 14 }}>
                    No deliveries scheduled for today.
                  </div>
                ) : (
                  <div className="dash-delivery-list">
                    {allDeliveries.map((load) => (
                      <Link
                        key={load.id}
                        href={`/dispatch/drops/${load.drop_id}`}
                        className="dash-delivery-row"
                      >
                        <div className="dash-delivery-main">
                          <div className="dash-delivery-customer">{load.customer_name || 'Unknown Customer'}</div>
                          <div className="dash-delivery-address">{load.address_short || '—'}</div>
                        </div>
                        <div className="dash-delivery-meta">
                          <span className="dash-delivery-window">
                            {load.window === 'P' ? 'Priority' : load.window === 'A' ? 'Morning' : 'Afternoon'}
                          </span>
                          <span className="dash-delivery-status" style={{ color: STATUS_COLORS[load.status] || 'var(--gray-500)' }}>
                            {STATUS_LABELS[load.status] || load.status}
                          </span>
                        </div>
                        <div className="dash-delivery-driver">
                          {load.driver_name && load.driver_name !== 'Unassigned'
                            ? load.driver_name
                            : <span style={{ color: 'var(--amber-500)', fontWeight: 600 }}>Unassigned</span>
                          }
                        </div>
                        <div className="dash-delivery-material">
                          {load.qty} {load.unit} {load.material}
                        </div>
                        <span className="dash-delivery-arrow">›</span>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            </div>

{/* ── Recent Exceptions ── */}
            {exceptions.length > 0 && (
              <div className="card">
                <div className="dash-card-head">Recent Exceptions</div>
                <div className="dash-card-body" style={{ padding: 0 }}>
                  {exceptions.slice(0, 5).map((e, i) => {
                    const label = EXCEPTION_LABELS[e.reason_code || ''] || 'Exception';
                    const inner = (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 20px', borderBottom: i < Math.min(exceptions.length, 5) - 1 ? '1px solid var(--border-light)' : 'none' }}>
                        <div className="dash-exc-dot" />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--gray-900)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {e.customer_name || 'Unknown Customer'}
                          </div>
                          <div style={{ fontSize: 13, color: 'var(--red-600)', fontWeight: 600, marginTop: 1 }}>{label}</div>
                          {e.notes && <div style={{ fontSize: 12, color: 'var(--gray-500)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.notes}</div>}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--gray-400)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                          {new Date(e.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </div>
                        {e.drop_id && <span style={{ fontSize: 13, color: 'var(--gray-400)' }}>›</span>}
                      </div>
                    );
                    return e.drop_id ? (
                      <Link key={i} href={`/dispatch/drops/${e.drop_id}`} style={{ display: 'block', textDecoration: 'none', color: 'inherit' }} className="dash-exc-link">
                        {inner}
                      </Link>
                    ) : (
                      <div key={i}>{inner}</div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

const dashStyles = `
  .dash-page { max-width: 880px; }
  .dash-top { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 20px; flex-wrap: wrap; gap: 12px; }
  .dash-top h1 { font-size: 28px; font-weight: 800; letter-spacing: -0.02em; margin: 0; }
  .dash-date { color: var(--gray-500); font-size: 15px; margin-top: 2px; }
  .dash-exc-link:hover { background: var(--gray-50); }

  /* Alerts */
  .dash-alert { margin-bottom: 12px; position: relative; }
  .dash-alert-dismiss {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 16px;
    color: inherit;
    opacity: 0.5;
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    transition: opacity 0.15s;
    flex-shrink: 0;
  }
  .dash-alert-dismiss:hover { opacity: 1; }
  .dash-alert-link { color: inherit; text-decoration: none; }
  .dash-alert-link:hover .dash-alert-link-cta { text-decoration: underline; }
  .dash-alert-link-cta { display: inline-block; margin-left: 8px; font-size: 13px; font-weight: 700; }

  /* Stat cards */
  .dash-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px; }
  .stat-card { background: var(--surface); border: 1px solid var(--border-light); border-radius: var(--radius-lg); padding: 18px 20px; box-shadow: var(--shadow-xs); }
  .stat-label { font-size: 13px; font-weight: 600; color: var(--gray-500); text-transform: uppercase; letter-spacing: 0.04em; }
  .stat-value { font-size: 32px; font-weight: 800; color: var(--gray-900); line-height: 1.1; margin-top: 4px; letter-spacing: -0.02em; }
  .stat-sub { font-size: 13px; color: var(--gray-400); margin-top: 2px; }
  @media (max-width: 700px) { .dash-stats { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 400px) { .dash-stats { grid-template-columns: 1fr; } }

  /* Two-column grid */
  .dash-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
  @media (max-width: 700px) { .dash-grid-2 { grid-template-columns: 1fr; } }

  /* Card internals */
  .card { background: var(--surface); border: 1px solid var(--border-light); border-radius: var(--radius-lg); box-shadow: var(--shadow-xs); overflow: hidden; margin-bottom: 16px; }
  .dash-card-head { padding: 14px 20px; font-size: 15px; font-weight: 700; color: var(--gray-800); border-bottom: 1px solid var(--border-light); }
  .dash-card-body { padding: 16px 20px; }

  /* Capacity */
  .dash-cap-row { margin-bottom: 16px; }
  .dash-cap-row:last-of-type { margin-bottom: 0; }
  .dash-cap-label { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; font-size: 14px; color: var(--gray-700); }
  .dash-cap-num { font-weight: 700; font-size: 13px; color: var(--gray-500); margin-left: auto; }
  .dash-cap-bar { height: 10px; border-radius: 5px; background: var(--gray-100); overflow: hidden; }
  .dash-cap-fill { height: 100%; border-radius: 5px; transition: width 0.3s; }
  .cap-fill.green { background: var(--green-500); }
  .cap-fill.amber { background: var(--amber-400); }
  .cap-fill.red { background: var(--red-500); }
  .dash-cap-remaining { font-size: 12px; font-weight: 600; margin-top: 4px; }

  /* Today's Deliveries */
  .dash-delivery-list { display: flex; flex-direction: column; }
  .dash-delivery-row {
    display: grid;
    grid-template-columns: 1fr auto auto auto 20px;
    align-items: center;
    gap: 12px;
    padding: 12px 20px;
    border-bottom: 1px solid var(--border-light);
    text-decoration: none;
    color: inherit;
    transition: background 0.12s;
    cursor: pointer;
  }
  .dash-delivery-row:last-child { border-bottom: none; }
  .dash-delivery-row:hover { background: var(--gray-50); }
  .dash-delivery-customer { font-size: 14px; font-weight: 600; color: var(--gray-900); }
  .dash-delivery-address { font-size: 13px; color: var(--gray-500); margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 280px; }
  .dash-delivery-meta { display: flex; flex-direction: column; align-items: center; gap: 2px; min-width: 80px; }
  .dash-delivery-window {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--gray-500);
    background: var(--gray-100);
    padding: 2px 8px;
    border-radius: 8px;
  }
  .dash-delivery-status { font-size: 12px; font-weight: 600; }
  .dash-delivery-driver { font-size: 13px; color: var(--gray-600); min-width: 90px; text-align: right; }
  .dash-delivery-material { font-size: 12px; color: var(--gray-400); min-width: 100px; text-align: right; white-space: nowrap; }
  .dash-delivery-arrow { color: var(--gray-300); font-size: 18px; font-weight: 300; }

  @media (max-width: 700px) {
    .dash-delivery-row {
      grid-template-columns: 1fr auto auto;
      gap: 8px;
      padding: 12px 16px;
    }
    .dash-delivery-material,
    .dash-delivery-arrow { display: none; }
    .dash-delivery-address { max-width: 180px; }
  }
  @media (max-width: 480px) {
    .dash-delivery-row {
      grid-template-columns: 1fr auto;
    }
    .dash-delivery-driver { display: none; }
  }

  /* 7-day sparkbar */
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
  .dash-exception-row { display: flex; align-items: flex-start; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--border-light); }
  .dash-exception-row:last-child { border-bottom: none; }
  .dash-exc-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--red-500); margin-top: 6px; flex-shrink: 0; }

  .pill-red { background: var(--red-50); color: var(--red-700); }
  .alert-warning { background: var(--amber-50); color: var(--amber-700); border: 1px solid rgba(245,158,11,0.2); padding: 12px 16px; border-radius: var(--radius-md); display: flex; align-items: flex-start; gap: 10px; font-size: 14px; font-weight: 500; }
  .alert-error { background: var(--red-50); color: var(--red-700); border: 1px solid rgba(239,68,68,0.2); padding: 12px 16px; border-radius: var(--radius-md); display: flex; align-items: flex-start; gap: 10px; font-size: 14px; font-weight: 500; }
`;
