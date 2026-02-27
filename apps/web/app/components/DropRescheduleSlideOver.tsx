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

/* ══════════════════════════════════════════
   TYPES
   ══════════════════════════════════════════ */
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

type Driver = { id: string; name: string; email: string; truck?: string | null };
type PanelView = 'main' | 'reschedule';

const STATUS_OPTIONS = [
  { value: 'assigned',       label: 'Assigned',        pill: 'pill-gray'  },
  { value: 'loaded_leaving', label: 'Out for Delivery', pill: 'pill-blue'  },
  { value: 'delivered',      label: 'Delivered',        pill: 'pill-green' },
  { value: 'exception',      label: 'Exception',        pill: 'pill-red'   },
  { value: 'cancelled',      label: 'Cancelled',        pill: 'pill-red'   },
];

function statusPill(s: string) { return STATUS_OPTIONS.find(o => o.value === s)?.pill ?? 'pill-gray'; }
function statusLabel(s: string) { return STATUS_OPTIONS.find(o => o.value === s)?.label ?? s; }

const DEFAULT_SMS = 'Your delivery has been rescheduled. Please contact us with questions.';

/* ══════════════════════════════════════════
   PROPS
   ══════════════════════════════════════════ */
interface OrderPanelProps {
  dropId: string;
  dropDetail: SlideOverDropDetail | null;
  capData?: Record<string, { A: CapWindow | null; B: CapWindow | null }>;
  onClose: () => void;
  /** Called after any change that should refresh the parent (reschedule, driver, status) */
  onRescheduled: () => void;
  /** When true, open directly on the reschedule calendar */
  startOnReschedule?: boolean;
}

/* ══════════════════════════════════════════
   COMPONENT
   ══════════════════════════════════════════ */
