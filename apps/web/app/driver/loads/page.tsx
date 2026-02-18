'use client';

import Link from 'next/link';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ApiError, api, requireRole } from '../../lib/auth';

const POLL_INTERVAL_MS = 15000;
const CONNECTION_STALE_MS = 90000;

function DriverLoadListContent() {
  const [loads, setLoads] = useState<any[]>([]);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [lastServerVersion, setLastServerVersion] = useState<string | null>(null);
  const [connectionIssue, setConnectionIssue] = useState(false);
  const [authExpired, setAuthExpired] = useState(false);
  const loadsRef = useRef<any[]>([]);
  const lastVersionRef = useRef<string | null>(null);
  const lastSyncRef = useRef<Date | null>(null);
  const day = new Date().toISOString().slice(0, 10);
  const params = useSearchParams();

  const pull = async () => {
    const knownIds = loadsRef.current.map((load) => `known_load_ids=${encodeURIComponent(load.id)}`).join('&');
    const version = lastVersionRef.current ? `&server_version=${encodeURIComponent(lastVersionRef.current)}` : '';
    const suffix = knownIds ? `&${knownIds}` : '';
    const data = await api(`/driver/loads?day=${day}${version}${suffix}`);
    if (Array.isArray(data.removed_load_ids) && data.removed_load_ids.length > 0) {
      setLoads((prev) => prev.filter((load) => !data.removed_load_ids.includes(load.id)));
    }
    const nextLoads = data.loads || [];
    setLoads(nextLoads);
    loadsRef.current = nextLoads;
    setLastServerVersion(data.server_version || null);
    lastVersionRef.current = data.server_version || null;
    const syncedAt = new Date(data.server_timestamp || Date.now());
    setLastSync(syncedAt);
    lastSyncRef.current = syncedAt;
    setConnectionIssue(false);
    setAuthExpired(false);
  };

  useEffect(() => {
    pull().catch((err) => {
      const apiErr = err as ApiError;
      if (apiErr.code === 'auth_expired') {
        setAuthExpired(true);
      }
      setConnectionIssue(true);
    });
    const id = setInterval(() => {
      pull().catch((err) => {
        const apiErr = err as ApiError;
        if (apiErr.code === 'auth_expired') {
          setAuthExpired(true);
        }
      });
    }, POLL_INTERVAL_MS);
    const watchdog = setInterval(() => {
      const latestSync = lastSyncRef.current;
      if (!latestSync || Date.now() - latestSync.getTime() > CONNECTION_STALE_MS) {
        setConnectionIssue(true);
      }
    }, 5000);
    return () => {
      clearInterval(id);
      clearInterval(watchdog);
    };
  }, [day]);

  const lastSyncText = useMemo(() => (lastSync ? lastSync.toLocaleTimeString() : 'Never'), [lastSync]);
  if (!requireRole(['driver'])) return <p>Unauthorized</p>;

  return (
    <main>
      <h1>My Loads Today</h1>
      {params.get('reassigned') === '1' && <p style={{ color: 'darkorange' }}>This delivery was reassigned by dispatch.</p>}
      {authExpired && <p style={{ color: 'darkred' }}>Session expired. Please sign in again.</p>}
      {connectionIssue && <p style={{ color: 'darkred' }}>Connection issue. Waiting for sync to resume.</p>}
      <p>Last sync version: {lastServerVersion || 'n/a'}</p>
      <p>Last sync: {lastSyncText}</p>
      <ul>
        {loads.map((l) => (
          <li key={l.id}>
            <Link href={`/driver/loads/${l.id}`}>{l.material} {l.qty} ({l.status})</Link>
          </li>
        ))}
      </ul>
    </main>
  );
}

export default function DriverLoadListPage() {
  return (
    <Suspense fallback={<main><h1>My Loads Today</h1><p>Loading…</p></main>}>
      <DriverLoadListContent />
    </Suspense>
  );
}
