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

const EXCEPTION_LABELS: Record<string, string> = {
  WRONG_ADDRESS: 'Wrong Address',
  CUSTOMER_REFUSED: 'Customer Refused',
  ACCESS_BLOCKED: 'Access Blocked',
  DAMAGED_GOODS: 'Damaged Material',
  CUSTOMER_UNAVAILABLE: 'Customer Not Home',
  SAFETY_RISK: 'Safety Risk',
  OUT_OF_STOCK: 'Out of Stock',
  OTHER: 'Other',
};

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
  scheduled_date: string | null;
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
    id: string;
    material: string;
    qty: number;
    unit: string;
    status: string;
    driver_user_id: string | null;
    driver_name: string | null;
    exception_reason_code?: string | null;
    exception_notes?: string | null;
    exception_photo_url?: string | null;
    condition_photo_url?: string | null;
    condition_notes?: string | null;
    pod_photo_url?: string | null;
  }[];
  notify_sent_at?: string | null;
  last_reschedule_sms_at?: string | null;
};

type Driver = { id: string; name: string; email: string; truck?: string | null };
type PanelView = 'main' | 'reschedule';

const STATUS_OPTIONS = [
  { value: 'assigned',       label: 'Assigned',         pill: 'pill-gray'  },
  { value: 'loaded_leaving', label: 'Out for Delivery',  pill: 'pill-blue'  },
  { value: 'delivered',      label: 'Delivered',         pill: 'pill-green' },
  { value: 'exception',      label: 'Exception',         pill: 'pill-red'   },
  { value: 'cancelled',      label: 'Cancelled',         pill: 'pill-red'   },
];

function statusPill(s: string) { return STATUS_OPTIONS.find(o => o.value === s)?.pill ?? 'pill-gray'; }
function statusLabel(s: string) { return STATUS_OPTIONS.find(o => o.value === s)?.label ?? s; }

const DEFAULT_SMS = 'Your delivery has been rescheduled. Please contact us with questions.';

/* ══════════════════════════════════════════
   PROPS
   ══════════════════════════════════════════ */
