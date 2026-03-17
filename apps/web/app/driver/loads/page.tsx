'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { api, ApiError, clearSession } from '../../lib/auth';

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
  condition_photo_url: string | null;
  condition_notes: string | null;
};

type DropItem = {
  drop_id: string;
  customer_name: string;
  customer_phone: string | null;
  address: { line1: string; city: string; state: string; postal_code: string } | null;
  notes: string | null;
  notify_sent: boolean;
  scheduled_window: string | null;
  is_priority?: boolean;
  drop_photos: string[];
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

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  assigned:       { label: 'Ready',       color: '#2d6a2e', bg: '#e8f5e9' },
  loaded_leaving: { label: 'Ready',       color: '#2d6a2e', bg: '#e8f5e9' },
  delivered:      { label: 'Delivered',    color: '#1b5e20', bg: '#c8e6c9' },
  exception:      { label: 'Exception',    color: '#c62828', bg: '#ffebee' },
  cancelled:      { label: 'Cancelled',    color: '#616161', bg: '#f5f5f5' },
};

/* ═══════════════════════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getDropStatus(drop: DropItem): string {
  const statuses = drop.loads.map(l => l.status);
  if (statuses.every(s => s === 'delivered')) return 'delivered';
  if (statuses.every(s => s === 'cancelled')) return 'cancelled';
  if (statuses.some(s => s === 'exception')) return 'exception';
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
  const [drops, setDrops] = useState<DropItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedDrop, setExpandedDrop] = useState<string | null>(null);

  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);

  const [exceptionModal, setExceptionModal] = useState<{ loadId: string; dropId: string } | null>(null);
  const [exceptionReason, setExceptionReason] = useState('');
  const [exceptionNotes, setExceptionNotes] = useState('');

  const [oosConfirm, setOosConfirm] = useState<{ loadId: string; material: string } | null>(null);

  const [photoTarget, setPhotoTarget] = useState<{ loadId: string; type: 'pod' | 'exception' | 'condition' } | null>(null);
  const [conditionModal, setConditionModal] = useState<{ loadId: string } | null>(null);
  const [conditionNotes, setConditionNotes] = useState('');
  const [conditionSaving, setConditionSaving] = useState(false);
  // After a condition photo uploads, holds the loadId so we can optionally add a note
  const [conditionPhotoTaken, setConditionPhotoTaken] = useState<string | null>(null);
  const [conditionPhotoNote, setConditionPhotoNote] = useState('');
  // After a note-only save, holds the loadId briefly to offer "add photo too?"
  const [conditionNoteLoadId, setConditionNoteLoadId] = useState<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  // ── Data fetch ─────────────────────────────────────────────────────────
  const fetchDrops = useCallback(async () => {
    try {
      const data = await api(`/driver/drops?day=${todayStr()}`);
      const fetched = data.drops || [];
      setDrops(fetched);
      setError('');
      return fetched;
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.code === 'auth_expired' || apiErr.status === 401) {
        clearSession();
        window.location.href = '/login';
        return;
      }
      setError('Could not load deliveries. Tap Refresh to try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDrops();
    const interval = setInterval(fetchDrops, 30000);
    return () => clearInterval(interval);
  }, [fetchDrops]);

  useEffect(() => {
    if (drops.length > 0 && !expandedDrop) {
      const active = drops.find(d => getDropStatus(d) === 'assigned');
      if (active) setExpandedDrop(active.drop_id);
    }
  }, [drops, expandedDrop]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // ── Actions ────────────────────────────────────────────────────────────
  const showToast = (msg: string, type: 'success' | 'error' = 'success') => setToast({ msg, type });

  const markDelivered = (loadId: string) => {
    setPhotoTarget({ loadId, type: 'pod' });
    setTimeout(() => photoInputRef.current?.click(), 100);
  };

  const notifyCustomer = async (dropId: string) => {
    setActionLoading(`notify-${dropId}`);
    try {
      const result = await api(`/driver/drops/${dropId}/notify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      showToast(result.already_sent ? 'Customer was already notified.' : 'Customer notified — SMS sent!');
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'exception', reason_code: exceptionReason, notes: exceptionNotes || null }),
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'exception', reason_code: 'OUT_OF_STOCK', notes: `Out of stock: ${oosConfirm.material}` }),
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

   const submitConditionNotes = async () => {
    if (!conditionModal) return;
    setConditionSaving(true);
    try {
      if (conditionNotes.trim()) {
        await api(`/driver/loads/${conditionModal.loadId}/condition-notes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ notes: conditionNotes.trim() }),
        });
      }
      const savedLoadId = conditionModal.loadId;
      setConditionModal(null);
      setConditionNotes('');
      await fetchDrops();
      // Offer "add photo too?" briefly after a note-only save
      setConditionNoteLoadId(savedLoadId);
    } catch {
      showToast('Failed to save. Try again.', 'error');
    } finally {
      setConditionSaving(false);
    }
  };

  const submitConditionPhotoNote = async () => {
    if (!conditionPhotoTaken) return;
    setConditionSaving(true);
    try {
      if (conditionPhotoNote.trim()) {
        await api(`/driver/loads/${conditionPhotoTaken}/condition-notes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ notes: conditionPhotoNote.trim() }),
        });
      }
      showToast('Site conditions documented.');
      setConditionPhotoTaken(null);
      setConditionPhotoNote('');
      await fetchDrops();
    } catch {
      showToast('Failed to save note. Try again.', 'error');
    } finally {
      setConditionSaving(false);
    }
  };

  const openConditionCamera = (loadId: string) => {
    setPhotoTarget({ loadId, type: 'condition' });
    setTimeout(() => photoInputRef.current?.click(), 100);
  };

  const handlePhotoCapture = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!photoTarget || !e.target.files?.[0]) return;
    const file = e.target.files[0];
    setActionLoading(photoTarget.loadId);
    try {
      const entityType = photoTarget.type === 'pod' ? 'POD_PHOTO'
        : photoTarget.type === 'exception' ? 'EXCEPTION_PHOTO'
        : 'CONDITION_PHOTO';

      const presign = await api('/uploads/presign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity_type: entityType, entity_id: photoTarget.loadId, content_type: 'image/jpeg' }),
      });

      await fetch(presign.upload_url, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': 'image/jpeg' },
      });

      await api('/uploads/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity_type: entityType, entity_id: photoTarget.loadId, object_key: presign.object_key }),
      });

      if (photoTarget.type === 'pod') {
        await api(`/driver/loads/${photoTarget.loadId}/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'delivered' }),
        });
        showToast('Photo saved & delivery confirmed!');
        // Immediately collapse this card
        setExpandedDrop(null);
        setPhotoTarget(null);
        await fetchDrops();
        // After fetch, open the next active drop
        setDrops(prev => {
          const sorted = [...prev].sort((a, b) => {
            const doneA = ['delivered', 'cancelled'].includes(getDropStatus(a));
            const doneB = ['delivered', 'cancelled'].includes(getDropStatus(b));
            if (doneA !== doneB) return doneA ? 1 : -1;
            if (a.is_priority !== b.is_priority) return a.is_priority ? -1 : 1;
            return 0;
          });
          const next = sorted.find(d => !['delivered', 'cancelled'].includes(getDropStatus(d)));
          if (next) setExpandedDrop(next.drop_id);
          return prev;
        });
        return;
      } else if (photoTarget.type === 'condition') {
        // Don't collapse yet — stay open so driver can optionally add a note
        const capturedLoadId = photoTarget.loadId;
        setPhotoTarget(null);
        await fetchDrops();
        setConditionPhotoTaken(capturedLoadId);
        setConditionPhotoNote('');
        return;
      } else {
        showToast('Exception photo saved.');
      }

      setPhotoTarget(null);
      await fetchDrops();
    } catch {
      showToast('Failed to upload photo. Try again.', 'error');
    } finally {
      setActionLoading(null);
      if (photoInputRef.current) photoInputRef.current.value = '';
    }
  };

  const openCamera = (loadId: string, type: 'pod' | 'exception') => {
    setPhotoTarget({ loadId, type });
    setTimeout(() => photoInputRef.current?.click(), 100);
  };

  const completedCount = drops.filter(d => getDropStatus(d) === 'delivered').length;
  const totalCount = drops.length;
  const priorityCount = drops.filter(d => d.is_priority && getDropStatus(d) !== 'delivered' && getDropStatus(d) !== 'cancelled').length;

  return (
    <>
      <style>{STYLES}</style>

      <div className="drv-page">
        {/* ── Header ── */}
        <div className="drv-header">
          <div className="drv-header-row">
            <div>
              <div className="drv-title">Today&apos;s Deliveries</div>
              <div className="drv-date">{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</div>
            </div>
            <button className="drv-refresh" onClick={() => { setLoading(true); fetchDrops(); }}>↻</button>
          </div>
          {totalCount > 0 && (
            <div className="drv-progress">
              <div className="drv-progress-track"><div className="drv-progress-bar" style={{ width: `${(completedCount / totalCount) * 100}%` }} /></div>
              <div className="drv-progress-text">
                {completedCount} of {totalCount} stop{totalCount !== 1 ? 's' : ''} complete
                {priorityCount > 0 && <span className="drv-priority-count"> · ⚡ {priorityCount} priority</span>}
              </div>
            </div>
          )}
        </div>

        {/* ── Loading ── */}
        {loading && <div className="drv-center"><div className="drv-spinner" /><p className="drv-muted">Loading deliveries…</p></div>}

        {/* ── Error ── */}
        {!loading && error && (
          <div className="drv-center">
            <div className="drv-big-icon">⚠️</div>
            <div className="drv-center-title">Something went wrong</div>
            <p className="drv-muted">{error}</p>
            <button className="drv-btn drv-btn--green" style={{ marginTop: 16, maxWidth: 200 }} onClick={() => { setLoading(true); fetchDrops(); }}>Refresh</button>
          </div>
        )}

        {/* ── Empty ── */}
        {!loading && !error && drops.length === 0 && (
          <div className="drv-center">
            <div className="drv-big-icon">🚚</div>
            <div className="drv-center-title">No deliveries today</div>
            <p className="drv-muted">You&apos;re all set! Check back later.</p>
            <button className="drv-btn drv-btn--green" style={{ marginTop: 16, maxWidth: 200 }} onClick={() => { setLoading(true); fetchDrops(); }}>Refresh</button>
          </div>
        )}

        {/* ── Cards ── */}
      {[...drops].sort((a, b) => {
        const doneA = ['delivered', 'cancelled', 'exception'].includes(getDropStatus(a));
        const doneB = ['delivered', 'cancelled', 'exception'].includes(getDropStatus(b));
        if (doneA === doneB) return 0;
        return doneA ? 1 : -1;
      }).map(drop => {
          const dropStatus = getDropStatus(drop);
          const isExpanded = expandedDrop === drop.drop_id;
          const cfg = STATUS_CONFIG[dropStatus] || STATUS_CONFIG.assigned;
          const isDone = dropStatus === 'delivered' || dropStatus === 'cancelled';
          const isException = dropStatus === 'exception';
          const isPriority = drop.is_priority && !isDone;
          const activeLoads = drop.loads.filter(l => l.status === 'assigned' || l.status === 'loaded_leaving');

          return (
            <div key={drop.drop_id} className={`drv-card ${isDone ? 'drv-card--done' : ''} ${isException ? 'drv-card--exc' : ''} ${isPriority ? 'drv-card--priority' : ''}`}>
              {/* Priority banner */}
              {isPriority && (
                <div className="drv-priority-strip">⚡ PRIORITY DELIVERY</div>
              )}

              {/* Header */}
              <div className="drv-card-hd" onClick={() => setExpandedDrop(isExpanded ? null : drop.drop_id)}>
                <div className="drv-dot" style={{ background: isPriority ? '#2563eb' : cfg.color }} />
                <div className="drv-card-info">
                  <div className="drv-name">{drop.customer_name}</div>
                  <div className="drv-sub">
                    {drop.loads.length} item{drop.loads.length !== 1 ? 's' : ''}
                    {drop.address ? ` · ${drop.address.city}` : ''}
                    {drop.is_priority && !isPriority ? ' · Priority ✓' : ''}
                  </div>
                </div>
                {isPriority ? (
                  <div className="drv-badge" style={{ color: '#1e40af', background: '#dbeafe' }}>⚡ Priority</div>
                ) : (
                  <div className="drv-badge" style={{ color: cfg.color, background: cfg.bg }}>{cfg.label}</div>
                )}
                <div className={`drv-chev ${isExpanded ? 'drv-chev--open' : ''}`}>▾</div>
              </div>

              {/* Body */}
              <div className={`drv-body ${isExpanded ? 'drv-body--open' : ''}`}>
                <div className="drv-inner">
               
               
                  {/* ① Load Manifest */}
                  <div className="drv-manifest">
                    <div className={`drv-manifest-hd ${isPriority ? 'drv-manifest-hd--priority' : ''}`}>
                      {isPriority ? '⚡ PRIORITY LOAD' : '📋 LOAD MANIFEST'}
                    </div>
                    {drop.loads.map((load, idx) => {
                      const isActive = load.status === 'assigned' || load.status === 'loaded_leaving';
                      const lCfg = STATUS_CONFIG[load.status] || STATUS_CONFIG.assigned;
                      return (
                        <div key={load.id} className={`drv-manifest-row ${idx < drop.loads.length - 1 ? 'drv-manifest-row--border' : ''}`}>
                          <div className={`drv-manifest-qty-line ${isPriority ? 'drv-manifest-qty-line--priority' : ''}`}>{load.qty} {load.unit}{load.qty !== 1 ? 's' : ''}</div>
                          <div className="drv-manifest-material">{load.material}</div>
                          {!isActive && <span className="drv-manifest-badge" style={{ color: lCfg.color, background: lCfg.bg }}>{lCfg.label}</span>}
                        </div>
                      );
                    })}
                  </div>

                  {/* ② Drop photo */}
                  {drop.drop_photos && drop.drop_photos.length > 0 && (
                    <div style={{ marginTop: 22 }}>
                      <div className="drv-label">Drop Location</div>
                      <div className="drv-photo-frame" onClick={() => setLightboxUrl(drop.drop_photos[0])}>
                        <img src={drop.drop_photos[0]} alt="Drop location" className="drv-photo-img" />
                        <div className="drv-photo-overlay">Tap to enlarge</div>
                      </div>
                    </div>
                  )}

                  {/* ③ Notes */}
                  {drop.notes && (
                    <div className="drv-notes" style={{ marginTop: 22 }}>
                      <div className="drv-notes-hd">Delivery Notes</div>
                      <div className="drv-notes-body">{drop.notes}</div>
                    </div>
                  )}

                  {/* ⑤ Notify */}
                  {!isDone && !isException && (
                    <div style={{ marginTop: 22 }}>
                      {drop.notify_sent ? (
                        <div className="drv-notified">✅ Customer has been notified</div>
                      ) : (
                        <button
                          className="drv-btn drv-btn--amber"
                          disabled={actionLoading === `notify-${drop.drop_id}`}
                          onClick={() => notifyCustomer(drop.drop_id)}
                        >
                          <span className="drv-btn-ic">📱</span>
                          {actionLoading === `notify-${drop.drop_id}` ? 'Sending…' : 'Notify Customer'}
                        </button>
                      )}
                    </div>
                  )}
                   
                  {/* ④ Navigate */}
                  {drop.address && (
                    <a href={getGoogleMapsUrl(drop.address)} target="_blank" rel="noopener noreferrer" className="drv-nav" style={{ marginTop: 22 }}>
                      <div className="drv-nav-icon">🗺️</div>
                      <div className="drv-nav-info">
                        <div className="drv-nav-hint">Tap to Navigate</div>
                        <div className="drv-nav-addr">{formatAddress(drop.address)}</div>
                      </div>
                      <div className="drv-nav-go">→</div>
                    </a>
                  )}

                  {/* ① Condition Documentation */}
                  {drop.loads.some(l => l.status === 'assigned' || l.status === 'loaded_leaving') && (
                    <div style={{ margin: '0 -18px', borderTop: '1.5px solid var(--g2)', marginTop: 22 }}>
                      {conditionPhotoTaken === drop.loads[0].id ? (
                        /* ── Photo captured — optionally add a note before closing ── */
                        <div style={{ padding: '14px 18px', background: '#f0fdf4', borderBottom: '1.5px solid #bbf7d0' }}>
                          <div style={{ fontFamily: 'var(--fh)', fontSize: 12, fontWeight: 700, color: '#15803d', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8 }}>
                            📸 Photo Saved — Add a Note?
                          </div>
                          <div style={{ fontSize: 14, color: '#166534', marginBottom: 12, lineHeight: 1.4 }}>
                            Describe the condition in more detail, or tap Done to finish.
                          </div>
                          <textarea
                            style={{
                              width: '100%', boxSizing: 'border-box', padding: '12px 14px',
                              fontSize: 15, lineHeight: 1.5, border: '1.5px solid #86efac',
                              borderRadius: 10, background: '#fff', color: '#1a1a1a',
                              fontFamily: 'var(--ff)', resize: 'none', marginBottom: 10,
                              WebkitAppearance: 'none',
                            }}
                            placeholder="e.g. Cracked driveway near the entrance, low-hanging branch over gate…"
                            value={conditionPhotoNote}
                            onChange={e => setConditionPhotoNote(e.target.value)}
                            rows={3}
                            autoFocus
                          />
                          <button
                            className="drv-btn drv-btn--green"
                            style={{ width: '100%', padding: '14px', fontSize: 15 }}
                            onClick={submitConditionPhotoNote}
                            disabled={conditionSaving}
                          >
                            {conditionSaving ? 'Saving…' : 'Done'}
                          </button>
                        </div>
                      ) : conditionNoteLoadId === drop.loads[0].id ? (
                        /* ── Note saved — offer to add a photo too ── */
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 18px', background: 'var(--grn0)' }}>
                          <span style={{ fontSize: 20 }}>✅</span>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontFamily: 'var(--fh)', fontSize: 13, fontWeight: 700, color: 'var(--grn7)' }}>Note saved</div>
                            <div style={{ fontSize: 13, color: 'var(--g5)', marginTop: 2 }}>Want to add a photo too?</div>
                          </div>
                          <button
                            className="drv-btn drv-btn--outline"
                            style={{ fontSize: 13, padding: '8px 14px', whiteSpace: 'nowrap' }}
                            onClick={() => { setConditionNoteLoadId(null); openConditionCamera(drop.loads[0].id); }}
                          >
                            📸 Add Photo
                          </button>
                          <button
                            style={{ background: 'none', border: 'none', fontSize: 18, color: 'var(--g4)', padding: '4px 6px', cursor: 'pointer' }}
                            onClick={() => setConditionNoteLoadId(null)}
                          >
                            ✕
                          </button>
                        </div>
                      ) : drop.loads.every(l => l.condition_photo_url || l.condition_notes) ? (
                        /* ── All loads documented ── */
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 18px', background: 'var(--grn0)' }}>
                          <span style={{ fontSize: 20 }}>✅</span>
                          <div>
                            <div style={{ fontFamily: 'var(--fh)', fontSize: 13, fontWeight: 700, color: 'var(--grn7)' }}>Site conditions documented</div>
                            {drop.loads[0].condition_notes && (
                              <div style={{ fontSize: 13, color: 'var(--g5)', marginTop: 2 }}>{drop.loads[0].condition_notes}</div>
                            )}
                          </div>
                        </div>
                      ) : (
                        /* ── Default — choose how to document ── */
                        <div style={{ padding: '14px 18px', background: '#fffbeb', borderBottom: '1.5px solid #fde68a' }}>
                          <div style={{ fontFamily: 'var(--fh)', fontSize: 12, fontWeight: 700, color: '#92400e', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8 }}>
                            📋 Document Site Conditions
                          </div>
                          <div style={{ fontSize: 14, color: '#78350f', marginBottom: 12, lineHeight: 1.4 }}>
                            Note any pre-existing damage, hazards, or access issues before delivering.
                          </div>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button
                              className="drv-btn drv-btn--outline"
                              style={{ flex: 1, padding: '12px 10px', fontSize: 14 }}
                              onClick={() => openConditionCamera(drop.loads[0].id)}
                              disabled={!!actionLoading}
                            >
                              📸 Take Photo
                            </button>
                            <button
                              className="drv-btn drv-btn--outline"
                              style={{ flex: 1, padding: '12px 10px', fontSize: 14 }}
                              onClick={() => { setConditionModal({ loadId: drop.loads[0].id }); setConditionNotes(''); }}
                              disabled={!!actionLoading}
                            >
                              📝 Add Note
                            </button>
                            <button
                              className="drv-btn drv-btn--green"
                              style={{ flex: 1, padding: '12px 10px', fontSize: 14 }}
                              onClick={async () => {
                                try {
                                  await api(`/driver/loads/${drop.loads[0].id}/condition-notes`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ notes: 'No issues noted.' }),
                                  });
                                  showToast('No issues noted.');
                                  await fetchDrops();
                                } catch { showToast('Failed. Try again.', 'error'); }
                              }}
                              disabled={!!actionLoading}
                            >
                              ✓ No Issues
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                   
                  {/* ⑥ Primary action */}
                  {activeLoads.length > 0 && (
                    <div className="drv-actions">
                      {activeLoads.map(load => (
                        <div key={`a-${load.id}`} className="drv-act-group">
                          {activeLoads.length > 1 && <div className="drv-act-label">{load.material}</div>}
                          <button
                             className="drv-btn drv-btn--green"
                             disabled={actionLoading === load.id || !drop.loads.every(l => l.condition_photo_url || l.condition_notes)}
                             onClick={() => markDelivered(load.id)}
                          >
                            <span className="drv-btn-ic">📸</span>
                            {actionLoading === load.id ? 'Saving…' : 'Mark Delivered — Take Photo'}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* ⑦ Divider + secondary */}
                  {activeLoads.length > 0 && (
                    <>
                      <div className="drv-sep">
                        <div className="drv-sep-line" />
                        <span className="drv-sep-text">Other Actions</span>
                        <div className="drv-sep-line" />
                      </div>
                      <div className="drv-secondary">
                        {activeLoads.map(load => (
                          <button
                            key={`oos-${load.id}`}
                            className="drv-btn-sec drv-btn-sec--amber"
                            disabled={actionLoading === load.id}
                            onClick={() => setOosConfirm({ loadId: load.id, material: load.material })}
                          >
                            📦 {activeLoads.length > 1 ? `Out of Stock — ${load.material}` : 'Out of Stock — Return to Dispatch'}
                          </button>
                        ))}
                        <button
                          className="drv-btn-sec drv-btn-sec--red"
                          onClick={() => {
                            const l = activeLoads[0];
                            if (l) setExceptionModal({ loadId: l.id, dropId: drop.drop_id });
                          }}
                        >
                          🚨 Report a Problem
                        </button>
                      </div>
                    </>
                  )}

                  {isDone && <div className="drv-banner drv-banner--green">✅ Delivery complete</div>}
                  {isException && <div className="drv-banner drv-banner--red">⚠️ Exception reported</div>}
                </div>
              </div>
            </div>
          );
        })}

        <div style={{ height: 40 }} />
      </div>

      {/* ── Lightbox ── */}
      {lightboxUrl && (
        <div className="drv-overlay drv-overlay--center" onClick={() => setLightboxUrl(null)}>
          <div className="drv-lb">
            <img src={lightboxUrl} alt="Drop location" className="drv-lb-img" />
            <button className="drv-lb-x" onClick={() => setLightboxUrl(null)}>✕</button>
          </div>
        </div>
      )}

      {/* ── OOS Confirm ── */}
      {oosConfirm && (
        <div className="drv-overlay" onClick={e => { if (e.target === e.currentTarget) setOosConfirm(null); }}>
          <div className="drv-modal">
            <div className="drv-modal-ic">📦</div>
            <div className="drv-modal-h">Out of Stock?</div>
            <div className="drv-modal-p">This will return <strong>{oosConfirm.material}</strong> to dispatch for rescheduling.</div>
            <div className="drv-modal-btns">
              <button
                className="drv-btn drv-btn--amber"
                disabled={actionLoading === oosConfirm.loadId}
                onClick={submitOutOfStock}
              >
                {actionLoading === oosConfirm.loadId ? 'Submitting…' : 'Yes — Return to Dispatch'}
              </button>
              <button className="drv-btn drv-btn--ghost" onClick={() => setOosConfirm(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Condition Notes Modal */}
              {conditionModal && (
                <div className="drv-overlay" onClick={() => setConditionModal(null)}>
                  <div className="drv-modal" onClick={e => e.stopPropagation()}>
                    <div className="drv-modal-ic">📋</div>
                    <div className="drv-modal-h">Document Site Conditions</div>
                    <div className="drv-modal-p">Describe any pre-existing damage, hazards, or access issues at this location.</div>
                    <textarea
                      className="drv-ta"
                      placeholder="e.g. Broken mailbox post, cracked driveway near entrance, low-hanging branch..."
                      value={conditionNotes}
                      onChange={e => setConditionNotes(e.target.value)}
                      rows={4}
                      autoFocus
                    />
                    <div className="drv-modal-btns">
                      <button className="drv-btn drv-btn--amber" onClick={submitConditionNotes} disabled={conditionSaving || !conditionNotes.trim()}>
                        {conditionSaving ? 'Saving…' : 'Save Note'}
                      </button>
                      <button className="drv-btn drv-btn--outline" onClick={() => setConditionModal(null)}>Cancel</button>
                    </div>
                  </div>
                </div>
              )}
      
      {/* ── Exception Modal ── */}
      {exceptionModal && (
        <div className="drv-overlay" onClick={e => { if (e.target === e.currentTarget) { setExceptionModal(null); setExceptionReason(''); setExceptionNotes(''); } }}>
          <div className="drv-modal">
            <div className="drv-modal-h" style={{ textAlign: 'left' }}>Report a Problem</div>
            <div className="drv-modal-p" style={{ textAlign: 'left' }}>Select the reason below:</div>
            <div className="drv-reason-grid">
              {Object.entries(EXCEPTION_REASONS).map(([code, { label, icon }]) => (
                <button
                  key={code}
                  className={`drv-reason ${exceptionReason === code ? 'drv-reason--on' : ''}`}
                  onClick={() => setExceptionReason(code)}
                >
                  <span className="drv-reason-ic">{icon}</span>
                  <span>{label}</span>
                </button>
              ))}
            </div>
            <div className="drv-field-lbl">Additional Details (Optional)</div>
            <textarea
              className="drv-ta"
              placeholder="Describe what happened…"
              value={exceptionNotes}
              onChange={e => setExceptionNotes(e.target.value)}
            />
            <button
              className="drv-btn drv-btn--outline"
              style={{ marginTop: 12 }}
              onClick={() => openCamera(exceptionModal.loadId, 'exception')}
            >
              <span className="drv-btn-ic">📸</span>
              Take Exception Photo
            </button>
            <div className="drv-modal-btns">
              <button
                className="drv-btn drv-btn--red"
                disabled={!exceptionReason || actionLoading === exceptionModal.loadId}
                onClick={submitException}
              >
                {actionLoading === exceptionModal.loadId ? 'Submitting…' : 'Submit Exception Report'}
              </button>
              <button
                className="drv-btn drv-btn--ghost"
                onClick={() => { setExceptionModal(null); setExceptionReason(''); setExceptionNotes(''); }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <input ref={photoInputRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={handlePhotoCapture} />

      {toast && <div className={`drv-toast ${toast.type === 'error' ? 'drv-toast--err' : ''}`}>{toast.msg}</div>}
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   STYLES
   ═══════════════════════════════════════════════════════════════════════════ */

const STYLES = `
  :root {
    --g9: #1a1a1a; --g7: #404040; --g5: #737373; --g4: #a3a3a3; --g2: #e5e5e5; --g1: #f5f5f5; --g0: #fafafa;
    --grn9: #14532d; --grn7: #15803d; --grn6: #16a34a; --grn5: #22c55e; --grn1: #dcfce7; --grn0: #f0fdf4;
    --amb7: #b45309; --amb6: #d97706; --amb1: #fef3c7; --amb0: #fffbeb;
    --red7: #b91c1c; --red6: #dc2626; --red1: #fee2e2;
    --teal7: #0f766e; --teal6: #0d9488; --teal1: #ccfbf1;
    --blu9: #1e3a5f; --blu7: #1d4ed8; --blu6: #2563eb; --blu5: #3b82f6; --blu1: #dbeafe; --blu0: #eff6ff;
    --r: 14px; --rs: 10px;
    --ff: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif;
    --fh: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
  }

  .drv-page { font-family: var(--ff); min-height: 100dvh; background: var(--g0); -webkit-tap-highlight-color: transparent; }

  /* Header */
  .drv-header { padding: 20px 20px 14px; background: #fff; border-bottom: 1px solid var(--g2); position: sticky; top: 0; z-index: 50; }
  .drv-header-row { display: flex; justify-content: space-between; align-items: flex-start; }
  .drv-title { font-family: var(--fh); font-size: 24px; font-weight: 800; color: var(--g9); }
  .drv-date { font-size: 15px; color: var(--g5); font-weight: 500; margin-top: 2px; }
  .drv-refresh { width: 44px; height: 44px; border-radius: 12px; border: 1px solid var(--g2); background: #fff; font-size: 22px; color: var(--g5); cursor: pointer; display: flex; align-items: center; justify-content: center; }
  .drv-refresh:active { background: var(--g1); }
  .drv-progress { margin-top: 14px; }
  .drv-progress-track { background: var(--g2); border-radius: 6px; height: 8px; overflow: hidden; }
  .drv-progress-bar { height: 100%; border-radius: 6px; background: var(--grn5); transition: width 0.5s ease; }
  .drv-progress-text { font-size: 14px; font-weight: 600; color: var(--g5); margin-top: 6px; }
  .drv-priority-count { color: var(--blu6); }

  /* Center states */
  .drv-center { text-align: center; padding: 60px 24px; }
  .drv-big-icon { font-size: 56px; margin-bottom: 12px; }
  .drv-center-title { font-family: var(--fh); font-size: 20px; font-weight: 700; color: var(--g7); margin-bottom: 6px; }
  .drv-muted { font-size: 16px; color: var(--g5); }
  .drv-spinner { width: 40px; height: 40px; border: 3px solid var(--g2); border-top-color: var(--grn6); border-radius: 50%; animation: spin .7s linear infinite; margin: 0 auto 14px; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Card */
  .drv-card { margin: 10px 14px; background: #fff; border-radius: var(--r); box-shadow: 0 1px 3px rgba(0,0,0,0.04); border: 1.5px solid var(--g2); overflow: hidden; }
  .drv-card--done { opacity: 0.55; border-color: var(--grn6); }
  .drv-card--exc { border-color: var(--red6); }
  .drv-card--priority { border-color: var(--blu5); box-shadow: 0 2px 8px rgba(37,99,235,0.12); }
  .drv-card-hd { padding: 16px 18px; display: flex; align-items: center; gap: 12px; cursor: pointer; user-select: none; }
  .drv-card-hd:active { background: var(--g0); }
  .drv-dot { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; }
  .drv-card-info { flex: 1; min-width: 0; }
  .drv-name { font-family: var(--fh); font-size: 19px; font-weight: 700; color: var(--g9); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .drv-sub { font-size: 14px; color: var(--g5); font-weight: 500; }
  .drv-badge { padding: 4px 10px; border-radius: 20px; font-family: var(--fh); font-size: 12px; font-weight: 700; white-space: nowrap; flex-shrink: 0; }
  .drv-chev { font-size: 18px; color: var(--g4); transition: transform .25s; flex-shrink: 0; }
  .drv-chev--open { transform: rotate(180deg); }
  .drv-body { max-height: 0; overflow: hidden; transition: max-height .35s ease; }
  .drv-body--open { max-height: 3000px; }
  .drv-inner { padding: 0 18px 24px; }

  /* Priority strip */
  .drv-priority-strip { background: linear-gradient(135deg, #1e40af, #2563eb); color: #fff; padding: 8px 18px; font-family: var(--fh); font-size: 13px; font-weight: 800; letter-spacing: .08em; text-align: center; }

  /* Labels */
  .drv-label { font-family: var(--fh); font-size: 12px; font-weight: 700; color: var(--g4); text-transform: uppercase; letter-spacing: .06em; margin: 16px 0 8px; }

  /* Load Manifest */
  .drv-manifest { margin: 0 -18px; border-bottom: 1.5px solid var(--g2); }
  .drv-manifest-hd { background: var(--grn9); color: #fff; padding: 14px 18px; font-family: var(--fh); font-size: 13px; font-weight: 800; letter-spacing: .08em; display: flex; align-items: center; gap: 8px; }
  .drv-manifest-hd--priority { background: linear-gradient(135deg, #1e3a5f, #1e40af); }
  .drv-manifest-row { display: flex; flex-direction: column; align-items: center; padding: 20px 18px; background: #fff; text-align: center; }
  .drv-manifest-row--border { border-bottom: 1px dashed var(--g2); }
  .drv-manifest-qty-line { font-family: var(--fh); font-size: 34px; font-weight: 800; color: var(--grn7); line-height: 1.1; }
  .drv-manifest-qty-line--priority { color: var(--blu7); }
  .drv-manifest-material { font-family: var(--fh); font-size: 20px; font-weight: 700; color: var(--g9); margin-top: 4px; }
  .drv-manifest-badge { padding: 4px 12px; border-radius: 20px; font-family: var(--fh); font-size: 12px; font-weight: 700; margin-top: 8px; }

  /* Drop photo */
  .drv-photo-frame { border-radius: var(--rs); overflow: hidden; border: 1.5px solid var(--g2); cursor: pointer; position: relative; }
  .drv-photo-img { width: 100%; height: auto; display: block; max-height: 200px; object-fit: cover; }
  .drv-photo-overlay { position: absolute; bottom: 0; left: 0; right: 0; background: linear-gradient(transparent, rgba(0,0,0,.55)); color: #fff; font-size: 13px; font-weight: 600; padding: 20px 12px 8px; text-align: center; }

  /* Notes */
  .drv-notes { padding: 14px 16px; background: var(--amb0); border-left: 4px solid var(--amb6); border-radius: 0 var(--rs) var(--rs) 0; }
  .drv-notes-hd { font-family: var(--fh); font-size: 12px; font-weight: 700; color: var(--amb7); text-transform: uppercase; letter-spacing: .04em; margin-bottom: 4px; }
  .drv-notes-body { font-size: 16px; color: var(--amb7); line-height: 1.45; }

  /* Navigate */
  .drv-nav { display: flex; align-items: center; gap: 14px; width: 100%; padding: 16px; background: var(--teal1); border: 1.5px solid var(--teal6); border-radius: var(--rs); text-decoration: none; color: var(--teal7); cursor: pointer; transition: transform .1s; }
  .drv-nav:active { transform: scale(.98); }
  .drv-nav-icon { font-size: 28px; flex-shrink: 0; }
  .drv-nav-info { flex: 1; text-align: left; }
  .drv-nav-hint { font-family: var(--fh); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; opacity: .7; margin-bottom: 2px; }
  .drv-nav-addr { font-size: 16px; font-weight: 600; line-height: 1.3; }
  .drv-nav-go { font-size: 24px; opacity: .5; flex-shrink: 0; }

  /* Notified */
  .drv-notified { display: flex; align-items: center; gap: 8px; padding: 12px 16px; background: var(--grn0); border-radius: var(--rs); font-size: 15px; font-weight: 600; color: var(--grn7); }

  /* Buttons */
  .drv-btn { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; padding: 16px 20px; border: none; border-radius: var(--rs); font-family: var(--fh); font-size: 17px; font-weight: 700; cursor: pointer; transition: transform .1s; user-select: none; }
  .drv-btn:active:not(:disabled) { transform: scale(.97); }
  .drv-btn:disabled { opacity: .5; cursor: not-allowed; }
  .drv-btn-ic { font-size: 20px; }
  .drv-btn--green { background: var(--grn6); color: #fff; }
  .drv-btn--teal { background: var(--teal6); color: #fff; }
  .drv-btn--amber { background: var(--amb6); color: #fff; }
  .drv-btn--red { background: var(--red6); color: #fff; }
  .drv-btn--outline { background: #fff; color: var(--g7); border: 1.5px solid var(--g2); }
  .drv-btn--ghost { background: var(--g1); color: var(--g7); }

  /* Actions area */
  .drv-actions { margin-top: 24px; display: flex; flex-direction: column; gap: 14px; }
  .drv-act-group { display: flex; flex-direction: column; gap: 6px; }
  .drv-act-label { font-family: var(--fh); font-size: 13px; font-weight: 700; color: var(--g5); }

  /* Divider */
  .drv-sep { display: flex; align-items: center; gap: 12px; margin: 32px 0 16px; }
  .drv-sep-line { flex: 1; height: 1px; background: var(--g2); }
  .drv-sep-text { font-family: var(--fh); font-size: 11px; font-weight: 700; color: var(--g4); text-transform: uppercase; letter-spacing: .06em; white-space: nowrap; }

  /* Secondary buttons */
  .drv-secondary { display: flex; flex-direction: column; gap: 8px; }
  .drv-btn-sec { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; padding: 12px 16px; border-radius: var(--rs); font-family: var(--fh); font-size: 14px; font-weight: 600; cursor: pointer; background: #fff; user-select: none; transition: transform .1s; }
  .drv-btn-sec:active:not(:disabled) { transform: scale(.98); }
  .drv-btn-sec:disabled { opacity: .5; }
  .drv-btn-sec--amber { color: var(--amb7); border: 1.5px solid var(--amb6); }
  .drv-btn-sec--red { color: var(--red7); border: 1.5px solid var(--red6); }

  /* Banners */
  .drv-banner { text-align: center; padding: 16px; margin-top: 14px; font-family: var(--fh); font-size: 17px; font-weight: 700; border-radius: var(--rs); }
  .drv-banner--green { color: var(--grn7); background: var(--grn1); }
  .drv-banner--red { color: var(--red7); background: var(--red1); }

  /* Toast */
  .drv-toast { position: fixed; bottom: 24px; left: 16px; right: 16px; z-index: 200; padding: 16px 20px; border-radius: var(--rs); font-family: var(--fh); font-size: 16px; font-weight: 700; text-align: center; background: var(--grn7); color: #fff; animation: up .3s ease; box-shadow: 0 8px 24px rgba(0,0,0,.15); }
  .drv-toast--err { background: var(--red6); }
  @keyframes up { from { transform: translateY(60px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

  /* Overlay + Modal */
  .drv-overlay { position: fixed; inset: 0; z-index: 100; background: rgba(0,0,0,.5); display: flex; align-items: flex-end; justify-content: center; animation: fade .15s; }
  .drv-overlay--center { align-items: center; }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  .drv-modal { width: 100%; max-width: 500px; background: #fff; border-radius: var(--r) var(--r) 0 0; padding: 28px 20px 32px; max-height: 85dvh; overflow-y: auto; animation: up .25s ease; }
  .drv-modal-ic { text-align: center; font-size: 48px; margin-bottom: 8px; }
  .drv-modal-h { font-family: var(--fh); font-size: 22px; font-weight: 800; color: var(--g9); text-align: center; }
  .drv-modal-p { font-size: 16px; color: var(--g5); text-align: center; line-height: 1.5; margin: 6px 0 20px; }
  .drv-modal-btns { display: flex; flex-direction: column; gap: 10px; margin-top: 20px; }

  /* Reason grid */
  .drv-reason-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 16px; }
  .drv-reason { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 18px 10px; background: var(--g0); border: 2px solid var(--g2); border-radius: var(--rs); font-family: var(--fh); font-size: 14px; font-weight: 600; color: var(--g7); cursor: pointer; text-align: center; min-height: 80px; transition: border-color .15s; }
  .drv-reason:active { background: var(--g1); }
  .drv-reason--on { border-color: var(--red6); background: var(--red1); color: var(--red7); }
  .drv-reason-ic { font-size: 28px; }

  /* Textarea */
  .drv-field-lbl { font-family: var(--fh); font-size: 12px; font-weight: 700; color: var(--g4); text-transform: uppercase; letter-spacing: .04em; margin-bottom: 6px; }
  .drv-ta { width: 100%; min-height: 90px; padding: 12px 14px; border: 1.5px solid var(--g2); border-radius: var(--rs); font-family: var(--ff); font-size: 16px; color: var(--g9); resize: vertical; box-sizing: border-box; }
  .drv-ta:focus { outline: none; border-color: var(--grn6); }

  /* Lightbox */
  .drv-lb { position: relative; max-width: 95vw; max-height: 90vh; margin: auto; }
  .drv-lb-img { max-width: 95vw; max-height: 85vh; object-fit: contain; border-radius: var(--r); display: block; }
  .drv-lb-x { position: absolute; top: -14px; right: -8px; width: 40px; height: 40px; border-radius: 50%; background: #fff; border: none; font-size: 20px; box-shadow: 0 2px 8px rgba(0,0,0,.2); cursor: pointer; display: flex; align-items: center; justify-content: center; }
`;
