'use client';

import Link from 'next/link';
import { useState, useMemo, useEffect, useCallback } from 'react';
import { ApiError, api } from '../lib/auth';

/* ── Date helpers ── */
const FULL_MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];
const SHORT_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

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
export type CapWindow = {
  date?: string; window?: string;
  used: number; total: number; remaining_capacity: number;
  available?: boolean;
};

export type SlideOverDropDetail = {
  id: string;
  ref: string;
  source?: string;
  is_priority: boolean;
  scheduled_date: string;
  scheduled_window: string | null;
  customer_name: string;
  customer_phone: string;
  delivery_address?: {
    line1: string; line2?: string | null;
    city: string; state: string; postal_code: string;
  } | null;
  notes?: string | null;
  required_loads: number;
  loads: {
    id: string; material: string; qty: number; unit: string;
    status: string; driver_user_id: string | null; driver_name: string | null;
  }[];
  notify_sent_at?: string | null;
  last_reschedule_sms_at?: string | null;
};

type SlideOverView = 'quick' | 'reschedule';

const STATUS_PILL: Record<string, string> = {
  assigned: 'pill-gray', loaded_leaving: 'pill-blue', delivered: 'pill-green',
  exception: 'pill-red', cancelled: 'pill-red', new: 'pill-amber',
};
const STATUS_LABEL: Record<string, string> = {
  assigned: 'Assigned', loaded_leaving: 'En Route', delivered: 'Delivered',
  exception: 'Exception', cancelled: 'Cancelled', new: 'Pending',
};

/* ════════════════════════════════════════════════
   PROPS
   ════════════════════════════════════════════════ */
interface DropRescheduleSlideOverProps {
  /** The drop ID to operate on */
  dropId: string;
  /** Pre-loaded drop detail — if null, the slide-over fetches it itself */
  dropDetail: SlideOverDropDetail | null;
  /** Pre-loaded capacity map — if not provided, the slide-over fetches its own */
  capData?: Record<string, { A: CapWindow | null; B: CapWindow | null }>;
  /** Called when the panel should close */
  onClose: () => void;
  /** Called after a successful reschedule so the parent can refresh */
  onRescheduled: () => void;
  /** If true, open directly to the reschedule calendar (skip quick-view) */
  startOnReschedule?: boolean;
}

/* ════════════════════════════════════════════════
   COMPONENT
   ════════════════════════════════════════════════ */
