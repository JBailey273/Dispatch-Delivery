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

function fmtDateLong(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function orderLabel(drop: PickupDrop) {
  if (drop.external_order_id) return `WC-${drop.external_order_id}`;
  return drop.order_number ? `#${drop.order_number}` : `#${drop.drop_id.slice(0, 8).toUpperCase()}`;
}

// ── Print a single pick ticket ──────────────────────────────────────────────
function printPickTicket(drop: PickupDrop) {
  const label = orderLabel(drop);
  const dateStr = fmtDateLong(drop.created_at);
  const timeStr = fmtTime(drop.created_at);
  const itemRows = drop.items.map(item => `<tr><td class="pt-item">${item}</td></tr>`).join('');
  const customerNote = drop.notes && !drop.notes.startsWith('Items:') ? drop.notes : null;

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Pick Ticket ${label}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap');
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Plus Jakarta Sans', sans-serif; color: #111; background: #fff; padding: 32px; font-size: 13px; }
    .pt-header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #111; padding-bottom: 14px; margin-bottom: 18px; }
    .pt-gc { font-size: 18px; font-weight: 800; letter-spacing: -0.02em; }
    .pt-gc-sub { font-size: 11px; color: #555; margin-top: 2px; }
    .pt-order-num { font-size: 28px; font-weight: 800; letter-spacing: -0.03em; text-align: right; }
    .pt-order-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #555; text-align: right; }
    .pt-meta { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 24px; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid #ddd; }
    .pt-meta-block dt { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #777; margin-bottom: 3px; }
    .pt-meta-block dd { font-size: 14px; font-weight: 700; }
    .pt-meta-block dd.small { font-size: 12px; font-weight: 600; }
    .pt-section-label { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.1em; color: #555; margin-bottom: 8px; }
    .pt-items-table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
    .pt-items-table th { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #777; border-bottom: 1px solid #ddd; padding: 0 0 6px; text-align: left; }
    .pt-item { padding: 8px 0; border-bottom: 1px solid #eee; font-size: 13px; font-weight: 600; }
    .pt-notes { background: #f5f5f5; border-radius: 6px; padding: 10px 14px; font-size: 12px; color: #444; margin-bottom: 20px; }
    .pt-notes-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #777; margin-bottom: 4px; }
    .pt-sigs { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 32px; padding-top: 16px; border-top: 1px solid #ddd; }
    .pt-sig-line { border-bottom: 1px solid #999; height: 28px; margin-bottom: 6px; }
    .pt-sig-label { font-size: 10px; color: #777; text-transform: uppercase; letter-spacing: 0.06em; }
  </style>
</head>
<body>
  <div class="pt-header">
    <div>
      <div class="pt-gc">East Meadow Garden Center</div>
      <div class="pt-gc-sub">Pickup Order</div>
    </div>
    <div>
      <div class="pt-order-label">Order</div>
      <div class="pt-order-num">${label}</div>
    </div>
  </div>

  <div class="pt-meta">
    <dl class="pt-meta-block">
      <dt>Customer</dt>
      <dd>${drop.customer_name}</dd>
    </dl>
    <dl class="pt-meta-block">
      <dt>Order Date</dt>
      <dd class="small">${dateStr}</dd>
    </dl>
    ${drop.customer_phone ? `<dl class="pt-meta-block"><dt>Phone</dt><dd class="small">${drop.customer_phone}</dd></dl>` : ''}
    <dl class="pt-meta-block">
      <dt>Order Time</dt>
      <dd class="small">${timeStr}</dd>
    </dl>
    ${drop.customer_email ? `<dl class="pt-meta-block"><dt>Email</dt><dd class="small">${drop.customer_email}</dd></dl>` : ''}
    ${drop.external_order_id ? `<dl class="pt-meta-block"><dt>Source</dt><dd class="small">WooCommerce</dd></dl>` : ''}
  </div>

  <div class="pt-section-label">Items</div>
  <table class="pt-items-table">
    <thead><tr><th>Description</th></tr></thead>
    <tbody>${itemRows}</tbody>
  </table>

  ${customerNote ? `<div class="pt-notes"><div class="pt-notes-label">Notes</div>${customerNote}</div>` : ''}

  <div class="pt-sigs">
    <div>
      <div class="pt-sig-line"></div>
      <div class="pt-sig-label">Picked by</div>
    </div>
    <div>
      <div class="pt-sig-line"></div>
      <div class="pt-sig-label">Checked by</div>
    </div>
  </div>
</body>
</html>`;

  const win = window.open('', '_blank', 'width=600,height=800');
  if (!win) return;
  win.document.write(html);
  win.document.close();
  win.onload = () => { win.print(); };
}

// ── Detail Slide-Over ────────────────────────────────────────────────────────
function DetailSlideOver({
  drop,
  onClose,
  onNotify,
  onFulfill,
  actionLoading,
}: {
  drop: PickupDrop;
  onClose: () => void;
  onNotify: (drop: PickupDrop) => void;
  onFulfill: (drop: PickupDrop) => void;
  actionLoading: string | null;
}) {
  const notifyBusy = actionLoading === `notify-${drop.drop_id}`;
  const fulfillBusy = actionLoading === `fulfill-${drop.drop_id}`;
  const hasNotifyChannel = drop.customer_sms_opt_in || !!drop.customer_email_opt_in;
  const customerNote = drop.notes && !drop.notes.startsWith('Items:') ? drop.notes : null;

  const handleBackdrop = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div className="so-backdrop" onClick={handleBackdrop}>
      <div className="so-panel">

        {/* Header */}
        <div className="so-header">
          <div>
            <div className="so-order-num">{orderLabel(drop)}</div>
            <div className="so-order-meta">
              {fmtDate(drop.created_at)} · {fmtTime(drop.created_at)}
              {drop.external_order_id && <span className="pq-woo-badge" style={{ marginLeft: 8 }}>WooCommerce</span>}
            </div>
          </div>
          <button className="so-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {/* Body */}
        <div className="so-body">

          {/* Customer block */}
          <div className="so-section">
            <div className="so-section-label">Customer</div>
            <div className="so-customer-name">{drop.customer_name}</div>
            {drop.customer_phone && (
              <a href={`tel:${drop.customer_phone}`} className="so-contact-row">
                <span className="so-contact-icon">📞</span>
                {drop.customer_phone}
              </a>
            )}
            {drop.customer_email && (
              <a href={`mailto:${drop.customer_email}`} className="so-contact-row">
                <span className="so-contact-icon">✉️</span>
                {drop.customer_email}
              </a>
            )}
            <div className="so-opt-badges">
              <span className={`so-opt-badge ${drop.customer_sms_opt_in ? 'so-opt-on' : 'so-opt-off'}`}>
                SMS {drop.customer_sms_opt_in ? '✓' : '✗'}
              </span>
              <span className={`so-opt-badge ${drop.customer_email_opt_in ? 'so-opt-on' : 'so-opt-off'}`}>
                Email {drop.customer_email_opt_in ? '✓' : '✗'}
              </span>
            </div>
          </div>

          {/* Items block */}
          <div className="so-section">
            <div className="so-section-label">Items ({drop.items.length})</div>
            <div className="so-items-list">
              {drop.items.map((item, i) => (
                <div key={i} className="so-item-row">
                  <span className="so-item-dot" />
                  <span className="so-item-text">{item}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Notes — only real customer notes, not the old Items: fallback */}
          {customerNote && (
            <div className="so-section">
              <div className="so-section-label">Notes</div>
              <div className="so-notes">{customerNote}</div>
            </div>
          )}

          {/* Ready notification status */}
          {drop.pickup_ready_sent_at && (
            <div className="so-ready-banner">
              <span>✓</span>
              <span>Ready notification sent at {fmtTime(drop.pickup_ready_sent_at)}</span>
            </div>
          )}

        </div>

        {/* Footer actions */}
        <div className="so-footer">
          <button
            className="btn btn-ghost btn-sm so-print-btn"
            onClick={() => printPickTicket(drop)}
          >
            🖨 Print Ticket
          </button>
          <div className="so-footer-right">
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => onNotify(drop)}
              disabled={notifyBusy || fulfillBusy || !hasNotifyChannel}
              title={!hasNotifyChannel ? 'Customer has no SMS or email opt-in' : undefined}
            >
              {notifyBusy ? '…' : drop.pickup_ready_sent_at ? '📣 Notify Again' : '📣 Notify Ready'}
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => onFulfill(drop)}
              disabled={fulfillBusy || notifyBusy}
            >
              {fulfillBusy ? '…' : '✓ Mark Fulfilled'}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
// ── Main Page ────────────────────────────────────────────────────────────────
export default function PickupQueuePage() {
  const [mounted, setMounted] = useState(false);
  const [drops, setDrops] = useState<PickupDrop[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const [selectedDrop, setSelectedDrop] = useState<PickupDrop | null>(null);
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
    if (!confirm(`Mark Order ${orderLabel(drop)} as fulfilled?\n\nThis will remove it from the queue and mark it complete on the website.`)) return;
    setActionLoading(`fulfill-${drop.drop_id}`);
    try {
      await api(`/pickup/${drop.drop_id}/fulfill`, { method: 'POST' });
      showToast('✓ Order fulfilled');
      setDrops(prev => prev.filter(d => d.drop_id !== drop.drop_id));
      if (selectedDrop?.drop_id === drop.drop_id) setSelectedDrop(null);
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
                <div
                  key={drop.drop_id}
                  className="card pq-card"
                  onClick={() => setSelectedDrop(drop)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={e => e.key === 'Enter' && setSelectedDrop(drop)}
                >

                  {/* ── Card header ── */}
                  <div className="pq-card-head">
                    <div className="pq-card-ref">
                      {orderLabel(drop)}
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
                  {drop.notes && !drop.notes.startsWith('Items:') && (
                    <div className="pq-notes">📝 {drop.notes}</div>
                  )}

                  {/* ── Ready sent indicator ── */}
                  {drop.pickup_ready_sent_at && (
                    <div className="pq-ready-sent">
                      ✓ Ready notification sent at {fmtTime(drop.pickup_ready_sent_at)}
                    </div>
                  )}

                  {/* ── Actions ── */}
                  <div className="pq-actions" onClick={e => e.stopPropagation()}>
                    <button
                      className="btn btn-ghost btn-sm pq-print-btn"
                      onClick={() => printPickTicket(drop)}
                      title="Print pick ticket"
                    >
                      🖨
                    </button>
                    <button
                      className="btn btn-secondary btn-sm pq-notify-btn"
                      onClick={() => notifyReady(drop)}
                      disabled={notifyBusy || fulfillBusy || !hasNotifyChannel}
                      title={!hasNotifyChannel ? 'Customer has no SMS or email opt-in' : drop.pickup_ready_sent_at ? 'Send again' : 'Notify customer'}
                    >
                      {notifyBusy ? '…' : drop.pickup_ready_sent_at ? '📣 Again' : '📣 Notify'}
                    </button>
                    <button
                      className="btn btn-primary btn-sm pq-fulfill-btn"
                      onClick={() => fulfill(drop)}
                      disabled={fulfillBusy || notifyBusy}
                    >
                      {fulfillBusy ? '…' : '✓ Fulfilled'}
                    </button>
                  </div>

                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Detail Slide-Over ── */}
      {selectedDrop && (
        <DetailSlideOver
          drop={selectedDrop}
          onClose={() => setSelectedDrop(null)}
          onNotify={notifyReady}
          onFulfill={fulfill}
          actionLoading={actionLoading}
        />
      )}
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

  .pq-card {
    padding: 0;
    overflow: hidden;
    cursor: pointer;
    transition: box-shadow 0.15s var(--ease-out), transform 0.15s var(--ease-out);
  }
  .pq-card:hover {
    box-shadow: var(--shadow-md), var(--shadow-ring);
    transform: translateY(-1px);
  }
  .pq-card:focus-visible {
    outline: 2px solid var(--green-500);
    outline-offset: 2px;
  }

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
    align-items: center;
  }
  .pq-print-btn { flex-shrink: 0; padding: 7px 10px; }
  .pq-notify-btn { flex: 1; }
  .pq-fulfill-btn { flex: 1; }

  /* ── Detail Slide-Over ── */
  .so-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.35);
    z-index: 400;
    display: flex;
    justify-content: flex-end;
  }
  .so-panel {
    width: 100%;
    max-width: 440px;
    height: 100%;
    background: var(--surface);
    display: flex;
    flex-direction: column;
    box-shadow: var(--shadow-xl);
    animation: so-slide-in 0.22s var(--ease-out);
  }
  @keyframes so-slide-in {
    from { transform: translateX(100%); opacity: 0.6; }
    to   { transform: translateX(0);    opacity: 1; }
  }

  .so-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    padding: 20px 20px 16px;
    border-bottom: 1px solid var(--border-light);
    flex-shrink: 0;
  }
  .so-order-num {
    font-family: var(--font-heading);
    font-size: 22px;
    font-weight: 800;
    color: var(--gray-900);
    letter-spacing: -0.02em;
  }
  .so-order-meta {
    font-size: 13px;
    color: var(--gray-500);
    margin-top: 3px;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px;
  }
  .so-close {
    background: none;
    border: none;
    font-size: 18px;
    color: var(--gray-400);
    cursor: pointer;
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    line-height: 1;
    transition: color 0.15s, background 0.15s;
    flex-shrink: 0;
  }
  .so-close:hover { color: var(--gray-700); background: var(--gray-100); }

  .so-body {
    flex: 1;
    overflow-y: auto;
    padding: 0;
    -webkit-overflow-scrolling: touch;
  }

  .so-section {
    padding: 16px 20px;
    border-bottom: 1px solid var(--border-light);
  }
  .so-section-label {
    font-family: var(--font-heading);
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--gray-400);
    margin-bottom: 8px;
  }
  .so-customer-name {
    font-family: var(--font-heading);
    font-size: 18px;
    font-weight: 700;
    color: var(--gray-900);
    margin-bottom: 6px;
  }
  .so-contact-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    color: var(--gray-700);
    text-decoration: none;
    margin-bottom: 4px;
    border-radius: var(--radius-sm);
    padding: 3px 0;
    transition: color 0.15s;
  }
  .so-contact-row:hover { color: var(--green-700); }
  .so-contact-icon { font-size: 14px; }
  .so-opt-badges {
    display: flex;
    gap: 6px;
    margin-top: 10px;
  }
  .so-opt-badge {
    font-size: 11px;
    font-weight: 700;
    border-radius: 5px;
    padding: 2px 8px;
    letter-spacing: 0.02em;
  }
  .so-opt-on  { background: var(--green-50);  color: var(--green-700); border: 1px solid var(--green-200); }
  .so-opt-off { background: var(--gray-100); color: var(--gray-400);  border: 1px solid var(--gray-200); }

  .so-items-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .so-item-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }
  .so-item-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--green-500);
    flex-shrink: 0;
    margin-top: 5px;
  }
  .so-item-text {
    font-size: 14px;
    color: var(--gray-800);
    line-height: 1.4;
  }

  .so-notes {
    font-size: 14px;
    color: var(--gray-700);
    background: var(--gray-50);
    border-radius: var(--radius-md);
    padding: 10px 14px;
    line-height: 1.5;
  }

  .so-ready-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 12px 20px;
    padding: 10px 14px;
    background: var(--green-50);
    border: 1px solid var(--green-200);
    border-radius: var(--radius-md);
    font-size: 13px;
    font-weight: 600;
    color: var(--green-700);
  }

  .so-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 16px 20px;
    border-top: 1px solid var(--border-light);
    background: var(--gray-50);
    flex-shrink: 0;
  }
  .so-footer-right {
    display: flex;
    gap: 8px;
  }
  .so-print-btn { color: var(--gray-600); }

  @media (max-width: 600px) {
    .pq-grid { grid-template-columns: 1fr; }
    .pq-actions { flex-direction: row; }
    .so-panel { max-width: 100%; }
    .so-footer { flex-wrap: wrap; }
    .so-footer-right { flex: 1; justify-content: flex-end; }
  }
`;
