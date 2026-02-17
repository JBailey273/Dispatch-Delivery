'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api, requireRole } from '../../../lib/auth';

export default function DriverLoadDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [load, setLoad] = useState<any>(null);
  const [msg, setMsg] = useState('');
  const router = useRouter();
  const refresh = async () => {
    try {
      setLoad(await api(`/driver/loads/${id}`));
    } catch {
      setMsg('Load was reassigned away.');
      router.push('/driver/loads');
    }
  };
  useEffect(() => {
    refresh();
    const t = setInterval(() => refresh().catch(() => null), 30000);
    return () => clearInterval(t);
  }, [id]);
  if (!requireRole(['driver'])) return <p>Unauthorized</p>;
  return <main><h1>Load Detail</h1>{msg && <p>{msg}</p>}{load && <div><p>{load.address.line1}, {load.address.city}</p><p>{load.material} {load.qty} {load.unit}</p><p>{load.notes}</p><button onClick={async()=>{await api(`/driver/loads/${id}/status`,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':`k-${Date.now()}`},body:JSON.stringify({status:'loaded_leaving'})}); refresh();}}>Loaded/Leaving</button><button onClick={async()=>{await api(`/driver/loads/${id}/status`,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':`e-${Date.now()}`},body:JSON.stringify({status:'exception',reason:'Customer unavailable'})}); refresh();}}>Exception</button></div>}</main>;
}
