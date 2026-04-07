  'use client';

import Link from 'next/link';
import { Suspense } from 'react';
import { useEffect, useMemo, useState, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { ApiError, api, requireRole } from '../lib/auth';
import { useLocation } from '../lib/location-context';
import DropRescheduleSlideOver from '../components/DropRescheduleSlideOver';
import type { SlideOverDropDetail } from '../components/DropRescheduleSlideOver';

/* ── Date helpers ── */
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const FULL_MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];
const SHORT_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function daysInMonth(y: number, m: number) { return new Date(y, m + 1, 0).getDate(); }
function firstDow(y: number, m: number) { return new Date(y, m, 1).getDay(); }
function toKey(d: Date) { return d.toISOString().slice(0, 10); }
function sameDay(a: Date, b: Date) { return toKey(a) === toKey(b); }
function fmtPhone(p: string) {
  const d = p.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') return `(${d.slice(1,4)}) ${d.slice(4,7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
  return p;
}
function fmtDateLong(ds: string) {
  const d = new Date(ds + 'T12:00:00');
  return `${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getDay()]}, ${FULL_MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}
function fmtDateShort(ds: string) {
  const d = new Date(ds + 'T12:00:00');
  return `${SHORT_MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/* ── Types ── */
type CapWindow = { date: string; window: string; used: number; total: number; remaining_capacity: number; available: boolean; active_holds: number };
type LoadItem = { id: string; drop_id: string; order_ref: string; status: string; material: string; qty: number; unit: string; customer_name: string; customer_phone: string; address_short: string; driver_name: string; driver_user_id: string | null; is_priority?: boolean };
type ScheduleData = {
  date: string;
  priority: { groups: Record<string, LoadItem[]>; load_count: number; warning: string | null };
  windows: {
    A: { capacity: { used: number; total: number; remaining_capacity: number }; groups: Record<string, LoadItem[]>; disabled: boolean };
    B: { capacity: { used: number; total: number; remaining_capacity: number }; groups: Record<string, LoadItem[]>; disabled: boolean };
  };
};
type DropDetail = {
  id: string; ref: string; order_number: number | null; external_order_id: string | null; source: string;
  is_priority: boolean; customer_type: string;
  scheduled_date: string; scheduled_window: string | null;
  customer_name: string; customer_phone: string;
  delivery_address: { line1: string; line2?: string | null; city: string; state: string; postal_code: string } | null;
  notes: string | null; required_loads: number;
  loads: { id: string; material: string; qty: number; unit: string; status: string; driver_user_id: string | null; driver_name: string | null }[];
  notify_sent_at: string | null; last_reschedule_sms_at: string | null;
};
type Driver = { id: string; email: string; name: string; truck: string | null };
type NeedsAttentionItem = { drop_id: string; ref: string; customer_name: string; scheduled_date: string; scheduled_window: string | null; is_priority: boolean };

/* ── Helpers ── */
function capColor(used: number, total: number): string {
  if (total === 0) return 'green';
  const pct = used / total;
  if (pct >= 1) return 'red';
  if (pct >= 0.75) return 'amber';
  return 'green';
}
function fmtShortDate(ds: string) {
  const d = new Date(ds + 'T12:00:00');
  return `${FULL_MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}`;
}
const STATUS_PILL: Record<string, string> = {
  assigned: 'pill-gray', loaded_leaving: 'pill-blue', delivered: 'pill-green',
  exception: 'pill-red', cancelled: 'pill-red', new: 'pill-amber',
};
const STATUS_LABEL: Record<string, string> = {
  assigned: 'Scheduled', loaded_leaving: 'En Route', delivered: 'Delivered',
  exception: 'Exception', cancelled: 'Cancelled', new: 'Pending',
};
const ALL_STATUSES = [
  { value: 'assigned', label: 'Scheduled' },
  { value: 'loaded_leaving', label: 'Out for Delivery' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'exception', label: 'Exception' },
  { value: 'cancelled', label: 'Cancelled' },
];

/* ════════════════════════════════════════════════════════
   MAIN PAGE
   ════════════════════════════════════════════════════════ */
export default function DispatchSchedulePageWrapper() {
  return (
    <Suspense fallback={<div style={{ height: '100vh' }} />}>
      <DispatchSchedulePage />
    </Suspense>
  );
}

function DispatchSchedulePage() {
  const searchParams = useSearchParams();
  const [mounted, setMounted] = useState(false);
  const today = useMemo(() => new Date(), []);
  const [viewMode, setViewMode] = useState<'week' | 'month'>('week');
  const [selDate, setSelDate] = useState(today);
  const [navOffset, setNavOffset] = useState(0);

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    const dropId = searchParams.get('drop');
    if (dropId && mounted) openDrop(dropId);
  }, [mounted, searchParams]);

  const [capData, setCapData] = useState<Record<string, { A: CapWindow | null; B: CapWindow | null }>>({});
  const [monthSummary, setMonthSummary] = useState<Record<string, { drop_id: string; order_ref: string; customer_name: string; materials: string; window: string; status: string }[]>>({});
  const [schedule, setSchedule] = useState<ScheduleData | null>(null);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [error, setError] = useState('');
 const [needsAttention, setNeedsAttention] = useState<NeedsAttentionItem[]>([]);
  const [unscheduled, setUnscheduled] = useState<{ drop_id: string; order_number: number | null; customer_name: string; customer_phone: string; address_short: string; created_at: string; source: string }[]>([]);
  const [unschedLoading, setUnschedLoading] = useState(false);

  /* ── Slide-over state ── */
  const [slideDropId, setSlideDropId] = useState<string | null>(null);
  const [slideDropDetail, setSlideDropDetail] = useState<DropDetail | null>(null);
  const [slideStartReschedule, setSlideStartReschedule] = useState(false);
  /* ── Driver assignment state ── */



  const [drivers, setDrivers] = useState<Driver[]>([]);

  /* ── Compute visible date range ── */
  const visibleRange = useMemo(() => {
    if (viewMode === 'week') {
      const base = new Date(today);
      base.setDate(base.getDate() - base.getDay() + navOffset * 7);
      return Array.from({ length: 7 }, (_, i) => {
        const d = new Date(base); d.setDate(base.getDate() + i); return d;
      });
    } else {
      const baseMonth = today.getMonth() + navOffset;
      const y = today.getFullYear() + Math.floor(baseMonth / 12);
      const m = ((baseMonth % 12) + 12) % 12;
      const dim = daysInMonth(y, m);
      const dow = firstDow(y, m);
      const cells: { date: Date; other: boolean }[] = [];
      const prevDim = daysInMonth(y, m === 0 ? 11 : m - 1);
      for (let i = dow - 1; i >= 0; i--) cells.push({ date: new Date(y, m - 1, prevDim - i), other: true });
      for (let d = 1; d <= dim; d++) cells.push({ date: new Date(y, m, d), other: false });
      while (cells.length % 7 !== 0) {
        const next = cells.length - (dow + dim) + 1;
        cells.push({ date: new Date(y, m + 1, next), other: true });
      }
      return cells;
    }
  }, [today, viewMode, navOffset]);

  const headingText = useMemo(() => {
    if (viewMode === 'week') {
      const days = visibleRange as Date[];
      const first = days[0], last = days[6];
      return `${SHORT_MONTHS[first.getMonth()]} ${first.getDate()} – ${SHORT_MONTHS[last.getMonth()]} ${last.getDate()}, ${first.getFullYear()}`;
    } else {
      const baseMonth = today.getMonth() + navOffset;
      const y = today.getFullYear() + Math.floor(baseMonth / 12);
      const m = ((baseMonth % 12) + 12) % 12;
      return `${FULL_MONTHS[m]} ${y}`;
    }
  }, [today, viewMode, navOffset, visibleRange]);

  /* ── Location context ── */
  const { activeLocation } = useLocation();
  const locationParam = activeLocation ? `&location_id=${activeLocation.id}` : '';

  /* ── Data fetching ── */
  const fetchCapacity = useCallback(async () => {
    try {
      let startDate: string, days: number;
      if (viewMode === 'week') {
        const weekDays = visibleRange as Date[];
        startDate = toKey(weekDays[0]); days = 7;
      } else {
        const monthCells = visibleRange as { date: Date; other: boolean }[];
        const nonOther = monthCells.filter(c => !c.other);
        startDate = toKey(nonOther[0].date); days = nonOther.length;
      }
      const resp = await api(`/availability?start_date=${startDate}&days=${days}${locationParam}`);
      const map: Record<string, { A: CapWindow | null; B: CapWindow | null }> = {};
      for (const w of (resp.windows || [])) {
        if (!map[w.date]) map[w.date] = { A: null, B: null };
        map[w.date][w.window as 'A' | 'B'] = w;
      }
      setCapData(map);
    } catch { /* silently fail */ }
  }, [viewMode, visibleRange, locationParam]);

  const fetchMonthSummary = useCallback(async () => {
    try {
      let startDate: string, endDate: string;
      if (viewMode === 'week') {
        const weekDays = visibleRange as Date[];
        startDate = toKey(weekDays[0]); endDate = toKey(weekDays[weekDays.length - 1]);
      } else {
        const monthCells = visibleRange as { date: Date; other: boolean }[];
        const nonOther = monthCells.filter(c => !c.other);
        if (nonOther.length === 0) return;
        startDate = toKey(nonOther[0].date); endDate = toKey(nonOther[nonOther.length - 1].date);
      }
      const resp = await api(`/dispatch/month-summary?start_date=${startDate}&end_date=${endDate}${locationParam}`);
      setMonthSummary(resp.days || {});
    } catch { /* silently fail */ }
  }, [viewMode, visibleRange, locationParam]);

  const fetchSchedule = useCallback(async () => {
    setScheduleLoading(true); setError('');
    try {
      const resp = await api(`/dispatch/schedule?day=${toKey(selDate)}${locationParam}`);
      setSchedule(resp);
    } catch (err) {
      setError((err as ApiError).message || 'Failed to load schedule');
      setSchedule(null);
    } finally { setScheduleLoading(false); }
  }, [selDate, locationParam]);

  useEffect(() => { fetchCapacity(); }, [fetchCapacity]);
  useEffect(() => { fetchMonthSummary(); }, [fetchMonthSummary]);
  useEffect(() => { fetchSchedule(); }, [fetchSchedule]);
  useEffect(() => {
    api('/dispatch/drivers').then(d => setDrivers(d.drivers || [])).catch(() => null);
  }, []);
  useEffect(() => {
    api(`/dispatch/needs-attention${locationParam ? `?location_id=${activeLocation?.id}` : ''}`).then(r => setNeedsAttention(r.drops || [])).catch(() => null);
  }, [locationParam, activeLocation]);

  const fetchUnscheduled = useCallback(async () => {
    setUnschedLoading(true);
    try {
      const r = await api(`/dispatch/unscheduled${locationParam ? `?location_id=${activeLocation?.id}` : ''}`);
      setUnscheduled(r.drops || []);
    } catch { /* silent */ }
    finally { setUnschedLoading(false); }
  }, [locationParam, activeLocation]);

  useEffect(() => { fetchUnscheduled(); }, [fetchUnscheduled]);

  /* ── Open slide-over ── */
  const openDrop = async (dropId: string, startOnReschedule = false) => {
    setSlideDropId(dropId);
    setSlideStartReschedule(startOnReschedule);
    setSlideDropDetail(null);
    try {
      const resp = await api(`/dispatch/drops/${dropId}`);
      setSlideDropDetail(resp);
    } catch { setSlideDropDetail(null); }
  };

  const closeDrop = () => { setSlideDropId(null); setSlideDropDetail(null); };

  const handleRescheduled = async () => {
    setCapData({});
    await fetchSchedule();
    await fetchCapacity();
    fetchMonthSummary();
    api(`/dispatch/needs-attention${locationParam ? `?location_id=${activeLocation?.id}` : ''}`).then(r => setNeedsAttention(r.drops || [])).catch(() => null);
    if (slideDropId) {
      try {
        const resp = await api(`/dispatch/drops/${slideDropId}`);
        setSlideDropDetail(resp);
      } catch { /* ignore */ }
    }
  };

  /* ── Flatten loads ── */
  const getPriorityLoads = (): { driver: string; load: LoadItem }[] => {
    if (!schedule) return [];
    const groups = schedule.priority.groups;
    const result: { driver: string; load: LoadItem }[] = [];
    for (const load of (groups['Unassigned'] || [])) result.push({ driver: 'Unassigned', load });
    for (const [driver, loads] of Object.entries(groups)) {
      if (driver === 'Unassigned') continue;
      for (const load of loads) result.push({ driver, load });
    }
    return result;
  };

  const getWindowLoads = (windowCode: 'A' | 'B'): { driver: string; load: LoadItem }[] => {
    if (!schedule) return [];
    const groups = schedule.windows[windowCode].groups;
    const result: { driver: string; load: LoadItem }[] = [];
    for (const load of (groups['Unassigned'] || [])) result.push({ driver: 'Unassigned', load });
    for (const [driver, loads] of Object.entries(groups)) {
      if (driver === 'Unassigned') continue;
      for (const load of loads) result.push({ driver, load });
    }
    return result;
  };

  /* ── Render load card (read-only — editing via order panel) ── */
  const renderLoadCard = (driver: string, load: LoadItem) => {
    const displayStatus = driver === 'Unassigned' && load.status === 'assigned' ? 'pending' : load.status;
    const pillClass = displayStatus === 'pending' ? 'pill-amber' : (STATUS_PILL[load.status] || 'pill-gray');
    const pillLabel = displayStatus === 'pending' ? 'Pending' : (STATUS_LABEL[load.status] || load.status);
    return (
      <div key={load.id} className="order-row" onClick={() => openDrop(load.drop_id)}>
        <div className="order-info">
          <div className="order-ref">#{load.order_ref}</div>
          <div className="order-customer">{load.customer_name}</div>
          <div className="order-addr">{load.address_short}</div>
          <div className="order-material">{load.material} x{load.qty} {load.unit}</div>
          <div className="order-driver">
            {load.driver_name
              ? <span>🚚 {load.driver_name}</span>
              : <span className="order-unassigned">⚠ Unassigned</span>}
          </div>
        </div>
        <span className={`pill ${pillClass}`}><span className="pill-dot" />{pillLabel}</span>
      </div>
    );
  };

  if (!requireRole(['dispatcher'])) return <div className="page"><p>Unauthorized</p></div>;

  const selDateStr = `${DAYS[selDate.getDay()]}, ${FULL_MONTHS[selDate.getMonth()]} ${selDate.getDate()}, ${selDate.getFullYear()}`;
  const dayCap = capData[toKey(selDate)];
  const amCap = schedule?.windows.A.capacity || dayCap?.A || { used: 0, total: 0, remaining_capacity: 0 };
  const pmCap = schedule?.windows.B.capacity || dayCap?.B || { used: 0, total: 0, remaining_capacity: 0 };
  const priorityLoads = getPriorityLoads();
  const amLoads = getWindowLoads('A');
  const pmLoads = getWindowLoads('B');

  if (!mounted) return <div style={{ height: '100vh' }} />;

  return (
    <>
      <style>{schedulerStyles}</style>

      <div className="dispatch-layout">
        {/* ── LEFT: Calendar Panel ── */}
        <div className="cal-panel">
          <div className="cal-toolbar">
            <div className="cal-nav">
              <button className="cal-nav-btn" onClick={() => setNavOffset(n => n - 1)}>‹</button>
              <div className="cal-heading">{headingText}</div>
              <button className="cal-nav-btn" onClick={() => setNavOffset(n => n + 1)}>›</button>
            </div>
            <div className="cal-actions">
              <button className="btn btn-secondary btn-sm" onClick={() => { setNavOffset(0); setSelDate(today); }}>Today</button>
              <div className="view-toggle">
                <button className={`vt-btn${viewMode === 'week' ? ' on' : ''}`} onClick={() => { setViewMode('week'); setNavOffset(0); }}>Week</button>
                <button className={`vt-btn${viewMode === 'month' ? ' on' : ''}`} onClick={() => { setViewMode('month'); setNavOffset(0); }}>Month</button>
              </div>
            </div>
          </div>

          <div className="legend-row">
            <div className="legend-item"><div className="legend-dot" style={{ background: 'var(--green-500)' }} /> AM</div>
            <div className="legend-item"><div className="legend-dot" style={{ background: 'var(--blue-500)' }} /> PM</div>
            <div className="legend-item"><div className="legend-dot" style={{ background: 'var(--amber-500)' }} /> Priority</div>
          </div>

          <div className="cal-body">
            {/* ── Week View ── */}
            {viewMode === 'week' && (() => {
              const weekDays = visibleRange as Date[];
              return (
                <div className="week-grid">
                  <div className="week-header">
                    {weekDays.map((d, i) => (
                      <div key={i} className={`whd${sameDay(d, today) ? ' today' : ''}${sameDay(d, selDate) ? ' selected' : ''}`} onClick={() => setSelDate(new Date(d))}>
                        <div className="whd-name">{DAYS[d.getDay()]}</div>
                        <div className="whd-date">{d.getDate()}</div>
                      </div>
                    ))}
                  </div>
                  <div className="week-body">
                    {weekDays.map((d, i) => {
                      const k = toKey(d);
                      const dc = capData[k];
                      const amU = dc?.A?.used ?? 0, amT = dc?.A?.total ?? 0;
                      const pmU = dc?.B?.used ?? 0, pmT = dc?.B?.total ?? 0;
                      const dayDrops = monthSummary[k] || [];
                      return (
                        <div key={i} className={`week-col${sameDay(d, today) ? ' today' : ''}${sameDay(d, selDate) ? ' selected' : ''}`} onClick={() => setSelDate(new Date(d))}>
                          {(amT > 0 || pmT > 0) && (
                            <div>
                              <div className="cap-label"><span>Morning</span><span>{amU}/{amT || '—'}</span></div>
                              <div className="cap-bar"><div className={`cap-fill ${capColor(amU, amT)}`} style={{ width: amT > 0 ? `${Math.round(amU / amT * 100)}%` : '0%' }} /></div>
                              <div className="cap-label" style={{ marginTop: 4 }}><span>Afternoon</span><span>{pmU}/{pmT || '—'}</span></div>
                              <div className="cap-bar"><div className={`cap-fill ${capColor(pmU, pmT)}`} style={{ width: pmT > 0 ? `${Math.round(pmU / pmT * 100)}%` : '0%' }} /></div>
                            </div>
                          )}
                          {dayDrops.length > 0 && (
                            <div className="wk-drops">
                              {dayDrops.map((drop, di) => (
                                <div key={di}
                                  className={`wk-drop-chip ${drop.window === 'P' ? 'wk-chip-priority' : drop.window === 'A' ? 'wk-chip-am' : 'wk-chip-pm'}`}
                                  onClick={e => { e.stopPropagation(); openDrop(drop.drop_id); }}
                                >
                                  <span className="wk-chip-name">{drop.customer_name}</span>
                                  <span className="wk-chip-mat">{drop.materials}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {/* ── Month View ── */}
            {viewMode === 'month' && (() => {
              const monthCells = visibleRange as { date: Date; other: boolean }[];
              return (
                <div className="month-grid">
                  <div className="month-header">
                    {DAYS.map(d => <div key={d} className="month-dow">{d}</div>)}
                  </div>
                  <div className="month-body">
                    {monthCells.map((cell, i) => {
                      const k = toKey(cell.date);
                      const dc = capData[k];
                      const amU = dc?.A?.used ?? 0, amT = dc?.A?.total ?? 0;
                      const pmU = dc?.B?.used ?? 0, pmT = dc?.B?.total ?? 0;
                      const colors: Record<string, string> = { green: 'var(--green-500)', amber: 'var(--amber-400)', red: 'var(--red-500)' };
                      const dayDrops = monthSummary[k] || [];
                      return (
                        <div key={i}
                          className={`month-cell${cell.other ? ' other' : ''}${sameDay(cell.date, today) ? ' today' : ''}${sameDay(cell.date, selDate) ? ' selected' : ''}`}
                          onClick={() => !cell.other && setSelDate(new Date(cell.date))}
                        >
                          <div className="mc-date">{cell.date.getDate()}</div>
                          {!cell.other && dayDrops.length > 0 && (
                            <div className="mc-drops">
                              {dayDrops.slice(0, 3).map((d, di) => (
                                <div key={di}
                                  className={`mc-drop-chip ${d.window === 'P' ? 'mc-chip-priority' : d.window === 'A' ? 'mc-chip-am' : 'mc-chip-pm'}`}
                                  onClick={e => { e.stopPropagation(); openDrop(d.drop_id); }}
                                >
                                  <span className="mc-chip-name">{d.customer_name}</span>
                                </div>
                              ))}
                              {dayDrops.length > 3 && <div className="mc-drop-more">+{dayDrops.length - 3} more</div>}
                            </div>
                          )}
                          {!cell.other && (amT > 0 || pmT > 0) && (
                            <div className="mc-bars">
                              {amT > 0 && (
                                <div className="mc-cap-row">
                                  <div className="mc-cap-label"><span>AM</span><span>{amU}/{amT}</span></div>
                                  <div className="mc-bar-track"><div className="mc-bar" style={{ background: colors[capColor(amU, amT)], width: `${Math.max(Math.round(amU / amT * 100), amU > 0 ? 8 : 0)}%` }} /></div>
                                </div>
                              )}
                              {pmT > 0 && (
                                <div className="mc-cap-row">
                                  <div className="mc-cap-label"><span>PM</span><span>{pmU}/{pmT}</span></div>
                                  <div className="mc-bar-track"><div className="mc-bar" style={{ background: colors[capColor(pmU, pmT)], width: `${Math.max(Math.round(pmU / pmT * 100), pmU > 0 ? 8 : 0)}%` }} /></div>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}
          </div>
        </div>

        {/* ── RIGHT: Day Detail Panel ── */}
        <div className="detail-panel">
          <div className="detail-header">
            <div className="detail-date">{selDateStr}</div>
            <div className="detail-sub">
              {priorityLoads.length + amLoads.length + pmLoads.length} load{priorityLoads.length + amLoads.length + pmLoads.length !== 1 ? 's' : ''}
              {priorityLoads.length > 0 ? ` (${priorityLoads.length} priority)` : ''} · {(amCap.remaining_capacity ?? 0) + (pmCap.remaining_capacity ?? 0)} slots remaining
            </div>
          </div>

          {error && <div className="alert alert-error" style={{ margin: '12px 16px', fontSize: 13 }}>{error}</div>}

          {/* ── Unscheduled Queue ── */}
          {(unscheduled.length > 0 || unschedLoading) && (
            <div className="uq-section">
              <div className="uq-head">
                <span className="uq-icon">⏳</span>
                <span>Awaiting Schedule</span>
                {unschedLoading
                  ? <span className="uq-count">…</span>
                  : <span className="uq-count">{unscheduled.length}</span>}
              </div>
              {unschedLoading ? (
                <div style={{ padding: '12px 16px' }}><div className="spinner" style={{ width: 16, height: 16 }} /></div>
              ) : unscheduled.map(item => (
                <div key={item.drop_id} className="uq-row" onClick={() => openDrop(item.drop_id, false)}>
                  <div className="uq-row-info">
                    <div className="uq-row-name">{item.customer_name}</div>
                    <div className="uq-row-meta">{item.address_short} · {item.source === 'manual' ? 'Manual' : 'Online'}</div>
                  </div>
                  <button
                    className="uq-link-btn"
                    onClick={async e => {
                      e.stopPropagation();
                      try {
                        const r = await api(`/schedule/drops/${item.drop_id}/scheduling-link`, { method: 'POST' });
                        const link = `${window.location.origin}/schedule?token=${r.token}`;
                        const msg = `Hi ${item.customer_name.split(' ')[0]}, please use this link to schedule your delivery from East Meadow Garden Center: ${link}`;
                        await api(`/dispatch/drops/${item.drop_id}/send-notification`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ type: 'scheduling_link', scheduling_link: link, admin_override: true }),
                        });
                        fetchUnscheduled();
                      } catch { /* silent — dispatcher can use slide-over for details */ }
                    }}
                  >
                    🔗 Send Link
                  </button>
                  <div className="uq-row-action">View →</div>
                </div>
              ))}
            </div>
          )}

          {/* ── Needs Attention ── */}
          {needsAttention.length > 0 && (
            <div className="na-section">
              <div className="na-head">
                <span className="na-icon">🚨</span>
                <span>Needs Attention</span>
                <span className="na-count">{needsAttention.length}</span>
              </div>
              {needsAttention.map(item => (
                <div key={item.drop_id} className="na-row" onClick={() => openDrop(item.drop_id, false)}>
                  <div className="na-row-info">
                    <div className="na-row-name">{item.customer_name}</div>
                    <div className="na-row-meta">
                      #{item.ref} · {fmtShortDate(item.scheduled_date)} ·{' '}
                      {item.is_priority ? '⚡ Priority' : item.scheduled_window === 'A' ? 'Morning' : 'Afternoon'}
                    </div>
                  </div>
                  <div className="na-row-action">View Exception →</div>
                </div>
              ))}
            </div>
          )}
          {scheduleLoading ? (
            <div style={{ padding: 40, textAlign: 'center' }}><div className="spinner" style={{ margin: '0 auto' }} /></div>
          ) : (
            <>
              {/* Priority */}
              {priorityLoads.length > 0 && (
                <div className="window-section priority-section">
                  <div className="window-head">
                    <div className="window-title">⚡ Priority</div>
                    <span className="pill pill-amber pill-sm"><span className="pill-dot" />{priorityLoads.length} load{priorityLoads.length !== 1 ? 's' : ''}</span>
                  </div>
                  {priorityLoads.map(({ driver, load }) => renderLoadCard(driver, load))}
                </div>
              )}

              {/* AM Window */}
              <div className="window-section am">
                <div className="window-head">
                  <div className="window-title">Morning Window (9am – 1pm)</div>
                  <span className={`pill pill-sm pill-${capColor(amCap.used ?? 0, amCap.total ?? 0) === 'red' ? 'red' : capColor(amCap.used ?? 0, amCap.total ?? 0) === 'amber' ? 'amber' : 'green'}`}>
                    <span className="pill-dot" />{amCap.used ?? 0}/{amCap.total ?? 0}
                  </span>
                </div>
                <div className="window-bar">
                  <div className={`window-fill cap-fill ${capColor(amCap.used ?? 0, amCap.total ?? 0)}`}
                    style={{ width: (amCap.total ?? 0) > 0 ? `${Math.round((amCap.used ?? 0) / (amCap.total ?? 1) * 100)}%` : '0%' }} />
                </div>
                {amLoads.length === 0 ? <div className="no-loads">No deliveries scheduled</div>
                  : amLoads.map(({ driver, load }) => renderLoadCard(driver, load))}
              </div>

              {/* PM Window */}
              <div className="window-section pm">
                <div className="window-head">
                  <div className="window-title">Afternoon Window (1pm – 5pm)</div>
                  <span className={`pill pill-sm pill-${capColor(pmCap.used ?? 0, pmCap.total ?? 0) === 'red' ? 'red' : capColor(pmCap.used ?? 0, pmCap.total ?? 0) === 'amber' ? 'amber' : 'green'}`}>
                    <span className="pill-dot" />{pmCap.used ?? 0}/{pmCap.total ?? 0}
                  </span>
                </div>
                <div className="window-bar">
                  <div className={`window-fill cap-fill ${capColor(pmCap.used ?? 0, pmCap.total ?? 0)}`}
                    style={{ width: (pmCap.total ?? 0) > 0 ? `${Math.round((pmCap.used ?? 0) / (pmCap.total ?? 1) * 100)}%` : '0%' }} />
                </div>
                {pmLoads.length === 0 ? <div className="no-loads">No deliveries scheduled</div>
                  : pmLoads.map(({ driver, load }) => renderLoadCard(driver, load))}
              </div>


            </>
          )}
        </div>
      </div>
            
      {/* ── Slide-over ── */}
      {slideDropId && (
        <DropRescheduleSlideOver
          dropId={slideDropId}
          dropDetail={slideDropDetail}
          capData={capData}
          onClose={() => { setSlideDropId(null); setSlideDropDetail(null); }}
          onRescheduled={handleRescheduled}
          startOnReschedule={slideStartReschedule}
          locationId={activeLocation?.id ?? null}
        />
      )}
    </>
  );
}

/* ══════════════════════════════════════════════════════════
   STYLES
   ══════════════════════════════════════════════════════════ */
const schedulerStyles = `
  .dispatch-layout { display: flex; height: calc(100vh - var(--nav-height)); overflow: hidden; }

  /* ── Calendar Panel ── */
  .cal-panel { flex: 1; min-width: 0; display: flex; flex-direction: column; border-right: 1px solid var(--border); background: var(--surface); overflow: hidden; }
  .cal-toolbar { display: flex; align-items: center; justify-content: space-between; padding: 16px 24px; border-bottom: 1px solid var(--border-light); gap: 16px; flex-wrap: wrap; }
  .cal-nav { display: flex; align-items: center; gap: 10px; }
  .cal-nav-btn { width: 36px; height: 36px; border-radius: var(--radius-md); border: 1px solid var(--border); background: var(--surface); cursor: pointer; font-size: 18px; display: flex; align-items: center; justify-content: center; color: var(--gray-600); transition: all 0.15s var(--ease-out); font-family: inherit; box-shadow: var(--shadow-xs); }
  .cal-nav-btn:hover { background: var(--gray-50); color: var(--gray-900); box-shadow: var(--shadow-sm); }
  .cal-heading { font-family: var(--font-heading); font-size: 22px; font-weight: 800; color: var(--gray-900); min-width: 220px; text-align: center; letter-spacing: -0.02em; }
  .cal-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .cal-body { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
  .view-toggle { display: flex; background: var(--gray-100); border-radius: var(--radius-md); padding: 3px; gap: 2px; }
  .vt-btn { padding: 6px 16px; border: none; background: transparent; font-family: var(--font-heading); font-size: 13px; font-weight: 600; color: var(--gray-400); cursor: pointer; border-radius: var(--radius-sm); transition: all 0.15s var(--ease-out); }
  .vt-btn.on { background: var(--surface); color: var(--gray-900); box-shadow: var(--shadow-sm); }
  .vt-btn:hover:not(.on) { color: var(--gray-600); }
  .legend-row { display: flex; gap: 18px; padding: 10px 24px; border-bottom: 1px solid var(--border-light); font-size: 12px; color: var(--gray-500); font-weight: 500; font-family: var(--font-heading); }
  .legend-item { display: flex; align-items: center; gap: 6px; }
  .legend-dot { width: 8px; height: 8px; border-radius: 50%; }

  /* ── Week view ── */
  .week-grid { flex: 1; display: grid; grid-template-columns: repeat(7, 1fr); grid-template-rows: auto 1fr; overflow: hidden; }
  .week-header { display: contents; }
  .whd { text-align: center; padding: 12px 4px; cursor: pointer; transition: all 0.15s var(--ease-out); border-right: 1px solid var(--border-light); border-bottom: 1px solid var(--border); }
  .whd:last-child { border-right: none; }
  .whd:hover { background: var(--gray-50); }
  .whd.today { background: var(--green-25); }
  .whd.selected { background: var(--green-50); }
  .whd-name { font-family: var(--font-heading); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--gray-400); }
  .whd-date { font-family: var(--font-heading); font-size: 22px; font-weight: 800; margin-top: 2px; color: var(--gray-900); letter-spacing: -0.02em; }
  .whd.today .whd-date { color: var(--green-600); }
  .week-body { display: contents; }
  .week-col { overflow-y: auto; grid-row: 2; }
  .week-col { border-right: 1px solid var(--border-light); padding: 14px 10px; cursor: pointer; transition: background 0.12s; display: flex; flex-direction: column; gap: 8px; min-height: 160px; }
  .week-col:last-child { border-right: none; }
  .week-col:hover { background: var(--gray-25); }
  .week-col.today { background: var(--green-25); }
  .week-col.selected { background: rgba(15,133,48,0.04); }
  .wk-drops { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; overflow-y: auto; flex: 1; }
  .wk-drop-chip { padding: 5px 8px; border-radius: var(--radius-sm); font-family: var(--font-heading); border-left: 3px solid; cursor: pointer; transition: all 0.12s; }
  .wk-drop-chip:hover { transform: translateX(2px); box-shadow: var(--shadow-sm); }
  .wk-chip-am { background: rgba(26,158,58,0.07); border-left-color: var(--green-500); }
  .wk-chip-pm { background: rgba(37,99,235,0.05); border-left-color: var(--blue-500); }
  .wk-chip-priority { background: rgba(245,158,11,0.1); border-left-color: var(--amber-500, #f59e0b); }
  .wk-chip-name { display: block; font-size: 11.5px; font-weight: 700; color: var(--gray-800); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .wk-chip-mat { display: block; font-size: 10px; font-weight: 500; color: var(--gray-500); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* ── Capacity bars ── */
  .cap-row { display: flex; flex-direction: column; gap: 4px; }
  .cap-label { display: flex; justify-content: space-between; font-family: var(--font-heading); font-size: 10px; font-weight: 700; color: var(--gray-400); letter-spacing: 0.02em; }
  .cap-bar { height: 5px; border-radius: 3px; background: var(--gray-100); overflow: hidden; }
  .cap-fill { height: 100%; border-radius: 3px; transition: width 0.3s var(--ease-out); }
  .cap-fill.green { background: var(--green-500); }
  .cap-fill.amber { background: var(--amber-400); }
  .cap-fill.red { background: var(--red-500); }

  /* ── Month view ── */
  .month-grid { display: flex; flex-direction: column; flex: 1; overflow: hidden; }
  .month-header { display: grid; grid-template-columns: repeat(7, 1fr); border-bottom: 1px solid var(--border-light); }
  .month-dow { text-align: center; padding: 8px 4px; font-family: var(--font-heading); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--gray-400); }
  .month-body { display: grid; grid-template-columns: repeat(7, 1fr); grid-auto-rows: 1fr; flex: 1; overflow-y: auto; }
  .month-cell { border-right: 1px solid var(--border-light); border-bottom: 1px solid var(--border-light); padding: 8px; cursor: pointer; transition: background 0.12s; min-height: 90px; display: flex; flex-direction: column; gap: 4px; }
  .month-cell:hover:not(.other) { background: var(--gray-25); }
  .month-cell.other { opacity: 0.35; cursor: default; }
  .month-cell.today { background: var(--green-25); }
  .month-cell.selected { background: rgba(15,133,48,0.06); box-shadow: inset 0 0 0 2px var(--green-300); }
  .mc-date { font-family: var(--font-heading); font-size: 13px; font-weight: 800; color: var(--gray-700); }
  .month-cell.today .mc-date { color: var(--green-600); }
  .mc-drops { display: flex; flex-direction: column; gap: 2px; flex: 1; }
  .mc-drop-chip { padding: 3px 6px; border-radius: 3px; font-size: 10px; font-family: var(--font-heading); font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.4; border-left: 3px solid; cursor: pointer; transition: opacity 0.12s; }
  .mc-drop-chip:hover { opacity: 0.8; }
  .mc-chip-am { background: rgba(26,158,58,0.08); border-left-color: var(--green-500); color: var(--gray-700); }
  .mc-chip-pm { background: rgba(37,99,235,0.06); border-left-color: var(--blue-500); color: var(--gray-700); }
  .mc-chip-priority { background: rgba(245,158,11,0.1); border-left-color: var(--amber-500); color: var(--gray-700); }
  .mc-chip-name { display: block; overflow: hidden; text-overflow: ellipsis; }
  .mc-drop-more { font-family: var(--font-heading); font-size: 10px; font-weight: 700; color: var(--gray-400); padding-left: 6px; }
  .mc-bars { display: flex; flex-direction: column; gap: 3px; margin-top: auto; }
  .mc-cap-row { display: flex; flex-direction: column; gap: 2px; }
  .mc-cap-label { font-family: var(--font-heading); font-size: 10px; font-weight: 700; color: var(--gray-400); display: flex; justify-content: space-between; letter-spacing: 0.02em; }
  .mc-bar-track { height: 4px; border-radius: 2px; background: var(--gray-100); overflow: hidden; }
  .mc-bar { height: 4px; border-radius: 2px; transition: width 0.3s var(--ease-out); }

/* ── Unscheduled Queue ── */
  .uq-section { background: #fffbeb; border-top: 2px solid #f59e0b; border-bottom: 1px solid #fde68a; margin: 12px 16px; border-radius: 10px; box-shadow: 0 0 0 1px #fde68a; }
  .uq-head { display: flex; align-items: center; gap: 8px; padding: 10px 16px 8px; font-family: var(--font-heading); font-size: 13px; font-weight: 800; color: #92400e; text-transform: uppercase; letter-spacing: 0.05em; }
  .uq-icon { font-size: 15px; }
  .uq-count { margin-left: auto; background: #d97706; color: #fff; border-radius: 10px; font-size: 11px; font-weight: 800; padding: 1px 7px; }
  .uq-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; border-top: 1px solid #fde68a; transition: background 0.12s; gap: 10px; cursor: pointer; }
  .uq-row:hover { background: #fef3c7; }
  .uq-row-info { flex: 1; min-width: 0; }
  .uq-row-name { font-family: var(--font-heading); font-size: 14px; font-weight: 700; color: var(--gray-900); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .uq-row-meta { font-size: 12px; color: #92400e; margin-top: 2px; }
  .uq-link-btn { font-size: 12px; font-weight: 700; color: #92400e; background: #fde68a; border: 1px solid #f59e0b; border-radius: 6px; padding: 4px 8px; cursor: pointer; white-space: nowrap; flex-shrink: 0; font-family: inherit; transition: background 0.12s; }
  .uq-link-btn:hover { background: #fcd34d; }
  .uq-row-action { font-size: 12px; font-weight: 700; color: #d97706; white-space: nowrap; flex-shrink: 0; }

  /* ── Needs Attention ── */
  .na-section { background: #fff1f2; border-top: 2px solid #f43f5e; border-bottom: 1px solid #fecdd3; margin: 12px 16px; border-radius: 10px; overflow: hidden; box-shadow: 0 0 0 1px #fecdd3; }
  .na-head { display: flex; align-items: center; gap: 8px; padding: 10px 16px 8px; font-family: var(--font-heading); font-size: 13px; font-weight: 800; color: #be123c; text-transform: uppercase; letter-spacing: 0.05em; }
  .na-icon { font-size: 15px; }
  .na-count { margin-left: auto; background: #e11d48; color: #fff; border-radius: 10px; font-size: 11px; font-weight: 800; padding: 1px 7px; }
  .na-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; cursor: pointer; border-top: 1px solid #fecdd3; transition: background 0.12s; gap: 12px; }
  .na-row:hover { background: #ffe4e6; }
  .na-row-info { flex: 1; min-width: 0; }
  .na-row-name { font-family: var(--font-heading); font-size: 14px; font-weight: 700; color: var(--gray-900); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .na-row-meta { font-size: 12px; color: #be123c; margin-top: 2px; }
  .na-row-action { font-size: 12px; font-weight: 700; color: #e11d48; white-space: nowrap; flex-shrink: 0; }

  /* ── Right detail panel ── */
  .detail-panel { width: 420px; flex-shrink: 0; background: var(--bg-primary); overflow-y: auto; border-left: 1px solid var(--border-light); height: calc(100vh - var(--nav-height)); }
  .detail-header { padding: 24px; border-bottom: 1px solid var(--border-light); }
  .detail-date { font-family: var(--font-heading); font-size: 24px; font-weight: 800; color: var(--gray-900); letter-spacing: -0.025em; }
  .detail-sub { font-size: 14px; color: var(--gray-500); margin-top: 4px; }
  .window-section { padding: 18px 24px; border-bottom: 1px solid var(--border-light); border-left: 4px solid transparent; }
  .window-section.am { background: rgba(26,158,58,0.05); border-left-color: var(--green-500); }
  .window-section.am .window-title { color: var(--green-800, #166534); }
  .window-section.pm { background: rgba(37,99,235,0.05); border-left-color: var(--blue-500); }
  .window-section.pm .window-title { color: #1e40af; }
  .window-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
  .window-title { font-family: var(--font-heading); font-size: 15px; font-weight: 700; color: var(--gray-800); }
  .window-bar { height: 8px; border-radius: 4px; background: var(--gray-100); overflow: hidden; margin-bottom: 14px; }
  .window-fill { height: 100%; border-radius: 4px; transition: width 0.3s var(--ease-out); }
  .no-loads { font-size: 14px; color: var(--gray-400); padding: 8px 0; font-style: italic; }
  .priority-section { background: rgba(245,158,11,0.07); border-left: 4px solid var(--amber-500, #f59e0b); }
  .priority-section .window-title { color: #92400e; }

  /* ── Load cards ── */
  .order-row { display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px; border-radius: var(--radius-lg); cursor: pointer; transition: all 0.15s var(--ease-out); border: 1px solid var(--border-light); margin-bottom: 6px; background: var(--surface); }
  .order-row:hover { border-color: var(--green-200); box-shadow: var(--shadow-sm); }
  .order-info { flex: 1; min-width: 0; }
  .order-ref { font-family: var(--font-heading); font-size: 11px; font-weight: 700; color: var(--gray-400); text-transform: uppercase; letter-spacing: 0.05em; }
  .order-customer { font-family: var(--font-heading); font-size: 14px; font-weight: 700; color: var(--gray-900); }
  .order-addr { font-size: 12px; color: var(--gray-500); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .order-material { font-size: 12px; color: var(--gray-600); font-weight: 500; }
  .order-driver { font-size: 12px; color: var(--gray-500); margin-top: 4px; }
  .order-unassigned { font-size: 12px; color: var(--amber-600,#d97706); font-weight: 600; }

  .dm-status-select { width: auto; min-width: 140px; padding: 4px 8px; font-size: 12px; font-weight: 600; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); cursor: pointer; font-family: inherit; }

  /* ── Responsive layout ── */
  @media (max-width: 900px) {
    .dispatch-layout { flex-direction: column; height: auto; }
    .cal-panel { border-right: none; border-bottom: 1px solid var(--border); max-height: 50vh; }
    .detail-panel { width: 100%; border-left: none; }
    .week-col { min-height: 100px; }
    .month-cell { min-height: 60px; }
  }
  @media (max-width: 600px) {
    .cal-toolbar { flex-direction: column; align-items: stretch; gap: 8px; }
    .cal-nav { justify-content: center; }
    .cal-actions { justify-content: center; flex-wrap: wrap; }
    .legend-row { flex-wrap: wrap; gap: 8px; }
    .detail-panel { width: 100%; }
  }

  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
`;
