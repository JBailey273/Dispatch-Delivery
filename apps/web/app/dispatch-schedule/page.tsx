'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, requireRole } from '../lib/auth';

export default function DispatchSchedulePage() {
  const [day, setDay] = useState(new Date().toISOString().slice(0, 10));
  const [schedule, setSchedule] = useState<any>(null);
  const [driver, setDriver] = useState('');
  const [loadIds, setLoadIds] = useState<string[]>([]);
  const driverLoadWarningThreshold = 8;
  const load = async () => setSchedule(await api(`/dispatch/schedule?day=${day}`));
  useEffect(() => { load().catch(() => null); }, []);
  if (!requireRole(['dispatcher'])) return <p>Unauthorized</p>;
  return <main><h1>Dispatch Schedule</h1><input type='date' value={day} onChange={(e)=>setDay(e.target.value)} /><button onClick={load}>Refresh</button>
  {schedule && ['A','B'].map((w)=> <section key={w}><h2>Window {w} ({schedule.windows[w].capacity.used}/{schedule.windows[w].capacity.total})</h2>{Object.entries(schedule.windows[w].groups).map(([k,v]:any)=><div key={k}><h4>{k}</h4><ul>{v.map((l:any)=><li key={l.id}><label><input type='checkbox' onChange={(e)=>setLoadIds(e.target.checked?[...loadIds,l.id]:loadIds.filter(id=>id!==l.id))} /><Link href={`/dispatch/drops/${l.drop_id}`}>Drop</Link> - {l.material} {l.qty}</label></li>)}</ul></div>)}</section>)}
  <input placeholder='driver user id' value={driver} onChange={(e)=>setDriver(e.target.value)} />
  {loadIds.length > driverLoadWarningThreshold && <p style={{color:'orange'}}>Warning: assigning more than {driverLoadWarningThreshold} loads at once to one driver can increase risk.</p>}
  <button onClick={async()=>{await api('/dispatch/loads/assign',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({load_ids:loadIds,driver_user_id:driver})}); load();}}>Assign selected</button>
  </main>;
}
