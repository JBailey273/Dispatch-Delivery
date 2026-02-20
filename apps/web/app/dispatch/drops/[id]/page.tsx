'use client';

import { useCallback, useEffect, useState, useMemo } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ApiError, api, requireRole } from '../../../lib/auth';

/* ── Types ── */
type Address = { line1: string; line2?: string | null; city: string; state: string; postal_code: string };
type LoadItem = { id: string; material: string; qty: number; unit: string; status: string; driver_user_id: string | null; driver_name: string | null; driver_email: string | null };
type Driver = { id: string; name: string; email: string };
type DropDetail = {
  id: string; ref: string; order_number: number | null; external_order_id: string | null;
  source: string; scheduled_date: string; scheduled_window: string;
  customer_name: string; customer_phone: string; delivery_address: Address | null;
  notes: string | null; required_loads: number; loads: LoadItem[];
  notify_sent_at: string | null; last_reschedule_sms_at: string | null;
};
type CapWindow = { used: number; total: number; remaining_capacity: number };

/* ── Helpers ── */
const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const SHORT_DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function fmtDate(ds: string) {
  const d = new Date(ds + 'T12:00:00');
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}
function toKey(d: Date) { return d.toISOString().slice(0, 10); }
function sameDay(a: Date, b: Date) { return toKey(a) === toKey(b); }
function fmtPhone(p: string) {
  const d = p.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') return `(${d.slice(1,4)}) ${d.slice(4,7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
  return p;
}
function fmtAddr(a: Address) {
  let s = a.line1;
  if (a.line2) s += ', ' + a.line2;
  s += `, ${a.city}, ${a.state} ${a.postal_code}`;
  return s;
}

const STATUS_PILL: Record<string, string> = {
  assigned: 'pill-green', loaded_leaving: 'pill-blue', delivered: 'pill-green',
  exception: 'pill-red', cancelled: 'pill-red',
};
const STATUS_LABEL: Record<string, string> = {
  assigned: 'Assigned', loaded_leaving: 'En Route', delivered: 'Delivered',
  exception: 'Exception', cancelled: 'Cancelled',
};

