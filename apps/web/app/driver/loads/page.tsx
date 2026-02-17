'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api, requireRole } from '../../lib/auth';

export default function DriverLoadListPage() {
  const [loads, setLoads] = useState<any[]>([]);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [connectionIssue, setConnectionIssue] = useState(false);
  const day = new Date().toISOString().slice(0, 10);
  const params = useSearchParams();
  const pull = async () => {
    const data = await api(`/driver/loads?day=${day}`);
    setLoads(data.loads);
    setLastSync(new Date());
    setConnectionIssue(false);
  };
  useEffect(() => {
    pull().catch(() => setConnectionIssue(true));
    const id = setInterval(() => pull().catch(() => null), 15000);
    const watchdog = setInterval(() => {
      if (lastSync && Date.now() - lastSync.getTime() > 90000) setConnectionIssue(true);
    }, 5000);
    return () => {
      clearInterval(id);
      clearInterval(watchdog);
    };
  }, [lastSync]);
  const lastSyncText = useMemo(() => (lastSync ? lastSync.toLocaleTimeString() : 'Never'), [lastSync]);
  if (!requireRole(['driver'])) return <p>Unauthorized</p>;
  return <main><h1>My Loads Today</h1>{params.get('reassigned')==='1' && <p style={{color:'darkorange'}}>This delivery was reassigned by dispatch.</p>}{connectionIssue && <p style={{color:'darkred'}}>Connection issue</p>}<p>Last sync: {lastSyncText}</p><ul>{loads.map((l)=><li key={l.id}><Link href={`/driver/loads/${l.id}`}>{l.material} {l.qty} ({l.status})</Link></li>)}</ul></main>;
}