export default function DropRescheduleSlideOver({
  dropId,
  dropDetail: externalDetail,
  capData: externalCapData,
  onClose,
  onRescheduled,
  startOnReschedule = false,
}: OrderPanelProps) {
  const today = useMemo(() => new Date(), []);

  /* Self-fetch detail if parent didn't supply */
  const [internalDetail, setInternalDetail] = useState<SlideOverDropDetail | null>(null);
  const dropDetail = externalDetail ?? internalDetail;

  const refreshDetail = useCallback(async () => {
    try {
      const d = await api(`/dispatch/drops/${dropId}`);
      setInternalDetail(d);
    } catch { /* silent */ }
  }, [dropId]);

  useEffect(() => {
    if (!externalDetail) refreshDetail();
  }, [dropId, externalDetail, refreshDetail]);

  /* Self-fetch capacity if not supplied */
  const [internalCapData, setInternalCapData] = useState<Record<string, { A: CapWindow | null; B: CapWindow | null }>>({});
  const capData = externalCapData ?? internalCapData;

  const fetchCapForMonth = useCallback(async (monthStart: Date) => {
    if (externalCapData) return;
    try {
      const y = monthStart.getFullYear(), m = monthStart.getMonth();
      const daysCount = new Date(y, m + 1, 0).getDate();
      const resp = await api(`/availability?start_date=${toKey(new Date(y, m, 1))}&days=${daysCount}`);
      const map: Record<string, { A: CapWindow | null; B: CapWindow | null }> = {};
      for (const w of (resp.windows || [])) {
        if (!map[w.date]) map[w.date] = { A: null, B: null };
        map[w.date][w.window as 'A' | 'B'] = {
          used: w.used, total: w.total,
          remaining_capacity: w.remaining_capacity ?? (w.total - w.used),
        };
      }
      setInternalCapData(prev => ({ ...prev, ...map }));
    } catch { /* silent */ }
  }, [externalCapData]);

  /* Drivers list */
  const [drivers, setDrivers] = useState<Driver[]>([]);
  useEffect(() => {
    api('/dispatch/drivers').then(d => setDrivers(d.drivers || [])).catch(() => null);
  }, []);

  /* Panel view */
  const [view, setView] = useState<PanelView>(startOnReschedule ? 'reschedule' : 'main');

  /* ── Load accordion ── */
  const [expandedLoadId, setExpandedLoadId] = useState<string | null>(null);
  const [loadEdits, setLoadEdits] = useState<Record<string, { driverId: string; status: string }>>({});
  const [savingLoadId, setSavingLoadId] = useState<string | null>(null);
  const [loadMsg, setLoadMsg] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!dropDetail) return;
    const init: Record<string, { driverId: string; status: string }> = {};
    for (const l of dropDetail.loads) {
      if (!loadEdits[l.id]) init[l.id] = { driverId: l.driver_user_id ?? '', status: l.status };
    }
    if (Object.keys(init).length) setLoadEdits(prev => ({ ...prev, ...init }));
  }, [dropDetail?.loads.map(l => l.id).join(',')]);

  const toggleLoad = (id: string) =>
    setExpandedLoadId(prev => prev === id ? null : id);

  const saveLoad = async (loadId: string) => {
    const edit = loadEdits[loadId];
    if (!edit) return;
    setSavingLoadId(loadId);
    setLoadMsg(prev => ({ ...prev, [loadId]: '' }));
    try {
      await api('/dispatch/loads/assign', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ load_ids: [loadId], driver_user_id: edit.driverId || null }),
      });
      await api(`/dispatch/loads/${loadId}/status`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: edit.status }),
      });
      setLoadMsg(prev => ({ ...prev, [loadId]: 'saved' }));
      setExpandedLoadId(null);
      await refreshDetail();
      onRescheduled();
      setTimeout(() => setLoadMsg(prev => ({ ...prev, [loadId]: '' })), 2500);
    } catch (err) {
      setLoadMsg(prev => ({ ...prev, [loadId]: (err as ApiError).message || 'Save failed' }));
    } finally { setSavingLoadId(null); }
  };

  /* ── SMS / notifications ── */
  const [smsText, setSmsText] = useState(DEFAULT_SMS);
  const [smsEditing, setSmsEditing] = useState(false);
  const [smsSending, setSmsSending] = useState(false);
  const [smsMsg, setSmsMsg] = useState('');
  const [notifySending, setNotifySending] = useState(false);
  const [notifyMsg, setNotifyMsg] = useState('');

  const sendSms = async () => {
    setSmsSending(true); setSmsMsg('');
    try {
      await api(`/dispatch/drops/${dropId}/send-reschedule-sms`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: smsText }),
      });
      setSmsMsg('sent'); setSmsEditing(false);
      await refreshDetail();
    } catch (err) {
      setSmsMsg((err as ApiError).message || 'Failed to send');
    } finally { setSmsSending(false); }
  };

  const sendDeliveryNotification = async () => {
    setNotifySending(true); setNotifyMsg('');
    try {
      await api(`/dispatch/drops/${dropId}/send-delivery-notification`, { method: 'POST' });
      setNotifyMsg('sent');
      await refreshDetail();
    } catch (err) {
      setNotifyMsg((err as ApiError).message || 'Failed to send');
    } finally { setNotifySending(false); }
  };

  /* ── Reschedule ── */
  const [rescCalMonth, setRescCalMonth] = useState(() => {
    const base = dropDetail?.scheduled_date
      ? new Date(dropDetail.scheduled_date + 'T12:00:00') : new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });
  const [rescDate, setRescDate] = useState(dropDetail?.scheduled_date || toKey(today));
  const [rescWindow, setRescWindow] = useState<'A' | 'B'>(
    dropDetail?.scheduled_window === 'B' ? 'B' : 'A'
  );
  const [rescheduling, setRescheduling] = useState(false);
  const [rescMsg, setRescMsg] = useState('');
  const [rescSuccess, setRescSuccess] = useState(false);

  useEffect(() => {
    if (!dropDetail) return;
    const base = new Date(dropDetail.scheduled_date + 'T12:00:00');
    setRescCalMonth(new Date(base.getFullYear(), base.getMonth(), 1));
    setRescDate(dropDetail.scheduled_date);
    setRescWindow(dropDetail.scheduled_window === 'B' ? 'B' : 'A');
  }, [dropDetail?.id]);

  useEffect(() => { fetchCapForMonth(rescCalMonth); }, [rescCalMonth, fetchCapForMonth]);

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

  const submitReschedule = async () => {
    if (!rescDate) { setRescMsg('Please select a date.'); return; }
    setRescheduling(true); setRescMsg('');
    try {
await api(`/drops/${dropId}/reschedule`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ scheduled_date: rescDate, scheduled_window: dropDetail.is_priority ? null : rescWindow }),
});    
      setRescSuccess(true);
      onRescheduled();
      await refreshDetail();
    } catch (err) {
      setRescMsg((err as ApiError).message || 'Reschedule failed. Please try again.');
    } finally { setRescheduling(false); }
  };

  const targetCap = capData[rescDate];
  const windowCap = rescWindow === 'A' ? targetCap?.A : targetCap?.B;
  const isSameAsOriginal =
    rescDate === dropDetail?.scheduled_date &&
    rescWindow === (dropDetail?.scheduled_window || 'A');

  /* Escape key */
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  /* ══════════════════════════════════════════
     RENDER
     ══════════════════════════════════════════ */
  return (
    <>
      <style>{panelStyles}</style>
      <div className="so-backdrop" onClick={onClose} />
      <div className="so-panel" role="dialog" aria-modal="true">

        {/* Header */}
        <div className="so-header">
          <div className="so-header-left">
            {view === 'reschedule' && !startOnReschedule && (
              <button className="so-back-btn" onClick={() => { setView('main'); setRescMsg(''); setRescSuccess(false); }}>
                ← Back
              </button>
            )}
            <div className="so-header-title">
              {!dropDetail ? 'Loading…'
                : view === 'main' ? `Order #${dropDetail.ref}`
                : 'Reschedule Delivery'}
            </div>
          </div>
          <button className="so-close-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {!dropDetail && <div className="so-loading"><div className="spinner spinner-lg" /></div>}

        {/* ════════════════════════════
            MAIN VIEW
            ════════════════════════════ */}
        {dropDetail && view === 'main' && (
          <div className="so-body">

            {/* Badges */}
            {(dropDetail.source || dropDetail.is_priority) && (
              <div className="so-source-row">
                {dropDetail.source && (
                  <span className={`so-source-badge${dropDetail.source === 'manual' ? ' manual' : ''}`}>
                    {dropDetail.source === 'manual' ? 'Manual Entry' : dropDetail.source}
                  </span>
                )}
                {dropDetail.is_priority && <span className="so-priority-badge">⚡ Priority</span>}
              </div>
            )}

            {/* Customer */}
            <div className="so-card">
              <div className="so-card-label">Customer</div>
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
            <div className="so-card">
              <div className="so-card-label">Schedule</div>
              <div className="so-info-date">{fmtDateLong(dropDetail.scheduled_date)}</div>
              <div className="so-info-window">
                {dropDetail.is_priority ? 'Priority — flexible window'
                  : dropDetail.scheduled_window === 'A' ? '🌅 Morning (9am – 1pm)'
                  : '🌤 Afternoon (1pm – 5pm)'}
              </div>
              <button
                className="so-resc-trigger"
                onClick={() => { setView('reschedule'); setRescMsg(''); setRescSuccess(false); }}
              >
                📅 Reschedule
              </button>
            </div>

            {/* Loads */}
            <div className="so-card so-card-flush">
              <div className="so-card-label so-card-label-pad">
                Loads ({dropDetail.loads.length})
              </div>
              {dropDetail.loads.map(load => {
                const isExpanded = expandedLoadId === load.id;
                const edit = loadEdits[load.id] ?? { driverId: load.driver_user_id ?? '', status: load.status };
                const isTerminal = ['delivered', 'cancelled'].includes(load.status);
                const msg = loadMsg[load.id];
                return (
                  <div key={load.id} className={`so-load${isExpanded ? ' expanded' : ''}`}>
                    <div
                      className="so-load-summary"
                      onClick={() => !isTerminal && toggleLoad(load.id)}
                      style={{ cursor: isTerminal ? 'default' : 'pointer' }}
                    >
                      <div className="so-load-left">
                        <div className="so-load-mat">{load.material} × {load.qty} {load.unit}</div>
                        <div className="so-load-driver-name">
                          {load.driver_name
                            ? <span>🚚 {load.driver_name}</span>
                            : <span className="so-unassigned">⚠ Unassigned</span>}
                        </div>
                      </div>
                      <div className="so-load-right">
                        {msg === 'saved' && <span className="so-load-saved">✓</span>}
                        <span className={`pill pill-sm ${statusPill(load.status)}`}>
                          <span className="pill-dot" />{statusLabel(load.status)}
                        </span>
                        {!isTerminal && (
                          <span className={`so-load-chevron${isExpanded ? ' open' : ''}`}>›</span>
                        )}
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="so-load-editor">
                        <div className="so-field">
                          <label className="so-field-label">Driver</label>
                          <select
                            className="so-select"
                            value={edit.driverId}
                            onChange={e => setLoadEdits(prev => ({
                              ...prev, [load.id]: { ...prev[load.id], driverId: e.target.value },
                            }))}
                          >
                            <option value="">⚠ Unassigned</option>
                            {drivers.map(d => (
                              <option key={d.id} value={d.id}>
                                {d.name}{d.truck ? ` (${d.truck})` : ''}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div className="so-field">
                          <label className="so-field-label">Status</label>
                          <div className="so-status-btns">
                            {STATUS_OPTIONS.map(opt => (
                              <button
                                key={opt.value}
                                className={`so-status-btn${edit.status === opt.value ? ' active' : ''}`}
                                onClick={() => setLoadEdits(prev => ({
                                  ...prev, [load.id]: { ...prev[load.id], status: opt.value },
                                }))}
                              >
                                {opt.label}
                              </button>
                            ))}
                          </div>
                        </div>

                        {msg && msg !== 'saved' && <div className="so-load-err">{msg}</div>}

                        <div className="so-load-editor-actions">
                          <button
                            className="btn btn-primary btn-sm"
                            disabled={savingLoadId === load.id}
                            onClick={() => saveLoad(load.id)}
                          >
                            {savingLoadId === load.id ? 'Saving…' : 'Save Changes'}
                          </button>
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => {
                              setExpandedLoadId(null);
                              setLoadEdits(prev => ({
                                ...prev,
                                [load.id]: { driverId: load.driver_user_id ?? '', status: load.status },
                              }));
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Notifications */}
            <div className="so-card">
              <div className="so-card-label">Notifications</div>

              {/* Delivery notification */}
              <div className="so-notif-row">
                <div className="so-notif-info">
                  <div className="so-notif-title">Delivery notification</div>
                  <div className="so-notif-sub">
                    {dropDetail.notify_sent_at
                      ? `Sent ${new Date(dropDetail.notify_sent_at).toLocaleString()}`
                      : 'Not yet sent'}
                  </div>
                </div>
                <button className="btn btn-secondary btn-sm" disabled={notifySending} onClick={sendDeliveryNotification}>
                  {notifySending ? 'Sending…' : '📱 Send'}
                </button>
              </div>
              {notifyMsg === 'sent' && <div className="so-notif-success">✓ Notification sent</div>}
              {notifyMsg && notifyMsg !== 'sent' && <div className="so-notif-err">{notifyMsg}</div>}

              {/* Reschedule SMS */}
              <div className="so-notif-row" style={{ marginTop: 12 }}>
                <div className="so-notif-info">
                  <div className="so-notif-title">Reschedule SMS</div>
                  <div className="so-notif-sub">
                    {dropDetail.last_reschedule_sms_at
                      ? `Sent ${new Date(dropDetail.last_reschedule_sms_at).toLocaleString()}`
                      : 'Not yet sent'}
                  </div>
                </div>
                {!smsEditing && (
                  <button className="btn btn-secondary btn-sm" onClick={() => { setSmsEditing(true); setSmsMsg(''); }}>
                    📱 Send
                  </button>
                )}
              </div>

              {smsEditing && (
                <div className="so-sms-composer">
                  <textarea
                    className="so-sms-textarea"
                    value={smsText}
                    rows={3}
                    onChange={e => setSmsText(e.target.value)}
                    placeholder="Message…"
                  />
                  <div className="so-sms-char">{smsText.length} chars · sending to {fmtPhone(dropDetail.customer_phone)}</div>
                  {smsMsg && smsMsg !== 'sent' && <div className="so-notif-err">{smsMsg}</div>}
                  <div className="so-sms-actions">
                    <button className="btn btn-primary btn-sm" disabled={smsSending || !smsText.trim()} onClick={sendSms}>
                      {smsSending ? 'Sending…' : 'Send SMS'}
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => { setSmsEditing(false); setSmsText(DEFAULT_SMS); setSmsMsg(''); }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {smsMsg === 'sent' && <div className="so-notif-success">✓ SMS sent</div>}
            </div>

            {/* Notes */}
            {dropDetail.notes && (
              <div className="so-card">
                <div className="so-card-label">Notes</div>
                <div className="so-notes-text">{dropDetail.notes}</div>
              </div>
            )}

            {/* Full details link */}
            <Link href={`/dispatch/drops/${dropDetail.id}`} className="so-full-link" style={{ textDecoration: 'none' }}>
              View Full Order Details →
            </Link>

          </div>
        )}

        {/* ════════════════════════════
            RESCHEDULE VIEW
            ════════════════════════════ */}
        {dropDetail && view === 'reschedule' && (
          <div className="so-body">
            {rescSuccess ? (
              <div className="so-success">
                <div className="so-success-icon">✓</div>
                <div className="so-success-title">Rescheduled!</div>
                <div className="so-success-sub">
                  {dropDetail.customer_name} moved to {fmtDateLong(rescDate)},{' '}
                  {rescWindow === 'A' ? 'Morning' : 'Afternoon'}
                </div>
                <div className="so-success-actions">
                  {!startOnReschedule && (
                    <button className="btn btn-secondary" onClick={() => { setView('main'); setRescSuccess(false); }}>
                      Back to Order
                    </button>
                  )}
                  <button className="btn btn-ghost" onClick={onClose}>Done</button>
                </div>
              </div>
            ) : (
              <>
                <div className="so-resc-current">
                  <span className="so-resc-current-label">Currently:</span>
                  <span className="so-resc-current-val">
                    {fmtDateShort(dropDetail.scheduled_date)} · {dropDetail.scheduled_window === 'A' ? 'AM' : dropDetail.scheduled_window === 'B' ? 'PM' : 'Priority'}
                  </span>
                </div>

                <div className="so-cal">
                  <div className="so-cal-nav">
                    <button className="so-cal-nav-btn" onClick={() => setRescCalMonth(m => new Date(m.getFullYear(), m.getMonth() - 1, 1))}>‹</button>
                    <span className="so-cal-heading">{FULL_MONTHS[rescCalMonth.getMonth()]} {rescCalMonth.getFullYear()}</span>
                    <button className="so-cal-nav-btn" onClick={() => setRescCalMonth(m => new Date(m.getFullYear(), m.getMonth() + 1, 1))}>›</button>
                  </div>
                  <div className="so-cal-dow-row">
                    {['S','M','T','W','T','F','S'].map((d, i) => <div key={i} className="so-cal-dow">{d}</div>)}
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
                              {amR !== null && amR > 0 && <span className="so-cal-dot am" />}
                              {pmR !== null && pmR > 0 && <span className="so-cal-dot pm" />}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div className="so-cal-legend">
                    <span><span className="so-cal-dot am" /> AM</span>
                    <span><span className="so-cal-dot pm" /> PM</span>
                  </div>
                </div>

                {rescDate && !dropDetail.is_priority && (
                  <div className="so-window-pick">
                    <div className="so-window-pick-date">{fmtDateLong(rescDate)}</div>
                    <div className="so-window-btns">
                      {(['A', 'B'] as const).map(w => {
                        const cap = w === 'A' ? targetCap?.A : targetCap?.B;
                        return (
                          <button key={w} className={`so-win-btn${rescWindow === w ? ' active' : ''}`} onClick={() => setRescWindow(w)}>
                            <span className="so-win-label">{w === 'A' ? '🌅 Morning' : '🌤 Afternoon'}</span>
                            <span className="so-win-time">{w === 'A' ? '9am – 1pm' : '1pm – 5pm'}</span>
                            {cap != null && (
                              <span className={`so-win-cap ${(cap.remaining_capacity ?? 0) > 0 ? 'avail' : 'full'}`}>
                                {cap.remaining_capacity ?? 0} slots left
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {rescDate && dropDetail.is_priority && (
                  <div className="so-window-pick">
                    <div className="so-window-pick-date">{fmtDateLong(rescDate)}</div>
                    <div className="so-priority-note">⚡ Priority delivery — no window required</div>
                  </div>
                )}

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

                <div className="so-actions">
                  <button className="btn btn-primary" disabled={rescheduling || !rescDate || isSameAsOriginal} onClick={submitReschedule}>
                    {rescheduling ? 'Saving…' : isSameAsOriginal ? 'No Change Made' : `Move to ${fmtDateShort(rescDate)}`}
                  </button>
                  <button className="btn btn-ghost" onClick={startOnReschedule ? onClose : () => setView('main')}>
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

/* ══════════════════════════════════════════
   STYLES
   ══════════════════════════════════════════ */
const panelStyles = `
  .so-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.35); z-index: 200; animation: soFadeIn 0.2s ease; backdrop-filter: blur(2px); }
  .so-panel { position: fixed; top: 0; right: 0; bottom: 0; width: 440px; max-width: 100%; background: var(--bg-primary); border-left: 1px solid var(--border); box-shadow: -8px 0 40px rgba(0,0,0,0.15); z-index: 201; display: flex; flex-direction: column; animation: soSlideIn 0.25s cubic-bezier(0.32,0.72,0,1); overflow: hidden; }
  @keyframes soFadeIn { from { opacity: 0; } to { opacity: 1; } }
  @keyframes soSlideIn { from { transform: translateX(100%); } to { transform: translateX(0); } }

  .so-header { display: flex; align-items: center; justify-content: space-between; padding: 18px 20px; border-bottom: 1px solid var(--border-light); background: var(--surface); flex-shrink: 0; }
  .so-header-left { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .so-header-title { font-family: var(--font-heading); font-size: 18px; font-weight: 800; color: var(--gray-900); letter-spacing: -0.02em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .so-back-btn { display: flex; align-items: center; gap: 4px; padding: 6px 10px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface); font-family: var(--font-heading); font-size: 13px; font-weight: 600; color: var(--gray-600); cursor: pointer; transition: all 0.15s; white-space: nowrap; }
  .so-back-btn:hover { background: var(--gray-50); color: var(--gray-900); }
  .so-close-btn { width: 34px; height: 34px; border-radius: var(--radius-md); border: 1px solid var(--border); background: var(--surface); cursor: pointer; font-size: 16px; color: var(--gray-400); display: flex; align-items: center; justify-content: center; transition: all 0.15s; flex-shrink: 0; }
  .so-close-btn:hover { background: var(--gray-100); color: var(--gray-700); }

  .so-body { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .so-loading { flex: 1; display: flex; align-items: center; justify-content: center; }

  /* Cards */
  .so-card { background: var(--surface); border: 1px solid var(--border-light); border-radius: var(--radius-lg); padding: 14px 16px; display: flex; flex-direction: column; gap: 5px; }
  .so-card-flush { padding: 0; overflow: hidden; }
  .so-card-label { font-family: var(--font-heading); font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em; color: var(--gray-400); }
  .so-card-label-pad { padding: 12px 16px 8px; border-bottom: 1px solid var(--border-light); }

  /* Info */
  .so-source-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .so-source-badge { display: inline-flex; font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 12px; background: var(--blue-50,#eff6ff); color: var(--blue-700,#1d4ed8); text-transform: uppercase; letter-spacing: 0.04em; }
  .so-source-badge.manual { background: var(--gray-100); color: var(--gray-500); }
  .so-priority-badge { display: inline-flex; font-family: var(--font-heading); font-size: 11px; font-weight: 800; padding: 3px 10px; border-radius: 12px; background: var(--amber-100,#fef3c7); color: var(--amber-800,#92400e); text-transform: uppercase; letter-spacing: 0.04em; }
  .so-info-name { font-family: var(--font-heading); font-size: 17px; font-weight: 800; color: var(--gray-900); letter-spacing: -0.015em; }
  .so-info-phone { font-size: 14px; color: var(--gray-500); font-weight: 500; }
  .so-info-addr { font-size: 13px; color: var(--gray-600); line-height: 1.45; }
  .so-info-date { font-family: var(--font-heading); font-size: 15px; font-weight: 700; color: var(--gray-900); }
  .so-info-window { font-size: 13px; color: var(--gray-600); font-weight: 500; }
  .so-resc-trigger { align-self: flex-start; margin-top: 6px; padding: 6px 14px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface); font-family: var(--font-heading); font-size: 12px; font-weight: 600; color: var(--gray-700); cursor: pointer; transition: all 0.15s; }
  .so-resc-trigger:hover { background: var(--gray-50); border-color: var(--green-300); color: var(--green-700); }

  /* Load accordion */
  .so-load { border-bottom: 1px solid var(--border-light); }
  .so-load:last-child { border-bottom: none; }
  .so-load-summary { display: flex; align-items: center; justify-content: space-between; padding: 11px 16px; transition: background 0.12s; gap: 10px; }
  .so-load-summary:hover { background: var(--gray-25,#fafafa); }
  .so-load.expanded .so-load-summary { background: var(--green-25,#f0fdf4); }
  .so-load-left { flex: 1; min-width: 0; }
  .so-load-mat { font-family: var(--font-heading); font-size: 13px; font-weight: 700; color: var(--gray-900); }
  .so-load-driver-name { font-size: 12px; color: var(--gray-500); margin-top: 2px; }
  .so-unassigned { color: var(--amber-600,#d97706); font-weight: 600; }
  .so-load-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
  .so-load-saved { font-family: var(--font-heading); font-size: 12px; font-weight: 700; color: var(--green-600); }
  .so-load-chevron { font-size: 18px; color: var(--gray-400); transition: transform 0.2s; display: inline-block; line-height: 1; }
  .so-load-chevron.open { transform: rotate(90deg); }
  .so-load-editor { padding: 14px 16px 16px; background: var(--gray-25,#fafafa); border-top: 1px solid var(--border-light); display: flex; flex-direction: column; gap: 14px; }
  .so-field { display: flex; flex-direction: column; gap: 6px; }
  .so-field-label { font-family: var(--font-heading); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--gray-500); }
  .so-select { width: 100%; padding: 9px 12px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface); font-size: 14px; font-weight: 500; font-family: inherit; color: var(--gray-800); cursor: pointer; }
  .so-status-btns { display: flex; flex-wrap: wrap; gap: 6px; }
  .so-status-btn { padding: 6px 11px; border-radius: var(--radius-md); border: 1.5px solid var(--border); background: var(--surface); font-family: var(--font-heading); font-size: 12px; font-weight: 600; color: var(--gray-600); cursor: pointer; transition: all 0.12s; }
  .so-status-btn:hover { border-color: var(--green-300); color: var(--green-700); }
  .so-status-btn.active { border-color: var(--green-500); background: var(--green-600); color: #fff; }
  .so-load-err { font-size: 12px; color: var(--red-600); }
  .so-load-editor-actions { display: flex; gap: 8px; }

  /* Notifications */
  .so-notif-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .so-notif-info { flex: 1; min-width: 0; }
  .so-notif-title { font-family: var(--font-heading); font-size: 13px; font-weight: 700; color: var(--gray-800); }
  .so-notif-sub { font-size: 12px; color: var(--gray-400); margin-top: 2px; }
  .so-notif-success { font-size: 12px; color: var(--green-600); font-weight: 600; margin-top: 6px; }
  .so-notif-err { font-size: 12px; color: var(--red-600); margin-top: 4px; }
  .so-sms-composer { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; padding: 12px; background: var(--gray-25,#fafafa); border: 1px solid var(--border-light); border-radius: var(--radius-md); }
  .so-sms-textarea { width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-md); font-size: 13px; font-family: inherit; color: var(--gray-800); resize: vertical; background: var(--surface); box-sizing: border-box; }
  .so-sms-char { font-size: 11px; color: var(--gray-400); }
  .so-sms-actions { display: flex; gap: 8px; }

  .so-notes-text { font-size: 14px; color: var(--gray-600); line-height: 1.5; }

  .so-full-link { display: flex; align-items: center; justify-content: center; padding: 12px; border: 1px solid var(--border-light); border-radius: var(--radius-lg); font-family: var(--font-heading); font-size: 13px; font-weight: 600; color: var(--gray-600); background: var(--surface); transition: all 0.15s; }
  .so-full-link:hover { border-color: var(--green-300); color: var(--green-700); background: var(--green-25,#f0fdf4); }

  /* Reschedule view */
  .so-actions { display: flex; flex-direction: column; gap: 8px; padding-top: 4px; }
  .so-actions .btn { width: 100%; justify-content: center; padding: 12px; font-size: 15px; }
  .so-resc-current { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 14px; border-radius: var(--radius-md); background: var(--gray-50); border: 1px solid var(--border-light); font-size: 13px; }
  .so-resc-current-label { font-weight: 600; color: var(--gray-500); }
  .so-resc-current-val { font-family: var(--font-heading); font-weight: 700; color: var(--gray-700); }
  .so-cal { background: var(--surface); border: 1px solid var(--border-light); border-radius: var(--radius-lg); padding: 14px; }
  .so-cal-nav { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .so-cal-nav-btn { width: 30px; height: 30px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface); cursor: pointer; font-size: 16px; color: var(--gray-600); display: flex; align-items: center; justify-content: center; transition: all 0.15s; font-family: inherit; }
  .so-cal-nav-btn:hover { background: var(--gray-50); color: var(--gray-900); }
  .so-cal-heading { font-family: var(--font-heading); font-size: 14px; font-weight: 800; color: var(--gray-900); }
  .so-cal-dow-row { display: grid; grid-template-columns: repeat(7,1fr); margin-bottom: 3px; }
  .so-cal-dow { text-align: center; font-family: var(--font-heading); font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--gray-400); padding: 3px 0; }
  .so-cal-grid { display: grid; grid-template-columns: repeat(7,1fr); gap: 2px; }
  .so-cal-cell { display: flex; flex-direction: column; align-items: center; padding: 5px 2px; border-radius: var(--radius-sm); cursor: pointer; transition: all 0.12s; min-height: 40px; gap: 2px; border: 1px solid transparent; }
  .so-cal-cell:hover:not(.other):not(.past) { background: var(--gray-50); border-color: var(--border-light); }
  .so-cal-cell.other { opacity: 0.2; cursor: default; pointer-events: none; }
  .so-cal-cell.past:not(.other) { opacity: 0.35; cursor: default; pointer-events: none; }
  .so-cal-cell.today { background: var(--green-25,#f0fdf4); }
  .so-cal-cell.original { background: var(--amber-25,#fffbeb); border-color: var(--amber-300,#fcd34d); }
  .so-cal-cell.selected { background: var(--green-600); border-color: var(--green-700); }
  .so-cal-cell.selected .so-cal-num { color: #fff; font-weight: 800; }
  .so-cal-num { font-family: var(--font-heading); font-size: 12px; font-weight: 600; color: var(--gray-700); line-height: 1; }
  .so-cal-dots { display: flex; gap: 2px; }
  .so-cal-dot { width: 5px; height: 5px; border-radius: 50%; display: inline-block; }
  .so-cal-dot.am { background: var(--green-500); }
  .so-cal-dot.pm { background: var(--blue-500); }
  .so-cal-legend { display: flex; gap: 12px; margin-top: 10px; font-size: 11px; color: var(--gray-500); font-weight: 500; justify-content: center; }
  .so-cal-legend span { display: flex; align-items: center; gap: 4px; }
  .so-window-pick { background: var(--surface); border: 1px solid var(--border-light); border-radius: var(--radius-lg); padding: 14px 16px; }
  .so-window-pick-date { font-family: var(--font-heading); font-size: 14px; font-weight: 700; color: var(--gray-700); margin-bottom: 10px; }
  .so-window-btns { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .so-win-btn { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; padding: 12px 14px; border-radius: var(--radius-md); border: 2px solid var(--border-light); background: var(--surface); cursor: pointer; transition: all 0.15s; text-align: left; }
  .so-win-btn:hover { border-color: var(--green-300); background: var(--green-25,#f0fdf4); }
  .so-win-btn.active { border-color: var(--green-500); background: var(--green-25,#f0fdf4); box-shadow: 0 0 0 3px rgba(15,133,48,0.1); }
  .so-win-label { font-family: var(--font-heading); font-size: 13px; font-weight: 700; color: var(--gray-800); }
  .so-win-time { font-size: 11px; color: var(--gray-500); }
  .so-win-cap { font-family: var(--font-heading); font-size: 11px; font-weight: 700; margin-top: 2px; }
  .so-win-cap.avail { color: var(--green-600); }
  .so-win-cap.full { color: var(--red-500); }
  .so-priority-note { font-size: 13px; font-weight: 600; color: var(--amber-700); padding: 10px 14px; border-radius: var(--radius-md); background: var(--amber-25,#fffbeb); border: 1px solid var(--amber-200); }
  .so-cap-warn { font-size: 13px; }
  .alert-warning { background: var(--amber-25,#fffbeb); border: 1px solid var(--amber-200,#fde68a); color: var(--amber-800,#92400e); padding: 10px 14px; border-radius: var(--radius-md); }

  /* Success */
  .so-success { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 40px 20px; gap: 8px; }
  .so-success-icon { width: 60px; height: 60px; border-radius: 50%; background: var(--green-100); color: var(--green-700); font-size: 28px; display: flex; align-items: center; justify-content: center; font-weight: 700; margin-bottom: 8px; }
  .so-success-title { font-family: var(--font-heading); font-size: 24px; font-weight: 800; color: var(--gray-900); }
  .so-success-sub { font-size: 14px; color: var(--gray-500); line-height: 1.5; max-width: 280px; }
  .so-success-actions { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; justify-content: center; }

  /* Mobile */
  @media (max-width: 640px) {
    .so-panel { top: 0; left: 0; right: 0; bottom: 0; width: 100%; border-left: none; border-radius: 0; animation: soSlideUp 0.28s cubic-bezier(0.32,0.72,0,1); }
    @keyframes soSlideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
    .so-status-btns { gap: 5px; }
    .so-status-btn { padding: 8px 10px; font-size: 11px; }
    .so-actions .btn { padding: 14px; font-size: 16px; }
  }
`;
