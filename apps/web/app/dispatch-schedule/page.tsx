'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState, useCallback } from 'react';
import { ApiError, api, requireRole } from '../lib/auth';

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

/* ── Helpers ── */
function capColor(used: number, total: number): string {
  if (total === 0) return 'green';
  const pct = used / total;
  if (pct >= 1) return 'red';
  if (pct >= 0.75) return 'amber';
  return 'green';
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

/* ════════════════════════════════════════════════════════
   SLIDE-OVER PANEL COMPONENT
   ════════════════════════════════════════════════════════ */
type SlideOverView = 'quick' | 'reschedule';

function DropSlideOver({
  dropId,
  dropDetail,
  onClose,
  onRescheduled,
  capData,
}: {
  dropId: string;
  dropDetail: DropDetail | null;
  onClose: () => void;
  onRescheduled: () => void;
  capData: Record<string, { A: CapWindow | null; B: CapWindow | null }>;
}) {
  const today = useMemo(() => new Date(), []);
  const [view, setView] = useState<SlideOverView>('quick');

  /* Reschedule state */
  const [rescCalMonth, setRescCalMonth] = useState(() => {
    const d = dropDetail?.scheduled_date ? new Date(dropDetail.scheduled_date + 'T12:00:00') : new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [rescDate, setRescDate] = useState(dropDetail?.scheduled_date || toKey(new Date()));
  const [rescWindow, setRescWindow] = useState<'A' | 'B'>(dropDetail?.scheduled_window === 'B' ? 'B' : 'A');
  const [rescheduling, setRescheduling] = useState(false);
  const [rescMsg, setRescMsg] = useState('');
  const [rescSuccess, setRescSuccess] = useState(false);

  // Build mini-calendar cells
  const calCells = useMemo(() => {
    const y = rescCalMonth.getFullYear();
    const m = rescCalMonth.getMonth();
    const firstDay = new Date(y, m, 1).getDay();
    const dim = new Date(y, m + 1, 0).getDate();
    const cells: { date: Date; other: boolean }[] = [];
    for (let i = firstDay - 1; i >= 0; i--) cells.push({ date: new Date(y, m, -i), other: true });
    for (let i = 1; i <= dim; i++) cells.push({ date: new Date(y, m, i), other: false });
    while (cells.length % 7 !== 0) {
      const last = cells[cells.length - 1].date;
      const nd = new Date(last); nd.setDate(nd.getDate() + 1);
      cells.push({ date: nd, other: true });
    }
    return cells;
  }, [rescCalMonth]);

  const submitReschedule = async () => {
    if (!rescDate) { setRescMsg('Please select a date.'); return; }
    setRescheduling(true); setRescMsg('');
    try {
      await api(`/drops/${dropId}/reschedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduled_date: rescDate, scheduled_window: rescWindow }),
      });
      setRescSuccess(true);
      onRescheduled();
    } catch (err) {
      setRescMsg((err as ApiError).message || 'Reschedule failed');
    } finally {
      setRescheduling(false);
    }
  };

  const targetCap = capData[rescDate];
  const windowCap = rescWindow === 'A' ? targetCap?.A : targetCap?.B;
  const isSameAsOriginal = rescDate === dropDetail?.scheduled_date && rescWindow === (dropDetail?.scheduled_window || 'A');

  return (
    <>
      {/* Backdrop */}
      <div className="so-backdrop" onClick={onClose} />

      {/* Panel */}
      <div className="so-panel">
        {/* ── Header ── */}
        <div className="so-header">
          <div className="so-header-left">
            {view === 'reschedule' && (
              <button className="so-back-btn" onClick={() => { setView('quick'); setRescMsg(''); setRescSuccess(false); }}>
                ← Back
              </button>
            )}
            <div className="so-header-title">
              {view === 'quick'
                ? (dropDetail ? `Order #${dropDetail.ref}` : 'Loading…')
                : 'Reschedule Delivery'}
            </div>
          </div>
          <button className="so-close-btn" onClick={onClose}>✕</button>
        </div>

        {/* ── Loading ── */}
        {!dropDetail && (
          <div className="so-loading">
            <div className="spinner spinner-lg" />
          </div>
        )}

        {/* ══════════════════════════════
            QUICK VIEW
            ══════════════════════════════ */}
        {dropDetail && view === 'quick' && (
          <div className="so-body">
            {/* Source badge */}
            {dropDetail.source && (
              <div className="so-source-row">
                <span className={`so-source-badge${dropDetail.source === 'manual' ? ' manual' : ''}`}>
                  {dropDetail.source === 'manual' ? 'Manual Entry' : dropDetail.source}
                </span>
                {dropDetail.is_priority && <span className="so-priority-badge">⚡ Priority</span>}
              </div>
            )}

            {/* Customer card */}
            <div className="so-info-card">
              <div className="so-info-label">Customer</div>
              <div className="so-info-name">{dropDetail.customer_name}</div>
              <div className="so-info-phone">{fmtPhone(dropDetail.customer_phone)}</div>
              {dropDetail.delivery_address && (
                <div className="so-info-addr">
                  📍 {dropDetail.delivery_address.line1}
                  {dropDetail.delivery_address.line2 && `, ${dropDetail.delivery_address.line2}`}
                  , {dropDetail.delivery_address.city}, {dropDetail.delivery_address.state} {dropDetail.delivery_address.postal_code}
                </div>
              )}
            </div>

            {/* Schedule card */}
            <div className="so-info-card">
              <div className="so-info-label">Current Schedule</div>
              <div className="so-info-date">{fmtDateLong(dropDetail.scheduled_date)}</div>
              <div className="so-info-window">
                {dropDetail.is_priority
                  ? 'Priority — no window'
                  : dropDetail.scheduled_window === 'A'
                    ? '🌅 Morning (9am – 1pm)'
                    : '🌤 Afternoon (1pm – 5pm)'}
              </div>
            </div>

            {/* Loads summary */}
            {dropDetail.loads.length > 0 && (
              <div className="so-info-card">
                <div className="so-info-label">Loads ({dropDetail.loads.length})</div>
                {dropDetail.loads.map(l => (
                  <div key={l.id} className="so-load-row">
                    <div className="so-load-mat">{l.material} × {l.qty} {l.unit}</div>
                    <div className="so-load-driver">{l.driver_name || <span className="so-unassigned">Unassigned</span>}</div>
                    <span className={`pill pill-sm ${STATUS_PILL[l.status] || 'pill-gray'}`}>
                      <span className="pill-dot" />{STATUS_LABEL[l.status] || l.status}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Notes */}
            {dropDetail.notes && (
              <div className="so-info-card so-notes">
                <div className="so-info-label">Notes</div>
                <div className="so-notes-text">{dropDetail.notes}</div>
              </div>
            )}

            {/* Actions */}
            <div className="so-actions">
              <button className="btn btn-primary" onClick={() => { setView('reschedule'); setRescMsg(''); setRescSuccess(false); }}>
                Reschedule Delivery
              </button>
              <Link href={`/dispatch/drops/${dropDetail.id}`} className="btn btn-secondary" style={{ textDecoration: 'none', textAlign: 'center' }}>
                View Full Details →
              </Link>
            </div>
          </div>
        )}

        {/* ══════════════════════════════
            RESCHEDULE VIEW
            ══════════════════════════════ */}
        {dropDetail && view === 'reschedule' && (
          <div className="so-body">
            {rescSuccess ? (
              <div className="so-success">
                <div className="so-success-icon">✓</div>
                <div className="so-success-title">Rescheduled!</div>
                <div className="so-success-sub">
                  {dropDetail.customer_name} moved to {fmtDateLong(rescDate)},&nbsp;
                  {rescWindow === 'A' ? 'Morning' : 'Afternoon'}
                </div>
                <button className="btn btn-secondary" style={{ marginTop: 16 }} onClick={onClose}>Done</button>
              </div>
            ) : (
              <>
                {/* Current schedule reminder */}
                <div className="so-resc-current">
                  <span className="so-resc-current-label">Currently:</span>
                  <span className="so-resc-current-val">
                    {fmtDateShort(dropDetail.scheduled_date)} · {dropDetail.scheduled_window === 'A' ? 'AM' : dropDetail.scheduled_window === 'B' ? 'PM' : 'Priority'}
                  </span>
                </div>

                {/* Mini calendar */}
                <div className="so-cal">
                  <div className="so-cal-nav">
                    <button className="so-cal-nav-btn" onClick={() => setRescCalMonth(m => new Date(m.getFullYear(), m.getMonth() - 1, 1))}>‹</button>
                    <span className="so-cal-heading">
                      {FULL_MONTHS[rescCalMonth.getMonth()]} {rescCalMonth.getFullYear()}
                    </span>
                    <button className="so-cal-nav-btn" onClick={() => setRescCalMonth(m => new Date(m.getFullYear(), m.getMonth() + 1, 1))}>›</button>
                  </div>
                  <div className="so-cal-dow-row">
                    {['S','M','T','W','T','F','S'].map((d, i) => (
                      <div key={i} className="so-cal-dow">{d}</div>
                    ))}
                  </div>
                  <div className="so-cal-grid">
                    {calCells.map((cell, i) => {
                      const k = toKey(cell.date);
                      const isPast = cell.date < new Date(toKey(today) + 'T00:00:00');
                      const isSelected = k === rescDate;
                      const isOriginal = k === dropDetail.scheduled_date;
                      const dc = capData[k];
                      const amR = dc?.A?.remaining_capacity ?? null;
                      const pmR = dc?.B?.remaining_capacity ?? null;
                      const hasAm = amR !== null && amR > 0;
                      const hasPm = pmR !== null && pmR > 0;
                      return (
                        <div
                          key={i}
                          className={[
                            'so-cal-cell',
                            cell.other ? 'other' : '',
                            isPast && !cell.other ? 'past' : '',
                            isSelected ? 'selected' : '',
                            isOriginal && !isSelected ? 'original' : '',
                            sameDay(cell.date, today) ? 'today' : '',
                          ].filter(Boolean).join(' ')}
                          onClick={() => !cell.other && !isPast && setRescDate(k)}
                        >
                          <span className="so-cal-num">{cell.date.getDate()}</span>
                          {!cell.other && !isPast && (
                            <div className="so-cal-dots">
                              {hasAm && <span className="so-cal-dot am" title={`AM: ${amR} remaining`} />}
                              {hasPm && <span className="so-cal-dot pm" title={`PM: ${pmR} remaining`} />}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div className="so-cal-legend">
                    <span><span className="so-cal-dot am" /> AM available</span>
                    <span><span className="so-cal-dot pm" /> PM available</span>
                  </div>
                </div>

                {/* Selected date + window picker */}
                {rescDate && (
                  <div className="so-window-pick">
                    <div className="so-window-pick-date">{fmtDateLong(rescDate)}</div>
                    {!dropDetail.is_priority && (
                      <div className="so-window-btns">
                        <button
                          className={`so-win-btn${rescWindow === 'A' ? ' active' : ''}`}
                          onClick={() => setRescWindow('A')}
                        >
                          <span className="so-win-label">🌅 Morning</span>
                          <span className="so-win-time">9am – 1pm</span>
                          {targetCap?.A !== undefined && targetCap.A !== null && (
                            <span className={`so-win-cap ${(targetCap.A?.remaining_capacity ?? 0) > 0 ? 'avail' : 'full'}`}>
                              {targetCap.A?.remaining_capacity ?? 0} slots left
                            </span>
                          )}
                        </button>
                        <button
                          className={`so-win-btn${rescWindow === 'B' ? ' active' : ''}`}
                          onClick={() => setRescWindow('B')}
                        >
                          <span className="so-win-label">🌤 Afternoon</span>
                          <span className="so-win-time">1pm – 5pm</span>
                          {targetCap?.B !== undefined && targetCap.B !== null && (
                            <span className={`so-win-cap ${(targetCap.B?.remaining_capacity ?? 0) > 0 ? 'avail' : 'full'}`}>
                              {targetCap.B?.remaining_capacity ?? 0} slots left
                            </span>
                          )}
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* Capacity warning */}
                {windowCap && windowCap.remaining_capacity < dropDetail.required_loads && (
                  <div className="alert alert-warning so-cap-warn">
                    ⚠ Only {windowCap.remaining_capacity} slot{windowCap.remaining_capacity !== 1 ? 's' : ''} available — this order needs {dropDetail.required_loads}
                  </div>
                )}

                {rescMsg && <div className="alert alert-error so-cap-warn">{rescMsg}</div>}

                {/* Footer actions */}
                <div className="so-actions">
                  <button
                    className="btn btn-primary"
                    disabled={rescheduling || !rescDate || isSameAsOriginal}
                    onClick={submitReschedule}
                  >
                    {rescheduling ? 'Saving…' : isSameAsOriginal ? 'No Change' : `Move to ${fmtDateShort(rescDate)}`}
                  </button>
                  <button className="btn btn-ghost" onClick={() => setView('quick')}>Cancel</button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}

/* ════════════════════════════════════════════════════════
   MAIN PAGE
   ════════════════════════════════════════════════════════ */
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
  const [error, setError] = useState('');

  /* ── Slide-over state ── */
  const [slideDropId, setSlideDropId] = useState<string | null>(null);
  const [slideDropDetail, setSlideDropDetail] = useState<DropDetail | null>(null);

  /* ── Driver assignment state ── */
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
      const resp = await api(`/availability?start_date=${startDate}&days=${days}`);
      const map: Record<string, { A: CapWindow | null; B: CapWindow | null }> = {};
      for (const w of (resp.windows || [])) {
        if (!map[w.date]) map[w.date] = { A: null, B: null };
        map[w.date][w.window as 'A' | 'B'] = w;
      }
      setCapData(map);
    } catch { /* silently fail */ }
  }, [viewMode, visibleRange]);

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
      const resp = await api(`/dispatch/month-summary?start_date=${startDate}&end_date=${endDate}`);
      setMonthSummary(resp.days || {});
    } catch { /* silently fail */ }
  }, [viewMode, visibleRange]);

  const fetchSchedule = useCallback(async () => {
    setScheduleLoading(true); setError(''); setAssignLoadIds([]); setAssignMsg('');
    try {
      const resp = await api(`/dispatch/schedule?day=${toKey(selDate)}`);
      setSchedule(resp);
    } catch (err) {
      setError((err as ApiError).message || 'Failed to load schedule');
      setSchedule(null);
    } finally { setScheduleLoading(false); }
  }, [selDate]);

  useEffect(() => { fetchCapacity(); }, [fetchCapacity]);
  useEffect(() => { fetchMonthSummary(); }, [fetchMonthSummary]);
  useEffect(() => { fetchSchedule(); }, [fetchSchedule]);
  useEffect(() => {
    api('/dispatch/drivers').then(d => setDrivers(d.drivers || [])).catch(() => null);
  }, []);

  /* ── Open slide-over ── */
  const openDrop = async (dropId: string) => {
    setSlideDropId(dropId);
    setSlideDropDetail(null);
    try {
      const resp = await api(`/dispatch/drops/${dropId}`);
      setSlideDropDetail(resp);
    } catch { setSlideDropDetail(null); }
  };

  const closeDrop = () => { setSlideDropId(null); setSlideDropDetail(null); };

  const handleRescheduled = async () => {
    await fetchSchedule();
    await fetchCapacity();
    fetchMonthSummary();
    // Refresh drop detail so success screen shows correct data
    if (slideDropId) {
      try {
        const resp = await api(`/dispatch/drops/${slideDropId}`);
        setSlideDropDetail(resp);
      } catch { /* ignore */ }
    }
  };

  /* ── Assign loads ── */
  const handleAssign = async () => {
    if (!assignLoadIds.length || !assignDriverId) return;
    setAssignBusy(true); setAssignMsg('');
    try {
      await api('/dispatch/loads/assign', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ load_ids: assignLoadIds, driver_user_id: assignDriverId }),
      });
      setAssignMsg(`Assigned ${assignLoadIds.length} load(s) successfully.`);
      setAssignLoadIds([]);
      await fetchSchedule(); await fetchCapacity(); fetchMonthSummary();
    } catch (err) {
      setAssignMsg((err as ApiError).message || 'Assignment failed.');
    } finally { setAssignBusy(false); }
  };

  const reassignDriver = async (loadId: string, driverId: string) => {
    setReassigningLoadId(loadId);
    try {
      await api('/dispatch/loads/assign', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ load_ids: [loadId], driver_user_id: driverId || null }),
      });
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
      await fetchSchedule(); fetchMonthSummary();
    } catch (err) {
      setError((err as ApiError).message || 'Status update failed');
    } finally { setUpdatingStatusId(null); }
  };

  const toggleLoad = (loadId: string) => {
    setAssignLoadIds(prev => prev.includes(loadId) ? prev.filter(id => id !== loadId) : [...prev, loadId]);
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

  /* ── Render load card ── */
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
                {drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            )}
            {reassigningLoadId === load.id && <span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />}
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
              <div className="window-section">
                <div className="window-head">
                  <div className="window-title">🌅 Morning (9am – 1pm)</div>
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
              <div className="window-section">
                <div className="window-head">
                  <div className="window-title">🌤 Afternoon (1pm – 5pm)</div>
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

              {/* Bulk assign */}
              {assignLoadIds.length > 0 && (
                <div className="bulk-assign-bar">
                  <span className="bulk-assign-count">{assignLoadIds.length} selected</span>
                  <select value={assignDriverId} onChange={e => setAssignDriverId(e.target.value)} className="bulk-assign-select">
                    <option value="">Assign driver…</option>
                    {drivers.map(d => <option key={d.id} value={d.id}>{d.name}{d.truck ? ` (${d.truck})` : ''} — {d.email}</option>)}
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

      {/* ── Slide-over ── */}
      {slideDropId && (
        <DropSlideOver
          dropId={slideDropId}
          dropDetail={slideDropDetail}
          onClose={closeDrop}
          onRescheduled={handleRescheduled}
          capData={capData}
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
  .priority-section { background: var(--amber-25, #fffbeb); border-left: 4px solid var(--amber-500, #f59e0b); }

  /* ── Load cards ── */
  .order-row { display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px; border-radius: var(--radius-lg); cursor: pointer; transition: all 0.15s var(--ease-out); border: 1px solid var(--border-light); margin-bottom: 6px; background: var(--surface); }
  .order-row:hover { border-color: var(--green-200); box-shadow: var(--shadow-sm); }
  .order-check { display: flex; align-items: flex-start; padding-top: 2px; cursor: pointer; }
  .order-info { flex: 1; min-width: 0; }
  .order-ref { font-family: var(--font-heading); font-size: 11px; font-weight: 700; color: var(--gray-400); text-transform: uppercase; letter-spacing: 0.05em; }
  .order-customer { font-family: var(--font-heading); font-size: 14px; font-weight: 700; color: var(--gray-900); }
  .order-addr { font-size: 12px; color: var(--gray-500); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .order-material { font-size: 12px; color: var(--gray-600); font-weight: 500; }
  .order-driver-row { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
  .order-driver { font-size: 12px; color: var(--gray-500); }
  .order-driver-select { font-size: 12px; font-weight: 500; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); cursor: pointer; font-family: inherit; padding: 3px 6px; }

  /* ── Bulk assign bar ── */
  .bulk-assign-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 14px 24px; border-top: 2px solid var(--green-200); background: var(--green-25); }
  .bulk-assign-count { font-family: var(--font-heading); font-size: 13px; font-weight: 700; color: var(--green-700); }
  .bulk-assign-select { flex: 1; min-width: 0; padding: 6px 8px; font-size: 13px; font-weight: 500; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); cursor: pointer; font-family: inherit; }
  .dm-status-select { width: auto; min-width: 140px; padding: 4px 8px; font-size: 12px; font-weight: 600; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); cursor: pointer; font-family: inherit; }

  /* ══════════════════════════════════════════
     SLIDE-OVER
     ══════════════════════════════════════════ */
  .so-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.35);
    z-index: 200; animation: soFadeIn 0.2s ease;
    backdrop-filter: blur(2px);
  }
  .so-panel {
    position: fixed; top: 0; right: 0; bottom: 0;
    width: 420px; max-width: 100%;
    background: var(--bg-primary);
    border-left: 1px solid var(--border);
    box-shadow: -8px 0 40px rgba(0,0,0,0.15);
    z-index: 201;
    display: flex; flex-direction: column;
    animation: soSlideIn 0.25s cubic-bezier(0.32, 0.72, 0, 1);
    overflow: hidden;
  }
  @keyframes soFadeIn { from { opacity: 0; } to { opacity: 1; } }
  @keyframes soSlideIn { from { transform: translateX(100%); } to { transform: translateX(0); } }

  /* Header */
  .so-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 18px 20px;
    border-bottom: 1px solid var(--border-light);
    background: var(--surface);
    flex-shrink: 0;
  }
  .so-header-left { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .so-header-title { font-family: var(--font-heading); font-size: 18px; font-weight: 800; color: var(--gray-900); letter-spacing: -0.02em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .so-back-btn { display: flex; align-items: center; gap: 4px; padding: 6px 10px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface); font-family: var(--font-heading); font-size: 13px; font-weight: 600; color: var(--gray-600); cursor: pointer; transition: all 0.15s; white-space: nowrap; }
  .so-back-btn:hover { background: var(--gray-50); color: var(--gray-900); }
  .so-close-btn { width: 34px; height: 34px; border-radius: var(--radius-md); border: 1px solid var(--border); background: var(--surface); cursor: pointer; font-size: 16px; color: var(--gray-400); display: flex; align-items: center; justify-content: center; transition: all 0.15s; flex-shrink: 0; }
  .so-close-btn:hover { background: var(--gray-100); color: var(--gray-700); }

  /* Body */
  .so-body { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 14px; }
  .so-loading { flex: 1; display: flex; align-items: center; justify-content: center; }

  /* Source/priority badges */
  .so-source-row { display: flex; align-items: center; gap: 8px; }
  .so-source-badge { display: inline-flex; font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 12px; background: var(--blue-50, #eff6ff); color: var(--blue-700, #1d4ed8); text-transform: uppercase; letter-spacing: 0.04em; }
  .so-source-badge.manual { background: var(--gray-100); color: var(--gray-500); }
  .so-priority-badge { display: inline-flex; font-family: var(--font-heading); font-size: 11px; font-weight: 800; padding: 3px 10px; border-radius: 12px; background: var(--amber-100, #fef3c7); color: var(--amber-800, #92400e); text-transform: uppercase; letter-spacing: 0.04em; }

  /* Info cards */
  .so-info-card { background: var(--surface); border: 1px solid var(--border-light); border-radius: var(--radius-lg); padding: 14px 16px; display: flex; flex-direction: column; gap: 4px; }
  .so-info-label { font-family: var(--font-heading); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--gray-400); margin-bottom: 2px; }
  .so-info-name { font-family: var(--font-heading); font-size: 18px; font-weight: 800; color: var(--gray-900); letter-spacing: -0.015em; }
  .so-info-phone { font-size: 14px; color: var(--gray-500); font-weight: 500; }
  .so-info-addr { font-size: 13px; color: var(--gray-600); line-height: 1.4; }
  .so-info-date { font-family: var(--font-heading); font-size: 16px; font-weight: 700; color: var(--gray-900); }
  .so-info-window { font-size: 14px; color: var(--gray-600); font-weight: 500; }

  /* Loads */
  .so-load-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-top: 1px solid var(--border-light); }
  .so-load-row:first-of-type { border-top: none; }
  .so-load-mat { flex: 1; font-size: 13px; font-weight: 600; color: var(--gray-800); }
  .so-load-driver { font-size: 12px; color: var(--gray-500); }
  .so-unassigned { color: var(--amber-600); font-weight: 600; }

  /* Notes */
  .so-notes-text { font-size: 14px; color: var(--gray-600); line-height: 1.5; }

  /* Actions */
  .so-actions { display: flex; flex-direction: column; gap: 8px; margin-top: auto; padding-top: 8px; }
  .so-actions .btn { width: 100%; justify-content: center; padding: 12px; font-size: 15px; }

  /* ── Reschedule view ── */
  .so-resc-current {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 14px; border-radius: var(--radius-md);
    background: var(--gray-50); border: 1px solid var(--border-light);
    font-size: 13px;
  }
  .so-resc-current-label { font-weight: 600; color: var(--gray-500); }
  .so-resc-current-val { font-family: var(--font-heading); font-weight: 700; color: var(--gray-700); }

  /* Mini calendar */
  .so-cal { background: var(--surface); border: 1px solid var(--border-light); border-radius: var(--radius-lg); padding: 16px; }
  .so-cal-nav { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
  .so-cal-nav-btn { width: 32px; height: 32px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface); cursor: pointer; font-size: 16px; color: var(--gray-600); display: flex; align-items: center; justify-content: center; transition: all 0.15s; font-family: inherit; }
  .so-cal-nav-btn:hover { background: var(--gray-50); color: var(--gray-900); }
  .so-cal-heading { font-family: var(--font-heading); font-size: 15px; font-weight: 800; color: var(--gray-900); }
  .so-cal-dow-row { display: grid; grid-template-columns: repeat(7, 1fr); margin-bottom: 4px; }
  .so-cal-dow { text-align: center; font-family: var(--font-heading); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--gray-400); padding: 4px 0; }
  .so-cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
  .so-cal-cell {
    display: flex; flex-direction: column; align-items: center; justify-content: flex-start;
    padding: 6px 4px; border-radius: var(--radius-sm); cursor: pointer;
    transition: all 0.12s; min-height: 44px; gap: 3px;
    border: 1px solid transparent;
  }
  .so-cal-cell:hover:not(.other):not(.past) { background: var(--gray-50); border-color: var(--border-light); }
  .so-cal-cell.other { opacity: 0.25; cursor: default; }
  .so-cal-cell.past:not(.other) { opacity: 0.4; cursor: default; }
  .so-cal-cell.today { background: var(--green-25); }
  .so-cal-cell.original { background: var(--amber-25, #fffbeb); border-color: var(--amber-200); }
  .so-cal-cell.selected { background: var(--green-600); border-color: var(--green-700); }
  .so-cal-cell.selected .so-cal-num { color: #fff; font-weight: 800; }
  .so-cal-num { font-family: var(--font-heading); font-size: 13px; font-weight: 600; color: var(--gray-700); line-height: 1; }
  .so-cal-dots { display: flex; gap: 2px; }
  .so-cal-dot { width: 5px; height: 5px; border-radius: 50%; display: inline-block; }
  .so-cal-dot.am { background: var(--green-500); }
  .so-cal-dot.pm { background: var(--blue-500); }
  .so-cal-legend { display: flex; gap: 12px; margin-top: 10px; font-size: 11px; color: var(--gray-500); font-weight: 500; justify-content: center; }
  .so-cal-legend span { display: flex; align-items: center; gap: 4px; }

  /* Window picker */
  .so-window-pick { background: var(--surface); border: 1px solid var(--border-light); border-radius: var(--radius-lg); padding: 14px 16px; }
  .so-window-pick-date { font-family: var(--font-heading); font-size: 14px; font-weight: 700; color: var(--gray-700); margin-bottom: 12px; }
  .so-window-btns { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .so-win-btn {
    display: flex; flex-direction: column; align-items: flex-start; gap: 3px;
    padding: 12px 14px; border-radius: var(--radius-md);
    border: 2px solid var(--border-light); background: var(--surface);
    cursor: pointer; transition: all 0.15s; text-align: left;
  }
  .so-win-btn:hover { border-color: var(--green-300); background: var(--green-25); }
  .so-win-btn.active { border-color: var(--green-500); background: var(--green-25); box-shadow: 0 0 0 3px rgba(15,133,48,0.1); }
  .so-win-label { font-family: var(--font-heading); font-size: 13px; font-weight: 700; color: var(--gray-800); }
  .so-win-time { font-size: 11px; color: var(--gray-500); }
  .so-win-cap { font-family: var(--font-heading); font-size: 11px; font-weight: 700; margin-top: 2px; }
  .so-win-cap.avail { color: var(--green-600); }
  .so-win-cap.full { color: var(--red-500); }

  .so-cap-warn { margin: 0; font-size: 13px; }

  /* Capacity warning */
  .alert-warning { background: var(--amber-25, #fffbeb); border: 1px solid var(--amber-200); color: var(--amber-800, #92400e); padding: 10px 14px; border-radius: var(--radius-md); }

  /* Success state */
  .so-success { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 40px 20px; gap: 8px; }
  .so-success-icon { width: 56px; height: 56px; border-radius: 50%; background: var(--green-100); color: var(--green-700); font-size: 26px; display: flex; align-items: center; justify-content: center; font-weight: 700; margin-bottom: 8px; }
  .so-success-title { font-family: var(--font-heading); font-size: 22px; font-weight: 800; color: var(--gray-900); }
  .so-success-sub { font-size: 14px; color: var(--gray-500); line-height: 1.5; }

  /* ── Mobile: full-screen modal ── */
  @media (max-width: 640px) {
    .so-panel {
      top: 0; left: 0; right: 0; bottom: 0;
      width: 100%; border-left: none;
      border-radius: 0;
      animation: soSlideUp 0.28s cubic-bezier(0.32, 0.72, 0, 1);
    }
    @keyframes soSlideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
    .so-win-btn { padding: 14px; }
    .so-cal-cell { min-height: 40px; }
    .so-actions .btn { padding: 14px; font-size: 16px; }
  }

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
