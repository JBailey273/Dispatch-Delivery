'use client';

import Link from 'next/link';
import { useEffect, useState, useMemo, useCallback } from 'react';
import { ApiError, api, requireRole } from '../lib/auth';

/* ── Helpers ── */
const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function toKey(d: Date) { return d.toISOString().slice(0, 10); }
function fmtDate(d: Date) { return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}`; }
function capColor(u: number, t: number) { if (t === 0) return 'green'; const p = u / t; return p >= 1 ? 'red' : p >= 0.75 ? 'amber' : 'green'; }

type LoadItem = { id: string; drop_id: string; status: string; material: string; qty: number; unit: string };
type ScheduleData = {
  date: string;
  windows: {
    A: { capacity: { used: number; total: number; remaining_capacity: number }; groups: Record<string, LoadItem[]>; disabled: boolean };
    B: { capacity: { used: number; total: number; remaining_capacity: number }; groups: Record<string, LoadItem[]>; disabled: boolean };
  };
};
type ThroughputDay = { date: string; drops_created: number; loads_created: number; loads_delivered: number; loads_exceptioned: number; loads_cancelled: number };
type Suggestion = { type: string; message: string; severity: string; referenced_entities: any };
type Anomaly = { type: string; [key: string]: any };
type ExceptionItem = { timestamp: string; load_id: string; notes: string };

export default function DashboardPage() {
  const today = useMemo(() => new Date(), []);
  const todayStr = toKey(today);

  const [schedule, setSchedule] = useState<ScheduleData | null>(null);
  const [throughput, setThroughput] = useState<ThroughputDay[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [exceptions, setExceptions] = useState<ExceptionItem[]>([]);
  const [capA, setCapA] = useState<{ used: number; total: number } | null>(null);
  const [capB, setCapB] = useState<{ used: number; total: number } | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 6);

    const results = await Promise.allSettled([
      api(`/dispatch/schedule?day=${todayStr}`),
      api(`/ops/reports/throughput?start_date=${toKey(weekAgo)}&end_date=${todayStr}`),
      api(`/dispatch/suggestions?day=${todayStr}`),
      api(`/admin/diagnostics/anomalies?auto_fix=false`),
      api(`/ops/reports/exceptions?start_date=${toKey(weekAgo)}&end_date=${todayStr}`),
      api(`/availability?start_date=${todayStr}&days=1`),
    ]);

    if (results[0].status === 'fulfilled') setSchedule(results[0].value);
    if (results[1].status === 'fulfilled') setThroughput(results[1].value.per_day || []);
    if (results[2].status === 'fulfilled') setSuggestions(results[2].value.suggestions || []);
    if (results[3].status === 'fulfilled') setAnomalies(results[3].value.anomalies || []);
    if (results[4].status === 'fulfilled') setExceptions(results[4].value.recent_exceptions || []);
    if (results[5].status === 'fulfilled') {
      const wins = results[5].value.windows || [];
      const a = wins.find((w: any) => w.date === todayStr && w.window === 'A');
      const b = wins.find((w: any) => w.date === todayStr && w.window === 'B');
      if (a) setCapA({ used: a.used, total: a.total });
      if (b) setCapB({ used: b.used, total: b.total });
    }
    setLoading(false);
  }, [today, todayStr]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  /* ── Derived stats ── */
  const todayTP = throughput.find(d => d.date === todayStr);
  const totalLoadsToday = useMemo(() => {
    if (!schedule) return 0;
    let c = 0;
    for (const win of ['A', 'B'] as const) {
      for (const loads of Object.values(schedule.windows[win].groups)) c += loads.length;
    }
    return c;
  }, [schedule]);

  const unassignedCount = useMemo(() => {
    if (!schedule) return 0;
    let c = 0;
    for (const win of ['A', 'B'] as const) {
      c += (schedule.windows[win].groups['Unassigned'] || []).length;
    }
    return c;
  }, [schedule]);

  const deliveredCount = todayTP?.loads_delivered ?? 0;
  const exceptionCount = todayTP?.loads_exceptioned ?? 0;
  const pendingCount = totalLoadsToday - deliveredCount - exceptionCount - (todayTP?.loads_cancelled ?? 0);

  // 7-day trend
  const weekDelivered = throughput.reduce((s, d) => s + d.loads_delivered, 0);
  const weekExceptions = throughput.reduce((s, d) => s + d.loads_exceptioned, 0);
  const weekDrops = throughput.reduce((s, d) => s + d.drops_created, 0);

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
            {/* ── Alert banner for unassigned ── */}
            {unassignedCount > 0 && (
              <div className="alert alert-warning dash-alert">
                <span>⚠</span>
                <div style={{ flex: 1 }}>
                  <strong>{unassignedCount} unassigned load{unassignedCount !== 1 ? 's' : ''}</strong> for today.
                  <Link href="/dispatch-schedule" style={{ marginLeft: 8, fontWeight: 700, color: 'var(--amber-700)', textDecoration: 'underline' }}>Open Schedule →</Link>
                </div>
              </div>
            )}

            {/* ── Anomaly alerts ── */}
            {anomalies.length > 0 && (
              <div className="alert alert-error dash-alert">
                <span>🔴</span>
                <div style={{ flex: 1 }}>
                  <strong>{anomalies.length} system anomal{anomalies.length !== 1 ? 'ies' : 'y'} detected</strong> — {anomalies.map(a => a.type.replace(/_/g, ' ')).slice(0, 3).join(', ')}{anomalies.length > 3 ? '…' : ''}
                </div>
              </div>
            )}

            {/* ── Stat cards ── */}
            <div className="dash-stats">
              <div className="stat-card">
                <div className="stat-label">Today's Loads</div>
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

            {/* ── Two-column layout: Capacity + Suggestions ── */}
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
                          <span style={{ fontWeight: 700 }}>{w === 'A' ? 'AM (9–1)' : 'PM (1–5)'}</span>
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

              {/* Suggestions */}
              <div className="card">
                <div className="dash-card-head">Dispatch Suggestions</div>
                <div className="dash-card-body">
                  {suggestions.length === 0 ? (
                    <p style={{ color: 'var(--gray-400)', fontSize: 14 }}>No suggestions right now — schedule looks good.</p>
                  ) : (
                    <div className="dash-suggestion-list">
                      {suggestions.slice(0, 5).map((s, i) => (
                        <div key={i} className={`dash-suggestion ${s.severity || 'info'}`}>
                          <span className="dash-sug-icon">{s.severity === 'warning' ? '⚠️' : s.severity === 'critical' ? '🔴' : '💡'}</span>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 14, fontWeight: 500 }}>{s.message || s.type?.replace(/_/g, ' ')}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* ── 7-Day Trend ── */}
            <div className="card">
              <div className="dash-card-head">7-Day Overview</div>
              <div className="dash-card-body">
                <div className="dash-week-stats">
                  <div className="dash-week-stat"><span className="dash-ws-val">{weekDrops}</span><span className="dash-ws-label">Orders</span></div>
                  <div className="dash-week-stat"><span className="dash-ws-val" style={{ color: 'var(--green-600)' }}>{weekDelivered}</span><span className="dash-ws-label">Delivered</span></div>
                  <div className="dash-week-stat"><span className="dash-ws-val" style={{ color: exceptionCount > 0 ? 'var(--red-600)' : 'var(--gray-400)' }}>{weekExceptions}</span><span className="dash-ws-label">Exceptions</span></div>
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

            {/* ── Recent Exceptions ── */}
            {exceptions.length > 0 && (
              <div className="card">
                <div className="dash-card-head">Recent Exceptions</div>
                <div className="dash-card-body">
                  {exceptions.slice(0, 5).map((e, i) => (
                    <div key={i} className="dash-exception-row">
                      <div className="dash-exc-dot" />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 14, fontWeight: 600 }}>Load {e.load_id?.slice(0, 8)}…</div>
                        {e.notes && <div style={{ fontSize: 13, color: 'var(--gray-500)', marginTop: 2 }}>{e.notes}</div>}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--gray-400)', whiteSpace: 'nowrap' }}>
                        {new Date(e.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                  ))}
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

  .dash-alert { margin-bottom: 12px; }

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

  /* Suggestions */
  .dash-suggestion-list { display: flex; flex-direction: column; gap: 8px; }
  .dash-suggestion { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border-radius: var(--radius-md); background: var(--gray-50); }
  .dash-suggestion.warning { background: var(--amber-50); }
  .dash-suggestion.critical { background: var(--red-50); }
  .dash-sug-icon { font-size: 16px; flex-shrink: 0; margin-top: 1px; }

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
`;
