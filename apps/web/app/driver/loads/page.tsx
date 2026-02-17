'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, requireRole } from '../../lib/auth';

export default function DriverLoadListPage() {
  const [loads, setLoads] = useState<any[]>([]);
  const day = new Date().toISOString().slice(0, 10);
  const pull = async () => {
    const data = await api(`/driver/loads?day=${day}`);
    setLoads(data.loads);
  };
  useEffect(() => {
    pull().catch(() => null);
    const id = setInterval(() => pull().catch(() => null), 15000);
    return () => clearInterval(id);
  }, []);
  if (!requireRole(['driver'])) return <p>Unauthorized</p>;
  return <main><h1>My Loads Today</h1><ul>{loads.map((l)=><li key={l.id}><Link href={`/driver/loads/${l.id}`}>{l.material} {l.qty} ({l.status})</Link></li>)}</ul></main>;
}
