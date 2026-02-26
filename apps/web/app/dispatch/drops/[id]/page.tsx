'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api, requireRole } from '../../../lib/auth';
import DropRescheduleSlideOver from '../../../components/DropRescheduleSlideOver';
import type { SlideOverDropDetail } from '../../../components/DropRescheduleSlideOver';

/* ── Types ── */
type Address = { line1: string; line2?: string | null; city: string; state: string; postal_code: string };
type LoadItem = {
  id: string; material: string; qty: number; unit: string; status: string;
  driver_user_id: string | null; driver_name: string | null; driver_email: string | null;
};
type Driver = { id: string; name: string; email: string };
type DropDetail = {
  id: string; ref: string; order_number: number | null; external_order_id: string | null;
  source: string; scheduled_date: string; scheduled_window: string; is_priority: boolean;
  customer_name: string; customer_phone: string; delivery_address: Address | null;
  notes: string | null; required_loads: number; loads: LoadItem[];
  notify_sent_at: string | null; last_reschedule_sms_at: string | null;
};

/* ── Helpers ── */
const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function fmtDate(ds: string) {
  const d = new Date(ds + 'T12:00:00');
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}
function fmtPhone(p: string) {
  const d = p.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') return `(${d.slice(1,4)}) ${d.slice(4,7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
  return p;
}
function fmtAddr(a: Address) {
  let s = a.line1;
  if (a.line2) s += ', ' + a.line2;
  return `${s}, ${a.city}, ${a.state} ${a.postal_code}`;
}

const STATUS_PILL: Record<string, string> = {
  assigned: 'pill-green', loaded_leaving: 'pill-blue', delivered: 'pill-green',
  exception: 'pill-red', cancelled: 'pill-red',
};
const STATUS_LABEL: Record<string, string> = {
  assigned: 'Assigned', loaded_leaving: 'En Route', delivered: 'Delivered',
  exception: 'Exception', cancelled: 'Cancelled',
};
const ALL_STATUSES = [
  { value: 'assigned', label: 'Assigned' },
  { value: 'loaded_leaving', label: 'Out for Delivery' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'exception', label: 'Exception' },
  { value: 'cancelled', label: 'Cancelled' },
];

/* ── Adapt DropDetail to SlideOverDropDetail ── */
function toSlideOverDetail(drop: DropDetail): SlideOverDropDetail {
  return {
    id: drop.id,
    ref: drop.ref,
    source: drop.source,
    is_priority: drop.is_priority,
    scheduled_date: drop.scheduled_date,
    scheduled_window: drop.scheduled_window,
    customer_name: drop.customer_name,
    customer_phone: drop.customer_phone,
    delivery_address: drop.delivery_address,
    notes: drop.notes,
    required_loads: drop.required_loads,
    loads: drop.loads.map(l => ({
      id: l.id,
      material: l.material,
      qty: l.qty,
      unit: l.unit,
      status: l.status,
      driver_user_id: l.driver_user_id,
      driver_name: l.driver_name,
    })),
    notify_sent_at: drop.notify_sent_at,
    last_reschedule_sms_at: drop.last_reschedule_sms_at,
  };
}

export default function DispatchDropDetailPageWrapper() {
  return (
    <Suspense fallback={<div className="page" style={{ padding: 40 }}>Loading…</div>}>
      <DispatchDropDetailPage />
    </Suspense>
  );
}

