'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ApiError, api, requireRole } from '../../../lib/auth';

type DropDetail = {
  id: string; scheduled_date: string; scheduled_window: string;
  customer_phone: string; required_loads: number;
  notify_sent_at: string | null; last_reschedule_sms_at: string | null;
};
type LoadItem = { id: string; drop_id: string; status: string; material: string; qty: number; unit: string };

const STATUS_PILL: Record<string, string> = {
  assigned: 'pill-gray', loaded_leaving: 'pill-blue', delivered: 'pill-green',
  exception: 'pill-red', cancelled: 'pill-red',
};
const STATUS_LABEL: Record<string, string> = {
  assigned: 'Assigned', loaded_leaving: 'En Route', delivered: 'Delivered',
  exception: 'Exception', cancelled: 'Cancelled',
};
const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function fmtDate(ds: string) {
  const d = new Date(ds + 'T12:00:00');
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

export default function DispatchDropDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [drop, setDrop] = useState<DropDetail | null>(null);
  const [loads, setLoads] = useState<LoadItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // SMS
  const [smsMessage, setSmsMessage] = useState('Your delivery window has changed. Please contact us with questions.');
  const [smsOverride, setSmsOverride] = useState(false);
  const [smsSending, setSmsSending] = useState(false);
  const [showSms, setShowSms] = useState(false);

  // Reschedule
  const [showReschedule, setShowReschedule] = useState(false);
  const [rescDate, setRescDate] = useState('');
  const [rescWindow, setRescWindow] = useState('A');
  const [rescheduling, setRescheduling] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api(`/dispatch/drops/${id}`);
      setDrop(d);
      setRescDate(d.scheduled_date);
      setRescWindow(d.scheduled_window);
      // Fetch loads for this drop from the schedule
      try {
        const sched = await api(`/dispatch/schedule?day=${d.scheduled_date}`);
        const allLoads: LoadItem[] = [];
        for (const win of ['A', 'B'] as const) {
          for (const group of Object.values(sched.windows[win].groups) as LoadItem[][]) {
            for (const ld of group) {
              if (ld.drop_id === id) allLoads.push(ld);
            }
          }
        }
        setLoads(allLoads);
      } catch { setLoads([]); }
    } catch (err) {
      setError((err as ApiError).message || 'Failed to load drop');
    } finally { setLoading(false); }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const sendSms = async () => {
    setSmsSending(true);
    setError('');
    try {
      const res = await api(`/dispatch/drops/${id}/send-reschedule-sms`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: smsMessage, admin_override: smsOverride }),
      });
      setSuccess(`SMS queued at ${new Date(res.sent_at).toLocaleTimeString()}`);
      setShowSms(false);
      load();
    } catch (err) {
      setError((err as ApiError).message || 'Failed to send SMS');
    } finally { setSmsSending(false); }
  };

  const reschedule = async () => {
    if (!drop) return;
    setRescheduling(true);
    setError('');
    try {
      await api(`/drops/${id}/reschedule`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduled_date: rescDate, scheduled_window: rescWindow }),
      });
      setSuccess('Drop rescheduled successfully');
      setShowReschedule(false);
      load();
    } catch (err) {
      setError((err as ApiError).message || 'Reschedule failed');
    } finally { setRescheduling(false); }
  };

  if (!requireRole(['dispatcher'])) return <div className="page"><p>Unauthorized</p></div>;

  return (
    <>
      <style>{styles}</style>
      <div className="page dd-page">
        {/* Header */}
        <div className="dd-top">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <Link href="/dispatch-schedule" style={{ color: 'var(--gray-400)', textDecoration: 'none', fontSize: 14 }}>← Schedule</Link>
            </div>
            <h1>Drop Detail</h1>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-secondary btn-sm" onClick={() => setShowSms(true)}>📱 Send SMS</button>
            <button className="btn btn-secondary btn-sm" onClick={() => setShowReschedule(true)}>📅 Reschedule</button>
          </div>
        </div>

        {error && <div className="alert alert-error" style={{ marginBottom: 12 }}><span>⚠</span> {error}</div>}
        {success && <div className="alert alert-success" style={{ marginBottom: 12 }}><span>✓</span> {success}</div>}

        {loading && <div style={{ textAlign: 'center', padding: 40 }}><div className="spinner spinner-lg" style={{ margin: '0 auto' }} /></div>}

        {!loading && drop && (
          <>
            {/* Info cards */}
            <div className="dd-info-grid">
              <div className="card dd-info-card">
                <div className="dd-info-label">Drop ID</div>
                <div className="dd-info-value" style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{drop.id}</div>
              </div>
              <div className="card dd-info-card">
                <div className="dd-info-label">Customer</div>
                <div className="dd-info-value">{drop.customer_phone}</div>
              </div>
              <div className="card dd-info-card">
                <div className="dd-info-label">Scheduled</div>
                <div className="dd-info-value">{fmtDate(drop.scheduled_date)}</div>
                <div style={{ fontSize: 13, color: 'var(--gray-500)', marginTop: 2 }}>Window {drop.scheduled_window === 'A' ? 'AM (9–1)' : 'PM (1–5)'}</div>
              </div>
              <div className="card dd-info-card">
                <div className="dd-info-label">Loads</div>
                <div className="dd-info-value" style={{ fontSize: 28, fontWeight: 800, color: 'var(--green-700)' }}>{drop.required_loads}</div>
              </div>
            </div>

            {/* SMS status */}
            <div className="card" style={{ marginBottom: 16 }}>
              <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border-light)', fontWeight: 700, fontSize: 15, color: 'var(--gray-800)' }}>
                Notifications
              </div>
              <div style={{ padding: '16px 20px' }}>
                <div className="dd-notify-row">
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>Delivery Notification</div>
                    <div style={{ fontSize: 13, color: 'var(--gray-500)' }}>Auto-sent SMS before delivery</div>
                  </div>
                  {drop.notify_sent_at
                    ? <span className="pill pill-green">Sent {new Date(drop.notify_sent_at).toLocaleString()}</span>
                    : <span className="pill pill-gray">Not sent</span>
                  }
                </div>
                <div className="dd-notify-row" style={{ borderBottom: 'none' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>Last Reschedule SMS</div>
                    <div style={{ fontSize: 13, color: 'var(--gray-500)' }}>Manual text to customer</div>
                  </div>
                  {drop.last_reschedule_sms_at
                    ? <span className="pill pill-amber">Sent {new Date(drop.last_reschedule_sms_at).toLocaleString()}</span>
                    : <span className="pill pill-gray">Not sent</span>
                  }
                </div>
              </div>
            </div>

            {/* Loads table */}
            <div className="card">
              <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border-light)', fontWeight: 700, fontSize: 15, color: 'var(--gray-800)' }}>
                Loads ({loads.length})
              </div>
              {loads.length === 0 ? (
                <div style={{ padding: 20, color: 'var(--gray-400)', fontSize: 14 }}>No loads found for this drop on the scheduled date.</div>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Load ID</th>
                      <th>Material</th>
                      <th>Qty</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loads.map(l => (
                      <tr key={l.id}>
                        <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{l.id.slice(0, 12)}…</td>
                        <td style={{ fontWeight: 600 }}>{l.material}</td>
                        <td>{l.qty} {l.unit}{l.qty !== 1 ? 's' : ''}</td>
                        <td><span className={`pill ${STATUS_PILL[l.status] || 'pill-gray'}`}>{STATUS_LABEL[l.status] || l.status}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}

        {/* SMS modal */}
        {showSms && (
          <div className="modal-overlay" onClick={() => setShowSms(false)}>
            <div className="modal-card" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h2>Send Reschedule SMS</h2>
                <button className="btn btn-ghost btn-sm" onClick={() => setShowSms(false)}>✕</button>
              </div>
              <div className="modal-body">
                <p style={{ fontSize: 14, color: 'var(--gray-600)' }}>
                  This will send a text to <strong>{drop?.customer_phone}</strong>.
                </p>
                <div className="form-group">
                  <label className="form-label">Message</label>
                  <textarea value={smsMessage} onChange={e => setSmsMessage(e.target.value)} rows={4} />
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

        {/* Reschedule modal */}
        {showReschedule && (
          <div className="modal-overlay" onClick={() => setShowReschedule(false)}>
            <div className="modal-card" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h2>Reschedule Drop</h2>
                <button className="btn btn-ghost btn-sm" onClick={() => setShowReschedule(false)}>✕</button>
              </div>
              <div className="modal-body">
                <p style={{ fontSize: 14, color: 'var(--gray-600)' }}>
                  All {drop?.required_loads} load{(drop?.required_loads || 0) !== 1 ? 's' : ''} will be moved to the new date and window.
                </p>
                <div className="form-group">
                  <label className="form-label">New Date</label>
                  <input type="date" value={rescDate} onChange={e => setRescDate(e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Window</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button type="button" className={`btn ${rescWindow === 'A' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setRescWindow('A')} style={{ flex: 1 }}>AM (9–1)</button>
                    <button type="button" className={`btn ${rescWindow === 'B' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setRescWindow('B')} style={{ flex: 1 }}>PM (1–5)</button>
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button className="btn btn-ghost" onClick={() => setShowReschedule(false)}>Cancel</button>
                <button className="btn btn-primary" onClick={reschedule} disabled={rescheduling}>
                  {rescheduling ? 'Rescheduling…' : 'Reschedule'}
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
  .dd-page { max-width: 800px; }
  .dd-top { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 20px; flex-wrap: wrap; gap: 12px; }
  .dd-top h1 { font-size: 28px; font-weight: 800; letter-spacing: -0.02em; margin: 0; }

  .dd-info-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px; }
  @media (max-width: 700px) { .dd-info-grid { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 400px) { .dd-info-grid { grid-template-columns: 1fr; } }
  .dd-info-card { padding: 16px 20px; }
  .dd-info-label { font-size: 12px; font-weight: 700; color: var(--gray-400); text-transform: uppercase; letter-spacing: 0.04em; }
  .dd-info-value { font-size: 15px; font-weight: 600; color: var(--gray-900); margin-top: 4px; }

  .dd-notify-row { display: flex; align-items: center; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--border-light); }
`;
