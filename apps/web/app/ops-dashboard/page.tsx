'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, getSession, requireRole } from '../lib/auth';

export default function OpsDashboardPage() {
  const today = new Date().toISOString().slice(0, 10);
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [overview, setOverview] = useState<any>(null);
  const [capacity, setCapacity] = useState<any>(null);

  const load = async () => {
    setOverview(await api(`/ops/analytics/overview?start_date=${startDate}&end_date=${endDate}`));
    setCapacity(await api(`/ops/capacity/utilization?start_date=${startDate}&end_date=${endDate}`));
  };

  useEffect(() => { load().catch(() => null); }, []);
  if (!requireRole(['dispatcher'])) return <p>Unauthorized</p>;

  return <main>
    <h1>Operations Dashboard</h1>
    <label>Start <input type='date' value={startDate} onChange={(e)=>setStartDate(e.target.value)} /></label>
    <label>End <input type='date' value={endDate} onChange={(e)=>setEndDate(e.target.value)} /></label>
    <button onClick={load}>Refresh</button>

    {capacity && <section>
      <h2>Today's Capacity Usage</h2>
      <p>Available: {capacity.total_capacity_available} | Used: {capacity.capacity_used} | Lost to expired holds: {capacity.capacity_lost_to_expired_holds}</p>
      <ul>{capacity.under_utilized_windows.map((w:any)=><li key={`${w.date}-${w.window}`}>{w.date} {w.window} - {w.utilization_percent}%</li>)}</ul>
    </section>}

    {overview && <section>
      <h2>Operational Signals</h2>
      <p>Loads scheduled vs completed: {overview.exception_rates.total_loads} / {overview.deliveries_per_day.reduce((a:any,b:any)=>a+b.count,0)}</p>
      <p>Exceptions today: {overview.exception_rates.exception_loads}</p>
      <p>Drivers active today: {new Set(overview.driver_operational_signals.map((d:any)=>d.driver_user_id)).size}</p>
    </section>}

    <section>
      <h3>Quick links</h3>
      <ul>
        <li><Link href='/dispatch-schedule'>Schedule</Link></li>
        <li><Link href='/ops-dashboard'>Exceptions</Link></li>
        <li><Link href='/ops-dashboard'>Diagnostics</Link></li>
      </ul>
    </section>

    <section>
      <h3>CSV Export</h3>
      <button onClick={async()=>{
        const s = getSession();
        const res = await fetch(`http://localhost:8000/api/v1/ops/reports/loads.csv?start_date=${startDate}&end_date=${endDate}`, { headers: { Authorization: `Bearer ${s?.token || ''}`, ...(s?.tenant_slug ? { 'X-Tenant-Slug': s.tenant_slug } : {}) } });
        const blob = await res.blob(); const u = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = u; a.download = 'loads.csv'; a.click();
      }}>Loads CSV</button>
      <button onClick={async()=>{
        const s = getSession();
        const res = await fetch(`http://localhost:8000/api/v1/ops/reports/drops.csv?start_date=${startDate}&end_date=${endDate}`, { headers: { Authorization: `Bearer ${s?.token || ''}`, ...(s?.tenant_slug ? { 'X-Tenant-Slug': s.tenant_slug } : {}) } });
        const blob = await res.blob(); const u = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = u; a.download = 'drops.csv'; a.click();
      }}>Drops CSV</button>
      <button onClick={async()=>{
        const s = getSession();
        const res = await fetch(`http://localhost:8000/api/v1/ops/reports/exceptions.csv?start_date=${startDate}&end_date=${endDate}`, { headers: { Authorization: `Bearer ${s?.token || ''}`, ...(s?.tenant_slug ? { 'X-Tenant-Slug': s.tenant_slug } : {}) } });
        const blob = await res.blob(); const u = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = u; a.download = 'exceptions.csv'; a.click();
      }}>Exceptions CSV</button>
    </section>
  </main>;
}
