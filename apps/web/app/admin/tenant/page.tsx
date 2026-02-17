'use client';

import { useEffect, useState } from 'react';
import { api, requireRole } from '../../lib/auth';

export default function TenantSettingsPage() {
  const [form, setForm] = useState<any>(null);
  const [message, setMessage] = useState('');

  useEffect(() => { api('/tenant/settings').then(setForm).catch(()=>null); }, []);
  if (!requireRole(['admin'])) return <p>Unauthorized</p>;
  if (!form) return <p>Loading...</p>;

  const overlap = form.windowA_end > form.windowB_start;
  const badCapacity = Number(form.capacity_per_window) < 1;

  return <main>
    <h1>Administration / Tenant Settings</h1>
    <p>Changing windows and capacity applies to future scheduling only.</p>
    <p><strong>Warning:</strong> Tenant-wide changes impact all dispatchers and channels.</p>
    {['name','slug','timezone','windowA_start','windowA_end','windowB_start','windowB_end','capacity_per_window'].map((k)=><div key={k}><label>{k}</label><input disabled={k==='slug'} value={form[k]} onChange={(e)=>setForm({...form,[k]:e.target.value})} /></div>)}
    <div><label>service_days (comma list)</label><input value={form.service_days.join(',')} onChange={(e)=>setForm({...form,service_days:e.target.value.split(',').map((v)=>v.trim())})} /></div>
    {overlap && <p>Windows must not overlap.</p>}
    {badCapacity && <p>Capacity must be at least 1.</p>}
    <button disabled={overlap || badCapacity} onClick={async()=>{
      if (!confirm('Apply tenant-wide settings?')) return;
      await api('/tenant/settings', {method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(form)});
      setMessage('Saved');
    }}>Save</button>
    <p>{message}</p>
  </main>;
}
