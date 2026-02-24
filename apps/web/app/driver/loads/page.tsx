'use client';

import { useEffect, useState, useCallback, useRef } from 'react';

/* ═══════════════════════════════════════════════════════════════════════════
   TYPES
   ═══════════════════════════════════════════════════════════════════════════ */

type LoadItem = {
  id: string;
  status: string;
  material: string;
  qty: number;
  unit: string;
  pod_photo_url: string | null;
  exception_photo_url: string | null;
  exception_reason_code: string | null;
  exception_notes: string | null;
};

type DropItem = {
  drop_id: string;
  customer_name: string;
  customer_phone: string | null;
  address: { line1: string; city: string; state: string; postal_code: string } | null;
  notes: string | null;
  notify_sent: boolean;
  scheduled_window: string | null;
  loads: LoadItem[];
};

/* ═══════════════════════════════════════════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════════════════════════════════════════ */

const EXCEPTION_REASONS: Record<string, { label: string; icon: string }> = {
  WRONG_ADDRESS:        { label: 'Wrong Address',     icon: '📍' },
  CUSTOMER_REFUSED:     { label: 'Customer Refused',  icon: '🚫' },
  ACCESS_BLOCKED:       { label: 'Access Blocked',    icon: '🚧' },
  DAMAGED_GOODS:        { label: 'Damaged Material',  icon: '💥' },
  CUSTOMER_UNAVAILABLE: { label: 'Not Home',          icon: '🏠' },
  SAFETY_RISK:          { label: 'Safety Risk',       icon: '⚠️' },
  OTHER:                { label: 'Other',             icon: '📝' },
};

// OUT_OF_STOCK is handled separately — not shown in exception modal

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  assigned:       { label: 'Ready',       color: '#1d4ed8', bg: '#dbeafe' },
  loaded_leaving: { label: 'Ready',       color: '#1d4ed8', bg: '#dbeafe' },  // treat same as assigned for driver
  delivered:      { label: 'Delivered',    color: '#15803d', bg: '#dcfce7' },
  exception:      { label: 'Exception',    color: '#dc2626', bg: '#fee2e2' },
  cancelled:      { label: 'Cancelled',    color: '#6b7280', bg: '#f3f4f6' },
};

/* ═══════════════════════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function api(path: string, opts?: RequestInit) {
  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...opts?.headers },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw { status: res.status, ...err };
  }
  return res.json();
}

function getDropStatus(drop: DropItem): string {
  const statuses = drop.loads.map(l => l.status);
  if (statuses.every(s => s === 'delivered')) return 'delivered';
  if (statuses.every(s => s === 'cancelled')) return 'cancelled';
  if (statuses.some(s => s === 'exception')) return 'exception';
  // assigned and loaded_leaving are both "active" from the driver's perspective
  return 'assigned';
}

function formatAddress(addr: DropItem['address']): string {
  if (!addr) return 'No address';
  return `${addr.line1}, ${addr.city}, ${addr.state} ${addr.postal_code}`;
}

function getGoogleMapsUrl(addr: DropItem['address']): string {
  if (!addr) return '#';
  const q = encodeURIComponent(`${addr.line1}, ${addr.city}, ${addr.state} ${addr.postal_code}`);
  return `https://www.google.com/maps/dir/?api=1&destination=${q}`;
}


/* ═══════════════════════════════════════════════════════════════════════════
   COMPONENT
   ═══════════════════════════════════════════════════════════════════════════ */