interface OrderPanelProps {
  dropId: string;
  dropDetail?: SlideOverDropDetail | null;
  capData?: Record<string, { A: CapWindow | null; B: CapWindow | null }>;
  onClose: () => void;
  onRescheduled: () => void;
  startOnReschedule?: boolean;
  locationId?: string | null;
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
  locationId,
}: OrderPanelProps) {
  const today = useMemo(() => new Date(), []);

  /* Self-fetch detail */
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

  /* Self-fetch capacity */
  const [internalCapData, setInternalCapData] = useState<Record<string, { A: CapWindow | null; B: CapWindow | null }>>({});
  const capData = { ...externalCapData, ...internalCapData };

  const fetchCapForMonth = useCallback(async (monthStart: Date) => {
    const firstDayOfMonth = new Date(monthStart.getFullYear(), monthStart.getMonth(), 1);
    const firstKey = toKey(firstDayOfMonth);
    if (internalCapData[firstKey]) return;
    try {
      const y = monthStart.getFullYear(), m = monthStart.getMonth();
      const daysCount = new Date(y, m + 1, 0).getDate();
      const resp = await api(`/availability?start_date=${toKey(new Date(y, m, 1))}&days=${daysCount}${locationId ? `&location_id=${locationId}` : ''}`);
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
  }, [internalCapData, locationId]);

  /* Drivers list */
  const [drivers, setDrivers] = useState<Driver[]>([]);
  useEffect(() => {
    api('/dispatch/drivers').then(d => setDrivers(d.drivers || [])).catch(() => null);
  }, []);

  /* Panel view */
  const [view, setView] = useState<PanelView>(startOnReschedule ? 'reschedule' : 'main');

  /* ── Load editing ── */
  const [editingLoadId, setEditingLoadId] = useState<string | null>(null);
  const [loadEdits, setLoadEdits] = useState<Record<string, { driverId: string; status: string }>>({});
  const [savingLoadId, setSavingLoadId] = useState<string | null>(null);
  const [loadMsg, setLoadMsg] = useState<Record<string, string>>({});

  /* Lightbox for exception photos */
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!dropDetail) return;
    const init: Record<string, { driverId: string; status: string }> = {};
    for (const l of dropDetail.loads) {
      if (!loadEdits[l.id]) init[l.id] = { driverId: l.driver_user_id ?? '', status: l.status };
    }
    if (Object.keys(init).length) setLoadEdits(prev => ({ ...prev, ...init }));
  }, [dropDetail?.loads.map(l => l.id).join(',')]);

  const saveLoad = async (loadId: string) => {
    const edit = loadEdits[loadId];
    if (!edit) return;
    setSavingLoadId(loadId);
    try {
      await api('/dispatch/loads/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ load_ids: [loadId], driver_user_id: edit.driverId || null }),
      });
      if (edit.status) {
        await api(`/dispatch/loads/${loadId}/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: edit.status }),
        });
      }
      setLoadMsg(prev => ({ ...prev, [loadId]: 'saved' }));
      setEditingLoadId(null);
      onRescheduled();
      await refreshDetail();
    } catch (err) {
      setLoadMsg(prev => ({ ...prev, [loadId]: (err as ApiError).message || 'Save failed' }));
    } finally { setSavingLoadId(null); }
  };

  /* ── Reschedule state ── */
  const [rescDate, setRescDate] = useState('');
  const [rescWindow, setRescWindow] = useState<'A' | 'B'>('A');
  const [rescheduling, setRescheduling] = useState(false);
  const [rescMsg, setRescMsg] = useState('');
  const [rescSuccess, setRescSuccess] = useState(false);
  const [calMonth, setCalMonth] = useState(() => {
    const d = new Date(); d.setDate(1); return d;
  });

  useEffect(() => {
    if (dropDetail && !rescDate) {
      setRescDate(dropDetail.scheduled_date ?? '');
      setRescWindow((dropDetail.scheduled_window as 'A' | 'B') || 'A');
    }
  }, [dropDetail?.scheduled_date]);

  useEffect(() => {
    fetchCapForMonth(calMonth);
  }, [calMonth, fetchCapForMonth]);

  /* ── Notification/SMS ── */
/* ── Notification/SMS ── */
  const [notifLoading, setNotifLoading] = useState(false);
  const [notifMsg, setNotifMsg] = useState('');
  const [smsEditing, setSmsEditing] = useState(false);
  const [smsText, setSmsText] = useState(DEFAULT_SMS);
  const [smsSending, setSmsSending] = useState(false);
  const [smsMsg, setSmsMsg] = useState('');
  const [schedLinkLoading, setSchedLinkLoading] = useState(false);
  const [schedLinkMsg, setSchedLinkMsg] = useState('');
  const [schedLink, setSchedLink] = useState('');

  const sendNotification = async () => {
    setNotifLoading(true); setNotifMsg('');
    try {
      const r = await api(`/dispatch/drops/${dropId}/notify`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      setNotifMsg(r.already_sent ? 'Already sent' : 'sent');
      await refreshDetail();
    } catch (err) { setNotifMsg((err as ApiError).message || 'Failed'); }
    finally { setNotifLoading(false); }
  };
  const sendSms = async () => {
    setSmsSending(true); setSmsMsg('');
    try {
      await api(`/dispatch/drops/${dropId}/send-reschedule-sms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: smsText }),
      });
      setSmsMsg('sent'); setSmsEditing(false);
      await refreshDetail();
    } catch (err) { setSmsMsg((err as ApiError).message || 'Failed'); }
    finally { setSmsSending(false); }
  };
  const sendSchedulingLink = async () => {
    setSchedLinkLoading(true); setSchedLinkMsg(''); setSchedLink('');
    try {
      const r = await api(`/schedule/drops/${dropId}/scheduling-link`, { method: 'POST' });
      const link = `${window.location.origin}/schedule?token=${r.token}`;
      setSchedLink(link);
      // Send via reschedule SMS channel
      const message = `Hi ${dropDetail?.customer_name?.split(' ')[0] || 'there'}, please use this link to schedule your delivery from East Meadow Garden Center: ${link}`;
      await api(`/dispatch/drops/${dropId}/send-reschedule-sms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, admin_override: true }),
      });
      setSchedLinkMsg('sent');
      await refreshDetail();
    } catch (err) { setSchedLinkMsg((err as ApiError).message || 'Failed'); }
    finally { setSchedLinkLoading(false); }
  };

  /* ── Calendar cells ── */
  const calCells = useMemo(() => {
    const y = calMonth.getFullYear(), m = calMonth.getMonth();
    const dim = new Date(y, m + 1, 0).getDate();
    const dow = new Date(y, m, 1).getDay();
    const prevDim = new Date(y, m, 0).getDate();
    const cells: { date: Date; other: boolean }[] = [];
    for (let i = dow - 1; i >= 0; i--) cells.push({ date: new Date(y, m - 1, prevDim - i), other: true });
    for (let i = 1; i <= dim; i++) cells.push({ date: new Date(y, m, i), other: false });
    while (cells.length % 7 !== 0) cells.push({ date: new Date(y, m + 1, cells.length - dim - dow + 1), other: true });
    return cells;
  }, [calMonth]);

  const headingText = `${FULL_MONTHS[calMonth.getMonth()]} ${calMonth.getFullYear()}`;

  const doReschedule = async () => {
    if (!rescDate) return;
    setRescheduling(true); setRescMsg('');
    try {
      await api(`/drops/${dropId}/reschedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scheduled_date: rescDate,
          scheduled_window: dropDetail?.is_priority ? null : rescWindow,
        }),
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

  /* ── Derived: exception loads ── */
  const exceptionLoads = dropDetail?.loads.filter(l => l.status === 'exception') ?? [];
  const hasExceptions = exceptionLoads.length > 0;

  /* ══════════════════════════════════════════
     RENDER
     ══════════════════════════════════════════ */
  return (
    <>
      <style>{panelStyles}</style>
      {lightboxUrl && (
        <div className="so-lightbox" onClick={() => setLightboxUrl(null)}>
          <img src={lightboxUrl} alt="Exception photo" className="so-lightbox-img" />
          <button className="so-lightbox-close">✕</button>
        </div>
      )}
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

            {/* ── Exception Alert ── */}
            {hasExceptions && (
              <div className="so-exception-alert">
                <div className="so-exception-alert-head">
                  <span className="so-exception-alert-icon">⚠️</span>
                  <span className="so-exception-alert-title">
                    Exception Reported{exceptionLoads.length > 1 ? ` (${exceptionLoads.length} loads)` : ''}
                  </span>
                </div>
                {exceptionLoads.map(l => (
                  <div key={l.id} className="so-exception-detail">
                    <div className="so-exception-material">{l.material} × {l.qty} {l.unit}</div>
                    {l.exception_reason_code && (
                      <div className="so-exception-reason">
                        <span className="so-exception-reason-label">Reason:</span>
                        {EXCEPTION_LABELS[l.exception_reason_code] || l.exception_reason_code}
                      </div>
                    )}
                    {l.exception_notes && (
                      <div className="so-exception-notes">
                        <span className="so-exception-reason-label">Driver notes:</span>
                        {l.exception_notes}
                      </div>
                    )}
                    {l.driver_name && (
                      <div className="so-exception-driver">🚚 Reported by {l.driver_name}</div>
                    )}
                    {l.exception_photo_url && (
                      <div className="so-exception-photo-row">
                        <img
                          src={l.exception_photo_url}
                          alt="Exception photo"
                          className="so-exception-thumb"
                          onClick={() => setLightboxUrl(l.exception_photo_url!)}
                        />
                        <span className="so-exception-photo-hint">Tap to enlarge</span>
                      </div>
                    )}
                  </div>
                ))}
                <button
                  className="so-reschedule-cta"
                  onClick={() => { setView('reschedule'); setRescMsg(''); setRescSuccess(false); }}
                >
                  📅 Reschedule This Delivery
                </button>
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
              {dropDetail.scheduled_date ? (
                <>
                  <div className="so-info-date">{fmtDateLong(dropDetail.scheduled_date)}</div>
                  <div className="so-info-window">
                    {dropDetail.is_priority ? 'Priority — flexible window'
                      : dropDetail.scheduled_window === 'A' ? 'Morning Window (9am – 1pm)'
                      : 'Afternoon Window (1pm – 5pm)'}
                  </div>
                  {!hasExceptions && (
                    <button
                      className="so-resc-trigger"
                      onClick={() => { setView('reschedule'); setRescMsg(''); setRescSuccess(false); }}
                    >
                      📅 Reschedule
                    </button>
                  )}
                </>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, cursor: 'pointer' }}>
                  <div>
                    <div className="so-info-date" style={{ color: 'var(--amber-600)', fontSize: 15 }}>Not Yet Scheduled</div>
                    <div className="so-info-window">Send the customer a scheduling link below</div>
                  </div>
                  <button
                    className="so-resc-trigger"
                    onClick={() => { setView('reschedule'); setRescMsg(''); setRescSuccess(false); }}
                  >
                    Assign Date
                  </button>
                </div>
              )}
            </div>

            {/* Loads */}
            <div className="so-card so-card-flush">
              <div className="so-card-label so-card-label-pad">
                Loads ({dropDetail.loads.length})
              </div>
              {dropDetail.loads.map(load => {
                const isEditing = editingLoadId === load.id;
                const edit = loadEdits[load.id] ?? { driverId: load.driver_user_id ?? '', status: load.status };
                const isTerminal = ['delivered', 'cancelled'].includes(load.status);
                const isException = load.status === 'exception';
                const msg = loadMsg[load.id];

                return (
                  <div key={load.id} className={`so-load${isEditing ? ' editing' : ''}${isException ? ' so-load-exception' : ''}`}>
                    {/* Read-only summary row */}
                    <div className="so-load-summary">
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
                          <button
                            className="so-edit-btn"
                            onClick={() => setEditingLoadId(isEditing ? null : load.id)}
                          >
                            {isEditing ? 'Cancel' : 'Edit'}
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Editable section */}
                    {isEditing && (
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

                        <button
                          className="btn btn-primary"
                          style={{ width: '100%', marginTop: 4 }}
                          disabled={savingLoadId === load.id}
                          onClick={() => saveLoad(load.id)}
                        >
                          {savingLoadId === load.id ? 'Saving…' : 'Save Changes'}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Notifications */}
            <div className="so-card">
              <div className="so-card-label">Notifications</div>

              <div className="so-notif-row">
                <div className="so-notif-info">
                  <div className="so-notif-title">Delivery notification</div>
                  <div className="so-notif-sub">
                    {dropDetail.notify_sent_at
                      ? `Sent ${new Date(dropDetail.notify_sent_at).toLocaleDateString()}`
                      : 'Not yet sent'}
                  </div>
                </div>
                <button className="btn btn-secondary btn-sm" onClick={sendNotification} disabled={notifLoading}>
                  {notifLoading ? 'Sending…' : '📱 Send'}
                </button>
              </div>
              {notifMsg && notifMsg !== 'sent' && <div className="so-notif-err">{notifMsg}</div>}
              {notifMsg === 'sent' && <div className="so-notif-success">✓ Notification sent</div>}

              <div style={{ borderTop: '1px solid var(--border-light)', marginTop: 10, paddingTop: 10 }}>
                <div className="so-notif-row">
                  <div className="so-notif-info">
                    <div className="so-notif-title">Reschedule SMS</div>
                    <div className="so-notif-sub">
                      {dropDetail.last_reschedule_sms_at
                        ? `Sent ${new Date(dropDetail.last_reschedule_sms_at).toLocaleDateString()}`
                        : 'Not yet sent'}
                    </div>
                  </div>
                  {!smsEditing && (
                    <button className="btn btn-secondary btn-sm" onClick={() => setSmsEditing(true)}>
                      📱 Send
                    </button>
                  )}
                </div>
                {smsEditing && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                    <textarea
                      className="so-sms-textarea"
                      value={smsText}
                      onChange={e => setSmsText(e.target.value)}
                      rows={3}
                    />
                    {smsMsg && smsMsg !== 'sent' && <div className="so-notif-err">{smsMsg}</div>}
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="btn btn-primary btn-sm" onClick={sendSms} disabled={smsSending}>
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
              <div style={{ borderTop: '1px solid var(--border-light)', marginTop: 10, paddingTop: 10 }}>
                <div className="so-notif-row">
                  <div className="so-notif-info">
                    <div className="so-notif-title">Scheduling Link</div>
                    <div className="so-notif-sub">Send customer a link to self-schedule</div>
                  </div>
                  <button className="btn btn-secondary btn-sm" onClick={sendSchedulingLink} disabled={schedLinkLoading}>
                    {schedLinkLoading ? 'Sending…' : '🔗 Send'}
                  </button>
                </div>
                {schedLinkMsg === 'sent' && (
                  <div className="so-notif-success">✓ Scheduling link sent</div>
                )}
                {schedLink && schedLinkMsg === 'sent' && (
                  <div style={{ marginTop: 6, fontSize: 11, color: 'var(--gray-400)', wordBreak: 'break-all' }}>
                    {schedLink}
                  </div>
                )}
                {schedLinkMsg && schedLinkMsg !== 'sent' && (
                  <div className="so-notif-err">{schedLinkMsg}</div>
                )}
              </div>
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
                  {dropDetail.is_priority ? 'Priority' : rescWindow === 'A' ? 'Morning' : 'Afternoon'}
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
                    {dropDetail.scheduled_date
                      ? `${fmtDateShort(dropDetail.scheduled_date)} · ${dropDetail.scheduled_window === 'A' ? 'AM' : dropDetail.scheduled_window === 'B' ? 'PM' : 'Priority'}`
                      : 'Not yet scheduled'}
                  </span>
                </div>

                {/* Calendar */}
                <div className="so-cal-card">
                  <div className="so-cal-nav">
                    <button className="so-cal-nav-btn" onClick={() => setCalMonth(m => { const n = new Date(m); n.setMonth(n.getMonth() - 1); return n; })}>‹</button>
                    <span className="so-cal-heading">{headingText}</span>
                    <button className="so-cal-nav-btn" onClick={() => setCalMonth(m => { const n = new Date(m); n.setMonth(n.getMonth() + 1); return n; })}>›</button>
                  </div>
                  <div className="so-cal-dow-row">
                    {['Su','Mo','Tu','We','Th','Fr','Sa'].map(d => <div key={d} className="so-cal-dow">{d}</div>)}
                  </div>
                  <div className="so-cal-grid">
                    {calCells.map((cell, i) => {
                      const k = toKey(cell.date);
                      const isPast = !cell.other && cell.date < today && !sameDay(cell.date, today);
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
                            <span className="so-win-label">{w === 'A' ? 'Morning' : 'Afternoon'}</span>
                            <span className="so-win-time">{w === 'A' ? '9am – 1pm' : '1pm – 5pm'}</span>
                            {cap != null && (
                              <span className={`so-win-cap ${(cap.remaining_capacity ?? 0) > 0 ? 'avail' : 'full'}`}>
                                {cap.remaining_capacity ?? 0} slot{cap.remaining_capacity !== 1 ? 's' : ''} left
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {rescMsg && <div className="alert alert-error" style={{ fontSize: 13 }}>{rescMsg}</div>}

                <div className="so-resc-actions">
                  <button
                    className="btn btn-primary"
                    onClick={doReschedule}
                    disabled={rescheduling || !rescDate || isSameAsOriginal}
                  >
                    {rescheduling ? 'Saving…' : isSameAsOriginal ? 'No Change Made' : rescDate ? `Move to ${fmtDateShort(rescDate)}` : 'Select A Date Above'}
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

  /* ── Exception Alert ── */
  .so-exception-alert { background: #fff1f2; border: 2px solid #f43f5e; border-radius: var(--radius-lg); overflow: hidden; }
  .so-exception-alert-head { display: flex; align-items: center; gap: 8px; padding: 12px 14px 8px; background: #ffe4e6; border-bottom: 1px solid #fecdd3; }
  .so-exception-alert-icon { font-size: 16px; }
  .so-exception-alert-title { font-family: var(--font-heading); font-size: 13px; font-weight: 800; color: #be123c; text-transform: uppercase; letter-spacing: 0.04em; }
  .so-exception-detail { padding: 12px 14px; border-bottom: 1px solid #fecdd3; display: flex; flex-direction: column; gap: 6px; }
  .so-exception-detail:last-of-type { border-bottom: none; }
  .so-exception-material { font-family: var(--font-heading); font-size: 13px; font-weight: 700; color: var(--gray-900); }
  .so-exception-reason { font-size: 13px; color: #be123c; font-weight: 600; }
  .so-exception-notes { font-size: 13px; color: var(--gray-700); line-height: 1.45; }
  .so-exception-reason-label { font-weight: 700; margin-right: 4px; }
  .so-exception-driver { font-size: 12px; color: var(--gray-500); }
  .so-exception-photo-row { display: flex; align-items: center; gap: 10px; margin-top: 4px; }
  .so-exception-thumb { width: 72px; height: 72px; object-fit: cover; border-radius: 8px; border: 1px solid #fecdd3; cursor: pointer; transition: opacity 0.15s; }
  .so-exception-thumb:hover { opacity: 0.85; }
  .so-exception-photo-hint { font-size: 11px; color: var(--gray-400); }
  .so-reschedule-cta { width: calc(100% - 28px); margin: 0 14px 14px; padding: 11px; border-radius: var(--radius-md); border: none; background: #e11d48; color: #fff; font-family: var(--font-heading); font-size: 14px; font-weight: 700; cursor: pointer; transition: background 0.15s; }
  .so-reschedule-cta:hover { background: #be123c; }

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

  /* Load rows */
  .so-load { border-bottom: 1px solid var(--border-light); }
  .so-load:last-child { border-bottom: none; }
  .so-load-exception .so-load-summary { background: #fff1f2; }
  .so-load-summary { display: flex; align-items: center; justify-content: space-between; padding: 11px 16px; gap: 10px; }
  .so-load-left { flex: 1; min-width: 0; }
  .so-load-mat { font-family: var(--font-heading); font-size: 13px; font-weight: 700; color: var(--gray-900); }
  .so-load-driver-name { font-size: 12px; color: var(--gray-500); margin-top: 2px; }
  .so-unassigned { color: var(--amber-600,#d97706); font-weight: 600; }
  .so-load-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
  .so-load-saved { font-family: var(--font-heading); font-size: 12px; font-weight: 700; color: var(--green-600); }
  .so-edit-btn { padding: 4px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); font-family: var(--font-heading); font-size: 11px; font-weight: 600; color: var(--gray-600); cursor: pointer; transition: all 0.12s; white-space: nowrap; }
  .so-edit-btn:hover { border-color: var(--green-300); color: var(--green-700); background: var(--green-50); }

  /* Load editor */
  .so-load-editor { padding: 14px 16px 16px; background: var(--gray-25,#fafafa); border-top: 1px solid var(--border-light); display: flex; flex-direction: column; gap: 14px; }
  .so-field { display: flex; flex-direction: column; gap: 6px; }
  .so-field-label { font-family: var(--font-heading); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--gray-500); }
  .so-select { width: 100%; padding: 9px 12px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface); font-size: 14px; font-weight: 500; font-family: inherit; color: var(--gray-800); cursor: pointer; }
  .so-status-btns { display: flex; flex-wrap: wrap; gap: 6px; }
  .so-status-btn { padding: 6px 11px; border-radius: var(--radius-md); border: 1.5px solid var(--border); background: var(--surface); font-family: var(--font-heading); font-size: 12px; font-weight: 600; color: var(--gray-600); cursor: pointer; transition: all 0.12s; }
  .so-status-btn:hover { border-color: var(--green-300); color: var(--green-700); }
  .so-status-btn.active { border-color: var(--green-500); background: var(--green-600); color: #fff; }
  .so-load-err { font-size: 12px; color: var(--red-600); }

  /* Notifications */
  .so-notif-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .so-notif-info { flex: 1; min-width: 0; }
  .so-notif-title { font-family: var(--font-heading); font-size: 13px; font-weight: 700; color: var(--gray-800); }
  .so-notif-sub { font-size: 12px; color: var(--gray-400); margin-top: 2px; }
  .so-notif-success { font-size: 12px; color: var(--green-600); font-weight: 600; margin-top: 4px; }
  .so-notif-err { font-size: 12px; color: var(--red-600); margin-top: 4px; }
  .so-sms-textarea { width: 100%; padding: 9px 12px; border: 1px solid var(--border); border-radius: var(--radius-md); font-size: 13px; font-family: inherit; color: var(--gray-800); resize: vertical; box-sizing: border-box; }

  /* Notes */
  .so-notes-text { font-size: 13px; color: var(--gray-700); line-height: 1.5; font-style: italic; }

  /* Footer link */
  .so-full-link { display: block; text-align: center; font-family: var(--font-heading); font-size: 13px; font-weight: 600; color: var(--gray-400); padding: 8px; transition: color 0.15s; }
  .so-full-link:hover { color: var(--green-600); }

  /* Reschedule view */
  .so-resc-current { display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: var(--gray-50); border: 1px solid var(--border-light); border-radius: var(--radius-md); font-size: 13px; }
  .so-resc-current-label { font-weight: 600; color: var(--gray-500); }
  .so-resc-current-val { font-family: var(--font-heading); font-weight: 700; color: var(--gray-800); }
  .so-cal-card { background: var(--surface); border: 1px solid var(--border-light); border-radius: var(--radius-lg); overflow: hidden; }
  .so-cal-nav { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--border-light); }
  .so-cal-nav-btn { width: 32px; height: 32px; border-radius: var(--radius-md); border: 1px solid var(--border); background: var(--surface); cursor: pointer; font-size: 16px; color: var(--gray-600); display: flex; align-items: center; justify-content: center; transition: all 0.15s; font-family: inherit; }
  .so-cal-nav-btn:hover { background: var(--gray-50); }
  .so-cal-heading { font-family: var(--font-heading); font-size: 15px; font-weight: 800; color: var(--gray-900); }
  .so-cal-dow-row { display: grid; grid-template-columns: repeat(7, 1fr); padding: 8px 8px 4px; }
  .so-cal-dow { text-align: center; font-family: var(--font-heading); font-size: 10px; font-weight: 700; color: var(--gray-400); text-transform: uppercase; letter-spacing: 0.05em; }
  .so-cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); padding: 0 8px 8px; gap: 2px; }
  .so-cal-cell { display: flex; flex-direction: column; align-items: center; padding: 6px 2px; border-radius: var(--radius-sm); cursor: pointer; transition: all 0.12s; min-height: 44px; gap: 3px; }
  .so-cal-cell:hover:not(.other):not(.past) { background: var(--green-50); }
  .so-cal-cell.other { opacity: 0.25; cursor: default; pointer-events: none; }
  .so-cal-cell.past { opacity: 0.35; cursor: default; pointer-events: none; }
  .so-cal-cell.today .so-cal-num { color: var(--green-600); font-weight: 800; }
  .so-cal-cell.selected { background: var(--green-600); border-radius: var(--radius-md); }
  .so-cal-cell.selected .so-cal-num { color: #fff; }
  .so-cal-cell.original { background: var(--amber-50,#fffbeb); border: 1px solid var(--amber-200,#fde68a); }
  .so-cal-num { font-family: var(--font-heading); font-size: 13px; font-weight: 700; color: var(--gray-700); line-height: 1; }
  .so-cal-dots { display: flex; gap: 3px; }
  .so-cal-dot { display: inline-block; width: 5px; height: 5px; border-radius: 50%; }
  .so-cal-dot.am { background: var(--green-500); }
  .so-cal-dot.pm { background: var(--blue-500); }
  .so-cal-legend { display: flex; gap: 12px; padding: 8px 16px; border-top: 1px solid var(--border-light); font-size: 11px; color: var(--gray-500); font-weight: 500; }
  .so-window-pick { background: var(--surface); border: 1px solid var(--border-light); border-radius: var(--radius-lg); padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
  .so-window-pick-date { font-family: var(--font-heading); font-size: 14px; font-weight: 700; color: var(--gray-900); }
  .so-window-btns { display: flex; flex-direction: column; gap: 8px; }
  .so-win-btn { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border: 2px solid var(--border-light); border-radius: var(--radius-md); background: var(--surface); cursor: pointer; transition: all 0.15s; text-align: left; font-family: inherit; }
  .so-win-btn:hover { border-color: var(--green-300); background: var(--green-50); }
  .so-win-btn.active { border-color: var(--green-500); background: var(--green-50); }
  .so-win-label { font-family: var(--font-heading); font-size: 14px; font-weight: 700; color: var(--gray-900); flex: 1; }
  .so-win-time { font-size: 12px; color: var(--gray-500); }
  .so-win-cap { font-family: var(--font-heading); font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 10px; }
  .so-win-cap.avail { background: var(--green-100); color: var(--green-700); }
  .so-win-cap.full { background: var(--red-100,#fee2e2); color: var(--red-700,#b91c1c); }
  .so-resc-actions { display: flex; flex-direction: column; gap: 8px; }
  .so-resc-actions .btn { width: 100%; justify-content: center; }

  /* Success */
  .so-success { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 40px 20px; text-align: center; }
  .so-success-icon { width: 60px; height: 60px; border-radius: 50%; background: var(--green-600); color: #fff; font-size: 28px; display: flex; align-items: center; justify-content: center; }
  .so-success-title { font-family: var(--font-heading); font-size: 22px; font-weight: 800; color: var(--gray-900); }
  .so-success-sub { font-size: 14px; color: var(--gray-600); max-width: 280px; line-height: 1.5; }
  .so-success-actions { display: flex; gap: 10px; margin-top: 8px; }

  /* Lightbox */
  .so-lightbox { position: fixed; inset: 0; background: rgba(0,0,0,0.85); z-index: 300; display: flex; align-items: center; justify-content: center; cursor: pointer; }
  .so-lightbox-img { max-width: 90vw; max-height: 85vh; border-radius: 8px; object-fit: contain; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
  .so-lightbox-close { position: absolute; top: 20px; right: 20px; width: 40px; height: 40px; border-radius: 50%; background: rgba(255,255,255,0.15); border: none; color: #fff; font-size: 18px; cursor: pointer; display: flex; align-items: center; justify-content: center; }

  @media (max-width: 500px) {
    .so-panel { width: 100%; }
  }
`;
