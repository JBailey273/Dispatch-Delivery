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

type CapWindow = { date: string; window: string; used: number; total: number; remaining_capacity: number; available: boolean; active_holds: number };
type LoadItem = { id: string; drop_id: string; status: string; material: string; qty: number; unit: string; historical_flags?: any };
type ScheduleData = {
  date: string;
  windows: {
    A: { capacity: { used: number; total: number; remaining_capacity: number }; groups: Record<string, LoadItem[]>; disabled: boolean };
    B: { capacity: { used: number; total: number; remaining_capacity: number }; groups: Record<string, LoadItem[]>; disabled: boolean };
  };
};
type DropDetail = { id: string; scheduled_date: string; scheduled_window: string; customer_phone: string; required_loads: number; last_reschedule_sms_at: string | null };

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

export default function DispatchSchedulePage() {
  const today = useMemo(() => new Date(), []);
  const [viewMode, setViewMode] = useState<'week' | 'month'>('week');
  const [selDate, setSelDate] = useState(today);
  const [navOffset, setNavOffset] = useState(0);

  const [capData, setCapData] = useState<Record<string, { A: CapWindow | null; B: CapWindow | null }>>({});
  const [schedule, setSchedule] = useState<ScheduleData | null>(null);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [dropDetail, setDropDetail] = useState<DropDetail | null>(null);
  const [selectedDropId, setSelectedDropId] = useState<string | null>(null);
  const [error, setError] = useState('');

  // Driver assignment state
  const [assignLoadIds, setAssignLoadIds] = useState<string[]>([]);
  const [assignDriverId, setAssignDriverId] = useState('');
  const [assignBusy, setAssignBusy] = useState(false);
  const [assignMsg, setAssignMsg] = useState('');

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
        days = Math.min(21, nonOther.length);
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
    } catch (err) {
      const e = err as ApiError;
      setAssignMsg(e.message || 'Assignment failed.');
    } finally {
      setAssignBusy(false);
    }
  };

  /* ── Load toggle ── */
  const toggleLoad = (loadId: string) => {
    setAssignLoadIds(prev => prev.includes(loadId) ? prev.filter(id => id !== loadId) : [...prev, loadId]);
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
                    return (
                      <div
                        key={i}
                        className={`month-cell${cell.other ? ' other' : ''}${sameDay(cell.date, today) ? ' today' : ''}${sameDay(cell.date, selDate) ? ' selected' : ''}`}
                        onClick={() => !cell.other && setSelDate(new Date(cell.date))}
                      >
                        <div className="mc-date">{cell.date.getDate()}</div>
                        {!cell.other && (
                          <div className="mc-bars">
                            {amT > 0 && <div className="mc-bar" style={{ background: colors[capColor(amU, amT)], width: `${Math.round(amU / amT * 100)}%`, minWidth: amU > 0 ? 4 : 0 }} />}
                            {pmT > 0 && <div className="mc-bar" style={{ background: colors[capColor(pmU, pmT)], opacity: 0.7, width: `${Math.round(pmU / pmT * 100)}%`, minWidth: pmU > 0 ? 4 : 0 }} />}
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
            <button className="btn btn-secondary btn-sm" onClick={() => { fetchSchedule(); fetchCapacity(); }} style={{ marginTop: 8 }}>
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
                {amLoads.length === 0 && <div style={{ fontSize: 14, color: 'var(--gray-400)', padding: '8px 0' }}>No loads in this window</div>}
                {amLoads.map(({ driver, load }) => (
                  <div key={load.id} className="order-row" onClick={() => openDrop(load.drop_id)}>
                    <label className="order-check" onClick={e => e.stopPropagation()}>
                      <input type="checkbox" checked={assignLoadIds.includes(load.id)} onChange={() => toggleLoad(load.id)} />
                    </label>
                    <div className="order-info">
                      <div className="order-name">{load.material} x{load.qty} {load.unit}</div>
                      <div className="order-driver">{driver === 'Unassigned' ? '⚠️ Unassigned' : `🚚 ${driver}`}</div>
                    </div>
                    <span className={`pill ${STATUS_PILL[load.status] || 'pill-gray'}`}>
                      <span className="pill-dot" />{STATUS_LABEL[load.status] || load.status}
                    </span>
                  </div>
                ))}
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
                {pmLoads.length === 0 && <div style={{ fontSize: 14, color: 'var(--gray-400)', padding: '8px 0' }}>No loads in this window</div>}
                {pmLoads.map(({ driver, load }) => (
                  <div key={load.id} className="order-row" onClick={() => openDrop(load.drop_id)}>
                    <label className="order-check" onClick={e => e.stopPropagation()}>
                      <input type="checkbox" checked={assignLoadIds.includes(load.id)} onChange={() => toggleLoad(load.id)} />
                    </label>
                    <div className="order-info">
                      <div className="order-name">{load.material} x{load.qty} {load.unit}</div>
                      <div className="order-driver">{driver === 'Unassigned' ? '⚠️ Unassigned' : `🚚 ${driver}`}</div>
                    </div>
                    <span className={`pill ${STATUS_PILL[load.status] || 'pill-gray'}`}>
                      <span className="pill-dot" />{STATUS_LABEL[load.status] || load.status}
                    </span>
                  </div>
                ))}
              </div>

              {/* Assignment bar */}
              {assignLoadIds.length > 0 && (
                <div className="assign-bar">
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{assignLoadIds.length} load{assignLoadIds.length !== 1 ? 's' : ''} selected</div>
                  <input
                    placeholder="Driver user ID or email"
                    value={assignDriverId}
                    onChange={e => setAssignDriverId(e.target.value)}
                    style={{ flex: 1, padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', fontFamily: 'inherit', fontSize: 14 }}
                  />
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
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Drop Detail</h2>
              <button className="btn btn-ghost btn-sm" onClick={() => { setSelectedDropId(null); setDropDetail(null); }} style={{ fontSize: 18, padding: '4px 8px' }}>✕</button>
            </div>
            {dropDetail ? (
              <div className="modal-body">
                <div className="modal-row">
                  <div className="modal-field">
                    <div className="modal-label">Drop ID</div>
                    <div className="modal-value" style={{ fontSize: 13, fontFamily: 'monospace' }}>{dropDetail.id}</div>
                  </div>
                </div>
                <div className="modal-row">
                  <div className="modal-field">
                    <div className="modal-label">Customer Phone</div>
                    <div className="modal-value">{dropDetail.customer_phone}</div>
                  </div>
                  <div className="modal-field">
                    <div className="modal-label">Required Loads</div>
                    <div className="modal-value">{dropDetail.required_loads}</div>
                  </div>
                </div>
                <div className="modal-row">
                  <div className="modal-field">
                    <div className="modal-label">Scheduled</div>
                    <div className="modal-value">{dropDetail.scheduled_date} — Window {dropDetail.scheduled_window}</div>
                  </div>
                </div>
                <div className="modal-row">
                  <div className="modal-field">
                    <div className="modal-label">Last Reschedule SMS</div>
                    <div className="modal-value">{dropDetail.last_reschedule_sms_at || 'Not sent'}</div>
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ padding: 32, textAlign: 'center' }}><div className="spinner" style={{ margin: '0 auto' }} /></div>
            )}
            <div className="modal-footer">
              <Link href={`/dispatch/drops/${selectedDropId}`} className="btn btn-primary btn-sm" style={{ textDecoration: 'none' }}>
                Full Detail / Edit
              </Link>
              <button className="btn btn-ghost btn-sm" onClick={() => { setSelectedDropId(null); setDropDetail(null); }}>Close</button>
            </div>
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
  .cal-toolbar { display: flex; align-items: center; justify-content: space-between; padding: 14px 20px; border-bottom: 1px solid var(--border-light); gap: 12px; flex-wrap: wrap; }
  .cal-nav { display: flex; align-items: center; gap: 8px; }
  .cal-nav-btn { width: 34px; height: 34px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--surface); cursor: pointer; font-size: 18px; display: flex; align-items: center; justify-content: center; color: var(--gray-600); transition: all 0.12s; font-family: inherit; }
  .cal-nav-btn:hover { background: var(--gray-50); color: var(--gray-900); }
  .cal-heading { font-size: 16px; font-weight: 700; color: var(--gray-900); min-width: 200px; text-align: center; }
  .cal-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .view-toggle { display: flex; background: var(--gray-100); border-radius: var(--radius-sm); padding: 2px; }
  .vt-btn { padding: 5px 14px; border: none; background: transparent; font-family: inherit; font-size: 13px; font-weight: 600; color: var(--gray-500); cursor: pointer; border-radius: 4px; transition: all 0.12s; }
  .vt-btn.on { background: var(--surface); color: var(--gray-900); box-shadow: var(--shadow-xs); }

  .legend-row { display: flex; gap: 16px; padding: 8px 20px; border-bottom: 1px solid var(--border-light); font-size: 12px; color: var(--gray-500); font-weight: 500; }
  .legend-item { display: flex; align-items: center; gap: 5px; }
  .legend-dot { width: 8px; height: 8px; border-radius: 50%; }

  .week-grid { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  .week-header { display: grid; grid-template-columns: repeat(7, 1fr); border-bottom: 1px solid var(--border); }
  .whd { text-align: center; padding: 10px 4px; cursor: pointer; transition: background 0.12s; border-right: 1px solid var(--border-light); }
  .whd:last-child { border-right: none; }
  .whd:hover { background: var(--gray-50); }
  .whd.today { background: var(--green-50); }
  .whd.selected { background: var(--green-100); }
  .whd-name { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--gray-400); }
  .whd-date { font-size: 20px; font-weight: 800; margin-top: 2px; color: var(--gray-900); }
  .whd.today .whd-date { color: var(--green-700); }

  .week-body { display: grid; grid-template-columns: repeat(7, 1fr); flex: 1; overflow-y: auto; }
  .week-col { border-right: 1px solid var(--border-light); padding: 12px 10px; cursor: pointer; transition: background 0.12s; display: flex; flex-direction: column; gap: 8px; min-height: 160px; }
  .week-col:last-child { border-right: none; }
  .week-col:hover { background: var(--gray-50); }
  .week-col.today { background: var(--green-50); }
  .week-col.selected { background: rgba(10,145,80,0.06); }

  .cap-row { display: flex; flex-direction: column; gap: 3px; }
  .cap-label { font-size: 11px; font-weight: 600; color: var(--gray-500); display: flex; justify-content: space-between; }
  .cap-bar { height: 6px; border-radius: 3px; background: var(--gray-100); overflow: hidden; }
  .cap-fill { height: 100%; border-radius: 3px; transition: width 0.3s; }
  .cap-fill.green { background: var(--green-500); }
  .cap-fill.amber { background: var(--amber-400); }
  .cap-fill.red { background: var(--red-500); }

  .month-grid { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  .month-header { display: grid; grid-template-columns: repeat(7, 1fr); border-bottom: 1px solid var(--border); }
  .month-dow { text-align: center; padding: 8px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--gray-400); }
  .month-body { display: grid; grid-template-columns: repeat(7, 1fr); flex: 1; overflow-y: auto; }
  .month-cell { border-right: 1px solid var(--border-light); border-bottom: 1px solid var(--border-light); padding: 6px 8px; cursor: pointer; min-height: 70px; transition: background 0.12s; display: flex; flex-direction: column; gap: 3px; }
  .month-cell:hover { background: var(--gray-50); }
  .month-cell.other { opacity: 0.3; pointer-events: none; }
  .month-cell.today { background: var(--green-50); }
  .month-cell.selected { background: rgba(10,145,80,0.08); }
  .mc-date { font-size: 14px; font-weight: 700; color: var(--gray-700); }
  .month-cell.today .mc-date { color: var(--green-700); font-weight: 800; }
  .mc-bars { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; }
  .mc-bar { height: 4px; border-radius: 2px; }

  .detail-panel { width: 400px; flex-shrink: 0; display: flex; flex-direction: column; background: var(--bg-secondary); overflow-y: auto; }
  .detail-header { padding: 20px; border-bottom: 1px solid var(--border-light); }
  .detail-date { font-size: 22px; font-weight: 800; color: var(--gray-900); letter-spacing: -0.01em; }
  .detail-sub { font-size: 14px; color: var(--gray-500); margin-top: 2px; }

  .window-section { padding: 16px 20px; border-bottom: 1px solid var(--border-light); }
  .window-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
  .window-title { font-size: 15px; font-weight: 700; color: var(--gray-800); }
  .window-bar { height: 8px; border-radius: 4px; background: var(--gray-100); overflow: hidden; margin-bottom: 12px; }
  .window-fill { height: 100%; border-radius: 4px; transition: width 0.3s; }

  .order-row { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: var(--radius-md); cursor: pointer; transition: background 0.12s; }
  .order-row:hover { background: var(--surface); box-shadow: var(--shadow-xs); }
  .order-check { display: flex; align-items: center; flex-shrink: 0; }
  .order-check input { width: 16px; height: 16px; cursor: pointer; accent-color: var(--green-600); }
  .order-info { flex: 1; min-width: 0; }
  .order-name { font-size: 14px; font-weight: 600; color: var(--gray-900); }
  .order-driver { font-size: 12px; color: var(--gray-500); margin-top: 2px; }

  .assign-bar { display: flex; align-items: center; gap: 8px; padding: 12px 20px; border-top: 2px solid var(--green-200); background: var(--green-50); flex-wrap: wrap; }

  .modal-overlay { position: fixed; inset: 0; z-index: 300; background: rgba(16,24,40,0.45); backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; padding: 24px; animation: fadeIn 0.15s; }
  .modal-card { background: var(--surface); border-radius: var(--radius-lg); box-shadow: 0 20px 40px rgba(0,0,0,0.15); width: 100%; max-width: 520px; max-height: 80vh; overflow-y: auto; animation: modalIn 0.2s; }
  .modal-header { display: flex; align-items: center; justify-content: space-between; padding: 20px 24px; border-bottom: 1px solid var(--border-light); }
  .modal-header h2 { font-size: 18px; font-weight: 700; }
  .modal-body { padding: 20px 24px; display: flex; flex-direction: column; gap: 16px; }
  .modal-row { display: flex; gap: 16px; }
  .modal-field { flex: 1; }
  .modal-label { font-size: 12px; font-weight: 600; color: var(--gray-500); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 4px; }
  .modal-value { font-size: 15px; font-weight: 500; color: var(--gray-900); }
  .modal-footer { display: flex; justify-content: flex-end; gap: 8px; padding: 16px 24px; border-top: 1px solid var(--border-light); }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  @keyframes modalIn { from { opacity: 0; transform: translateY(8px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }

  @media (max-width: 900px) {
    .dispatch-layout { flex-direction: column; height: auto; }
    .cal-panel { border-right: none; border-bottom: 1px solid var(--border); max-height: 50vh; }
    .detail-panel { width: 100%; }
    .week-col { min-height: 100px; }
    .month-cell { min-height: 50px; }
  }
  @media (max-width: 600px) {
    .cal-toolbar { flex-direction: column; align-items: stretch; gap: 8px; }
    .cal-nav { justify-content: center; }
    .cal-actions { justify-content: center; flex-wrap: wrap; }
    .legend-row { flex-wrap: wrap; gap: 8px; }
    .detail-panel { width: 100%; }
  }
`;