export default function DriverPage() {
  // ── State ──────────────────────────────────────────────────────────────
  const [drops, setDrops] = useState<DropItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedDrop, setExpandedDrop] = useState<string | null>(null);

  // Action states
  const [actionLoading, setActionLoading] = useState<string | null>(null); // load_id or drop_id being acted on
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);

  // Exception modal
  const [exceptionModal, setExceptionModal] = useState<{ loadId: string; dropId: string } | null>(null);
  const [exceptionReason, setExceptionReason] = useState('');
  const [exceptionNotes, setExceptionNotes] = useState('');

  // Out of stock confirmation
  const [oosConfirm, setOosConfirm] = useState<{ loadId: string; material: string } | null>(null);

  // Photo capture
  const [photoModal, setPhotoModal] = useState<{ loadId: string; type: 'pod' | 'exception' } | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  // ── Data fetch ─────────────────────────────────────────────────────────
  const fetchDrops = useCallback(async () => {
    try {
      const data = await api(`/driver/drops?day=${todayStr()}`);
      setDrops(data.drops || []);
      setError('');
    } catch {
      setError('Could not load deliveries. Pull down to retry.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDrops();
    const interval = setInterval(fetchDrops, 30000); // poll every 30s
    return () => clearInterval(interval);
  }, [fetchDrops]);

  // Auto-expand first active drop
  useEffect(() => {
    if (drops.length > 0 && !expandedDrop) {
      const active = drops.find(d => {
        const s = getDropStatus(d);
        return s === 'assigned' || s === 'loaded_leaving';
      });
      if (active) setExpandedDrop(active.drop_id);
    }
  }, [drops, expandedDrop]);

  // ── Toast auto-dismiss ─────────────────────────────────────────────────
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // ── Actions ────────────────────────────────────────────────────────────
  const showToast = (msg: string, type: 'success' | 'error' = 'success') => setToast({ msg, type });

  const markDelivered = async (loadId: string) => {
    setActionLoading(loadId);
    try {
      await api(`/driver/loads/${loadId}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: 'delivered' }),
      });
      showToast('Delivery confirmed! ✓');
      await fetchDrops();
    } catch (err: any) {
      if (err?.detail?.code === 'missing_pod') {
        showToast('Please take a photo before marking delivered.', 'error');
      } else {
        showToast('Failed to update. Try again.', 'error');
      }
    } finally {
      setActionLoading(null);
    }
  };

  const notifyCustomer = async (dropId: string) => {
    setActionLoading(`notify-${dropId}`);
    try {
      const result = await api(`/driver/drops/${dropId}/notify`, { method: 'POST' });
      if (result.already_sent) {
        showToast('Customer was already notified.');
      } else {
        showToast('Customer notified — SMS sent! ✓');
      }
      await fetchDrops();
    } catch {
      showToast('Could not send notification. Try again.', 'error');
    } finally {
      setActionLoading(null);
    }
  };

  const submitException = async () => {
    if (!exceptionModal || !exceptionReason) return;
    setActionLoading(exceptionModal.loadId);
    try {
      await api(`/driver/loads/${exceptionModal.loadId}/status`, {
        method: 'POST',
        body: JSON.stringify({
          status: 'exception',
          reason_code: exceptionReason,
          notes: exceptionNotes || null,
        }),
      });
      showToast('Exception reported.');
      setExceptionModal(null);
      setExceptionReason('');
      setExceptionNotes('');
      await fetchDrops();
    } catch {
      showToast('Failed to report exception. Try again.', 'error');
    } finally {
      setActionLoading(null);
    }
  };

  const submitOutOfStock = async () => {
    if (!oosConfirm) return;
    setActionLoading(oosConfirm.loadId);
    try {
      await api(`/driver/loads/${oosConfirm.loadId}/status`, {
        method: 'POST',
        body: JSON.stringify({
          status: 'exception',
          reason_code: 'OUT_OF_STOCK',
          notes: `Driver reported out of stock: ${oosConfirm.material}`,
        }),
      });
      showToast('Returned to dispatch — out of stock.');
      setOosConfirm(null);
      await fetchDrops();
    } catch {
      showToast('Failed to update. Try again.', 'error');
    } finally {
      setActionLoading(null);
    }
  };

  const handlePhotoCapture = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!photoModal || !e.target.files?.[0]) return;
    const file = e.target.files[0];
    setActionLoading(photoModal.loadId);

    try {
      // Get presigned upload URL
      const ext = file.name.split('.').pop() || 'jpg';
      const uploadData = await api(`/uploads/presign?ext=${ext}&purpose=${photoModal.type}`);
      // Upload to S3
      await fetch(uploadData.upload_url, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type },
      });
      // Attach to load
      await api(`/driver/loads/${photoModal.loadId}/photo`, {
        method: 'POST',
        body: JSON.stringify({ photo_url: uploadData.public_url, photo_type: photoModal.type }),
      });
      showToast(photoModal.type === 'pod' ? 'Delivery photo saved! ✓' : 'Exception photo saved.');
      setPhotoModal(null);
      await fetchDrops();
    } catch {
      showToast('Photo upload failed. Try again.', 'error');
    } finally {
      setActionLoading(null);
      if (photoInputRef.current) photoInputRef.current.value = '';
    }
  };

  const openCamera = (loadId: string, type: 'pod' | 'exception') => {
    setPhotoModal({ loadId, type });
    // Small delay so state sets before triggering input
    setTimeout(() => photoInputRef.current?.click(), 100);
  };

  // ── Render helpers ─────────────────────────────────────────────────────
  const completedCount = drops.filter(d => getDropStatus(d) === 'delivered').length;
  const totalCount = drops.length;

  return (
    <>
      <style>{`
        /* ── RESET & BASE ─────────────────────────────────────────── */
        * { box-sizing: border-box; margin: 0; padding: 0; }
        :root {
          --font-body: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif;
          --font-heading: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
          --green-700: #15803d; --green-100: #dcfce7;
          --blue-700: #1d4ed8; --blue-100: #dbeafe;
          --amber-700: #b45309; --amber-100: #fef3c7;
          --red-700: #dc2626; --red-100: #fee2e2;
          --gray-50: #f9fafb; --gray-100: #f3f4f6; --gray-200: #e5e7eb;
          --gray-400: #9ca3af; --gray-500: #6b7280; --gray-700: #374151; --gray-900: #111827;
          --radius: 16px; --radius-sm: 12px;
        }

        /* ── PAGE LAYOUT ──────────────────────────────────────────── */
        .drv-page {
          font-family: var(--font-body);
          min-height: 100dvh;
          background: linear-gradient(180deg, #f0fdf4 0%, var(--gray-50) 120px);
          padding: 0 0 100px 0;
          -webkit-tap-highlight-color: transparent;
          -webkit-font-smoothing: antialiased;
        }

        /* ── HEADER ───────────────────────────────────────────────── */
        .drv-header {
          padding: 20px 20px 16px;
          position: sticky; top: 0; z-index: 50;
          background: linear-gradient(180deg, #f0fdf4 0%, rgba(240,253,244,0.95) 100%);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
        }
        .drv-greeting {
          font-family: var(--font-heading);
          font-size: 28px; font-weight: 800;
          color: var(--gray-900);
          line-height: 1.2;
        }
        .drv-date {
          font-size: 17px; color: var(--gray-500);
          margin-top: 4px; font-weight: 500;
        }
        .drv-progress-bar {
          margin-top: 14px;
          background: var(--gray-200);
          border-radius: 8px; height: 10px;
          overflow: hidden;
        }
        .drv-progress-fill {
          height: 100%; border-radius: 8px;
          background: linear-gradient(90deg, #22c55e, #16a34a);
          transition: width 0.6s ease;
        }
        .drv-progress-label {
          font-size: 15px; font-weight: 600;
          color: var(--gray-700);
          margin-top: 6px;
        }

        /* ── CARD ─────────────────────────────────────────────────── */
        .drv-card {
          margin: 12px 16px;
          background: #fff;
          border-radius: var(--radius);
          box-shadow: 0 1px 3px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.04);
          overflow: hidden;
          border: 2px solid transparent;
          transition: border-color 0.2s, box-shadow 0.2s;
        }
        .drv-card--active {
          border-color: var(--blue-700);
          box-shadow: 0 2px 8px rgba(29,78,216,0.12), 0 8px 24px rgba(0,0,0,0.06);
        }
        .drv-card--done {
          opacity: 0.7;
          border-color: var(--green-700);
        }
        .drv-card--exception {
          border-color: var(--red-700);
        }

        /* ── CARD HEADER (tap to expand) ──────────────────────────── */
        .drv-card-header {
          padding: 18px 20px;
          display: flex; align-items: center; gap: 14px;
          cursor: pointer;
          -webkit-user-select: none; user-select: none;
          min-height: 72px;
        }
        .drv-card-header:active { background: var(--gray-50); }

        .drv-card-status-dot {
          width: 14px; height: 14px;
          border-radius: 50%; flex-shrink: 0;
        }
        .drv-card-info { flex: 1; min-width: 0; }
        .drv-customer-name {
          font-family: var(--font-heading);
          font-size: 20px; font-weight: 700;
          color: var(--gray-900);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .drv-card-subtitle {
          font-size: 15px; color: var(--gray-500);
          margin-top: 2px; font-weight: 500;
          display: flex; align-items: center; gap: 6px;
        }
        .drv-card-badge {
          display: inline-flex; align-items: center;
          padding: 3px 10px; border-radius: 20px;
          font-size: 13px; font-weight: 700;
          white-space: nowrap; flex-shrink: 0;
        }
        .drv-chevron {
          font-size: 22px; color: var(--gray-400);
          transition: transform 0.3s ease;
          flex-shrink: 0;
        }
        .drv-chevron--open { transform: rotate(180deg); }

        /* ── CARD BODY (expanded) ─────────────────────────────────── */
        .drv-card-body {
          max-height: 0; overflow: hidden;
          transition: max-height 0.35s ease;
        }
        .drv-card-body--open {
          max-height: 2000px;
        }
        .drv-card-content {
          padding: 0 20px 20px;
        }

        /* ── ADDRESS SECTION ──────────────────────────────────────── */
        .drv-address-btn {
          display: flex; align-items: center; gap: 12px;
          width: 100%; padding: 16px;
          background: var(--blue-100); border: 2px solid var(--blue-700);
          border-radius: var(--radius-sm);
          text-decoration: none; color: var(--blue-700);
          font-size: 17px; font-weight: 600;
          font-family: var(--font-body);
          cursor: pointer;
          transition: transform 0.1s;
        }
        .drv-address-btn:active { transform: scale(0.98); }
        .drv-address-icon { font-size: 28px; flex-shrink: 0; }
        .drv-address-text { text-align: left; line-height: 1.3; }
        .drv-address-label { font-size: 13px; color: var(--blue-700); opacity: 0.7; font-weight: 500; }

        /* ── NOTES ────────────────────────────────────────────────── */
        .drv-notes {
          margin-top: 14px; padding: 14px 16px;
          background: #fffbeb; border-left: 4px solid var(--amber-700);
          border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
          font-size: 16px; color: var(--amber-700);
          line-height: 1.4;
        }
        .drv-notes-label {
          font-size: 13px; font-weight: 700; text-transform: uppercase;
          letter-spacing: 0.5px; margin-bottom: 4px;
        }

        /* ── MATERIALS LIST ───────────────────────────────────────── */
        .drv-materials-label {
          font-family: var(--font-heading);
          font-size: 15px; font-weight: 700;
          color: var(--gray-500); text-transform: uppercase;
          letter-spacing: 0.5px; margin: 18px 0 10px;
        }
        .drv-material-row {
          display: flex; align-items: center; gap: 12px;
          padding: 14px 16px;
          background: var(--gray-50);
          border-radius: var(--radius-sm);
          margin-bottom: 8px;
        }
        .drv-material-icon { font-size: 24px; flex-shrink: 0; }
        .drv-material-info { flex: 1; }
        .drv-material-name {
          font-family: var(--font-heading);
          font-size: 18px; font-weight: 700; color: var(--gray-900);
        }
        .drv-material-qty {
          font-size: 15px; color: var(--gray-500); font-weight: 500;
        }
        .drv-material-status {
          padding: 4px 12px; border-radius: 20px;
          font-size: 13px; font-weight: 700;
        }

        /* ── POD PHOTO INDICATOR ──────────────────────────────────── */
        .drv-photo-indicator {
          display: flex; align-items: center; gap: 6px;
          margin-top: 6px;
          font-size: 13px; font-weight: 600;
        }
        .drv-photo-indicator--has { color: var(--green-700); }
        .drv-photo-indicator--needs { color: var(--gray-400); }

        /* ── ACTION BUTTONS ───────────────────────────────────────── */
        .drv-actions {
          margin-top: 18px;
          display: flex; flex-direction: column; gap: 10px;
        }
        .drv-btn {
          display: flex; align-items: center; justify-content: center; gap: 10px;
          width: 100%;
          padding: 18px 24px;
          border: none; border-radius: var(--radius-sm);
          font-family: var(--font-heading);
          font-size: 18px; font-weight: 700;
          cursor: pointer;
          transition: transform 0.1s, opacity 0.2s;
          -webkit-user-select: none; user-select: none;
        }
        .drv-btn:active:not(:disabled) { transform: scale(0.97); }
        .drv-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .drv-btn-icon { font-size: 24px; }

        .drv-btn--primary {
          background: linear-gradient(135deg, #16a34a, #15803d);
          color: #fff; box-shadow: 0 4px 12px rgba(22,163,74,0.3);
        }
        .drv-btn--blue {
          background: linear-gradient(135deg, #2563eb, #1d4ed8);
          color: #fff; box-shadow: 0 4px 12px rgba(37,99,235,0.3);
        }
        .drv-btn--notify {
          background: linear-gradient(135deg, #7c3aed, #6d28d9);
          color: #fff; box-shadow: 0 4px 12px rgba(124,58,237,0.3);
        }
        .drv-btn--camera {
          background: linear-gradient(135deg, #0891b2, #0e7490);
          color: #fff; box-shadow: 0 4px 12px rgba(8,145,178,0.3);
        }
        .drv-btn--danger {
          background: #fff; color: var(--red-700);
          border: 2px solid var(--red-700);
        }
        .drv-btn--oos {
          background: #fff; color: var(--amber-700);
          border: 2px solid var(--amber-700);
        }
        .drv-btn--disabled-sent {
          background: var(--gray-100); color: var(--gray-500);
          border: 2px solid var(--gray-200);
          cursor: default;
        }

        .drv-btn-row {
          display: flex; gap: 10px;
        }
        .drv-btn-row .drv-btn { flex: 1; }

        /* ── LOADING / EMPTY / ERROR ──────────────────────────────── */
        .drv-empty {
          text-align: center; padding: 60px 24px;
          color: var(--gray-500);
        }
        .drv-empty-icon { font-size: 64px; margin-bottom: 16px; }
        .drv-empty-title {
          font-family: var(--font-heading);
          font-size: 22px; font-weight: 700; color: var(--gray-700);
          margin-bottom: 8px;
        }
        .drv-empty-text { font-size: 17px; line-height: 1.5; }
        .drv-error-text { color: var(--red-700); }

        .drv-refresh-btn {
          margin-top: 20px;
          padding: 14px 32px;
          background: var(--green-700); color: #fff;
          border: none; border-radius: var(--radius-sm);
          font-family: var(--font-heading);
          font-size: 17px; font-weight: 700;
          cursor: pointer;
        }

        .drv-loading {
          text-align: center; padding: 80px 24px;
        }
        .drv-spinner {
          width: 48px; height: 48px;
          border: 4px solid var(--gray-200);
          border-top-color: var(--green-700);
          border-radius: 50%;
          animation: drv-spin 0.8s linear infinite;
          margin: 0 auto 16px;
        }
        @keyframes drv-spin { to { transform: rotate(360deg); } }

        /* ── TOAST ────────────────────────────────────────────────── */
        .drv-toast {
          position: fixed; bottom: 24px; left: 16px; right: 16px;
          z-index: 200;
          padding: 18px 20px;
          border-radius: var(--radius-sm);
          font-family: var(--font-heading);
          font-size: 17px; font-weight: 700;
          text-align: center;
          animation: drv-slide-up 0.3s ease;
          box-shadow: 0 8px 32px rgba(0,0,0,0.15);
        }
        .drv-toast--success { background: var(--green-700); color: #fff; }
        .drv-toast--error { background: var(--red-700); color: #fff; }
        @keyframes drv-slide-up { from { transform: translateY(80px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

        /* ── MODAL OVERLAY ────────────────────────────────────────── */
        .drv-overlay {
          position: fixed; inset: 0; z-index: 100;
          background: rgba(0,0,0,0.5);
          display: flex; align-items: flex-end;
          animation: drv-fade-in 0.2s ease;
        }
        @keyframes drv-fade-in { from { opacity: 0; } to { opacity: 1; } }

        .drv-modal {
          width: 100%;
          background: #fff;
          border-radius: var(--radius) var(--radius) 0 0;
          padding: 24px 20px 32px;
          max-height: 85dvh; overflow-y: auto;
          animation: drv-slide-up 0.3s ease;
        }
        .drv-modal-title {
          font-family: var(--font-heading);
          font-size: 24px; font-weight: 800;
          color: var(--gray-900);
          margin-bottom: 6px;
        }
        .drv-modal-subtitle {
          font-size: 16px; color: var(--gray-500);
          margin-bottom: 20px;
        }

        /* ── EXCEPTION REASON GRID ────────────────────────────────── */
        .drv-reason-grid {
          display: grid; grid-template-columns: 1fr 1fr;
          gap: 10px; margin-bottom: 20px;
        }
        .drv-reason-btn {
          display: flex; flex-direction: column;
          align-items: center; justify-content: center;
          gap: 8px; padding: 20px 12px;
          background: var(--gray-50); border: 3px solid var(--gray-200);
          border-radius: var(--radius-sm);
          font-family: var(--font-heading);
          font-size: 15px; font-weight: 700;
          color: var(--gray-700);
          cursor: pointer; text-align: center;
          transition: border-color 0.15s, background 0.15s;
          min-height: 90px;
        }
        .drv-reason-btn:active { background: var(--gray-100); }
        .drv-reason-btn--selected {
          border-color: var(--red-700);
          background: var(--red-100);
          color: var(--red-700);
        }
        .drv-reason-icon { font-size: 32px; }

        /* ── NOTES TEXTAREA ───────────────────────────────────────── */
        .drv-textarea-label {
          font-family: var(--font-heading);
          font-size: 15px; font-weight: 700;
          color: var(--gray-500); text-transform: uppercase;
          letter-spacing: 0.5px; margin-bottom: 8px;
        }
        .drv-textarea {
          width: 100%; min-height: 100px;
          padding: 14px 16px;
          border: 2px solid var(--gray-200);
          border-radius: var(--radius-sm);
          font-family: var(--font-body);
          font-size: 17px; color: var(--gray-900);
          resize: vertical;
        }
        .drv-textarea:focus { outline: none; border-color: var(--blue-700); }

        /* ── MODAL ACTIONS ────────────────────────────────────────── */
        .drv-modal-actions {
          margin-top: 20px;
          display: flex; flex-direction: column; gap: 10px;
        }
        .drv-btn--cancel {
          background: var(--gray-100); color: var(--gray-700);
          border: none;
        }

        /* ── HIDDEN FILE INPUT ────────────────────────────────────── */
        .drv-hidden { display: none; }
      `}</style>

      <div className="drv-page">
        {/* ── Header ──────────────────────────────────────────────── */}
        <div className="drv-header">
          <div className="drv-greeting">My Deliveries</div>
          <div className="drv-date">
            {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
          </div>
          {totalCount > 0 && (
            <>
              <div className="drv-progress-bar">
                <div className="drv-progress-fill" style={{ width: `${totalCount > 0 ? (completedCount / totalCount) * 100 : 0}%` }} />
              </div>
              <div className="drv-progress-label">
                {completedCount} of {totalCount} stop{totalCount !== 1 ? 's' : ''} complete
              </div>
            </>
          )}
        </div>

        {/* ── Loading ─────────────────────────────────────────────── */}
        {loading && (
          <div className="drv-loading">
            <div className="drv-spinner" />
            <div style={{ fontSize: 17, color: 'var(--gray-500)' }}>Loading your deliveries…</div>
          </div>
        )}

        {/* ── Error ───────────────────────────────────────────────── */}
        {!loading && error && (
          <div className="drv-empty">
            <div className="drv-empty-icon">⚠️</div>
            <div className="drv-empty-title drv-error-text">Something went wrong</div>
            <div className="drv-empty-text">{error}</div>
            <button className="drv-refresh-btn" onClick={() => { setLoading(true); fetchDrops(); }}>
              Try Again
            </button>
          </div>
        )}

        {/* ── Empty state ─────────────────────────────────────────── */}
        {!loading && !error && drops.length === 0 && (
          <div className="drv-empty">
            <div className="drv-empty-icon">🚚</div>
            <div className="drv-empty-title">No deliveries today</div>
            <div className="drv-empty-text">You're all set! Check back later for new assignments.</div>
            <button className="drv-refresh-btn" onClick={() => { setLoading(true); fetchDrops(); }}>
              Refresh
            </button>
          </div>
        )}

        {/* ── Drop Cards ──────────────────────────────────────────── */}
        {!loading && drops.map(drop => {
          const dropStatus = getDropStatus(drop);
          const isExpanded = expandedDrop === drop.drop_id;
          const cfg = STATUS_CONFIG[dropStatus] || STATUS_CONFIG.assigned;
          const isDone = dropStatus === 'delivered' || dropStatus === 'cancelled';
          const isException = dropStatus === 'exception';

          return (
            <div
              key={drop.drop_id}
              className={`drv-card ${!isDone && !isException ? 'drv-card--active' : ''} ${isDone ? 'drv-card--done' : ''} ${isException ? 'drv-card--exception' : ''}`}
            >
              {/* Card header — tap to expand/collapse */}
              <div className="drv-card-header" onClick={() => setExpandedDrop(isExpanded ? null : drop.drop_id)}>
                <div className="drv-card-status-dot" style={{ background: cfg.color }} />
                <div className="drv-card-info">
                  <div className="drv-customer-name">{drop.customer_name}</div>
                  <div className="drv-card-subtitle">
                    {drop.loads.length} load{drop.loads.length !== 1 ? 's' : ''}
                    {drop.address ? ` · ${drop.address.city}` : ''}
                  </div>
                </div>
                <div className="drv-card-badge" style={{ color: cfg.color, background: cfg.bg }}>
                  {cfg.label}
                </div>
                <div className={`drv-chevron ${isExpanded ? 'drv-chevron--open' : ''}`}>▼</div>
              </div>

              {/* Card body — expanded */}
              <div className={`drv-card-body ${isExpanded ? 'drv-card-body--open' : ''}`}>
                <div className="drv-card-content">

                  {/* Address — tap to navigate */}
                  {drop.address && (
                    <a href={getGoogleMapsUrl(drop.address)} target="_blank" rel="noopener noreferrer" className="drv-address-btn">
                      <span className="drv-address-icon">🗺️</span>
                      <span className="drv-address-text">
                        <span className="drv-address-label">TAP TO NAVIGATE</span>
                        <br />
                        {formatAddress(drop.address)}
                      </span>
                    </a>
                  )}

                  {/* Notify Customer — right under address, visible context */}
                  {!isDone && !isException && (
                    <div style={{ marginTop: 12 }}>
                      {drop.notify_sent ? (
                        <button className="drv-btn drv-btn--disabled-sent" disabled>
                          <span className="drv-btn-icon">✅</span>
                          Customer Notified
                        </button>
                      ) : (
                        <button
                          className="drv-btn drv-btn--notify"
                          disabled={actionLoading === `notify-${drop.drop_id}`}
                          onClick={() => notifyCustomer(drop.drop_id)}
                        >
                          <span className="drv-btn-icon">📱</span>
                          {actionLoading === `notify-${drop.drop_id}` ? 'Sending…' : 'Notify Customer — Send SMS'}
                        </button>
                      )}
                    </div>
                  )}

                  {/* Notes */}
                  {drop.notes && (
                    <div className="drv-notes">
                      <div className="drv-notes-label">📋 Delivery Notes</div>
                      {drop.notes}
                    </div>
                  )}

                  {/* Materials */}
                  <div className="drv-materials-label">Materials</div>
                  {drop.loads.map(load => {
                    const isActive = load.status === 'assigned' || load.status === 'loaded_leaving';
                    const lCfg = STATUS_CONFIG[load.status] || STATUS_CONFIG.assigned;
                    return (
                      <div key={load.id} className="drv-material-row">
                        <span className="drv-material-icon">📦</span>
                        <div className="drv-material-info">
                          <div className="drv-material-name">{load.material}</div>
                          <div className="drv-material-qty">{load.qty} {load.unit}{load.qty !== 1 ? 's' : ''}</div>
                          {load.pod_photo_url && (
                            <div className="drv-photo-indicator drv-photo-indicator--has">📸 Photo taken</div>
                          )}
                          {!load.pod_photo_url && isActive && (
                            <div className="drv-photo-indicator drv-photo-indicator--needs">📷 No photo yet</div>
                          )}
                        </div>
                        {!isActive && (
                          <span className="drv-material-status" style={{ color: lCfg.color, background: lCfg.bg }}>
                            {lCfg.label}
                          </span>
                        )}
                      </div>
                    );
                  })}

                  {/* ── Action Buttons ──────────────────────────────── */}
                  <div className="drv-actions">

                    {/* For each active load: Photo + Mark Delivered */}
                    {drop.loads.filter(l => l.status === 'assigned' || l.status === 'loaded_leaving').map(load => (
                      <div key={`actions-${load.id}`}>
                        {drop.loads.filter(l => l.status === 'assigned' || l.status === 'loaded_leaving').length > 1 && (
                          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--gray-500)', marginBottom: 6, marginTop: 4 }}>
                            {load.material}
                          </div>
                        )}
                        <div className="drv-btn-row">
                          <button
                            className="drv-btn drv-btn--camera"
                            disabled={actionLoading === load.id}
                            onClick={() => openCamera(load.id, 'pod')}
                          >
                            <span className="drv-btn-icon">📸</span>
                            {load.pod_photo_url ? 'Retake' : 'Photo'}
                          </button>
                          <button
                            className="drv-btn drv-btn--primary"
                            disabled={actionLoading === load.id}
                            onClick={() => markDelivered(load.id)}
                          >
                            <span className="drv-btn-icon">✓</span>
                            {actionLoading === load.id ? '…' : 'Delivered'}
                          </button>
                        </div>
                        {!load.pod_photo_url && (
                          <div style={{ textAlign: 'center', fontSize: 14, color: 'var(--amber-700)', marginTop: 4, fontWeight: 600 }}>
                            💡 Taking a photo is recommended
                          </div>
                        )}
                      </div>
                    ))}

                    {/* Out of Stock — per load, sends back to dispatch */}
                    {drop.loads.filter(l => l.status === 'assigned' || l.status === 'loaded_leaving').map(load => (
                      <button
                        key={`oos-${load.id}`}
                        className="drv-btn drv-btn--oos"
                        disabled={actionLoading === load.id}
                        onClick={() => setOosConfirm({ loadId: load.id, material: load.material })}
                      >
                        <span className="drv-btn-icon">📦</span>
                        {drop.loads.filter(l => l.status === 'assigned' || l.status === 'loaded_leaving').length > 1
                          ? `Out of Stock — ${load.material}`
                          : 'Out of Stock — Return to Dispatch'}
                      </button>
                    ))}

                    {/* Report Problem — always visible for active loads */}
                    {drop.loads.some(l => l.status === 'assigned' || l.status === 'loaded_leaving') && (
                      <button
                        className="drv-btn drv-btn--danger"
                        onClick={() => {
                          const activeLoad = drop.loads.find(l => l.status === 'assigned' || l.status === 'loaded_leaving');
                          if (activeLoad) setExceptionModal({ loadId: activeLoad.id, dropId: drop.drop_id });
                        }}
                      >
                        <span className="drv-btn-icon">🚨</span>
                        Report a Problem
                      </button>
                    )}

                    {/* Done state */}
                    {isDone && (
                      <div style={{ textAlign: 'center', padding: '12px 0', fontSize: 17, fontWeight: 700, color: 'var(--green-700)' }}>
                        ✅ All done!
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Out of Stock Confirmation ───────────────────────────────── */}
      {oosConfirm && (
        <div className="drv-overlay" onClick={e => { if (e.target === e.currentTarget) setOosConfirm(null); }}>
          <div className="drv-modal">
            <div style={{ textAlign: 'center', fontSize: 56, marginBottom: 12 }}>📦</div>
            <div className="drv-modal-title" style={{ textAlign: 'center' }}>Out of Stock?</div>
            <div className="drv-modal-subtitle" style={{ textAlign: 'center', fontSize: 18, lineHeight: 1.5 }}>
              This will return <strong>{oosConfirm.material}</strong> to dispatch for rescheduling.
            </div>
            <div className="drv-modal-actions">
              <button
                className="drv-btn drv-btn--primary"
                style={{ background: 'linear-gradient(135deg, #d97706, #b45309)', boxShadow: '0 4px 12px rgba(217,119,6,0.3)' }}
                disabled={actionLoading === oosConfirm.loadId}
                onClick={submitOutOfStock}
              >
                <span className="drv-btn-icon">✓</span>
                {actionLoading === oosConfirm.loadId ? 'Submitting…' : 'Yes — Return to Dispatch'}
              </button>
              <button
                className="drv-btn drv-btn--cancel"
                onClick={() => setOosConfirm(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Exception Modal ─────────────────────────────────────────── */}
      {exceptionModal && (
        <div className="drv-overlay" onClick={e => { if (e.target === e.currentTarget) { setExceptionModal(null); setExceptionReason(''); setExceptionNotes(''); } }}>
          <div className="drv-modal">
            <div className="drv-modal-title">Report a Problem</div>
            <div className="drv-modal-subtitle">What happened?</div>

            <div className="drv-reason-grid">
              {Object.entries(EXCEPTION_REASONS).map(([code, { label, icon }]) => (
                <button
                  key={code}
                  className={`drv-reason-btn ${exceptionReason === code ? 'drv-reason-btn--selected' : ''}`}
                  onClick={() => setExceptionReason(code)}
                >
                  <span className="drv-reason-icon">{icon}</span>
                  {label}
                </button>
              ))}
            </div>

            <div className="drv-textarea-label">Additional Details (Optional)</div>
            <textarea
              className="drv-textarea"
              placeholder="Describe what happened…"
              value={exceptionNotes}
              onChange={e => setExceptionNotes(e.target.value)}
            />

            {/* Exception photo */}
            <div style={{ marginTop: 16 }}>
              <button
                className="drv-btn drv-btn--camera"
                style={{ padding: '14px 24px', fontSize: 16 }}
                onClick={() => openCamera(exceptionModal.loadId, 'exception')}
              >
                <span className="drv-btn-icon">📸</span>
                Take Exception Photo
              </button>
            </div>

            <div className="drv-modal-actions">
              <button
                className="drv-btn drv-btn--primary"
                style={{ background: 'linear-gradient(135deg, #dc2626, #b91c1c)', boxShadow: '0 4px 12px rgba(220,38,38,0.3)' }}
                disabled={!exceptionReason || actionLoading === exceptionModal.loadId}
                onClick={submitException}
              >
                <span className="drv-btn-icon">🚨</span>
                {actionLoading === exceptionModal.loadId ? 'Submitting…' : 'Submit Exception Report'}
              </button>
              <button
                className="drv-btn drv-btn--cancel"
                onClick={() => { setExceptionModal(null); setExceptionReason(''); setExceptionNotes(''); }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Hidden file input for camera ─────────────────────────────── */}
      <input
        ref={photoInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="drv-hidden"
        onChange={handlePhotoCapture}
      />

      {/* ── Toast ────────────────────────────────────────────────────── */}
      {toast && (
        <div className={`drv-toast drv-toast--${toast.type}`}>
          {toast.msg}
        </div>
      )}
    </>
  );
}
