'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, requireRole } from '../lib/auth';
import { useLocation } from '../lib/location-context';

type PickupDrop = {
  drop_id: string;
  order_number: number | null;
  external_order_id: string | null;
  source: string;
  customer_name: string;
  customer_phone: string | null;
  customer_email: string | null;
  customer_sms_opt_in: boolean;
  customer_email_opt_in: boolean;
  items: string[];
  notes: string | null;
  created_at: string;
  pickup_ready_sent_at: string | null;
};

function fmtTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function fmtDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

export default function PickupQueuePage() {
  const [mounted, setMounted] = useState(false);
  const [drops, setDrops] = useState<PickupDrop[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const { activeLocation } = useLocation();

  useEffect(() => { setMounted(true); }, []);

  const locationParam = activeLocation ? `?location_id=${activeLocation.id}` : '';

  const showToast = (msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const fetchQueue = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api(`/pickup/queue${locationParam}`);
      setDrops(data.drops || []);
    } catch (err) {
      setError((err as ApiError).message || 'Failed to load pickup queue.');
    } finally {
      setLoading(false);
    }
  }, [locationParam]);

  useEffect(() => {
    if (mounted) fetchQueue();
  }, [mounted, fetchQueue]);

  const notifyReady = async (drop: PickupDrop) => {
    setActionLoading(`notify-${drop.drop_id}`);
    try {
      const res = await api(`/pickup/${drop.drop_id}/notify-ready`, { method: 'POST' });
      const channels = [res.sms_sent && 'SMS', res.email_sent && 'email'].filter(Boolean).join(' & ');
      showToast(`✓ Notified via ${channels}`);
      fetchQueue();
    } catch (err) {
      showToast((err as ApiError).message || 'Failed to send notification.', 'error');
    } finally {
      setActionLoading(null);
    }
  };

  const fulfill = async (drop: PickupDrop) => {
    if (!confirm(`Mark Order #${drop.order_number || drop.drop_id.slice(0, 8)} as fulfilled?\n\nThis will remove it from the queue and mark it complete on the website.`)) return;
    setActionLoading(`fulfill-${drop.drop_id}`);
    try {
      await api(`/pickup/${drop.drop_id}/fulfill`, { method: 'POST' });
      showToast('✓ Order fulfilled');
      setDrops(prev => prev.filter(d => d.drop_id !== drop.drop_id));
    } catch (err) {
      showToast((err as ApiError).message || 'Failed to fulfill order.', 'error');
    } finally {
      setActionLoading(null);
    }
  };

  if (!mounted) return <div style={{ height: '100vh' }} />;
  if (!requireRole(['dispatcher', 'admin'])) return <div className="page"><p>Unauthorized</p></div>;

  return (
    <>
      <style>{styles}</style>
      <div className="page pq-page">

        {/* ── Header ── */}
        <div className="pq-header">
          <div>
            <h1 className="pq-title">Pickup Queue</h1>
            <p className="pq-subtitle">
              {loading ? 'Loading…' : `${drops.length} order${drops.length !== 1 ? 's' : ''} awaiting pickup`}
            </p>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={fetchQueue} disabled={loading}>
            ↻ Refresh
          </button>
        </div>

        {/* ── Toast ── */}
        {toast && (
          <div className={`pq-toast ${toast.type === 'error' ? 'pq-toast-error' : 'pq-toast-success'}`}>
            {toast.msg}
          </div>
        )}

        {/* ── Error ── */}
        {error && (
          <div className="alert alert-error" style={{ marginBottom: 16 }}>
            <span>⚠</span> {error}
            <button className="btn btn-ghost btn-sm" onClick={() => setError('')} style={{ marginLeft: 'auto' }}>✕</button>
          </div>
        )}

        {/* ── Loading ── */}
        {loading && (
          <div style={{ textAlign: 'center', padding: 60 }}>
            <div className="spinner spinner-lg" style={{ margin: '0 auto' }} />
          </div>
        )}

        {/* ── Empty ── */}
        {!loading && drops.length === 0 && !error && (
          <div className="card">
            <div className="empty-state">
              <div className="empty-state-icon">🛻</div>
              <div className="empty-state-title">No pickups waiting</div>
              <div className="empty-state-desc">Pickup orders from the website will appear here when received.</div>
            </div>
          </div>
        )}

        {/* ── Queue ── */}
        {!loading && drops.length > 0 && (
          <div className="pq-grid">
            {drops.map(drop => {
              const notifyBusy = actionLoading === `notify-${drop.drop_id}`;
              const fulfillBusy = actionLoading === `fulfill-${drop.drop_id}`;
              const hasNotifyChannel = drop.customer_sms_opt_in || !!drop.customer_email_opt_in;

              return (
                <div key={drop.drop_id} className="card pq-card">

                  {/* ── Card header ── */}
                  <div className="pq-card-head">
                    <div className="pq-card-ref">
                      {drop.order_number ? `#${drop.order_number}` : `#${drop.drop_id.slice(0, 8)}`}
                      {drop.external_order_id && (
                        <span className="pq-woo-badge">WooCommerce</span>
                      )}
                    </div>
                    <div className="pq-card-time">{fmtDate(drop.created_at)} · {fmtTime(drop.created_at)}</div>
                  </div>

                  {/* ── Customer ── */}
                  <div className="pq-card-body">
                    <div className="pq-customer-name">{drop.customer_name}</div>
                    {drop.customer_phone && (
                      <div className="pq-customer-meta">{drop.customer_phone}</div>
                    )}
                    {drop.customer_email && (
                      <div className="pq-customer-meta">{drop.customer_email}</div>
                    )}
                  </div>

                  {/* ── Items ── */}
                  <div className="pq-items">
                    {drop.items.map((item, i) => (
                      <div key={i} className="pq-item-row">
                        <span className="pq-item-dot" />
                        {item}
                      </div>
                    ))}
                  </div>

                  {/* ── Notes ── */}
                  {drop.notes && (
                    <div className="pq-notes">📝 {drop.notes}</div>
                  )}

                  {/* ── Ready sent indicator ── */}
                  {drop.pickup_ready_sent_at && (
                    <div className="pq-ready-sent">
                      ✓ Ready notification sent at {fmtTime(drop.pickup_ready_sent_at)}
                    </div>
                  )}

                  {/* ── Actions ── */}
                  <div className="pq-actions">
                    <button
                      className="btn btn-secondary btn-sm pq-notify-btn"
                      onClick={() => notifyReady(drop)}
                      disabled={notifyBusy || fulfillBusy || !hasNotifyChannel}
                      title={!hasNotifyChannel ? 'Customer has no SMS or email opt-in' : drop.pickup_ready_sent_at ? 'Send again' : 'Notify customer'}
                    >
                      {notifyBusy ? '…' : drop.pickup_ready_sent_at ? '📣 Notify Again' : '📣 Notify Ready'}
                    </button>
                    <button
                      className="btn btn-primary btn-sm pq-fulfill-btn"
                      onClick={() => fulfill(drop)}
                      disabled={fulfillBusy || notifyBusy}
                    >
                      {fulfillBusy ? '…' : '✓ Mark Fulfilled'}
                    </button>
                  </div>

                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

const styles = `
  .pq-page { max-width: 960px; padding-bottom: 60px; }

  .pq-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    margin-bottom: 24px;
    gap: 16px;
  }
  .pq-title {
    font-family: var(--font-heading);
    font-size: 28px;
    font-weight: 800;
    color: var(--gray-900);
    letter-spacing: -0.02em;
    margin: 0;
  }
  .pq-subtitle {
    font-size: 14px;
    color: var(--gray-500);
    margin: 4px 0 0;
  }

  .pq-toast {
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%);
    padding: 12px 20px;
    border-radius: 10px;
    font-size: 14px;
    font-weight: 600;
    z-index: 9999;
    box-shadow: var(--shadow-lg);
    white-space: nowrap;
  }
  .pq-toast-success { background: var(--green-700); color: #fff; }
  .pq-toast-error { background: #dc2626; color: #fff; }

  .pq-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 16px;
  }

  .pq-card { padding: 0; overflow: hidden; }

  .pq-card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px 10px;
    border-bottom: 1px solid var(--border-light);
    gap: 8px;
  }
  .pq-card-ref {
    font-family: var(--font-heading);
    font-size: 16px;
    font-weight: 800;
    color: var(--gray-900);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .pq-woo-badge {
    font-size: 10px;
    font-weight: 700;
    background: #7c3aed;
    color: #fff;
    border-radius: 5px;
    padding: 2px 6px;
    letter-spacing: 0.02em;
  }
  .pq-card-time {
    font-size: 12px;
    color: var(--gray-400);
    white-space: nowrap;
  }

  .pq-card-body {
    padding: 12px 16px 8px;
  }
  .pq-customer-name {
    font-family: var(--font-heading);
    font-size: 15px;
    font-weight: 700;
    color: var(--gray-900);
  }
  .pq-customer-meta {
    font-size: 12px;
    color: var(--gray-500);
    margin-top: 2px;
  }

  .pq-items {
    padding: 0 16px 10px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .pq-item-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--gray-700);
  }
  .pq-item-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--green-500);
    flex-shrink: 0;
  }

  .pq-notes {
    margin: 0 16px 10px;
    font-size: 12px;
    color: var(--gray-500);
    background: var(--gray-50);
    border-radius: 6px;
    padding: 6px 10px;
  }

  .pq-ready-sent {
    margin: 0 16px 10px;
    font-size: 12px;
    color: var(--green-700);
    font-weight: 600;
  }

  .pq-actions {
    display: flex;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--border-light);
    background: var(--gray-50);
  }
  .pq-notify-btn { flex: 1; }
  .pq-fulfill-btn { flex: 1; }

  @media (max-width: 600px) {
    .pq-grid { grid-template-columns: 1fr; }
    .pq-actions { flex-direction: column; }
  }
`;
