'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ApiError, api, requireRole } from '../../../lib/auth';

const POLL_INTERVAL_MS = 30000;
const CONNECTION_STALE_MS = 90000;

const statusLabel: Record<string, string> = {
  assigned: 'Assigned. Head to the customer and prepare to depart.',
  loaded_leaving: 'Loaded and en route. Complete delivery when POD is ready.',
  delivered: 'Delivered. No further action is required.',
  exception: 'Exception recorded. No further driver action is required.',
  cancelled: 'Cancelled. No further action is required.',
};

export default function DriverLoadDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [load, setLoad] = useState<any>(null);
  const [msg, setMsg] = useState('');
  const [banner, setBanner] = useState('');
  const [reason, setReason] = useState('customer_unavailable');
  const [notes, setNotes] = useState('');
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [connectionIssue, setConnectionIssue] = useState(false);
  const [authExpired, setAuthExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const lastSyncRef = useRef<Date | null>(null);
  const router = useRouter();

  const handleReassignment = () => {
    setMsg('This delivery was reassigned by dispatch.');
    router.replace('/driver/loads?reassigned=1');
  };

  const refresh = async () => {
    try {
      const data = await api(`/driver/loads/${id}`);
      setLoad(data);
      const syncedAt = new Date(data.server_timestamp || Date.now());
      setLastSync(syncedAt);
      lastSyncRef.current = syncedAt;
      setConnectionIssue(false);
      setAuthExpired(false);
      setMsg('');
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.status === 403 || apiErr.status === 404 || apiErr.code === 'load_reassigned') {
        handleReassignment();
        return;
      }
      if (apiErr.code === 'auth_expired') {
        setAuthExpired(true);
      }
      setConnectionIssue(true);
      setMsg(apiErr.message || 'Unable to load delivery.');
    }
  };

  const uploadPhoto = async (entityType: 'POD_PHOTO' | 'EXCEPTION_PHOTO', file?: File | null) => {
    if (!file || !load || actionsDisabled) return;
    await runDriverAction(async () => {
      const presign = await api('/uploads/presign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity_type: entityType, entity_id: id, content_type: 'image/jpeg' }),
      });
      await fetch(presign.upload_url, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: file });
      await api('/uploads/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity_type: entityType, entity_id: id, object_key: presign.object_key }),
      });
    });
  };

  const runDriverAction = async (fn: () => Promise<void>) => {
    try {
      setBusy(true);
      setBanner('');
      await fn();
      await refresh();
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.status === 403 || apiErr.status === 404 || apiErr.code === 'load_reassigned') {
        handleReassignment();
        return;
      }
      if (apiErr.code === 'auth_expired') {
        setAuthExpired(true);
        setBanner('Session expired. Please sign in again.');
        return;
      }
      setBanner(apiErr.message || 'Action failed. Please wait for sync and retry.');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    refresh();
    const t = setInterval(() => refresh().catch(() => null), POLL_INTERVAL_MS);
    const watchdog = setInterval(() => {
      const latestSync = lastSyncRef.current;
      if (!latestSync || Date.now() - latestSync.getTime() > CONNECTION_STALE_MS) {
        setConnectionIssue(true);
      }
    }, 5000);
    return () => {
      clearInterval(t);
      clearInterval(watchdog);
    };
  }, [id]);

  const nextActions = useMemo(() => {
    if (!load) return { canLeave: false, canDeliver: false, canException: false, deliveredNeedsPod: false };
    const canLeave = load.status === 'assigned';
    const canDeliver = load.status === 'loaded_leaving' && Boolean(load.pod_photo_url);
    const canException = load.status === 'assigned' || load.status === 'loaded_leaving';
    return {
      canLeave,
      canDeliver,
      canException,
      deliveredNeedsPod: load.status === 'loaded_leaving' && !load.pod_photo_url,
    };
  }, [load]);

  const actionsDisabled = busy || connectionIssue || authExpired || !load;

  if (!requireRole(['driver'])) return <p>Unauthorized</p>;
  return (
    <main>
      <h1>Load Detail</h1>
      {msg && <p>{msg}</p>}
      {banner && <p>{banner}</p>}
      {authExpired && <p style={{ color: 'darkred' }}>Session expired. Please sign in again before updating status.</p>}
      {connectionIssue && <p style={{ color: 'darkred' }}>Connection issue. Actions are disabled until sync resumes.</p>}
      <p>Last sync: {lastSync ? lastSync.toLocaleTimeString() : 'Never'}</p>
      {load && (
        <div>
          <p>{load.address.line1}, {load.address.city}</p>
          <p>{load.material} {load.qty} {load.unit}</p>
          <p>{load.notes}</p>
          <p><strong>Current status:</strong> {statusLabel[load.status] || load.status}</p>

          <label>
            POD photo (jpeg):
            <input type='file' accept='image/jpeg' disabled={actionsDisabled} onChange={(e) => uploadPhoto('POD_PHOTO', e.target.files?.[0])} />
          </label>

          <button
            disabled={actionsDisabled || !nextActions.canLeave}
            onClick={() => runDriverAction(async () => {
              await api(`/driver/loads/${id}/status`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `k-${Date.now()}` },
                body: JSON.stringify({ status: 'loaded_leaving', client_server_version: load.server_version }),
              });
            })}
          >
            Mark Loaded/Leaving
          </button>

          <button
            disabled={actionsDisabled || !nextActions.canDeliver}
            onClick={() => runDriverAction(async () => {
              await api(`/driver/loads/${id}/status`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `d-${Date.now()}` },
                body: JSON.stringify({ status: 'delivered', client_server_version: load.server_version }),
              });
            })}
          >
            Mark Delivered
          </button>
          {nextActions.deliveredNeedsPod && <p>Upload POD photo before marking delivered.</p>}

          <h3>Report Exception</h3>
          <select disabled={actionsDisabled || !nextActions.canException} value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value='customer_unavailable'>Customer unavailable</option>
            <option value='access_blocked'>Access blocked</option>
            <option value='safety_risk'>Safety risk</option>
            <option value='damaged_goods'>Damaged goods</option>
            <option value='other'>Other</option>
          </select>
          <input
            disabled={actionsDisabled || !nextActions.canException}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder='Notes (optional)'
          />
          <label>
            Exception photo (optional):
            <input
              type='file'
              accept='image/jpeg'
              disabled={actionsDisabled || !nextActions.canException}
              onChange={(e) => uploadPhoto('EXCEPTION_PHOTO', e.target.files?.[0])}
            />
          </label>
          <button
            disabled={actionsDisabled || !nextActions.canException}
            onClick={() => runDriverAction(async () => {
              await api(`/driver/loads/${id}/status`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `e-${Date.now()}` },
                body: JSON.stringify({ status: 'exception', reason_code: reason, notes, client_server_version: load.server_version }),
              });
            })}
          >
            Submit Exception
          </button>
        </div>
      )}
    </main>
  );
}