function DispatchDropDetailPage() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const action = searchParams.get('action');

  const [mounted, setMounted] = useState(false);
  const [drop, setDrop] = useState<DropDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  /* ── Reschedule slide-over ── */
  const [showReschedule, setShowReschedule] = useState(false);

  /* ── SMS state ── */
  const [smsMessage, setSmsMessage] = useState('Your delivery has been rescheduled. Please contact us with questions.');
  const [smsOverride, setSmsOverride] = useState(false);
  const [smsSending, setSmsSending] = useState(false);
  const [showSms, setShowSms] = useState(false);
  const [notifySending, setNotifySending] = useState(false);

  /* ── Driver / status state ── */
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [reassigning, setReassigning] = useState<string | null>(null);
  const [updatingStatus, setUpdatingStatus] = useState<string | null>(null);

  /* ── Data fetching ── */
  const fetchDrop = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api(`/dispatch/drops/${id}`);
      setDrop(d);
    } catch (err) {
      setError((err as ApiError).message || 'Failed to load drop');
    } finally { setLoading(false); }
  }, [id]);

  useEffect(() => { setMounted(true); }, []);
  useEffect(() => { fetchDrop(); }, [fetchDrop]);
  useEffect(() => {
    api('/dispatch/drivers').then(d => setDrivers(d.drivers || [])).catch(() => null);
  }, []);

  /* Auto-open reschedule panel if ?action=reschedule */
  useEffect(() => {
    if (action === 'reschedule' && drop && !showReschedule) {
      setShowReschedule(true);
    }
  }, [action, drop]);

  /* ── Actions ── */
  const sendSms = async () => {
    setSmsSending(true); setError('');
    try {
      const res = await api(`/dispatch/drops/${id}/send-reschedule-sms`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: smsMessage, admin_override: smsOverride }),
      });
      setSuccess(`SMS queued at ${new Date(res.sent_at).toLocaleTimeString()}`);
      setShowSms(false); fetchDrop();
    } catch (err) { setError((err as ApiError).message || 'Failed to send SMS'); }
    finally { setSmsSending(false); }
  };

  const sendDeliveryNotification = async () => {
    setNotifySending(true); setError('');
    try {
      await api(`/dispatch/drops/${id}/send-delivery-notification`, { method: 'POST' });
      setSuccess('Delivery notification sent.');
      fetchDrop();
    } catch (err) { setError((err as ApiError).message || 'Failed to send notification'); }
    finally { setNotifySending(false); }
  };

  const updateLoadStatus = async (loadId: string, newStatus: string) => {
    setUpdatingStatus(loadId); setError('');
    try {
      await api(`/dispatch/loads/${loadId}/status`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      setSuccess(`Status updated to ${STATUS_LABEL[newStatus] || newStatus}.`);
      fetchDrop();
    } catch (err) { setError((err as ApiError).message || 'Status update failed'); }
    finally { setUpdatingStatus(null); }
  };

  const reassignDriver = async (loadId: string, driverId: string) => {
    setReassigning(loadId); setError('');
    try {
      await api('/dispatch/loads/assign', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ load_ids: [loadId], driver_user_id: driverId || null }),
      });
      setSuccess(driverId ? 'Driver reassigned.' : 'Driver unassigned.');
      fetchDrop();
    } catch (err) { setError((err as ApiError).message || 'Reassignment failed'); }
    finally { setReassigning(null); }
  };

  if (!requireRole(['dispatcher'])) return <div className="page"><p>Unauthorized</p></div>;
  if (!mounted) return <div style={{ minHeight: '100vh' }} />;

  return (
    <>
      <style>{styles}</style>
      <div className="page dd-page">

        {/* ── Header ── */}
        <div className="dd-header">
          <div>
            <Link href="/dispatch-schedule" className="dd-back">← Back to Schedule</Link>
            <h1 className="dd-title">
              Order <span className="dd-ref">#{drop?.ref || '…'}</span>
              {drop?.source && drop.source !== 'manual' && (
                <span className="dd-source-badge">{drop.source}</span>
              )}
              {drop?.source === 'manual' && (
                <span className="dd-source-badge manual">Manual</span>
              )}
            </h1>
          </div>
        </div>

        {/* ── Alerts ── */}
        {error && (
          <div className="alert alert-error dd-alert">
            <span>⚠</span> {error}
            <button className="dd-alert-close" onClick={() => setError('')}>✕</button>
          </div>
        )}
        {success && (
          <div className="alert alert-success dd-alert">
            <span>✓</span> {success}
            <button className="dd-alert-close" onClick={() => setSuccess('')}>✕</button>
          </div>
        )}

        {loading && (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <div className="spinner spinner-lg" style={{ margin: '0 auto' }} />
          </div>
        )}

        {!loading && drop && (
          <>
            {/* ── Hero: Customer + Schedule ── */}
            <div className="dd-hero-grid">
              {/* Customer card */}
              <div className="card dd-hero-card">
                <div className="dd-hero-icon">👤</div>
                <div className="dd-hero-label">Customer</div>
                <div className="dd-hero-name">{drop.customer_name}</div>
                <div className="dd-hero-phone">{fmtPhone(drop.customer_phone)}</div>
                {drop.delivery_address && (
                  <div className="dd-hero-addr">
                    <span className="dd-addr-icon">📍</span>
                    {fmtAddr(drop.delivery_address)}
                  </div>
                )}
              </div>

              {/* Schedule card */}
              <div className="card dd-hero-card">
                <div className="dd-hero-icon">📅</div>
                <div className="dd-hero-label">Scheduled Delivery</div>
                <div className="dd-hero-name">{fmtDate(drop.scheduled_date)}</div>
                <div className="dd-hero-window">
                  {drop.is_priority ? (
                    <span className="dd-window-badge priority">⚡ Priority</span>
                  ) : (
                    <span className={`dd-window-badge ${drop.scheduled_window === 'A' ? 'am' : 'pm'}`}>
                      {drop.scheduled_window === 'A' ? '🌅 Morning (9am – 1pm)' : '🌤 Afternoon (1pm – 5pm)'}
                    </span>
                  )}
                </div>
                <div className="dd-hero-loads">{drop.required_loads} load{drop.required_loads !== 1 ? 's' : ''}</div>
                {/* ── Reschedule button ── */}
                <button
                  className="btn btn-secondary btn-sm dd-resc-btn"
                  onClick={() => setShowReschedule(true)}
                >
                  📅 Reschedule Delivery
                </button>
              </div>
            </div>

            {/* ── Notifications ── */}
            <div className="card dd-section">
              <div className="dd-section-head">Notifications</div>
              <div className="dd-notify-row">
                <div className="dd-notify-info">
                  <div className="dd-notify-title">Delivery Notification</div>
                  <div className="dd-notify-sub">Auto-sent SMS before delivery window opens</div>
                </div>
                <div className="dd-notify-actions">
                  {drop.notify_sent_at
                    ? <span className="pill pill-green">Sent {new Date(drop.notify_sent_at).toLocaleString()}</span>
                    : <span className="pill pill-gray">Not sent</span>}
                  <button className="btn btn-secondary btn-sm" onClick={sendDeliveryNotification} disabled={notifySending}>
                    {notifySending ? 'Sending…' : '📱 Send Notification'}
                  </button>
                </div>
              </div>
              <div className="dd-notify-row" style={{ borderBottom: 'none' }}>
                <div className="dd-notify-info">
                  <div className="dd-notify-title">Reschedule SMS</div>
                  <div className="dd-notify-sub">Manual text to notify customer of schedule change</div>
                </div>
                <div className="dd-notify-actions">
                  {drop.last_reschedule_sms_at
                    ? <span className="pill pill-amber">Sent {new Date(drop.last_reschedule_sms_at).toLocaleString()}</span>
                    : <span className="pill pill-gray">Not sent</span>}
                  <button className="btn btn-secondary btn-sm" onClick={() => setShowSms(true)}>
                    📱 Send SMS
                  </button>
                </div>
              </div>
            </div>

            {/* ── Loads ── */}
            <div className="card dd-section">
              <div className="dd-section-head">Loads ({drop.loads.length})</div>
              {drop.loads.length === 0 ? (
                <div className="dd-section-body" style={{ color: 'var(--gray-400)', fontStyle: 'italic', fontSize: 14 }}>
                  No loads attached to this drop.
                </div>
              ) : (
                <table className="dd-loads-table">
                  <thead>
                    <tr>
                      <th>Material</th>
                      <th>Status</th>
                      <th>Driver</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drop.loads.map(l => {
                      const isTerminal = ['delivered', 'cancelled'].includes(l.status);
                      return (
                        <tr key={l.id}>
                          <td className="dd-load-mat">{l.material} × {l.qty} {l.unit}</td>
                          <td>
                            <div className="dd-status-select-wrap">
                              {isTerminal ? (
                                <span className={`pill ${STATUS_PILL[l.status] || 'pill-gray'}`}>
                                  <span className="pill-dot" />{STATUS_LABEL[l.status] || l.status}
                                </span>
                              ) : (
                                <>
                                  <select
                                    className="dd-status-select"
                                    value={l.status}
                                    disabled={updatingStatus === l.id}
                                    onChange={e => updateLoadStatus(l.id, e.target.value)}
                                  >
                                    {ALL_STATUSES.map(s => (
                                      <option key={s.value} value={s.value}>{s.label}</option>
                                    ))}
                                  </select>
                                  {updatingStatus === l.id && (
                                    <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
                                  )}
                                </>
                              )}
                            </div>
                          </td>
                          <td>
                            {isTerminal ? (
                              l.driver_name
                                ? <span className="dd-driver-tag">🚚 {l.driver_name}</span>
                                : <span className="dd-unassigned-tag">⚠️ Unassigned</span>
                            ) : (
                              <div className="dd-driver-select-wrap">
                                <select
                                  className="dd-driver-select"
                                  value={l.driver_user_id || ''}
                                  disabled={reassigning === l.id}
                                  onChange={e => reassignDriver(l.id, e.target.value)}
                                >
                                  <option value="">⚠️ Unassigned</option>
                                  {drivers.map(d => (
                                    <option key={d.id} value={d.id}>{d.name}</option>
                                  ))}
                                </select>
                                {reassigning === l.id && (
                                  <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* ── Notes ── */}
            {drop.notes && (
              <div className="card dd-section">
                <div className="dd-section-head">Notes</div>
                <div className="dd-section-body" style={{ fontSize: 14, color: 'var(--gray-700)', whiteSpace: 'pre-wrap' }}>
                  {drop.notes}
                </div>
              </div>
            )}

            {/* ── Drop ID footer ── */}
            <div className="dd-id-footer">
              Drop ID: <code>{drop.id}</code>
            </div>
          </>
        )}

        {/* ── SMS Modal ── */}
        {showSms && drop && (
          <div className="modal-overlay" onClick={() => setShowSms(false)}>
            <div className="modal-card" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h2>Send Reschedule SMS</h2>
                <button className="btn btn-ghost btn-sm" onClick={() => setShowSms(false)} style={{ fontSize: 18, padding: '4px 8px' }}>✕</button>
              </div>
              <div className="modal-body">
                <p style={{ fontSize: 14, color: 'var(--gray-600)', marginBottom: 16 }}>
                  This will send a text to <strong>{drop.customer_name}</strong> at <strong>{fmtPhone(drop.customer_phone)}</strong>.
                </p>
                <div className="form-group">
                  <label className="form-label">Message</label>
                  <textarea
                    value={smsMessage}
                    onChange={e => setSmsMessage(e.target.value)}
                    rows={4}
                    style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', fontFamily: 'inherit', fontSize: 14, resize: 'vertical' }}
                  />
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--gray-600)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={smsOverride} onChange={e => setSmsOverride(e.target.checked)} style={{ width: 'auto' }} />
                  Admin override (bypass 5-min rate limit)
                </label>
              </div>
              <div className="modal-footer">
                <button className="btn btn-ghost" onClick={() => setShowSms(false)}>Cancel</button>
                <button className="btn btn-primary" onClick={sendSms} disabled={smsSending || !smsMessage.trim()}>
                  {smsSending ? 'Sending…' : 'Send SMS'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Reschedule Slide-Over ── */}
      {showReschedule && drop && (
        <DropRescheduleSlideOver
          dropId={drop.id}
          dropDetail={toSlideOverDetail(drop)}
          onClose={() => setShowReschedule(false)}
          onRescheduled={async () => {
            await fetchDrop();
            setSuccess('Delivery rescheduled successfully.');
          }}
          startOnReschedule={true}
        />
      )}
    </>
  );
}

/* ════════════════════════════════════════════════
   STYLES
   ════════════════════════════════════════════════ */
const styles = `
  .dd-page { max-width: 820px; }

  /* Header */
  .dd-header { margin-bottom: 24px; }
  .dd-back { color: var(--gray-400); text-decoration: none; font-size: 13px; font-weight: 500; transition: color 0.15s; }
  .dd-back:hover { color: var(--green-600); }
  .dd-title { font-family: var(--font-heading); font-size: 28px; font-weight: 800; letter-spacing: -0.02em; margin: 4px 0 0; }
  .dd-ref { color: var(--green-700); }
  .dd-source-badge { display: inline-block; font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 12px; margin-left: 10px; vertical-align: middle; background: var(--blue-50, #eff6ff); color: var(--blue-700, #1d4ed8); text-transform: uppercase; letter-spacing: 0.04em; }
  .dd-source-badge.manual { background: var(--gray-100); color: var(--gray-500); }

  /* Alerts */
  .dd-alert { margin-bottom: 12px; display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-radius: var(--radius-md); font-size: 14px; }
  .dd-alert-close { background: none; border: none; cursor: pointer; font-size: 16px; color: inherit; opacity: 0.6; padding: 0 4px; margin-left: auto; }

  /* Hero grid */
  .dd-hero-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
  @media (max-width: 640px) { .dd-hero-grid { grid-template-columns: 1fr; } }
  .dd-hero-card { padding: 20px 24px; }
  .dd-hero-icon { font-size: 24px; margin-bottom: 4px; }
  .dd-hero-label { font-family: var(--font-heading); font-size: 11px; font-weight: 700; color: var(--gray-400); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 8px; }
  .dd-hero-name { font-family: var(--font-heading); font-size: 18px; font-weight: 700; color: var(--gray-900); line-height: 1.3; }
  .dd-hero-phone { font-size: 15px; color: var(--gray-600); margin-top: 4px; }
  .dd-hero-addr { font-size: 13px; color: var(--gray-500); margin-top: 8px; line-height: 1.5; display: flex; gap: 6px; }
  .dd-addr-icon { flex-shrink: 0; }
  .dd-hero-window { margin-top: 10px; }
  .dd-window-badge { display: inline-block; padding: 6px 14px; border-radius: var(--radius-md); font-size: 14px; font-weight: 600; }
  .dd-window-badge.am { background: var(--amber-50, #fffbeb); color: var(--amber-700, #b45309); }
  .dd-window-badge.pm { background: var(--blue-50, #eff6ff); color: var(--blue-700, #1d4ed8); }
  .dd-window-badge.priority { background: var(--amber-100, #fef3c7); color: var(--amber-800, #92400e); }
  .dd-hero-loads { font-size: 14px; color: var(--gray-500); margin-top: 8px; font-weight: 600; }
  .dd-resc-btn { margin-top: 14px; width: 100%; justify-content: center; }

  /* Section cards */
  .dd-section { margin-bottom: 16px; overflow: hidden; }
  .dd-section-head { padding: 14px 24px; border-bottom: 1px solid var(--border-light); font-weight: 700; font-size: 15px; color: var(--gray-800); font-family: var(--font-heading); }
  .dd-section-body { padding: 16px 24px; }

  /* Notifications */
  .dd-notify-row { display: flex; align-items: center; gap: 16px; padding: 14px 24px; border-bottom: 1px solid var(--border-light); }
  @media (max-width: 600px) { .dd-notify-row { flex-direction: column; align-items: flex-start; gap: 10px; } }
  .dd-notify-info { flex: 1; min-width: 0; }
  .dd-notify-title { font-weight: 600; font-size: 14px; color: var(--gray-800); }
  .dd-notify-sub { font-size: 12px; color: var(--gray-400); margin-top: 2px; }
  .dd-notify-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

  /* Loads table */
  .dd-loads-table { width: 100%; border-collapse: collapse; font-size: 14px; }
  .dd-loads-table th { padding: 10px 24px; text-align: left; font-family: var(--font-heading); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--gray-400); border-bottom: 1px solid var(--border-light); }
  .dd-loads-table td { padding: 12px 24px; border-bottom: 1px solid var(--border-light); vertical-align: middle; }
  .dd-loads-table tbody tr:last-child td { border-bottom: none; }
  .dd-load-mat { font-weight: 600; color: var(--gray-800); }
  .dd-status-select-wrap { display: flex; align-items: center; gap: 6px; }
  .dd-status-select { width: auto; min-width: 130px; padding: 5px 8px; font-size: 13px; font-weight: 600; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); cursor: pointer; font-family: inherit; }
  .dd-driver-select-wrap { display: flex; align-items: center; gap: 6px; }
  .dd-driver-select { width: auto; min-width: 160px; padding: 5px 8px; font-size: 13px; font-weight: 500; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); cursor: pointer; font-family: inherit; }
  .dd-driver-tag { font-size: 13px; font-weight: 500; color: var(--gray-700); }
  .dd-unassigned-tag { font-size: 13px; font-weight: 600; color: var(--amber-700); }

  /* Footer */
  .dd-id-footer { font-size: 12px; color: var(--gray-300); margin-top: 24px; margin-bottom: 40px; }
  .dd-id-footer code { font-size: 11px; background: var(--gray-50); padding: 2px 6px; border-radius: 4px; }
`;