export default function DropRescheduleSlideOver({
  dropId,
  dropDetail: externalDetail,
  capData: externalCapData,
  onClose,
  onRescheduled,
  startOnReschedule = false,
}: DropRescheduleSlideOverProps) {
  const today = useMemo(() => new Date(), []);

  /* If parent didn't supply detail, fetch it ourselves */
  const [internalDetail, setInternalDetail] = useState<SlideOverDropDetail | null>(null);
  const dropDetail = externalDetail ?? internalDetail;

  useEffect(() => {
    if (externalDetail) return; // parent handles it
    api(`/dispatch/drops/${dropId}`)
      .then(setInternalDetail)
      .catch(() => null);
  }, [dropId, externalDetail]);

  /* If parent didn't supply capData, fetch our own */
  const [internalCapData, setInternalCapData] = useState<Record<string, { A: CapWindow | null; B: CapWindow | null }>>({});
  const capData = externalCapData ?? internalCapData;

  const fetchCapForMonth = useCallback(async (monthStart: Date) => {
    if (externalCapData) return; // parent owns it
    try {
      const y = monthStart.getFullYear(), m = monthStart.getMonth();
      const start = new Date(y, m, 1);
      const daysCount = new Date(y, m + 1, 0).getDate();
      const resp = await api(`/availability?start_date=${toKey(start)}&days=${daysCount}`);
      const map: Record<string, { A: CapWindow | null; B: CapWindow | null }> = {};
      for (const w of (resp.windows || [])) {
        if (!map[w.date]) map[w.date] = { A: null, B: null };
        map[w.date][w.window as 'A' | 'B'] = { used: w.used, total: w.total, remaining_capacity: w.remaining_capacity ?? (w.total - w.used) };
      }
      setInternalCapData(prev => ({ ...prev, ...map }));
    } catch { /* silent */ }
  }, [externalCapData]);

  /* ── View / reschedule state ── */
  const [view, setView] = useState<SlideOverView>(startOnReschedule ? 'reschedule' : 'quick');

  const [rescCalMonth, setRescCalMonth] = useState(() => {
    const base = dropDetail?.scheduled_date
      ? new Date(dropDetail.scheduled_date + 'T12:00:00')
      : new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });

  // Sync calendar month when detail loads
  useEffect(() => {
    if (!dropDetail) return;
    const base = new Date(dropDetail.scheduled_date + 'T12:00:00');
    setRescCalMonth(new Date(base.getFullYear(), base.getMonth(), 1));
    setRescDate(dropDetail.scheduled_date);
    setRescWindow(dropDetail.scheduled_window === 'B' ? 'B' : 'A');
  }, [dropDetail?.id]); // only re-sync when a different drop loads

  const [rescDate, setRescDate] = useState(dropDetail?.scheduled_date || toKey(today));
  const [rescWindow, setRescWindow] = useState<'A' | 'B'>(
    dropDetail?.scheduled_window === 'B' ? 'B' : 'A'
  );
  const [rescheduling, setRescheduling] = useState(false);
  const [rescMsg, setRescMsg] = useState('');
  const [rescSuccess, setRescSuccess] = useState(false);

  // Fetch cap data when calendar month changes
  useEffect(() => { fetchCapForMonth(rescCalMonth); }, [rescCalMonth, fetchCapForMonth]);

  /* ── Mini calendar cells ── */
  const calCells = useMemo(() => {
    const y = rescCalMonth.getFullYear(), m = rescCalMonth.getMonth();
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

  /* ── Actions ── */
  const goToReschedule = () => {
    setView('reschedule');
    setRescMsg('');
    setRescSuccess(false);
  };

  const goToQuick = () => {
    setView('quick');
    setRescMsg('');
    setRescSuccess(false);
  };

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
      setRescMsg((err as ApiError).message || 'Reschedule failed. Please try again.');
    } finally {
      setRescheduling(false);
    }
  };

  /* ── Derived values ── */
  const targetCap = capData[rescDate];
  const windowCap = rescWindow === 'A' ? targetCap?.A : targetCap?.B;
  const isSameAsOriginal =
    rescDate === dropDetail?.scheduled_date &&
    rescWindow === (dropDetail?.scheduled_window || 'A');

  /* ── Close on Escape ── */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  /* ════════════════════════════════════════════════
     RENDER
     ════════════════════════════════════════════════ */
  return (
    <>
      <style>{slideOverStyles}</style>

      {/* Backdrop */}
      <div className="so-backdrop" onClick={onClose} />

      {/* Panel */}
      <div className="so-panel" role="dialog" aria-modal="true">

        {/* ── Header ── */}
        <div className="so-header">
          <div className="so-header-left">
            {view === 'reschedule' && !startOnReschedule && (
              <button className="so-back-btn" onClick={goToQuick}>← Back</button>
            )}
            <div className="so-header-title">
              {!dropDetail
                ? 'Loading…'
                : view === 'quick'
                  ? `Order #${dropDetail.ref}`
                  : 'Reschedule Delivery'}
            </div>
          </div>
          <button className="so-close-btn" onClick={onClose} aria-label="Close">✕</button>
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
            {/* Badges */}
            {(dropDetail.source || dropDetail.is_priority) && (
              <div className="so-source-row">
                {dropDetail.source && (
                  <span className={`so-source-badge${dropDetail.source === 'manual' ? ' manual' : ''}`}>
                    {dropDetail.source === 'manual' ? 'Manual Entry' : dropDetail.source}
                  </span>
                )}
                {dropDetail.is_priority && (
                  <span className="so-priority-badge">⚡ Priority</span>
                )}
              </div>
            )}

            {/* Customer */}
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

            {/* Schedule */}
            <div className="so-info-card">
              <div className="so-info-label">Current Schedule</div>
              <div className="so-info-date">{fmtDateLong(dropDetail.scheduled_date)}</div>
              <div className="so-info-window">
                {dropDetail.is_priority
                  ? 'Priority — flexible window'
                  : dropDetail.scheduled_window === 'A'
                    ? '🌅 Morning (9am – 1pm)'
                    : '🌤 Afternoon (1pm – 5pm)'}
              </div>
            </div>

            {/* Loads */}
            {dropDetail.loads.length > 0 && (
              <div className="so-info-card">
                <div className="so-info-label">Loads ({dropDetail.loads.length})</div>
                {dropDetail.loads.map(l => (
                  <div key={l.id} className="so-load-row">
                    <div className="so-load-mat">{l.material} × {l.qty} {l.unit}</div>
                    <div className="so-load-driver">
                      {l.driver_name || <span className="so-unassigned">Unassigned</span>}
                    </div>
                    <span className={`pill pill-sm ${STATUS_PILL[l.status] || 'pill-gray'}`}>
                      <span className="pill-dot" />{STATUS_LABEL[l.status] || l.status}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Notes */}
            {dropDetail.notes && (
              <div className="so-info-card">
                <div className="so-info-label">Notes</div>
                <div className="so-notes-text">{dropDetail.notes}</div>
              </div>
            )}

            {/* Actions */}
            <div className="so-actions">
              <button className="btn btn-primary" onClick={goToReschedule}>
                Reschedule Delivery
              </button>
              <Link
                href={`/dispatch/drops/${dropDetail.id}`}
                className="btn btn-secondary"
                style={{ textDecoration: 'none', textAlign: 'center' }}
              >
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
              /* Success state */
              <div className="so-success">
                <div className="so-success-icon">✓</div>
                <div className="so-success-title">Rescheduled!</div>
                <div className="so-success-sub">
                  {dropDetail.customer_name} moved to {fmtDateLong(rescDate)},&nbsp;
                  {rescWindow === 'A' ? 'Morning' : 'Afternoon'}
                </div>
                <div className="so-success-actions">
                  <button className="btn btn-secondary" onClick={onClose}>Done</button>
                  {!startOnReschedule && (
                    <button className="btn btn-ghost" onClick={goToQuick}>View Order</button>
                  )}
                </div>
              </div>
            ) : (
              <>
                {/* Current schedule reminder */}
                <div className="so-resc-current">
                  <span className="so-resc-current-label">Currently scheduled:</span>
                  <span className="so-resc-current-val">
                    {fmtDateShort(dropDetail.scheduled_date)}
                    {' · '}
                    {dropDetail.scheduled_window === 'A' ? 'AM' : dropDetail.scheduled_window === 'B' ? 'PM' : 'Priority'}
                  </span>
                </div>

                {/* Mini calendar */}
                <div className="so-cal">
                  <div className="so-cal-nav">
                    <button
                      className="so-cal-nav-btn"
                      onClick={() => setRescCalMonth(m => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
                    >‹</button>
                    <span className="so-cal-heading">
                      {FULL_MONTHS[rescCalMonth.getMonth()]} {rescCalMonth.getFullYear()}
                    </span>
                    <button
                      className="so-cal-nav-btn"
                      onClick={() => setRescCalMonth(m => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
                    >›</button>
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
                              {amR !== null && amR > 0 && <span className="so-cal-dot am" title={`AM: ${amR} remaining`} />}
                              {pmR !== null && pmR > 0 && <span className="so-cal-dot pm" title={`PM: ${pmR} remaining`} />}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  <div className="so-cal-legend">
                    <span><span className="so-cal-dot am" /> AM available</span>
                    <span><span className="so-cal-dot pm" /> PM available</span>
                    <span className="so-cal-legend-orig">■ Current date</span>
                  </div>
                </div>

                {/* Window picker */}
                {rescDate && !dropDetail.is_priority && (
                  <div className="so-window-pick">
                    <div className="so-window-pick-date">{fmtDateLong(rescDate)}</div>
                    <div className="so-window-btns">
                      <button
                        className={`so-win-btn${rescWindow === 'A' ? ' active' : ''}`}
                        onClick={() => setRescWindow('A')}
                      >
                        <span className="so-win-label">🌅 Morning</span>
                        <span className="so-win-time">9am – 1pm</span>
                        {targetCap?.A != null && (
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
                        {targetCap?.B != null && (
                          <span className={`so-win-cap ${(targetCap.B?.remaining_capacity ?? 0) > 0 ? 'avail' : 'full'}`}>
                            {targetCap.B?.remaining_capacity ?? 0} slots left
                          </span>
                        )}
                      </button>
                    </div>
                  </div>
                )}

                {/* Priority — no window needed */}
                {rescDate && dropDetail.is_priority && (
                  <div className="so-window-pick">
                    <div className="so-window-pick-date">{fmtDateLong(rescDate)}</div>
                    <div className="so-priority-note">⚡ Priority delivery — no window required</div>
                  </div>
                )}

                {/* Capacity warning */}
                {windowCap && windowCap.remaining_capacity < dropDetail.required_loads && (
                  <div className="so-cap-warn alert-warning">
                    ⚠ Only {windowCap.remaining_capacity} slot{windowCap.remaining_capacity !== 1 ? 's' : ''} available — this order needs {dropDetail.required_loads}
                  </div>
                )}

                {rescMsg && (
                  <div className="so-cap-warn" style={{ background: 'var(--red-50)', border: '1px solid var(--red-200)', color: 'var(--red-700)', padding: '10px 14px', borderRadius: 'var(--radius-md)', fontSize: 13 }}>
                    {rescMsg}
                  </div>
                )}

                {/* Footer */}
                <div className="so-actions">
                  <button
                    className="btn btn-primary"
                    disabled={rescheduling || !rescDate || isSameAsOriginal}
                    onClick={submitReschedule}
                  >
                    {rescheduling
                      ? 'Saving…'
                      : isSameAsOriginal
                        ? 'No Change Made'
                        : `Move to ${fmtDateShort(rescDate)}`}
                  </button>
                  <button className="btn btn-ghost" onClick={startOnReschedule ? onClose : goToQuick}>
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}

/* ════════════════════════════════════════════════
   STYLES
   ════════════════════════════════════════════════ */
const slideOverStyles = `
  .so-backdrop {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.35);
    z-index: 200;
    animation: soFadeIn 0.2s ease;
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
  .so-header-title {
    font-family: var(--font-heading); font-size: 18px; font-weight: 800;
    color: var(--gray-900); letter-spacing: -0.02em;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .so-back-btn {
    display: flex; align-items: center; gap: 4px;
    padding: 6px 10px; border: 1px solid var(--border);
    border-radius: var(--radius-md); background: var(--surface);
    font-family: var(--font-heading); font-size: 13px; font-weight: 600;
    color: var(--gray-600); cursor: pointer; transition: all 0.15s; white-space: nowrap;
  }
  .so-back-btn:hover { background: var(--gray-50); color: var(--gray-900); }
  .so-close-btn {
    width: 34px; height: 34px; border-radius: var(--radius-md);
    border: 1px solid var(--border); background: var(--surface);
    cursor: pointer; font-size: 16px; color: var(--gray-400);
    display: flex; align-items: center; justify-content: center;
    transition: all 0.15s; flex-shrink: 0;
  }
  .so-close-btn:hover { background: var(--gray-100); color: var(--gray-700); }

  /* Body */
  .so-body { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 14px; }
  .so-loading { flex: 1; display: flex; align-items: center; justify-content: center; }

  /* Badges */
  .so-source-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .so-source-badge {
    display: inline-flex; font-size: 11px; font-weight: 700;
    padding: 3px 10px; border-radius: 12px;
    background: var(--blue-50, #eff6ff); color: var(--blue-700, #1d4ed8);
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .so-source-badge.manual { background: var(--gray-100); color: var(--gray-500); }
  .so-priority-badge {
    display: inline-flex; font-family: var(--font-heading); font-size: 11px; font-weight: 800;
    padding: 3px 10px; border-radius: 12px;
    background: var(--amber-100, #fef3c7); color: var(--amber-800, #92400e);
    text-transform: uppercase; letter-spacing: 0.04em;
  }

  /* Info cards */
  .so-info-card {
    background: var(--surface); border: 1px solid var(--border-light);
    border-radius: var(--radius-lg); padding: 14px 16px;
    display: flex; flex-direction: column; gap: 4px;
  }
  .so-info-label {
    font-family: var(--font-heading); font-size: 11px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.06em; color: var(--gray-400); margin-bottom: 2px;
  }
  .so-info-name { font-family: var(--font-heading); font-size: 18px; font-weight: 800; color: var(--gray-900); letter-spacing: -0.015em; }
  .so-info-phone { font-size: 14px; color: var(--gray-500); font-weight: 500; }
  .so-info-addr { font-size: 13px; color: var(--gray-600); line-height: 1.4; }
  .so-info-date { font-family: var(--font-heading); font-size: 16px; font-weight: 700; color: var(--gray-900); }
  .so-info-window { font-size: 14px; color: var(--gray-600); font-weight: 500; }

  /* Loads */
  .so-load-row {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 0; border-top: 1px solid var(--border-light);
  }
  .so-load-row:first-of-type { border-top: none; }
  .so-load-mat { flex: 1; font-size: 13px; font-weight: 600; color: var(--gray-800); }
  .so-load-driver { font-size: 12px; color: var(--gray-500); }
  .so-unassigned { color: var(--amber-600); font-weight: 600; }

  /* Notes */
  .so-notes-text { font-size: 14px; color: var(--gray-600); line-height: 1.5; }

  /* Actions */
  .so-actions { display: flex; flex-direction: column; gap: 8px; margin-top: auto; padding-top: 8px; }
  .so-actions .btn { width: 100%; justify-content: center; padding: 12px; font-size: 15px; }

  /* Current schedule reminder */
  .so-resc-current {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    padding: 10px 14px; border-radius: var(--radius-md);
    background: var(--gray-50); border: 1px solid var(--border-light);
    font-size: 13px;
  }
  .so-resc-current-label { font-weight: 600; color: var(--gray-500); }
  .so-resc-current-val { font-family: var(--font-heading); font-weight: 700; color: var(--gray-700); }

  /* Mini calendar */
  .so-cal {
    background: var(--surface); border: 1px solid var(--border-light);
    border-radius: var(--radius-lg); padding: 16px;
  }
  .so-cal-nav { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
  .so-cal-nav-btn {
    width: 32px; height: 32px; border: 1px solid var(--border);
    border-radius: var(--radius-md); background: var(--surface);
    cursor: pointer; font-size: 16px; color: var(--gray-600);
    display: flex; align-items: center; justify-content: center;
    transition: all 0.15s; font-family: inherit;
  }
  .so-cal-nav-btn:hover { background: var(--gray-50); color: var(--gray-900); }
  .so-cal-heading { font-family: var(--font-heading); font-size: 15px; font-weight: 800; color: var(--gray-900); }
  .so-cal-dow-row { display: grid; grid-template-columns: repeat(7, 1fr); margin-bottom: 4px; }
  .so-cal-dow {
    text-align: center; font-family: var(--font-heading); font-size: 11px;
    font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--gray-400); padding: 4px 0;
  }
  .so-cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
  .so-cal-cell {
    display: flex; flex-direction: column; align-items: center;
    padding: 6px 4px; border-radius: var(--radius-sm);
    cursor: pointer; transition: all 0.12s;
    min-height: 44px; gap: 3px; border: 1px solid transparent;
  }
  .so-cal-cell:hover:not(.other):not(.past) { background: var(--gray-50); border-color: var(--border-light); }
  .so-cal-cell.other { opacity: 0.25; cursor: default; pointer-events: none; }
  .so-cal-cell.past:not(.other) { opacity: 0.35; cursor: default; pointer-events: none; }
  .so-cal-cell.today { background: var(--green-25, #f0fdf4); }
  .so-cal-cell.original { background: var(--amber-25, #fffbeb); border-color: var(--amber-300, #fcd34d); }
  .so-cal-cell.selected { background: var(--green-600); border-color: var(--green-700); }
  .so-cal-cell.selected .so-cal-num { color: #fff; font-weight: 800; }
  .so-cal-cell.selected .so-cal-dot { opacity: 0.7; }
  .so-cal-num { font-family: var(--font-heading); font-size: 13px; font-weight: 600; color: var(--gray-700); line-height: 1; }
  .so-cal-dots { display: flex; gap: 2px; }
  .so-cal-dot { width: 5px; height: 5px; border-radius: 50%; display: inline-block; }
  .so-cal-dot.am { background: var(--green-500); }
  .so-cal-dot.pm { background: var(--blue-500); }
  .so-cal-legend {
    display: flex; gap: 12px; margin-top: 10px;
    font-size: 11px; color: var(--gray-500); font-weight: 500; justify-content: center;
    flex-wrap: wrap;
  }
  .so-cal-legend span { display: flex; align-items: center; gap: 4px; }
  .so-cal-legend-orig { color: var(--amber-600); font-weight: 600; }

  /* Window picker */
  .so-window-pick {
    background: var(--surface); border: 1px solid var(--border-light);
    border-radius: var(--radius-lg); padding: 14px 16px;
  }
  .so-window-pick-date {
    font-family: var(--font-heading); font-size: 14px; font-weight: 700;
    color: var(--gray-700); margin-bottom: 12px;
  }
  .so-window-btns { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .so-win-btn {
    display: flex; flex-direction: column; align-items: flex-start; gap: 3px;
    padding: 12px 14px; border-radius: var(--radius-md);
    border: 2px solid var(--border-light); background: var(--surface);
    cursor: pointer; transition: all 0.15s; text-align: left;
  }
  .so-win-btn:hover { border-color: var(--green-300); background: var(--green-25, #f0fdf4); }
  .so-win-btn.active {
    border-color: var(--green-500); background: var(--green-25, #f0fdf4);
    box-shadow: 0 0 0 3px rgba(15,133,48,0.1);
  }
  .so-win-label { font-family: var(--font-heading); font-size: 13px; font-weight: 700; color: var(--gray-800); }
  .so-win-time { font-size: 11px; color: var(--gray-500); }
  .so-win-cap { font-family: var(--font-heading); font-size: 11px; font-weight: 700; margin-top: 2px; }
  .so-win-cap.avail { color: var(--green-600); }
  .so-win-cap.full { color: var(--red-500); }

  /* Priority note */
  .so-priority-note {
    font-size: 13px; font-weight: 600; color: var(--amber-700);
    padding: 10px 14px; border-radius: var(--radius-md);
    background: var(--amber-25, #fffbeb); border: 1px solid var(--amber-200);
  }

  /* Warnings */
  .so-cap-warn { font-size: 13px; }
  .alert-warning {
    background: var(--amber-25, #fffbeb); border: 1px solid var(--amber-200, #fde68a);
    color: var(--amber-800, #92400e); padding: 10px 14px; border-radius: var(--radius-md);
  }

  /* Success */
  .so-success {
    flex: 1; display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    text-align: center; padding: 40px 20px; gap: 8px;
  }
  .so-success-icon {
    width: 60px; height: 60px; border-radius: 50%;
    background: var(--green-100); color: var(--green-700);
    font-size: 28px; display: flex; align-items: center; justify-content: center;
    font-weight: 700; margin-bottom: 8px;
  }
  .so-success-title { font-family: var(--font-heading); font-size: 24px; font-weight: 800; color: var(--gray-900); }
  .so-success-sub { font-size: 14px; color: var(--gray-500); line-height: 1.5; max-width: 280px; }
  .so-success-actions { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; justify-content: center; }

  /* Mobile: full-screen */
  @media (max-width: 640px) {
    .so-panel {
      top: 0; left: 0; right: 0; bottom: 0;
      width: 100%; border-left: none; border-radius: 0;
      animation: soSlideUp 0.28s cubic-bezier(0.32, 0.72, 0, 1);
    }
    @keyframes soSlideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
    .so-win-btn { padding: 14px; }
    .so-cal-cell { min-height: 40px; }
    .so-actions .btn { padding: 14px; font-size: 16px; }
  }
`;
