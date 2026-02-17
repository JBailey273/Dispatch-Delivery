'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, requireRole } from '../../../lib/auth';

export default function DispatchDropDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [drop, setDrop] = useState<any>(null);
  const [message, setMessage] = useState('Your delivery window has changed. Please contact us with questions.');
  const [adminOverride, setAdminOverride] = useState(false);

  const load = async () => setDrop(await api(`/dispatch/drops/${id}`));
  useEffect(() => { load().catch(() => null); }, [id]);

  if (!requireRole(['dispatcher'])) return <p>Unauthorized</p>;
  return <main>
    <h1>Drop Detail</h1>
    {drop && <>
      <p>Drop {drop.id}</p>
      <p>Reschedule text sent at: {drop.last_reschedule_sms_at || 'Not sent'}</p>
      <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={5} cols={60} />
      <div><label><input type='checkbox' checked={adminOverride} onChange={(e)=>setAdminOverride(e.target.checked)} /> Admin override rate limit</label></div>
      <button onClick={async()=>{const res = await api(`/dispatch/drops/${id}/send-reschedule-sms`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message, admin_override:adminOverride})}); alert(`Queued at ${res.sent_at}`); load();}}>Send reschedule text</button>
    </>}
  </main>;
}
