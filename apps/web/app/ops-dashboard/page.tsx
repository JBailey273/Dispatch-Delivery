'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { api, getSession, requireRole } from '../lib/auth';

type TabKey = 'capacity' | 'throughput' | 'exceptions' | 'timing';

export default function OpsDashboardPage() {
  const today = new Date().toISOString().slice(0, 10);
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [tab, setTab] = useState<TabKey>('capacity');
  const [capacity, setCapacity] = useState<any>(null);
  const [throughput, setThroughput] = useState<any>(null);
  const [exceptions, setExceptions] = useState<any>(null);
  const [timing, setTiming] = useState<any>(null);
  const [anomalies, setAnomalies] = useState<any>(null);
  const [blackouts, setBlackouts] = useState<any[]>([]);
  const [reasonCode, setReasonCode] = useState('weather');
  const [windowCode, setWindowCode] = useState('ALL');
  const isAdmin = requireRole(['admin']);

  const load = async () => {
    const [c, t, e, ts, d] = await Promise.all([
      api(`/ops/reports/capacity-utilization?start_date=${startDate}&end_date=${endDate}`),
      api(`/ops/reports/throughput?start_date=${startDate}&end_date=${endDate}`),
      api(`/ops/reports/exceptions?start_date=${startDate}&end_date=${endDate}`),
      api(`/ops/reports/timing-signals?start_date=${startDate}&end_date=${endDate}`),
      api('/admin/diagnostics/anomalies?auto_fix=true'),
    ]);
    setCapacity(c);
    setThroughput(t);
    setExceptions(e);
    setTiming(ts);
    setAnomalies(d);
    if (isAdmin) {
      const b = await api(`/admin/blackouts?start_date=${startDate}&end_date=${endDate}`);
      setBlackouts(b.blackouts || []);
    }
  };

  useEffect(() => {
    load().catch(() => null);
  }, []);

  if (!requireRole(['dispatcher'])) return <p>Unauthorized</p>;

  const totals = useMemo(() => {
    const todayCap = capacity?.per_day?.find((d: any) => d.date === today);
    const todayThroughput = throughput?.per_day?.find((d: any) => d.date === today);
    return {
      capUsed: todayCap?.capacity_used || 0,
      capTotal: todayCap?.total_capacity || 0,
      loadsScheduled: todayThroughput?.loads_created || 0,
      loadsDelivered: todayThroughput?.loads_delivered || 0,
      exceptionsToday: exceptions?.exceptions_per_day?.find((d: any) => d.date === today)?.count || 0,
    };
  }, [capacity, throughput, exceptions, today]);

  const downloadCsv = async (path: string, filename: string) => {
    const s = getSession();
    const res = await fetch(`http://localhost:8000/api/v1${path}`, {
      headers: { Authorization: `Bearer ${s?.token || ''}`, ...(s?.tenant_slug ? { 'X-Tenant-Slug': s.tenant_slug } : {}) },
    });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
  };

  return (
    <main>
      <h1>Operations Dashboard</h1>
      <p>
        How full are we? <strong>{totals.capUsed}</strong>/<strong>{totals.capTotal}</strong> today.
      </p>
      <p>
        How did today go? Scheduled <strong>{totals.loadsScheduled}</strong>, delivered <strong>{totals.loadsDelivered}</strong>, exceptions <strong>{totals.exceptionsToday}</strong>.
      </p>
      <section>
        <h3>Quick links</h3>
        <ul>
          <li><Link href='/dispatch-schedule'>Schedule</Link></li>
          <li><Link href='/ops-dashboard'>Exceptions</Link></li>
          <li><Link href='/ops-dashboard'>Diagnostics</Link></li>
          <li><Link href='/ops-dashboard'>Reports</Link></li>
        </ul>
      </section>

      <section>
        <h2>Reports</h2>
        <label>Start <input type='date' value={startDate} onChange={(e) => setStartDate(e.target.value)} /></label>
        <label>End <input type='date' value={endDate} onChange={(e) => setEndDate(e.target.value)} /></label>
        <button onClick={load}>Refresh</button>
        <div style={{ marginTop: 8 }}>
          {(['capacity', 'throughput', 'exceptions', 'timing'] as TabKey[]).map((t) => (
            <button key={t} onClick={() => setTab(t)} style={{ marginRight: 6, fontWeight: tab === t ? 700 : 400 }}>{t}</button>
          ))}
        </div>

        {tab === 'capacity' && (
          <ul>{capacity?.per_window?.map((w: any) => <li key={`${w.date}-${w.window}`}>{w.date} window {w.window}: {w.capacity_used}/{w.capacity_total} used</li>)}</ul>
        )}
        {tab === 'throughput' && (
          <ul>{throughput?.per_day?.map((d: any) => <li key={d.date}>{d.date}: drops {d.drops_created}, loads {d.loads_created}, delivered {d.loads_delivered}, exceptioned {d.loads_exceptioned}, cancelled {d.loads_cancelled}</li>)}</ul>
        )}
        {tab === 'exceptions' && (
          <>
            <p>Top addresses:</p>
            <ul>{exceptions?.top_exception_addresses?.map((a: any) => <li key={a.normalized_address}>{a.normalized_address}: {a.count}</li>)}</ul>
            <p>Recent exceptions:</p>
            <ul>{exceptions?.recent_exceptions?.map((e: any) => <li key={`${e.timestamp}-${e.load_id}`}>{e.timestamp} load {e.load_id} {e.notes || ''}</li>)}</ul>
          </>
        )}
        {tab === 'timing' && (
          <ul>{timing?.per_day?.map((d: any) => <li key={d.date}>{d.date}: start→leave avg {Math.round(d.window_start_to_loaded_leaving.avg_seconds || 0)}s; leave→delivered avg {Math.round(d.loaded_leaving_to_delivered.avg_seconds || 0)}s</li>)}</ul>
        )}

        <h3>Exports</h3>
        <button onClick={() => downloadCsv(`/ops/reports/loads.csv?start_date=${startDate}&end_date=${endDate}`, 'loads.csv')}>Loads CSV</button>
        <button onClick={() => downloadCsv(`/ops/reports/drops.csv?start_date=${startDate}&end_date=${endDate}`, 'drops.csv')}>Drops CSV</button>
        <button onClick={() => downloadCsv(`/ops/reports/exceptions.csv?start_date=${startDate}&end_date=${endDate}`, 'exceptions.csv')}>Exceptions CSV</button>
      </section>

      <section>
        <h2>Diagnostics</h2>
        <p>Anomalies found: {anomalies?.anomalies?.length || 0}. Auto-fixes applied: {anomalies?.auto_fix_applied || 0}.</p>
        <ul>{anomalies?.anomalies?.slice(0, 20).map((a: any, idx: number) => <li key={idx}>{a.type}</li>)}</ul>
      </section>

      {isAdmin && (
        <section>
          <h2>Disruption controls (Admin)</h2>
          <p>Prevents new scheduling; existing deliveries remain.</p>
          <label>Date <input type='date' value={startDate} onChange={(e) => setStartDate(e.target.value)} /></label>
          <label>Window
            <select value={windowCode} onChange={(e) => setWindowCode(e.target.value)}>
              <option value='ALL'>All windows (blackout date)</option>
              <option value='A'>Window A only</option>
              <option value='B'>Window B only</option>
            </select>
          </label>
          <label>Reason
            <select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
              <option value='weather'>Weather</option>
              <option value='staffing'>Staffing</option>
              <option value='equipment'>Equipment</option>
              <option value='other'>Other</option>
            </select>
          </label>
          <button onClick={async () => {
            await api('/admin/blackouts', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ service_date: startDate, window_code: windowCode === 'ALL' ? null : windowCode, reason_code: reasonCode }),
            });
            await load();
          }}>Save disruption control</button>

          <ul>
            {blackouts.filter((b: any) => b.active).map((b: any) => (
              <li key={b.id}>{b.service_date} {b.window_code || 'ALL'} ({b.reason_code}) <button onClick={async () => { await api(`/admin/blackouts/${b.id}`, { method: 'DELETE' }); await load(); }}>Remove</button></li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
