'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api, requireRole } from '../../../lib/auth';

export default function DriverLoadDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [load, setLoad] = useState<any>(null);
  const [msg, setMsg] = useState('');
  const [reason, setReason] = useState('customer_unavailable');
  const [notes, setNotes] = useState('');
  const router = useRouter();

  const uploadPhoto = async (entityType: 'POD_PHOTO'|'EXCEPTION_PHOTO', file?: File | null) => {
    if (!file) return;
    const presign = await api('/uploads/presign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entity_type: entityType, entity_id: id, content_type: 'image/jpeg' }) });
    await fetch(presign.upload_url, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: file });
    await api('/uploads/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entity_type: entityType, entity_id: id, object_key: presign.object_key }) });
    await refresh();
  };

  const refresh = async () => {
    try {
      setLoad(await api(`/driver/loads/${id}`));
      setMsg('');
    } catch {
      setMsg('This delivery was reassigned by dispatch.');
      router.push('/driver/loads?reassigned=1');
    }
  };
  useEffect(() => {
    refresh();
    const t = setInterval(() => refresh().catch(() => null), 30000);
    return () => clearInterval(t);
  }, [id]);
  if (!requireRole(['driver'])) return <p>Unauthorized</p>;
  return <main><h1>Load Detail</h1>{msg && <p>{msg}</p>}{load && <div><p>{load.address.line1}, {load.address.city}</p><p>{load.material} {load.qty} {load.unit}</p><p>{load.notes}</p>
  <label>POD photo (jpeg): <input type='file' accept='image/jpeg' onChange={(e)=>uploadPhoto('POD_PHOTO', e.target.files?.[0])} /></label>
  <button onClick={async()=>{await api(`/driver/loads/${id}/status`,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':`k-${Date.now()}`},body:JSON.stringify({status:'loaded_leaving'})}); refresh();}}>Loaded/Leaving</button>
  <button disabled={!load.pod_photo_url} onClick={async()=>{await api(`/driver/loads/${id}/status`,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':`d-${Date.now()}`},body:JSON.stringify({status:'delivered'})}); refresh();}}>Delivered</button>
  <h3>Exception</h3>
  <select value={reason} onChange={(e)=>setReason(e.target.value)}>
    <option value='customer_unavailable'>Customer unavailable</option>
    <option value='access_blocked'>Access blocked</option>
    <option value='safety_risk'>Safety risk</option>
    <option value='damaged_goods'>Damaged goods</option>
    <option value='other'>Other</option>
  </select>
  <input value={notes} onChange={(e)=>setNotes(e.target.value)} placeholder='Notes (optional)' />
  <label>Exception photo (optional): <input type='file' accept='image/jpeg' onChange={(e)=>uploadPhoto('EXCEPTION_PHOTO', e.target.files?.[0])} /></label>
  <button onClick={async()=>{await api(`/driver/loads/${id}/status`,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':`e-${Date.now()}`},body:JSON.stringify({status:'exception',reason_code:reason,notes})}); refresh();}}>Submit Exception</button>
  </div>}</main>;
}
