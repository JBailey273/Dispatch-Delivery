'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { ApiError, api, requireRole } from '../../../lib/auth';
import DropRescheduleSlideOver from '../../../components/DropRescheduleSlideOver';
import type { SlideOverDropDetail } from '../../../components/DropRescheduleSlideOver';

/* ── Types ── */
type Address = { line1: string; line2?: string | null; city: string; state: string; postal_code: string };
type LoadItem = {
  id: string; material: string; qty: number; unit: string;
  status: string; driver_user_id: string | null; driver_name: string | null;
};
type DropDetail = {
  id: string; ref: string; source: string;
  scheduled_date: string; scheduled_window: string; is_priority: boolean;
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
  assigned: 'pill-gray', loaded_leaving: 'pill-blue', delivered: 'pill-green',
  exception: 'pill-red', cancelled: 'pill-red', new: 'pill-amber',
};
const STATUS_LABEL: Record<string, string> = {
  assigned: 'Assigned', loaded_leaving: 'En Route', delivered: 'Delivered',
  exception: 'Exception', cancelled: 'Cancelled', new: 'Pending',
};

function toSlideOverDetail(drop: DropDetail): SlideOverDropDetail {
  return {
    id: drop.id, ref: drop.ref, source: drop.source,
    is_priority: drop.is_priority,
    scheduled_date: drop.scheduled_date, scheduled_window: drop.scheduled_window,
    customer_name: drop.customer_name, customer_phone: drop.customer_phone,
    delivery_address: drop.delivery_address, notes: drop.notes,
    required_loads: drop.required_loads,
    loads: drop.loads.map(l => ({
      id: l.id, material: l.material, qty: l.qty, unit: l.unit,
      status: l.status, driver_user_id: l.driver_user_id, driver_name: l.driver_name,
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

  const [mounted, setMounted] = useState(false);
  const [drop, setDrop] = useState<DropDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showPanel, setShowPanel] = useState(false);

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

  // Auto-open panel if ?action=reschedule
  useEffect(() => {
    if (searchParams.get('action') === 'reschedule' && drop) setShowPanel(true);
  }, [searchParams, drop]);

  if (!requireRole(['dispatcher'])) return <div className="page"><p>Unauthorized</p></div>;
  if (!mounted) return <div style={{ minHeight: '100vh' }} />;

  return (
    <>
      <style>{styles}</style>
      <div className="page dd-page">

        {/* Header */}
        <div className="dd-header">
          <Link href="/dispatch-schedule" className="dd-back">← Back to Schedule</Link>
          <div className="dd-title-row">
            <h1 className="dd-title">
              Order <span className="dd-ref">#{drop?.ref || '…'}</span>
              {drop?.source && drop.source !== 'manual' && (
                <span className="dd-source-badge">{drop.source}</span>
              )}
              {drop?.source === 'manual' && (
                <span className="dd-source-badge manual">Manual</span>
              )}
            </h1>
            {drop && (
              <button className="btn btn-primary dd-manage-btn" onClick={() => setShowPanel(true)}>
                Manage Order
              </button>
            )}
          </div>
        </div>

        {error && (
          <div className="alert alert-error dd-alert">
            <span>⚠</span> {error}
            <button className="dd-alert-close" onClick={() => setError('')}>✕</button>
          </div>
        )}

        {loading && (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <div className="spinner spinner-lg" style={{ margin: '0 auto' }} />
          </div>
        )}

        {!loading && drop && (
          <>
            {/* Hero grid */}
            <div className="dd-hero-grid">
              <div className="card dd-hero-card">
                <div className="dd-hero-label">👤 Customer</div>
                <div className="dd-hero-name">{drop.customer_name}</div>
                <div className="dd-hero-phone">{fmtPhone(drop.customer_phone)}</div>
                {drop.delivery_address && (
                  <div className="dd-hero-addr">📍 {fmtAddr(drop.delivery_address)}</div>
                )}
              </div>
              <div className="card dd-hero-card">
                <div className="dd-hero-label">📅 Scheduled Delivery</div>
                <div className="dd-hero-name">{fmtDate(drop.scheduled_date)}</div>
                <div className="dd-hero-window">
                  {drop.is_priority
                    ? <span className="dd-window-badge priority">⚡ Priority</span>
                    : <span className={`dd-window-badge ${drop.scheduled_window === 'A' ? 'am' : 'pm'}`}>
                        {drop.scheduled_window === 'A' ? '🌅 Morning (9am – 1pm)' : '🌤 Afternoon (1pm – 5pm)'}
                      </span>}
                </div>
                <div className="dd-hero-loads">{drop.required_loads} load{drop.required_loads !== 1 ? 's' : ''}</div>
              </div>
            </div>

            {/* Notification status — read-only */}
            <div className="card dd-section">
              <div className="dd-section-head">Notifications</div>
              <div className="dd-notif-grid">
                <div className="dd-notif-item">
                  <div className="dd-notif-label">Delivery Notification</div>
                  {drop.notify_sent_at
                    ? <span className="pill pill-green pill-sm"><span className="pill-dot"/>Sent {new Date(drop.notify_sent_at).toLocaleString()}</span>
                    : <span className="pill pill-gray pill-sm"><span className="pill-dot"/>Not sent</span>}
                </div>
                <div className="dd-notif-item">
                  <div className="dd-notif-label">Reschedule SMS</div>
                  {drop.last_reschedule_sms_at
                    ? <span className="pill pill-amber pill-sm"><span className="pill-dot"/>Sent {new Date(drop.last_reschedule_sms_at).toLocaleString()}</span>
                    : <span className="pill pill-gray pill-sm"><span className="pill-dot"/>Not sent</span>}
                </div>
              </div>
            </div>

            {/* Loads — read-only */}
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
                      <th>Driver</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drop.loads.map(l => (
                      <tr key={l.id}>
                        <td className="dd-load-mat">{l.material} × {l.qty} {l.unit}</td>
                        <td className="dd-load-driver">
                          {l.driver_name
                            ? <span>🚚 {l.driver_name}</span>
                            : <span className="dd-unassigned">⚠ Unassigned</span>}
                        </td>
                        <td>
                          <span className={`pill pill-sm ${STATUS_PILL[l.status] || 'pill-gray'}`}>
                            <span className="pill-dot" />{STATUS_LABEL[l.status] || l.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Notes */}
            {drop.notes && (
              <div className="card dd-section">
                <div className="dd-section-head">Notes</div>
                <div className="dd-section-body" style={{ fontSize: 14, color: 'var(--gray-700)', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                  {drop.notes}
                </div>
              </div>
            )}

            <div className="dd-id-footer">Drop ID: <code>{drop.id}</code></div>
          </>
        )}
      </div>

      {/* Order management panel */}
      {showPanel && drop && (
        <DropRescheduleSlideOver
          dropId={drop.id}
          dropDetail={toSlideOverDetail(drop)}
          onClose={() => setShowPanel(false)}
          onRescheduled={fetchDrop}
          startOnReschedule={searchParams.get('action') === 'reschedule'}
        />
      )}
    </>
  );
}

const styles = `
  .dd-page { max-width: 820px; }

  .dd-header { margin-bottom: 24px; }
  .dd-back { color: var(--gray-400); text-decoration: none; font-size: 13px; font-weight: 500; transition: color 0.15s; display: inline-block; margin-bottom: 6px; }
  .dd-back:hover { color: var(--green-600); }
  .dd-title-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
  .dd-title { font-family: var(--font-heading); font-size: 28px; font-weight: 800; letter-spacing: -0.02em; margin: 0; }
  .dd-ref { color: var(--green-700); }
  .dd-source-badge { display: inline-block; font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 12px; margin-left: 10px; vertical-align: middle; background: var(--blue-50,#eff6ff); color: var(--blue-700,#1d4ed8); text-transform: uppercase; letter-spacing: 0.04em; }
  .dd-source-badge.manual { background: var(--gray-100); color: var(--gray-500); }
  .dd-manage-btn { flex-shrink: 0; margin-top: 4px; }

  .dd-alert { margin-bottom: 12px; display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-radius: var(--radius-md); font-size: 14px; }
  .dd-alert-close { background: none; border: none; cursor: pointer; font-size: 16px; color: inherit; opacity: 0.6; padding: 0 4px; margin-left: auto; }

  .dd-hero-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
  @media (max-width: 640px) { .dd-hero-grid { grid-template-columns: 1fr; } }
  .dd-hero-card { padding: 20px 24px; display: flex; flex-direction: column; gap: 5px; }
  .dd-hero-label { font-family: var(--font-heading); font-size: 11px; font-weight: 700; color: var(--gray-400); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 4px; }
  .dd-hero-name { font-family: var(--font-heading); font-size: 18px; font-weight: 700; color: var(--gray-900); line-height: 1.3; }
  .dd-hero-phone { font-size: 15px; color: var(--gray-600); }
  .dd-hero-addr { font-size: 13px; color: var(--gray-500); line-height: 1.5; }
  .dd-hero-window { margin-top: 4px; }
  .dd-window-badge { display: inline-block; padding: 5px 12px; border-radius: var(--radius-md); font-size: 13px; font-weight: 600; }
  .dd-window-badge.am { background: var(--amber-50,#fffbeb); color: var(--amber-700,#b45309); }
  .dd-window-badge.pm { background: var(--blue-50,#eff6ff); color: var(--blue-700,#1d4ed8); }
  .dd-window-badge.priority { background: var(--amber-100,#fef3c7); color: var(--amber-800,#92400e); }
  .dd-hero-loads { font-size: 13px; color: var(--gray-400); font-weight: 600; }

  .dd-section { margin-bottom: 16px; overflow: hidden; }
  .dd-section-head { padding: 14px 24px; border-bottom: 1px solid var(--border-light); font-family: var(--font-heading); font-weight: 700; font-size: 15px; color: var(--gray-800); }
  .dd-section-body { padding: 16px 24px; }

  .dd-notif-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
  @media (max-width: 540px) { .dd-notif-grid { grid-template-columns: 1fr; } }
  .dd-notif-item { padding: 14px 24px; border-right: 1px solid var(--border-light); }
  .dd-notif-item:last-child { border-right: none; }
  @media (max-width: 540px) { .dd-notif-item { border-right: none; border-bottom: 1px solid var(--border-light); } .dd-notif-item:last-child { border-bottom: none; } }
  .dd-notif-label { font-family: var(--font-heading); font-size: 12px; font-weight: 600; color: var(--gray-500); margin-bottom: 6px; }

  .dd-loads-table { width: 100%; border-collapse: collapse; font-size: 14px; }
  .dd-loads-table th { padding: 10px 24px; text-align: left; font-family: var(--font-heading); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--gray-400); border-bottom: 1px solid var(--border-light); }
  .dd-loads-table td { padding: 13px 24px; border-bottom: 1px solid var(--border-light); vertical-align: middle; }
  .dd-loads-table tbody tr:last-child td { border-bottom: none; }
  .dd-load-mat { font-weight: 600; color: var(--gray-800); }
  .dd-load-driver { font-size: 13px; color: var(--gray-600); }
  .dd-unassigned { color: var(--amber-600,#d97706); font-weight: 600; font-size: 13px; }

  .dd-id-footer { font-size: 12px; color: var(--gray-300); margin-top: 24px; margin-bottom: 40px; }
  .dd-id-footer code { font-size: 11px; background: var(--gray-50); padding: 2px 6px; border-radius: 4px; }
`;