export default function DispatchDropDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [mounted, setMounted] = useState(false);
  const [drop, setDrop] = useState<DropDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // SMS state
  const [smsMessage, setSmsMessage] = useState('Your delivery window has changed. Please contact us with questions.');
  const [smsOverride, setSmsOverride] = useState(false);
  const [smsSending, setSmsSending] = useState(false);
  const [showSms, setShowSms] = useState(false);
  const [notifySending, setNotifySending] = useState(false);

  // Reschedule state
  const [showReschedule, setShowReschedule] = useState(false);
  const [rescDate, setRescDate] = useState('');
  const [rescWindow, setRescWindow] = useState('A');
  const [rescheduling, setRescheduling] = useState(false);

  // Reschedule calendar state
  const [rescCalMonth, setRescCalMonth] = useState(() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), 1); });
  const [rescCapData, setRescCapData] = useState<Record<string, { A: CapWindow | null; B: CapWindow | null }>>({});
  const [rescDriverId, setRescDriverId] = useState('');

  // Driver reassignment
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [reassigning, setReassigning] = useState<string | null>(null);

  const fetchDrop = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api(`/dispatch/drops/${id}`);
      setDrop(d);
      setRescDate(d.scheduled_date);
      setRescWindow(d.scheduled_window);
    } catch (err) {
      setError((err as ApiError).message || 'Failed to load drop');
    } finally { setLoading(false); }
  }, [id]);

  useEffect(() => { setMounted(true); }, []);
  useEffect(() => { fetchDrop(); }, [fetchDrop]);
  useEffect(() => {
    api('/dispatch/drivers').then(d => setDrivers(d.drivers || [])).catch(() => null);
  }, []);

  // Fetch capacity for reschedule calendar
  const fetchRescCapacity = useCallback(async () => {
    const y = rescCalMonth.getFullYear();
    const m = rescCalMonth.getMonth();
    const start = new Date(y, m, 1);
    const end = new Date(y, m + 1, 0);
    try {
      const daysCount = Math.ceil((end.getTime() - start.getTime()) / 86400000) + 1;
      const resp = await api(`/availability?start_date=${toKey(start)}&days=${daysCount}`);
      const map: Record<string, { A: CapWindow | null; B: CapWindow | null }> = {};
      for (const w of (resp.windows || [])) {
        if (!map[w.date]) map[w.date] = { A: null, B: null };
        map[w.date][w.window as 'A' | 'B'] = { used: w.used, total: w.total, remaining_capacity: w.total - w.used };
      }
      setRescCapData(map);
    } catch { /* silent */ }
  }, [rescCalMonth]);

  useEffect(() => {
    if (showReschedule) fetchRescCapacity();
  }, [showReschedule, fetchRescCapacity]);

  // Calendar grid for reschedule
  const rescCalCells = useMemo(() => {
    const y = rescCalMonth.getFullYear();
    const m = rescCalMonth.getMonth();
    const firstDay = new Date(y, m, 1).getDay();
    const dim = new Date(y, m + 1, 0).getDate();
    const cells: { date: Date; other: boolean }[] = [];
    // Previous month padding
    for (let i = firstDay - 1; i >= 0; i--) {
      const d = new Date(y, m, -i);
      cells.push({ date: d, other: true });
    }
    // Current month
    for (let i = 1; i <= dim; i++) {
      cells.push({ date: new Date(y, m, i), other: false });
    }
    // Next month padding
    while (cells.length % 7 !== 0) {
      const last = cells[cells.length - 1].date;
      const d = new Date(last);
      d.setDate(d.getDate() + 1);
      cells.push({ date: d, other: true });
    }
    return cells;
  }, [rescCalMonth]);

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

  const reschedule = async () => {
    if (!drop) return;
    setRescheduling(true); setError('');
    try {
      await api(`/drops/${id}/reschedule`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduled_date: rescDate, scheduled_window: rescWindow }),
      });
      // Optionally reassign all loads to a different driver
      if (rescDriverId && drop.loads.length > 0) {
        const loadIds = drop.loads.map(l => l.id);
        await api('/dispatch/loads/assign', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ load_ids: loadIds, driver_user_id: rescDriverId }),
        });
      }
      setSuccess('Drop rescheduled successfully');
      setShowReschedule(false); setRescDriverId(''); fetchDrop();
    } catch (err) { setError((err as ApiError).message || 'Reschedule failed'); }
    finally { setRescheduling(false); }
  };

  const reassignDriver = async (loadId: string, driverId: string) => {
    if (!driverId) return;
    setReassigning(loadId); setError('');
    try {
      await api('/dispatch/loads/assign', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ load_ids: [loadId], driver_user_id: driverId }),
      });
      setSuccess('Driver reassigned.');
      fetchDrop();
    } catch (err) { setError((err as ApiError).message || 'Reassignment failed'); }
    finally { setReassigning(null); }
  };

  if (!requireRole(['dispatcher'])) return <div className="page"><p>Unauthorized</p></div>;

  const today = new Date();
  const rescDateObj = rescDate ? new Date(rescDate + 'T12:00:00') : null;
  const rescDayCap = rescDate ? rescCapData[rescDate] : null;

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
              Order <span className="dd-ref">#{drop?.ref || '...'}</span>
              {drop?.source && drop.source !== 'manual' && (
                <span className="dd-source-badge">{drop.source}</span>
              )}
              {drop?.source === 'manual' && (
                <span className="dd-source-badge manual">Manual</span>
              )}
            </h1>
          </div>
        </div>

        {error && <div className="alert alert-error dd-alert"><span>⚠</span> {error}<button className="dd-alert-close" onClick={() => setError('')}>✕</button></div>}
        {success && <div className="alert alert-success dd-alert"><span>✓</span> {success}<button className="dd-alert-close" onClick={() => setSuccess('')}>✕</button></div>}

        {loading && <div style={{ textAlign: 'center', padding: 40 }}><div className="spinner spinner-lg" style={{ margin: '0 auto' }} /></div>}

        {!loading && drop && (
          <>
            {/* ── Two-column: Customer + Schedule ── */}
            <div className="dd-hero-grid">
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
              <div className="card dd-hero-card">
                <div className="dd-hero-icon">📅</div>
                <div className="dd-hero-label">Scheduled Delivery</div>
                <div className="dd-hero-name">{fmtDate(drop.scheduled_date)}</div>
                <div className="dd-hero-window">
                  <span className={`dd-window-badge ${drop.scheduled_window === 'A' ? 'am' : 'pm'}`}>
                    {drop.scheduled_window === 'A' ? '🌅 AM (9am–1pm)' : '🌤 PM (1pm–5pm)'}
                  </span>
                </div>
                <div className="dd-hero-loads">{drop.required_loads} load{drop.required_loads !== 1 ? 's' : ''}</div>
                <button className="btn btn-secondary btn-sm" style={{ marginTop: 12 }} onClick={() => { setRescDriverId(''); setShowReschedule(true); }}>
                  📅 Reschedule
                </button>
              </div>
            </div>

            {/* ── Notifications ── */}
            <div className="card dd-section">
              <div className="dd-section-head">Notifications</div>
              <div className="dd-section-body">
                <div className="dd-notify-row">
                  <div className="dd-notify-info">
                    <div className="dd-notify-title">Delivery Notification</div>
                    <div className="dd-notify-sub">Auto-sent SMS before delivery window opens</div>
                  </div>
                  <div className="dd-notify-actions">
                    {drop.notify_sent_at
                      ? <span className="pill pill-green">Sent {new Date(drop.notify_sent_at).toLocaleString()}</span>
                      : <span className="pill pill-gray">Not sent</span>
                    }
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
                      : <span className="pill pill-gray">Not sent</span>
                    }
                    <button className="btn btn-secondary btn-sm" onClick={() => setShowSms(true)}>
                      📱 Send SMS
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* ── Loads ── */}
            <div className="card dd-section">
              <div className="dd-section-head">Loads ({drop.loads.length})</div>
              {drop.loads.length === 0 ? (
                <div className="dd-section-body" style={{ color: 'var(--gray-400)', fontSize: 14 }}>No loads found for this drop.</div>
              ) : (
                <table className="data-table dd-loads-table">
                  <thead>
                    <tr>
                      <th>Material</th>
                      <th>Qty</th>
                      <th>Status</th>
                      <th>Driver</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drop.loads.map(l => {
                      const isUnassignedDriver = !l.driver_name;
                      const displayStatus = isUnassignedDriver && l.status === 'assigned' ? 'pending' : l.status;
                      const pillCls = displayStatus === 'pending' ? 'pill-amber' : (STATUS_PILL[l.status] || 'pill-gray');
                      const pillLbl = displayStatus === 'pending' ? 'Pending' : (STATUS_LABEL[l.status] || l.status);
                      const isTerminal = ['delivered', 'cancelled'].includes(l.status);
                      return (
                        <tr key={l.id}>
                          <td style={{ fontWeight: 600 }}>{l.material}</td>
                          <td>{l.qty} {l.unit}{l.qty !== 1 ? 's' : ''}</td>
                          <td><span className={`pill ${pillCls}`}>{pillLbl}</span></td>
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
                                {reassigning === l.id && <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />}
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
                <div className="dd-section-body" style={{ fontSize: 14, color: 'var(--gray-700)', whiteSpace: 'pre-wrap' }}>{drop.notes}</div>
              </div>
            )}

            {/* ── Drop ID (small footer) ── */}
            <div className="dd-id-footer">
              Drop ID: <code>{drop.id}</code>
            </div>
          </>
        )}

        {/* ── SMS Modal ── */}
        {showSms && (
          <div className="modal-overlay" onClick={() => setShowSms(false)}>
            <div className="modal-card" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h2>Send Reschedule SMS</h2>
                <button className="btn btn-ghost btn-sm" onClick={() => setShowSms(false)} style={{ fontSize: 18, padding: '4px 8px' }}>✕</button>
              </div>
              <div className="modal-body">
                <p style={{ fontSize: 14, color: 'var(--gray-600)', marginBottom: 16 }}>
                  This will send a text to <strong>{drop?.customer_name}</strong> at <strong>{fmtPhone(drop?.customer_phone || '')}</strong>.
                </p>
                <div className="form-group">
                  <label className="form-label">Message</label>
                  <textarea value={smsMessage} onChange={e => setSmsMessage(e.target.value)} rows={4}
                    style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', fontFamily: 'inherit', fontSize: 14, resize: 'vertical' }} />
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

        {/* ── Reschedule Modal ── */}
        {showReschedule && (
          <div className="modal-overlay" onClick={() => setShowReschedule(false)}>
            <div className="modal-card resc-modal" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h2>Reschedule Drop #{drop?.ref}</h2>
                <button className="btn btn-ghost btn-sm" onClick={() => setShowReschedule(false)} style={{ fontSize: 18, padding: '4px 8px' }}>✕</button>
              </div>
              <div className="modal-body">
                <p className="resc-subtitle">
                  All {drop?.required_loads} load{(drop?.required_loads || 0) !== 1 ? 's' : ''} will be moved to the new date and window.
                </p>

                {/* Calendar */}
                <div className="resc-cal-wrap">
                  <div className="resc-cal-nav">
                    <button className="resc-cal-arrow" onClick={() => setRescCalMonth(new Date(rescCalMonth.getFullYear(), rescCalMonth.getMonth() - 1, 1))}>‹</button>
                    <div className="resc-cal-title">{MONTHS[rescCalMonth.getMonth()]} {rescCalMonth.getFullYear()}</div>
                    <button className="resc-cal-arrow" onClick={() => setRescCalMonth(new Date(rescCalMonth.getFullYear(), rescCalMonth.getMonth() + 1, 1))}>›</button>
                  </div>
                  <div className="resc-cal-grid">
                    {SHORT_DAYS.map(d => <div key={d} className="resc-cal-dow">{d}</div>)}
                    {rescCalCells.map((cell, i) => {
                      const k = toKey(cell.date);
                      const isSelected = k === rescDate;
                      const isToday = sameDay(cell.date, today);
                      const isPast = cell.date < today && !isToday;
                      const cap = rescCapData[k];
                      const amR = cap?.A?.remaining_capacity ?? 0;
                      const pmR = cap?.B?.remaining_capacity ?? 0;
                      const amT = cap?.A?.total ?? 0;
                      const pmT = cap?.B?.total ?? 0;
                      const hasSlots = (amR > 0 || pmR > 0);
                      return (
                        <div
                          key={i}
                          className={`resc-cal-cell${cell.other ? ' other' : ''}${isSelected ? ' selected' : ''}${isToday ? ' today' : ''}${isPast && !cell.other ? ' past' : ''}`}
                          onClick={() => {
                            if (!cell.other && !isPast) setRescDate(k);
                          }}
                        >
                          <div className="resc-cal-date">{cell.date.getDate()}</div>
                          {!cell.other && !isPast && amT + pmT > 0 && (
                            <div className="resc-cal-cap">
                              <span className={amR > 0 ? 'has-slots' : 'full'}>{amR}</span>
                              <span className="resc-cap-sep">/</span>
                              <span className={pmR > 0 ? 'has-slots' : 'full'}>{pmR}</span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div className="resc-cal-legend">
                    <span className="resc-legend-item"><span className="resc-legend-dot has-slots" />AM slots</span>
                    <span className="resc-legend-sep">/</span>
                    <span className="resc-legend-item"><span className="resc-legend-dot has-slots" />PM slots</span>
                    <span style={{ color: 'var(--gray-400)', fontSize: 11, marginLeft: 8 }}>remaining</span>
                  </div>
                </div>

                {/* Selected date summary */}
                {rescDate && (
                  <div className="resc-selected-summary">
                    <div className="resc-sel-date">{fmtDate(rescDate)}</div>
                    {rescDayCap && (
                      <div className="resc-sel-caps">
                        <div className={`resc-sel-win${rescWindow === 'A' ? ' active' : ''}`} onClick={() => setRescWindow('A')}>
                          <div className="resc-win-label">🌅 AM (9–1)</div>
                          <div className="resc-win-slots">
                            <span className={`resc-slot-num ${(rescDayCap.A?.remaining_capacity ?? 0) > 0 ? 'avail' : 'full'}`}>
                              {rescDayCap.A?.used ?? 0}/{rescDayCap.A?.total ?? 0}
                            </span>
                            <span className="resc-slot-label">
                              {(rescDayCap.A?.remaining_capacity ?? 0)} remaining
                            </span>
                          </div>
                        </div>
                        <div className={`resc-sel-win${rescWindow === 'B' ? ' active' : ''}`} onClick={() => setRescWindow('B')}>
                          <div className="resc-win-label">🌤 PM (1–5)</div>
                          <div className="resc-win-slots">
                            <span className={`resc-slot-num ${(rescDayCap.B?.remaining_capacity ?? 0) > 0 ? 'avail' : 'full'}`}>
                              {rescDayCap.B?.used ?? 0}/{rescDayCap.B?.total ?? 0}
                            </span>
                            <span className="resc-slot-label">
                              {(rescDayCap.B?.remaining_capacity ?? 0)} remaining
                            </span>
                          </div>
                        </div>
                      </div>
                    )}
                    {!rescDayCap && (
                      <div className="resc-sel-caps">
                        <div className={`resc-sel-win${rescWindow === 'A' ? ' active' : ''}`} onClick={() => setRescWindow('A')}>
                          <div className="resc-win-label">🌅 AM (9–1)</div>
                        </div>
                        <div className={`resc-sel-win${rescWindow === 'B' ? ' active' : ''}`} onClick={() => setRescWindow('B')}>
                          <div className="resc-win-label">🌤 PM (1–5)</div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {/* Optional driver change */}
                <div className="resc-driver-section">
                  <div className="resc-driver-label">Change Driver (optional)</div>
                  <select
                    className="resc-driver-select"
                    value={rescDriverId}
                    onChange={e => setRescDriverId(e.target.value)}
                  >
                    <option value="">Keep current driver{drop?.loads.length === 1 && drop.loads[0].driver_name ? ` (${drop.loads[0].driver_name})` : 's'}</option>
                    {drivers.map(d => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="modal-footer resc-footer">
                <button className="btn btn-ghost" onClick={() => setShowReschedule(false)}>Cancel</button>
                <button className="btn btn-primary" onClick={reschedule} disabled={rescheduling || !rescDate}>
                  {rescheduling ? 'Rescheduling…' : `Reschedule to ${rescDate ? fmtDate(rescDate).split(',').slice(0, 2).join(',') : '...'}`}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

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

  /* Hero grid: Customer + Schedule */
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
  .dd-window-badge.am { background: var(--amber-50); color: var(--amber-700); }
  .dd-window-badge.pm { background: var(--blue-50, #eff6ff); color: var(--blue-700, #1d4ed8); }
  .dd-hero-loads { font-size: 14px; color: var(--gray-500); margin-top: 8px; font-weight: 600; }

  /* Section cards */
  .dd-section { margin-bottom: 16px; overflow: hidden; }
  .dd-section-head { padding: 14px 24px; border-bottom: 1px solid var(--border-light); font-weight: 700; font-size: 15px; color: var(--gray-800); }
  .dd-section-body { padding: 16px 24px; }

  /* Notifications */
  .dd-notify-row { display: flex; align-items: center; gap: 16px; padding: 14px 24px; border-bottom: 1px solid var(--border-light); }
  .dd-notify-info { flex: 1; min-width: 0; }
  .dd-notify-title { font-weight: 600; font-size: 14px; color: var(--gray-800); }
  .dd-notify-sub { font-size: 12px; color: var(--gray-400); margin-top: 2px; }
  .dd-notify-actions { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }

  /* Loads table */
  .dd-loads-table { width: 100%; }
  .dd-loads-table th { padding: 10px 16px; text-align: left; font-size: 11px; font-weight: 700; color: var(--gray-400); text-transform: uppercase; letter-spacing: 0.04em; border-bottom: 1px solid var(--border-light); }
  .dd-loads-table td { padding: 12px 16px; border-bottom: 1px solid var(--border-light); font-size: 14px; }
  .dd-loads-table tr:last-child td { border-bottom: none; }
  .dd-driver-tag { color: var(--green-700); font-weight: 600; font-size: 13px; }
  .dd-unassigned-tag { color: var(--amber-600); font-weight: 600; font-size: 13px; }
  .dd-driver-select-wrap { display: flex; align-items: center; gap: 6px; }
  .dd-driver-select { width: auto; min-width: 140px; padding: 5px 8px; font-size: 13px; font-weight: 500; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); cursor: pointer; font-family: inherit; }

  /* ID footer */
  .dd-id-footer { text-align: center; padding: 16px 0 8px; font-size: 11px; color: var(--gray-300); }
  .dd-id-footer code { font-family: var(--font-mono); font-size: 11px; background: var(--gray-50); padding: 2px 6px; border-radius: 4px; }

  /* ── Reschedule Modal ── */
  .resc-modal { max-width: 520px; width: 100%; }
  .resc-subtitle { font-size: 14px; color: var(--gray-500); margin-bottom: 20px; }

  /* Calendar */
  .resc-cal-wrap { background: var(--gray-50); border: 1px solid var(--border-light); border-radius: var(--radius-lg); padding: 16px; margin-bottom: 20px; }
  .resc-cal-nav { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .resc-cal-title { font-size: 15px; font-weight: 700; color: var(--gray-800); }
  .resc-cal-arrow { background: none; border: 1px solid var(--border-light); border-radius: var(--radius-md); width: 32px; height: 32px; font-size: 18px; cursor: pointer; display: flex; align-items: center; justify-content: center; color: var(--gray-600); transition: background 0.15s; }
  .resc-cal-arrow:hover { background: var(--surface); }
  .resc-cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
  .resc-cal-dow { text-align: center; font-size: 11px; font-weight: 700; color: var(--gray-400); padding: 4px 0; text-transform: uppercase; }
  .resc-cal-cell { text-align: center; padding: 6px 2px; border-radius: var(--radius-md); cursor: pointer; transition: background 0.15s; min-height: 44px; display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .resc-cal-cell:hover:not(.other):not(.past) { background: var(--green-50, #f0fdf4); }
  .resc-cal-cell.selected { background: var(--green-600); }
  .resc-cal-cell.selected .resc-cal-date { color: white; font-weight: 700; }
  .resc-cal-cell.selected .resc-cal-cap span { color: rgba(255,255,255,0.85); }
  .resc-cal-cell.today .resc-cal-date { color: var(--green-700); font-weight: 800; }
  .resc-cal-cell.other { opacity: 0.3; cursor: default; }
  .resc-cal-cell.past { opacity: 0.3; cursor: default; }
  .resc-cal-date { font-size: 13px; font-weight: 500; color: var(--gray-700); line-height: 1; }
  .resc-cal-cap { font-size: 9px; font-weight: 700; margin-top: 2px; display: flex; gap: 1px; align-items: center; }
  .resc-cal-cap .has-slots { color: var(--green-600); }
  .resc-cal-cap .full { color: var(--red-500); }
  .resc-cap-sep { color: var(--gray-300); font-size: 8px; }

  .resc-cal-legend { display: flex; align-items: center; gap: 4px; justify-content: center; margin-top: 10px; font-size: 11px; color: var(--gray-500); }
  .resc-legend-item { display: flex; align-items: center; gap: 4px; }
  .resc-legend-dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; }
  .resc-legend-dot.has-slots { background: var(--green-500); }
  .resc-legend-sep { color: var(--gray-300); }

  /* Selected date summary */
  .resc-selected-summary { background: var(--surface); border: 1px solid var(--border-light); border-radius: var(--radius-lg); padding: 16px; }
  .resc-sel-date { font-size: 15px; font-weight: 700; color: var(--gray-800); margin-bottom: 12px; }
  .resc-sel-caps { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .resc-sel-win { border: 2px solid var(--border-light); border-radius: var(--radius-md); padding: 12px 14px; cursor: pointer; transition: all 0.15s; text-align: center; }
  .resc-sel-win:hover { border-color: var(--green-300, #86efac); }
  .resc-sel-win.active { border-color: var(--green-600); background: var(--green-50, #f0fdf4); }
  .resc-win-label { font-size: 14px; font-weight: 600; color: var(--gray-700); }
  .resc-win-slots { margin-top: 6px; }
  .resc-slot-num { font-size: 18px; font-weight: 800; display: block; }
  .resc-slot-num.avail { color: var(--green-600); }
  .resc-slot-num.full { color: var(--red-500); }
  .resc-slot-label { font-size: 11px; color: var(--gray-400); }

  .resc-driver-section { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border-light); }
  .resc-driver-label { font-family: var(--font-heading); font-size: 12px; font-weight: 700; color: var(--gray-500); margin-bottom: 6px; }
  .resc-driver-select { width: 100%; padding: 9px 12px; font-size: 14px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface); cursor: pointer; font-family: inherit; }
  .resc-footer { display: flex; justify-content: flex-end; gap: 10px; }
`;
