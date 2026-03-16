'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { ApiError, api, requireRole } from '../../../lib/auth';
import { useLocation } from '../../../lib/location-context';
import DropRescheduleSlideOver from '../../../components/DropRescheduleSlideOver';
import type { SlideOverDropDetail } from '../../../components/DropRescheduleSlideOver';

/* ── Types ── */
type Address = { line1: string; line2?: string | null; city: string; state: string; postal_code: string };
type LoadItem = {
  id: string; material: string; qty: number; unit: string;
  status: string; driver_user_id: string | null; driver_name: string | null;
  pod_photo_url: string | null;
  exception_photo_url: string | null;
  exception_reason_code: string | null;
  exception_notes: string | null;
  condition_photo_url: string | null;
  condition_notes: string | null;
};
type DropDetail = {
  id: string; ref: string; source: string;
  scheduled_date: string | null; scheduled_window: string | null; is_priority: boolean;
  customer_name: string; customer_phone: string; delivery_address: Address | null;
  notes: string | null; required_loads: number; loads: LoadItem[];
  notify_sent_at: string | null; last_reschedule_sms_at: string | null;
  drop_photos: string[];
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

const EXCEPTION_LABELS: Record<string, string> = {
  WRONG_ADDRESS: 'Wrong Address',
  CUSTOMER_REFUSED: 'Customer Refused',
  ACCESS_BLOCKED: 'Access Blocked',
  DAMAGED_GOODS: 'Damaged Material',
  CUSTOMER_UNAVAILABLE: 'Not Home',
  SAFETY_RISK: 'Safety Risk',
  OUT_OF_STOCK: 'Out of Stock',
  OTHER: 'Other',
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
      exception_reason_code: l.exception_reason_code,
      exception_notes: l.exception_notes,
      exception_photo_url: l.exception_photo_url,
      condition_photo_url: l.condition_photo_url,
      condition_notes: l.condition_notes,
      pod_photo_url: l.pod_photo_url,
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
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const { activeLocation } = useLocation();

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
    if (searchParams.get('action') === 'reschedule' && drop) setShowPanel(true);
  }, [searchParams, drop]);

  if (!requireRole(['dispatcher'])) return <div className="page"><p>Unauthorized</p></div>;
  if (!mounted) return <div style={{ minHeight: '100vh' }} />;

  /* ── Collect all photos across the drop ── */
  const buildPhotoSections = (drop: DropDetail) => {
    const sections: { label: string; icon: string; color: string; photos: { url: string; caption: string }[] }[] = [];

    if (drop.drop_photos?.length > 0) {
      sections.push({
        label: 'Drop Site',
        icon: '📍',
        color: '#1d4ed8',
        photos: drop.drop_photos.map((url, i) => ({ url, caption: `Site photo ${i + 1}` })),
      });
    }

    const conditionPhotos = drop.loads
      .filter(l => l.condition_photo_url || l.condition_notes)
      .map(l => ({
        url: l.condition_photo_url || '',
        caption: l.condition_notes ? `${l.material}: ${l.condition_notes}` : `${l.material} — condition documented`,
        notesOnly: !l.condition_photo_url,
        notes: l.condition_notes,
      }));
    if (conditionPhotos.length > 0) {
      sections.push({
        label: 'Site Conditions',
        icon: '📋',
        color: '#92400e',
        photos: conditionPhotos.filter(p => !p.notesOnly).map(p => ({ url: p.url, caption: p.caption })),
        ...(conditionPhotos.some(p => p.notesOnly) ? { notesOnly: conditionPhotos.filter(p => p.notesOnly) } : {}),
      } as any);
    }

    const podPhotos = drop.loads
      .filter(l => l.pod_photo_url)
      .map(l => ({ url: l.pod_photo_url!, caption: `POD — ${l.material}` }));
    if (podPhotos.length > 0) {
      sections.push({ label: 'Proof of Delivery', icon: '✅', color: '#15803d', photos: podPhotos });
    }

    const exceptionPhotos = drop.loads
      .filter(l => l.exception_photo_url || l.exception_reason_code)
      .map(l => ({
        url: l.exception_photo_url || '',
        caption: [
          EXCEPTION_LABELS[l.exception_reason_code || ''] || l.exception_reason_code || 'Exception',
          l.exception_notes,
        ].filter(Boolean).join(' — '),
        notesOnly: !l.exception_photo_url,
        notes: l.exception_notes,
        reason: l.exception_reason_code,
      }));
    if (exceptionPhotos.length > 0) {
      sections.push({
        label: 'Exception',
        icon: '⚠️',
        color: '#b91c1c',
        photos: exceptionPhotos.filter(p => !p.notesOnly).map(p => ({ url: p.url, caption: p.caption })),
        ...(exceptionPhotos.some(p => p.notesOnly) ? { notesOnly: exceptionPhotos.filter(p => p.notesOnly) } : {}),
      } as any);
    }

    return sections;
  };

  const photoSections = drop ? buildPhotoSections(drop) : [];
  const hasAnyPhotos = photoSections.length > 0;

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
                <div className="dd-hero-name">{drop.scheduled_date ? fmtDate(drop.scheduled_date) : 'Not Yet Scheduled'}</div>
                <div className="dd-hero-window">
                  {drop.is_priority
                    ? <span className="dd-window-badge priority">⚡ Priority</span>
                    : drop.scheduled_window ? <span className={`dd-window-badge ${drop.scheduled_window === 'A' ? 'am' : 'pm'}`}>
                        {drop.scheduled_window === 'A' ? 'Morning Window (9am – 1pm)' : 'Afternoon Window (1pm – 5pm)'}
                      </span> : null}
                </div>
                <div className="dd-hero-loads">{drop.required_loads} load{drop.required_loads !== 1 ? 's' : ''}</div>
              </div>
            </div>

            {/* Notification status */}
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

            {/* Loads */}
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

            {/* Photos */}
            {hasAnyPhotos && (
              <div className="card dd-section">
                <div className="dd-section-head">Photos & Documentation</div>
                <div className="dd-photos-body">
                  {photoSections.map((section, si) => (
                    <div key={si} className={`dd-photo-section ${si < photoSections.length - 1 ? 'dd-photo-section--border' : ''}`}>
                      <div className="dd-photo-section-label" style={{ color: section.color }}>
                        {section.icon} {section.label}
                      </div>

                      {/* Photo grid */}
                      {section.photos.length > 0 && (
                        <div className="dd-photo-grid">
                          {section.photos.map((photo, pi) => (
                            <div key={pi} className="dd-photo-tile" onClick={() => setLightboxUrl(photo.url)}>
                              <img src={photo.url} alt={photo.caption} className="dd-photo-img" />
                              <div className="dd-photo-caption">{photo.caption}</div>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Notes-only entries (no photo, just text) */}
                      {(section as any).notesOnly?.map((item: any, ni: number) => (
                        <div key={ni} className="dd-photo-note">
                          <span className="dd-photo-note-icon">📝</span>
                          <div>
                            {item.reason && <div className="dd-photo-note-reason">{EXCEPTION_LABELS[item.reason] || item.reason}</div>}
                            {item.notes && <div className="dd-photo-note-text">{item.notes}</div>}
                            {!item.reason && !item.notes && <div className="dd-photo-note-text">{item.caption}</div>}
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="dd-id-footer">Drop ID: <code>{drop.id}</code></div>
          </>
        )}
      </div>

      {/* Lightbox */}
      {lightboxUrl && (
        <div className="dd-lightbox-overlay" onClick={() => setLightboxUrl(null)}>
          <div className="dd-lightbox" onClick={e => e.stopPropagation()}>
            <img src={lightboxUrl} alt="Photo" className="dd-lightbox-img" />
            <button className="dd-lightbox-close" onClick={() => setLightboxUrl(null)}>✕</button>
          </div>
        </div>
      )}

      {/* Order management panel */}
      {showPanel && drop && (
        <DropRescheduleSlideOver
          dropId={drop.id}
          dropDetail={toSlideOverDetail(drop)}
          onClose={() => setShowPanel(false)}
          onRescheduled={fetchDrop}
          startOnReschedule={searchParams.get('action') === 'reschedule'}
          locationId={activeLocation?.id ?? null}
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

  /* Photos */
  .dd-photos-body { padding: 8px 0; }
  .dd-photo-section { padding: 16px 24px; }
  .dd-photo-section--border { border-bottom: 1px solid var(--border-light); }
  .dd-photo-section-label { font-family: var(--font-heading); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 12px; }
  .dd-photo-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; }
  .dd-photo-tile { border-radius: 10px; overflow: hidden; border: 1.5px solid var(--border-light); cursor: pointer; transition: transform 0.15s, box-shadow 0.15s; }
  .dd-photo-tile:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
  .dd-photo-img { width: 100%; height: 130px; object-fit: cover; display: block; }
  .dd-photo-caption { padding: 6px 10px; font-size: 12px; color: var(--gray-500); font-weight: 500; background: var(--gray-50); line-height: 1.3; }
  .dd-photo-note { display: flex; align-items: flex-start; gap: 10px; padding: 10px 14px; background: var(--gray-50); border-radius: 8px; margin-top: 8px; }
  .dd-photo-note-icon { font-size: 18px; flex-shrink: 0; margin-top: 1px; }
  .dd-photo-note-reason { font-family: var(--font-heading); font-size: 13px; font-weight: 700; color: var(--gray-700); margin-bottom: 2px; }
  .dd-photo-note-text { font-size: 13px; color: var(--gray-600); line-height: 1.4; }

  /* Lightbox */
  .dd-lightbox-overlay { position: fixed; inset: 0; z-index: 200; background: rgba(0,0,0,0.85); display: flex; align-items: center; justify-content: center; animation: dd-fade 0.15s; }
  @keyframes dd-fade { from { opacity: 0; } to { opacity: 1; } }
  .dd-lightbox { position: relative; max-width: 90vw; max-height: 90vh; }
  .dd-lightbox-img { max-width: 90vw; max-height: 85vh; object-fit: contain; border-radius: 12px; display: block; }
  .dd-lightbox-close { position: absolute; top: -16px; right: -16px; width: 40px; height: 40px; border-radius: 50%; background: #fff; border: none; font-size: 18px; box-shadow: 0 2px 8px rgba(0,0,0,0.3); cursor: pointer; display: flex; align-items: center; justify-content: center; }

  .dd-id-footer { font-size: 12px; color: var(--gray-300); margin-top: 24px; margin-bottom: 40px; }
  .dd-id-footer code { font-size: 11px; background: var(--gray-50); padding: 2px 6px; border-radius: 4px; }
`;
