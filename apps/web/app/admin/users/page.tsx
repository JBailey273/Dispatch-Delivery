'use client';

import { useEffect, useState } from 'react';
import { api, requireRole } from '../../lib/auth';

export default function UsersPage(){
  const [users,setUsers]=useState<any[]>([]);
  const [form,setForm]=useState({email:'',password:'password',role:'dispatcher',default_truck_identifier:''});
  const load=async()=>setUsers((await api('/users')).items);
  useEffect(()=>{load().catch(()=>null);},[]);
  if(!requireRole(['admin'])) return <p>Unauthorized</p>;
  return <main><h1>Administration / Users</h1>
    <input placeholder='email' value={form.email} onChange={e=>setForm({...form,email:e.target.value})}/>
    <input placeholder='password' value={form.password} onChange={e=>setForm({...form,password:e.target.value})}/>
    <select value={form.role} onChange={e=>setForm({...form,role:e.target.value})}><option value='admin'>Admin</option><option value='dispatcher'>Dispatcher</option><option value='driver'>Driver</option></select>
    <input placeholder='default truck (driver optional)' value={form.default_truck_identifier} onChange={e=>setForm({...form,default_truck_identifier:e.target.value})}/>
    <button onClick={async()=>{await api('/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(form)});load();}}>Create</button>
    <ul>{users.map(u=><li key={u.id}>{u.email} - {u.role} [{u.is_active?'active':'disabled'}] <button onClick={async()=>{await api(`/users/${u.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({is_active:!u.is_active})});load();}}>toggle</button></li>)}</ul>
  </main>
}
