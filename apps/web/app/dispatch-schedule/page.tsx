'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState, useCallback } from 'react';
import { ApiError, api, requireRole, getSession } from '../lib/auth';

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
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  return `${days[d.getDay()]}, ${FULL_MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

type CapWindow = { date: string; window: string; used: number; total: number; remaining_capacity: number; available: boolean; active_holds: number };
type LoadItem = { id: string; drop_id: string; order_ref: string; status: string; material: string; qty: number; unit: string; customer_name: string; customer_phone: string; address_short: string; driver_name: string; driver_user_id: string | null; historical_flags?: any };
type ScheduleData = {
  date: string;
  windows: {
    A: { capacity: { used: number; total: number; remaining_capacity: number }; groups: Record<string, LoadItem[]>; disabled: boolean };
    B: { capacity: { used: number; total: number; remaining_capacity: number }; groups: Record<string, LoadItem[]>; disabled: boolean };
  };
};
type DropDetailModal = {
  id: string; ref: string; order_number: number | null; external_order_id: string | null; source: string;
  scheduled_date: string; scheduled_window: string;
  customer_name: string; customer_phone: string; delivery_address: { line1: string; line2?: string | null; city: string; state: string; postal_code: string } | null;
  notes: string | null; required_loads: number;
  loads: { id: string; material: string; qty: number; unit: string; status: string; driver_user_id: string | null; driver_name: string | null }[];
  notify_sent_at: string | null; last_reschedule_sms_at: string | null;
};
type Driver = { id: string; email: string; name: string; truck: string | null };

function capColor(used: number, total: number): string {
  if (total === 0) return 'green';
  const pct = used / total;
  if (pct >= 1) return 'red';
  if (pct >= 0.75) return 'amber';
  return 'green';
}

function capColorVar(c: string) {
  if (c === 'red') return 'var(--red-600)';
  if (c === 'amber') return 'var(--amber-600)';
  return 'var(--green-600)';
}

const STATUS_PILL: Record<string, string> = {
  assigned: 'pill-gray', loaded_leaving: 'pill-blue', delivered: 'pill-green',
  exception: 'pill-red', cancelled: 'pill-red', new: 'pill-amber',
};
const STATUS_LABEL: Record<string, string> = {
  assigned: 'Assigned', loaded_leaving: 'En Route', delivered: 'Delivered',
  exception: 'Exception', cancelled: 'Cancelled', new: 'Pending',
};
const ALL_STATUSES = [
  { value: 'assigned', label: 'Assigned' },
  { value: 'loaded_leaving', label: 'Out for Delivery' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'exception', label: 'Exception' },
  { value: 'cancelled', label: 'Cancelled' },
];

export default function DispatchSchedulePage() {
  const [mounted, setMounted] = useState(false);
  const today = useMemo(() => new Date(), []);
  const [viewMode, setViewMode] = useState<'week' | 'month'>('week');
  const [selDate, setSelDate] = useState(today);
  const [navOffset, setNavOffset] = useState(0);

  useEffect(() => { setMounted(true); }, []);

  const [capData, setCapData] = useState<Record<string, { A: CapWindow | null; B: CapWindow | null }>>({});
  const [monthSummary, setMonthSummary] = useState<Record<string, { drop_id: string; order_ref: string; customer_name: string; materials: string; window: string; status: string }[]>>({});
  const [schedule, setSchedule] = useState<ScheduleData | null>(null);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [dropDetail, setDropDetail] = useState<DropDetailModal | null>(null);
  const [selectedDropId, setSelectedDropId] = useState<string | null>(null);
  const [error, setError] = useState('');

  // Driver assignment state
  const [assignLoadIds, setAssignLoadIds] = useState<string[]>([]);
  const [assignDriverId, setAssignDriverId] = useState('');
  const [assignBusy, setAssignBusy] = useState(false);
  const [assignMsg, setAssignMsg] = useState('');
  const [reassigningLoadId, setReassigningLoadId] = useState<string | null>(null);
  const [updatingStatusId, setUpdatingStatusId] = useState<string | null>(null);
  const [drivers, setDrivers] = useState<Driver[]>([]);

  /* ── Compute visible date range ── */
  const visibleRange = useMemo(() => {
    if (viewMode === 'week') {
      const base = new Date(today);
      base.setDate(base.getDate() - base.getDay() + navOffset * 7);
      return Array.from({ length: 7 }, (_, i) => {
        const d = new Date(base);
        d.setDate(base.getDate() + i);
        return d;
      });
    } else {
      const baseMonth = today.getMonth() + navOffset;
      const y = today.getFullYear() + Math.floor(baseMonth / 12);
      const m = ((baseMonth % 12) + 12) % 12;
      const dim = daysInMonth(y, m);
      const dow = firstDow(y, m);
      const cells: { date: Date; other: boolean }[] = [];
      // Previous month padding
      const prevDim = daysInMonth(y, m === 0 ? 11 : m - 1);
      for (let i = dow - 1; i >= 0; i--) {
        const d = new Date(y, m - 1, prevDim - i);
        cells.push({ date: d, other: true });
      }
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
      const first = days[0];
      const last = days[6];
      return `${SHORT_MONTHS[first.getMonth()]} ${first.getDate()} – ${SHORT_MONTHS[last.getMonth()]} ${last.getDate()}, ${first.getFullYear()}`;
    } else {
      const baseMonth = today.getMonth() + navOffset;
      const y = today.getFullYear() + Math.floor(baseMonth / 12);
      const m = ((baseMonth % 12) + 12) % 12;
      return `${FULL_MONTHS[m]} ${y}`;
    }
  }, [today, viewMode, navOffset, visibleRange]);

  /* ── Fetch capacity data for visible range ── */
  const fetchCapacity = useCallback(async () => {
    try {
      let startDate: string;
      let days: number;
      if (viewMode === 'week') {
        const weekDays = visibleRange as Date[];
        startDate = toKey(weekDays[0]);
        days = 7;
      } else {
        const monthCells = visibleRange as { date: Date; other: boolean }[];
        const nonOther = monthCells.filter(c => !c.other);
        startDate = toKey(nonOther[0].date);
        days = nonOther.length;
      }
      const resp = await api(`/availability?start_date=${startDate}&days=${days}`);
      const map: Record<string, { A: CapWindow | null; B: CapWindow | null }> = {};
      for (const w of (resp.windows || [])) {
        if (!map[w.date]) map[w.date] = { A: null, B: null };
        map[w.date][w.window as 'A' | 'B'] = w;
      }
      setCapData(map);
    } catch {
      // Silently fail — calendar will show empty
    }
  }, [viewMode, visibleRange]);

  useEffect(() => { fetchCapacity(); }, [fetchCapacity]);

  /* ── Fetch delivery summary for calendar cards ── */
  const fetchMonthSummary = useCallback(async () => {
    try {
      let startDate: string, endDate: string;
      if (viewMode === 'week') {
        const weekDays = visibleRange as Date[];
        startDate = toKey(weekDays[0]);
        endDate = toKey(weekDays[weekDays.length - 1]);
      } else {
        const monthCells = visibleRange as { date: Date; other: boolean }[];
        const nonOther = monthCells.filter(c => !c.other);
        if (nonOther.length === 0) return;
        startDate = toKey(nonOther[0].date);
        endDate = toKey(nonOther[nonOther.length - 1].date);
      }
      const resp = await api(`/dispatch/month-summary?start_date=${startDate}&end_date=${endDate}`);
      setMonthSummary(resp.days || {});
    } catch {
      // Silently fail
    }
  }, [viewMode, visibleRange]);

  useEffect(() => { fetchMonthSummary(); }, [fetchMonthSummary]);

  /* ── Fetch schedule for selected day ── */
  const fetchSchedule = useCallback(async () => {
    setScheduleLoading(true);
    setError('');
    setAssignLoadIds([]);
    setAssignMsg('');
    try {
      const resp = await api(`/dispatch/schedule?day=${toKey(selDate)}`);
      setSchedule(resp);
    } catch (err) {
      const e = err as ApiError;
      setError(e.message || 'Failed to load schedule');
      setSchedule(null);
    } finally {
      setScheduleLoading(false);
    }
  }, [selDate]);

  useEffect(() => { fetchSchedule(); }, [fetchSchedule]);

  // Fetch available drivers
  useEffect(() => {
    api('/dispatch/drivers').then(d => setDrivers(d.drivers || [])).catch(() => null);
  }, []);

  /* ── Drop detail modal ── */
  const openDrop = async (dropId: string) => {
    setSelectedDropId(dropId);
    try {
      const resp = await api(`/dispatch/drops/${dropId}`);
      setDropDetail(resp);
    } catch {
      setDropDetail(null);
    }
  };

  /* ── Assign loads ── */
  const handleAssign = async () => {
    if (!assignLoadIds.length || !assignDriverId) return;
    setAssignBusy(true);
    setAssignMsg('');
    try {
      await api('/dispatch/loads/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ load_ids: assignLoadIds, driver_user_id: assignDriverId }),
      });
      setAssignMsg(`Assigned ${assignLoadIds.length} load(s) successfully.`);
      setAssignLoadIds([]);
      await fetchSchedule();
      await fetchCapacity();
      fetchMonthSummary();
    } catch (err) {
      const e = err as ApiError;
      setAssignMsg(e.message || 'Assignment failed.');
    } finally {
      setAssignBusy(false);
    }
  };

  const reassignDriver = async (loadId: string, driverId: string) => {
    setReassigningLoadId(loadId);
    try {
      await api('/dispatch/loads/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ load_ids: [loadId], driver_user_id: driverId || null }),
      });
      // Refresh modal data
      if (selectedDropId) {
        const resp = await api(`/dispatch/drops/${selectedDropId}`);
        setDropDetail(resp);
      }
      await fetchSchedule();
    } catch (err) {
      setError((err as ApiError).message || 'Reassignment failed');
    } finally { setReassigningLoadId(null); }
  };
const updateLoadStatus = async (loadId: string, newStatus: string) => {
    setUpdatingStatusId(loadId);
    try {
      await api(`/dispatch/loads/${loadId}/status`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      // Refresh modal and schedule
      if (selectedDropId) {
        const resp = await api(`/dispatch/drops/${selectedDropId}`);
        setDropDetail(resp);
      }
      await fetchSchedule();
      fetchMonthSummary();
    } catch (err) {
      setError((err as ApiError).message || 'Status update failed');
    } finally { setUpdatingStatusId(null); }
  };
  /* ── Load toggle ── */
  const toggleLoad = (loadId: string) => {
    setAssignLoadIds(prev => prev.includes(loadId) ? prev.filter(id => id !== loadId) : [...prev, loadId]);
  };

  /* ── Render a load card (shared by AM/PM) ── */
  const renderLoadCard = (driver: string, load: LoadItem) => {
    const displayStatus = driver === 'Unassigned' && load.status === 'assigned' ? 'pending' : load.status;
    const pillClass = displayStatus === 'pending' ? 'pill-amber' : (STATUS_PILL[load.status] || 'pill-gray');
    const pillLabel = displayStatus === 'pending' ? 'Pending' : (STATUS_LABEL[load.status] || load.status);
    const isTerminal = ['delivered', 'cancelled'].includes(load.status);
    return (
      <div key={load.id} className="order-row" onClick={() => openDrop(load.drop_id)}>
        <label className="order-check" onClick={e => e.stopPropagation()}>
          <input type="checkbox" checked={assignLoadIds.includes(load.id)} onChange={() => toggleLoad(load.id)} />
        </label>
        <div className="order-info">
          <div className="order-ref">#{load.order_ref}</div>
          <div className="order-customer">{load.customer_name}</div>
          <div className="order-addr">{load.address_short}</div>
          <div className="order-material">{load.material} x{load.qty} {load.unit}</div>
          <div className="order-driver-row" onClick={e => e.stopPropagation()}>
            {isTerminal ? (
              <span className="order-driver">{load.driver_name || '—'}</span>
            ) : (
              <select
                className="order-driver-select"
                value={load.driver_user_id || ''}
                disabled={reassigningLoadId === load.id}
                onChange={e => { e.stopPropagation(); reassignDriver(load.id, e.target.value); }}
              >
                <option value="">⚠️ Unassigned</option>
                {drivers.map(d => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            )}
            {reassigningLoadId === load.id && <span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />}
          </div>
        </div>
        <span className={`pill ${pillClass}`}>
          <span className="pill-dot" />{pillLabel}
        </span>
      </div>
    );
  };

  /* ── Flatten loads by window ── */
  const getWindowLoads = (windowCode: 'A' | 'B'): { driver: string; load: LoadItem }[] => {
    if (!schedule) return [];
    const groups = schedule.windows[windowCode].groups;
    const result: { driver: string; load: LoadItem }[] = [];
    // Unassigned first
    for (const load of (groups['Unassigned'] || [])) {
      result.push({ driver: 'Unassigned', load });
    }
    for (const [driver, loads] of Object.entries(groups)) {
      if (driver === 'Unassigned') continue;
      for (const load of loads) {
        result.push({ driver, load });
      }
    }
    return result;
  };

  if (!requireRole(['dispatcher'])) return <div className="page"><p>Unauthorized</p></div>;

  const selDateStr = `${DAYS[selDate.getDay()]}, ${FULL_MONTHS[selDate.getMonth()]} ${selDate.getDate()}, ${selDate.getFullYear()}`;
  const dayCap = capData[toKey(selDate)];
  const amCap = schedule?.windows.A.capacity || dayCap?.A || { used: 0, total: 0, remaining_capacity: 0 };
  const pmCap = schedule?.windows.B.capacity || dayCap?.B || { used: 0, total: 0, remaining_capacity: 0 };
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
              <Link href="/new-drop" className="btn btn-primary btn-sm" style={{ textDecoration: 'none' }}>+ New Order</Link>
            </div>
          </div>

          <div className="legend-row">
            <div className="legend-item"><div className="legend-dot" style={{ background: 'var(--green-500)' }} />Available</div>
            <div className="legend-item"><div className="legend-dot" style={{ background: 'var(--amber-400)' }} />Filling Up</div>
            <div className="legend-item"><div className="legend-dot" style={{ background: 'var(--red-500)' }} />Full</div>
          </div>

          {/* Week View */}
          {viewMode === 'week' && (() => {
            const weekDays = visibleRange as Date[];
            return (
              <div className="week-grid">
                <div className="week-header">
                  {weekDays.map(day => (
                    <div
                      key={toKey(day)}
                      className={`whd${sameDay(day, today) ? ' today' : ''}${sameDay(day, selDate) ? ' selected' : ''}`}
                      onClick={() => setSelDate(new Date(day))}
                    >
                      <div className="whd-name">{DAYS[day.getDay()]}</div>
                      <div className="whd-date">{day.getDate()}</div>
                    </div>
                  ))}
                </div>
                <div className="week-body">
                  {weekDays.map(day => {
                    const k = toKey(day);
                    const dc = capData[k];
                    const amU = dc?.A?.used ?? 0, amT = dc?.A?.total ?? 0;
                    const pmU = dc?.B?.used ?? 0, pmT = dc?.B?.total ?? 0;
                    return (
                      <div
                        key={k}
                        className={`week-col${sameDay(day, today) ? ' today' : ''}${sameDay(day, selDate) ? ' selected' : ''}`}
                        onClick={() => setSelDate(new Date(day))}
                      >
                        <div className="cap-row">
                          <div className="cap-label"><span>AM</span><span>{amU}/{amT || '—'}</span></div>
                          <div className="cap-bar"><div className={`cap-fill ${capColor(amU, amT)}`} style={{ width: amT > 0 ? `${Math.round(amU / amT * 100)}%` : '0%' }} /></div>
                          <div className="cap-label" style={{ marginTop: 4 }}><span>PM</span><span>{pmU}/{pmT || '—'}</span></div>
                          <div className="cap-bar"><div className={`cap-fill ${capColor(pmU, pmT)}`} style={{ width: pmT > 0 ? `${Math.round(pmU / pmT * 100)}%` : '0%' }} /></div>
                        </div>
                        {(monthSummary[k] || []).length > 0 && (
                          <div className="wk-drops">
                            {(monthSummary[k] || []).map((d, di) => (
                              <div key={di} className={`wk-drop-chip ${d.window === 'A' ? 'wk-chip-am' : 'wk-chip-pm'}`}>
                                <span className="wk-chip-name">{d.customer_name}</span>
                                <span className="wk-chip-mat">{d.materials}</span>
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

          {/* Month View */}
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
                      <div
                        key={i}
                        className={`month-cell${cell.other ? ' other' : ''}${sameDay(cell.date, today) ? ' today' : ''}${sameDay(cell.date, selDate) ? ' selected' : ''}`}
                        onClick={() => !cell.other && setSelDate(new Date(cell.date))}
                      >
                        <div className="mc-date">{cell.date.getDate()}</div>
                        {!cell.other && dayDrops.length > 0 && (
                          <div className="mc-drops">
                            {dayDrops.slice(0, 3).map((d, di) => (
                              <div key={di} className={`mc-drop-chip ${d.window === 'A' ? 'mc-chip-am' : 'mc-chip-pm'}`}>
                                <span className="mc-chip-name">{d.customer_name}</span>
                              </div>
                            ))}
                            {dayDrops.length > 3 && (
                              <div className="mc-drop-more">+{dayDrops.length - 3} more</div>
                            )}
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

        {/* ── RIGHT: Day Detail Panel ── */}
        <div className="detail-panel">
          <div className="detail-header">
            <div className="detail-date">{selDateStr}</div>
            <div className="detail-sub">
              {amLoads.length + pmLoads.length} load{amLoads.length + pmLoads.length !== 1 ? 's' : ''} · {(amCap.remaining_capacity ?? 0) + (pmCap.remaining_capacity ?? 0)} slots remaining
            </div>
            <button className="btn btn-secondary btn-sm" onClick={() => { fetchSchedule(); fetchCapacity(); fetchMonthSummary(); }} style={{ marginTop: 8 }}>
              Refresh
            </button>
          </div>

          {error && <div className="alert alert-error" style={{ margin: '12px 20px' }}><span>⚠</span> {error}</div>}
          {scheduleLoading && <div style={{ padding: 32, textAlign: 'center' }}><div className="spinner spinner-lg" style={{ margin: '0 auto' }} /></div>}

          {!scheduleLoading && schedule && (
            <>
              {/* AM Window */}
              <div className="window-section">
                <div className="window-head">
                  <div className="window-title">🌅 AM Window (9am–1pm)</div>
                  <span style={{ fontSize: 13, fontWeight: 600, color: capColorVar(capColor(amCap.used, amCap.total)) }}>
                    {amCap.used}/{amCap.total} loads
                  </span>
                </div>
                <div className="window-bar">
                  <div className={`window-fill cap-fill ${capColor(amCap.used, amCap.total)}`} style={{ width: amCap.total > 0 ? `${Math.round(amCap.used / amCap.total * 100)}%` : '0%' }} />
                </div>
                {schedule.windows.A.disabled && <div className="alert alert-warning" style={{ marginBottom: 12, fontSize: 13 }}>⚠ This window is blacked out for new scheduling</div>}
                {amLoads.length === 0 && <div className="no-loads">No loads in this window</div>}
                {amLoads.map(({ driver, load }) => renderLoadCard(driver, load))}
              </div>

              {/* PM Window */}
              <div className="window-section">
                <div className="window-head">
                  <div className="window-title">🌤 PM Window (1pm–5pm)</div>
                  <span style={{ fontSize: 13, fontWeight: 600, color: capColorVar(capColor(pmCap.used, pmCap.total)) }}>
                    {pmCap.used}/{pmCap.total} loads
                  </span>
                </div>
                <div className="window-bar">
                  <div className={`window-fill cap-fill ${capColor(pmCap.used, pmCap.total)}`} style={{ width: pmCap.total > 0 ? `${Math.round(pmCap.used / pmCap.total * 100)}%` : '0%' }} />
                </div>
                {schedule.windows.B.disabled && <div className="alert alert-warning" style={{ marginBottom: 12, fontSize: 13 }}>⚠ This window is blacked out for new scheduling</div>}
                {pmLoads.length === 0 && <div className="no-loads">No loads in this window</div>}
                {pmLoads.map(({ driver, load }) => renderLoadCard(driver, load))}
              </div>

              {/* Assignment bar */}
              {assignLoadIds.length > 0 && (
                <div className="assign-bar">
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{assignLoadIds.length} load{assignLoadIds.length !== 1 ? 's' : ''} selected</div>
                  <select
                    value={assignDriverId}
                    onChange={e => setAssignDriverId(e.target.value)}
                    style={{ flex: 1, padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', fontFamily: 'inherit', fontSize: 14, background: 'var(--surface)' }}
                  >
                    <option value="">Select a driver…</option>
                    {drivers.map(d => (
                      <option key={d.id} value={d.id}>{d.name}{d.truck ? ` (${d.truck})` : ''} — {d.email}</option>
                    ))}
                  </select>
                  <button className="btn btn-primary btn-sm" onClick={handleAssign} disabled={assignBusy || !assignDriverId}>
                    {assignBusy ? 'Assigning…' : 'Assign'}
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setAssignLoadIds([])}>Clear</button>
                  {assignMsg && <div style={{ fontSize: 13, color: assignMsg.includes('success') ? 'var(--green-700)' : 'var(--red-700)', width: '100%' }}>{assignMsg}</div>}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── Drop Detail Modal ── */}
      {selectedDropId && (
        <div className="modal-overlay" onClick={() => { setSelectedDropId(null); setDropDetail(null); }}>
          <div className="modal-card drop-modal" onClick={e => e.stopPropagation()}>
            {dropDetail ? (
              <>
                <div className="modal-header">
                  <div>
                    <h2 style={{ margin: 0 }}>Order #{dropDetail.ref}</h2>
                    {dropDetail.source && <span className="dm-source">{dropDetail.source === 'manual' ? 'Manual Entry' : dropDetail.source}</span>}
                  </div>
                  <button className="btn btn-ghost btn-sm" onClick={() => { setSelectedDropId(null); setDropDetail(null); }} style={{ fontSize: 18, padding: '4px 8px' }}>✕</button>
                </div>
                <div className="modal-body">
                  {/* Customer */}
                  <div className="dm-section">
                    <div className="dm-section-label">Customer</div>
                    <div className="dm-customer-name">{dropDetail.customer_name}</div>
                    <div className="dm-customer-phone">{fmtPhone(dropDetail.customer_phone)}</div>
                    {dropDetail.delivery_address && (
                      <div className="dm-addr">
                        📍 {dropDetail.delivery_address.line1}
                        {dropDetail.delivery_address.line2 && `, ${dropDetail.delivery_address.line2}`}
                        , {dropDetail.delivery_address.city}, {dropDetail.delivery_address.state} {dropDetail.delivery_address.postal_code}
                      </div>
                    )}
                  </div>

                  {/* Schedule */}
                  <div className="dm-section">
                    <div className="dm-section-label">Scheduled</div>
                    <div className="dm-schedule-date">{fmtDateLong(dropDetail.scheduled_date)}</div>
                    <div className="dm-schedule-window">{dropDetail.scheduled_window === 'A' ? '🌅 AM Window (9am–1pm)' : '🌤 PM Window (1pm–5pm)'}</div>
                  </div>

                  {/* Loads */}
                  <div className="dm-section">
                    <div className="dm-section-label">Loads ({dropDetail.loads.length})</div>
                   {dropDetail.loads.map(l => {
                      const isUnassigned = !l.driver_name;
                      const isTerminal = ['delivered', 'cancelled'].includes(l.status);
                      return (
                        <div key={l.id} className="dm-load-row">
                          <div className="dm-load-info">
                            <span className="dm-load-material">{l.material}</span>
                            <span className="dm-load-qty">{l.qty} {l.unit}{l.qty !== 1 ? 's' : ''}</span>
                          </div>
                          <div className="dm-load-status-row">
                            <select
                              className="dm-status-select"
                              value={l.status}
                              disabled={updatingStatusId === l.id}
                              onChange={e => updateLoadStatus(l.id, e.target.value)}
                            >
                              {ALL_STATUSES.map(s => (
                                <option key={s.value} value={s.value}>{s.label}</option>
                              ))}
                            </select>
                            {updatingStatusId === l.id && <span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />}
                          </div>
                          <div className="dm-load-driver-row">
                            {isTerminal ? (
                              <span className="dm-load-driver">{l.driver_name ? `🚚 ${l.driver_name}` : '⚠️ Unassigned'}</span>
                            ) : (
                              <div className="dm-driver-select-wrap">
                                <select
                                  className="dm-driver-select"
                                  value={l.driver_user_id || ''}
                                  disabled={reassigningLoadId === l.id}
                                  onChange={e => reassignDriver(l.id, e.target.value)}
                                >
                                  <option value="">⚠️ Unassigned</option>
                                  {drivers.map(d => (
                                    <option key={d.id} value={d.id}>{d.name}</option>
                                  ))}
                                </select>
                                {reassigningLoadId === l.id && <span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Notifications */}
                  <div className="dm-section">
                    <div className="dm-section-label">Notifications</div>
                    <div className="dm-notify-item">
                      <span>Delivery Notification</span>
                      {dropDetail.notify_sent_at
                        ? <span className="pill pill-sm pill-green">Sent</span>
                        : <span className="pill pill-sm pill-gray">Not sent</span>}
                    </div>
                    <div className="dm-notify-item">
                      <span>Reschedule SMS</span>
                      {dropDetail.last_reschedule_sms_at
                        ? <span className="pill pill-sm pill-amber">Sent</span>
                        : <span className="pill pill-sm pill-gray">Not sent</span>}
                    </div>
                  </div>
                </div>
                <div className="modal-footer">
                  <Link href={`/dispatch/drops/${selectedDropId}`} className="btn btn-primary btn-sm" style={{ textDecoration: 'none' }}>
                    Modify Delivery
                  </Link>
                  <button className="btn btn-ghost btn-sm" onClick={() => { setSelectedDropId(null); setDropDetail(null); }}>Close</button>
                </div>
              </>
            ) : (
              <div style={{ padding: 32, textAlign: 'center' }}><div className="spinner" style={{ margin: '0 auto' }} /></div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/* ── Scoped styles for the scheduler ── */
const schedulerStyles = `
  .dispatch-layout { display: flex; height: calc(100vh - var(--nav-height)); overflow: hidden; }
  .cal-panel { flex: 1; min-width: 0; display: flex; flex-direction: column; border-right: 1px solid var(--border); background: var(--surface); }
  .cal-toolbar { display: flex; align-items: center; justify-content: space-between; padding: 16px 24px; border-bottom: 1px solid var(--border-light); gap: 16px; flex-wrap: wrap; }
  .cal-nav { display: flex; align-items: center; gap: 10px; }
  .cal-nav-btn { width: 36px; height: 36px; border-radius: var(--radius-md); border: 1px solid var(--border); background: var(--surface); cursor: pointer; font-size: 18px; display: flex; align-items: center; justify-content: center; color: var(--gray-600); transition: all 0.15s var(--ease-out); font-family: inherit; box-shadow: var(--shadow-xs); }
  .cal-nav-btn:hover { background: var(--gray-50); color: var(--gray-900); box-shadow: var(--shadow-sm); }
  .cal-heading { font-family: var(--font-heading); font-size: 22px; font-weight: 800; color: var(--gray-900); min-width: 220px; text-align: center; letter-spacing: -0.02em; }
  .cal-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .view-toggle { display: flex; background: var(--gray-100); border-radius: var(--radius-md); padding: 3px; gap: 2px; }
  .vt-btn { padding: 6px 16px; border: none; background: transparent; font-family: var(--font-heading); font-size: 13px; font-weight: 600; color: var(--gray-400); cursor: pointer; border-radius: var(--radius-sm); transition: all 0.15s var(--ease-out); }
  .vt-btn.on { background: var(--surface); color: var(--gray-900); box-shadow: var(--shadow-sm); }
  .vt-btn:hover:not(.on) { color: var(--gray-600); }
  .dm-load-status-row { width: 100%; margin-bottom: 4px; display: flex; align-items: center; gap: 6px; }
  .dm-status-select { width: auto; min-width: 140px; padding: 4px 8px; font-size: 12px; font-weight: 600; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); cursor: pointer; font-family: inherit; }

  .legend-row { display: flex; gap: 18px; padding: 10px 24px; border-bottom: 1px solid var(--border-light); font-size: 12px; color: var(--gray-500); font-weight: 500; font-family: var(--font-heading); }
  .legend-item { display: flex; align-items: center; gap: 6px; }
  .legend-dot { width: 8px; height: 8px; border-radius: 50%; }

  /* ── Week view ── */
  .week-grid { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  .week-header { display: grid; grid-template-columns: repeat(7, 1fr); border-bottom: 1px solid var(--border); }
  .whd { text-align: center; padding: 12px 4px; cursor: pointer; transition: all 0.15s var(--ease-out); border-right: 1px solid var(--border-light); }
  .whd:last-child { border-right: none; }
  .whd:hover { background: var(--gray-50); }
  .whd.today { background: var(--green-25); }
  .whd.selected { background: var(--green-50); }
  .whd-name { font-family: var(--font-heading); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--gray-400); }
  .whd-date { font-family: var(--font-heading); font-size: 22px; font-weight: 800; margin-top: 2px; color: var(--gray-900); letter-spacing: -0.02em; }
  .whd.today .whd-date { color: var(--green-600); }

  .week-body { display: grid; grid-template-columns: repeat(7, 1fr); flex: 1; overflow-y: auto; }
  .week-col { border-right: 1px solid var(--border-light); padding: 14px 10px; cursor: pointer; transition: background 0.12s; display: flex; flex-direction: column; gap: 8px; min-height: 160px; }
  .week-col:last-child { border-right: none; }
  .week-col:hover { background: var(--gray-25); }
  .week-col.today { background: var(--green-25); }
  .week-col.selected { background: rgba(15,133,48,0.04); }

  .wk-drops { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; overflow-y: auto; flex: 1; }
  .wk-drop-chip { padding: 5px 8px; border-radius: var(--radius-sm); font-family: var(--font-heading); border-left: 3px solid; cursor: pointer; transition: all 0.12s; }
  .wk-drop-chip:hover { transform: translateX(2px); }
  .wk-chip-am { background: rgba(26,158,58,0.07); border-left-color: var(--green-500); }
  .wk-chip-pm { background: rgba(37,99,235,0.05); border-left-color: var(--blue-500); }
  .wk-chip-name { display: block; font-size: 11.5px; font-weight: 700; color: var(--gray-800); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .wk-chip-mat { display: block; font-size: 10px; font-weight: 500; color: var(--gray-500); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .cap-row { display: flex; flex-direction: column; gap: 4px; }
  .cap-label { font-family: var(--font-heading); font-size: 11px; font-weight: 700; color: var(--gray-500); display: flex; justify-content: space-between; letter-spacing: 0.01em; }
  .cap-bar { height: 6px; border-radius: 3px; background: var(--gray-100); overflow: hidden; }
  .cap-fill { height: 100%; border-radius: 3px; transition: width 0.3s var(--ease-out); }
  .cap-fill.green { background: var(--green-500); }
  .cap-fill.amber { background: var(--amber-400); }
  .cap-fill.red { background: var(--red-500); }

  /* ── Month view ── */
  .month-grid { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  .month-header { display: grid; grid-template-columns: repeat(7, 1fr); border-bottom: 1px solid var(--border); }
  .month-dow { text-align: center; padding: 10px; font-family: var(--font-heading); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--gray-400); }
  .month-body { display: grid; grid-template-columns: repeat(7, 1fr); grid-auto-rows: 1fr; flex: 1; overflow-y: auto; }
  .month-cell { border-right: 1px solid var(--border-light); border-bottom: 1px solid var(--border-light); padding: 8px 10px; cursor: pointer; min-height: 110px; transition: all 0.12s; display: flex; flex-direction: column; gap: 2px; position: relative; }
  .month-cell:hover { background: var(--gray-25); }
  .month-cell:nth-child(7n) { border-right: none; }
  .month-cell.other { opacity: 0.25; pointer-events: none; }
  .month-cell.today { background: var(--green-25); }
  .month-cell.today::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px; background: var(--green-500); border-radius: 0 0 2px 2px; }
  .month-cell.selected { background: rgba(15,133,48,0.06); box-shadow: inset 0 0 0 2px var(--green-300); border-radius: 2px; }
  .mc-date { font-family: var(--font-heading); font-size: 15px; font-weight: 700; color: var(--gray-600); letter-spacing: -0.01em; }
  .month-cell.today .mc-date { color: var(--green-700); font-weight: 800; font-size: 16px; }
  .mc-bars { display: flex; flex-direction: column; gap: 6px; margin-top: auto; }
  .mc-drops { display: flex; flex-direction: column; gap: 3px; flex: 1; overflow: hidden; margin-top: 2px; }
  .mc-drop-chip { padding: 2px 6px; border-radius: 4px; font-family: var(--font-heading); font-size: 10.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.4; border-left: 3px solid; }
  .mc-chip-am { background: rgba(26,158,58,0.08); border-left-color: var(--green-500); color: var(--gray-700); }
  .mc-chip-pm { background: rgba(37,99,235,0.06); border-left-color: var(--blue-500); color: var(--gray-700); }
  .mc-chip-name { display: block; overflow: hidden; text-overflow: ellipsis; }
  .mc-drop-more { font-family: var(--font-heading); font-size: 10px; font-weight: 700; color: var(--gray-400); padding-left: 6px; }
  .mc-cap-row { display: flex; flex-direction: column; gap: 2px; }
  .mc-cap-label { font-family: var(--font-heading); font-size: 10px; font-weight: 700; color: var(--gray-400); display: flex; justify-content: space-between; letter-spacing: 0.02em; }
  .mc-bar-track { height: 4px; border-radius: 2px; background: var(--gray-100); overflow: hidden; }
  .mc-bar { height: 4px; border-radius: 2px; transition: width 0.3s var(--ease-out); }

  /* ── Right detail panel ── */
  .detail-panel { width: 420px; flex-shrink: 0; display: flex; flex-direction: column; background: var(--bg-primary); overflow-y: auto; border-left: 1px solid var(--border-light); }
  .detail-header { padding: 24px; border-bottom: 1px solid var(--border-light); }
  .detail-date { font-family: var(--font-heading); font-size: 24px; font-weight: 800; color: var(--gray-900); letter-spacing: -0.025em; }
  .detail-sub { font-size: 14px; color: var(--gray-500); margin-top: 4px; }

  .window-section { padding: 18px 24px; border-bottom: 1px solid var(--border-light); }
  .window-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
  .window-title { font-family: var(--font-heading); font-size: 15px; font-weight: 700; color: var(--gray-800); }
  .window-bar { height: 8px; border-radius: 4px; background: var(--gray-100); overflow: hidden; margin-bottom: 14px; }
  .window-fill { height: 100%; border-radius: 4px; transition: width 0.3s var(--ease-out); }

  .no-loads { font-size: 14px; color: var(--gray-400); padding: 8px 0; font-style: italic; }

  /* ── Load cards in detail panel ── */
  .order-row { display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px; border-radius: var(--radius-lg); cursor: pointer; transition: all 0.15s var(--ease-out); border: 1px solid var(--border-light); margin-bottom: 6px; background: var(--surface); }
  .order-row:hover { border-color: var(--green-200); box-shadow: var(--shadow-sm); transform: translateY(-1px); }
  .order-check { display: flex; align-items: center; flex-shrink: 0; margin-top: 4px; }
  .order-check input { width: 16px; height: 16px; cursor: pointer; accent-color: var(--green-600); }
  .order-info { flex: 1; min-width: 0; }
  .order-ref { font-family: var(--font-heading); font-size: 11px; font-weight: 700; color: var(--green-700); letter-spacing: 0.02em; margin-bottom: 2px; }
  .order-customer { font-family: var(--font-heading); font-size: 14px; font-weight: 700; color: var(--gray-900); letter-spacing: -0.01em; }
  .order-addr { font-size: 12px; color: var(--gray-400); margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .order-material { font-size: 13px; color: var(--gray-700); font-weight: 600; background: var(--gray-50); display: inline-block; padding: 2px 8px; border-radius: var(--radius-sm); }
  .order-driver-row { display: flex; align-items: center; gap: 6px; margin-top: 4px; }
  .order-driver { font-size: 12px; color: var(--gray-500); }
  .order-driver-select { padding: 3px 8px; font-family: var(--font-body); font-size: 11px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--gray-700); cursor: pointer; max-width: 170px; transition: border-color 0.15s; appearance: auto; }
  .order-driver-select:focus { border-color: var(--green-400); outline: none; box-shadow: 0 0 0 2px rgba(15,133,48,0.08); }
  .order-driver-select:disabled { opacity: 0.5; cursor: wait; }

  /* ── Assign bar ── */
  .assign-bar { display: flex; align-items: center; gap: 8px; padding: 14px 24px; border-top: 2px solid var(--green-200); background: var(--green-25); flex-wrap: wrap; }

  /* ── Modal ── */
  .modal-overlay { position: fixed; inset: 0; z-index: 300; background: rgba(23,23,20,0.5); backdrop-filter: blur(6px); display: flex; align-items: center; justify-content: center; padding: 24px; animation: fadeIn 0.15s; }
  .modal-card { background: var(--surface); border-radius: var(--radius-2xl); box-shadow: var(--shadow-xl); width: 100%; max-width: 520px; max-height: 80vh; overflow-y: auto; animation: modalIn 0.2s var(--ease-out); }
  .modal-header { display: flex; align-items: center; justify-content: space-between; padding: 20px 24px; border-bottom: 1px solid var(--border-light); }
  .modal-header h2 { font-family: var(--font-heading); font-size: 18px; font-weight: 800; letter-spacing: -0.02em; }
  .modal-body { padding: 20px 24px; display: flex; flex-direction: column; gap: 16px; }
  .modal-row { display: flex; gap: 16px; }
  .modal-field { flex: 1; }
  .modal-label { font-family: var(--font-heading); font-size: 11px; font-weight: 700; color: var(--gray-400); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 4px; }
  .modal-value { font-size: 15px; font-weight: 500; color: var(--gray-900); }
  .modal-footer { display: flex; justify-content: flex-end; gap: 8px; padding: 16px 24px; border-top: 1px solid var(--border-light); }

  /* ── Drop detail modal ── */
  .drop-modal { max-width: 540px; }
  .dm-source { display: inline-block; font-family: var(--font-heading); font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 10px; margin-left: 8px; vertical-align: middle; background: var(--gray-100); color: var(--gray-500); text-transform: uppercase; letter-spacing: 0.04em; }
  .dm-section { padding-bottom: 14px; border-bottom: 1px solid var(--border-light); }
  .dm-section:last-child { border-bottom: none; padding-bottom: 0; }
  .dm-section-label { font-family: var(--font-heading); font-size: 11px; font-weight: 700; color: var(--gray-400); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px; }
  .dm-customer-name { font-family: var(--font-heading); font-size: 17px; font-weight: 700; color: var(--gray-900); letter-spacing: -0.01em; }
  .dm-customer-phone { font-size: 14px; color: var(--gray-600); margin-top: 2px; }
  .dm-addr { font-size: 13px; color: var(--gray-500); margin-top: 4px; }
  .dm-schedule-date { font-family: var(--font-heading); font-size: 15px; font-weight: 700; color: var(--gray-900); }
  .dm-schedule-window { font-size: 13px; color: var(--gray-600); margin-top: 2px; }
  .dm-load-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 12px; border-radius: var(--radius-md); background: var(--gray-50); margin-bottom: 4px; }
  .dm-load-info { display: flex; align-items: baseline; gap: 8px; }
  .dm-load-material { font-family: var(--font-heading); font-size: 14px; font-weight: 700; color: var(--gray-900); }
  .dm-load-qty { font-size: 13px; color: var(--gray-500); }
  .dm-load-meta { margin-left: auto; }
  .dm-load-driver-row { width: 100%; }
  .dm-driver-select-wrap { display: flex; align-items: center; gap: 6px; }
  .dm-driver-select { width: 100%; padding: 5px 8px; font-size: 12px; font-weight: 500; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); cursor: pointer; font-family: inherit; }
  .dm-load-driver { font-size: 12px; color: var(--gray-500); }
  .pill-sm { font-size: 11px; padding: 2px 8px; }
  .dm-notify-item { display: flex; align-items: center; justify-content: space-between; padding: 4px 0; font-size: 14px; }

  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  @keyframes modalIn { from { opacity: 0; transform: translateY(8px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }

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
`;
