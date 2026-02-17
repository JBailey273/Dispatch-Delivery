'use client';
import { useEffect, useState } from 'react';
import { api, requireRole } from '../../lib/auth';

export default function ChannelsPage(){
  const [channels,setChannels]=useState<any[]>([]);
  const [name,setName]=useState('');
  const [type,setType]=useState('manual');
  const [key,setKey]=useState('');
  const load=async()=>setChannels((await api('/channels')).items);
  useEffect(()=>{load().catch(()=>null);},[]);
  if(!requireRole(['admin'])) return <p>Unauthorized</p>;
  return <main><h1>Administration / Channels</h1>
  <input placeholder='name' value={name} onChange={e=>setName(e.target.value)} /><select value={type} onChange={e=>setType(e.target.value)}><option value='manual'>manual</option><option value='woocommerce'>woocommerce</option></select>
  <button onClick={async()=>{const r=await api('/channels',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,type})});setKey(r.api_key);load();}}>Create</button>
  {key && <p>New API key: {key}</p>}
  <ul>{channels.map(c=><li key={c.id}>{c.name} ({c.type}) last call: {c.last_call_at || 'never'} <button onClick={async()=>{const r=await api(`/channels/${c.id}/rotate-key`,{method:'POST'});setKey(r.api_key);}}>Rotate key</button></li>)}</ul>
  </main>
}
