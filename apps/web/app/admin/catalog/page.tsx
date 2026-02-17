'use client';

import { useEffect, useState } from 'react';
import { api, requireRole, getSession } from '../../lib/auth';

export default function AdminCatalogPage() {
  const [items, setItems] = useState<any[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState('');
  const load = async () => setItems((await api('/product-catalog')).items);
  useEffect(() => { load().catch(()=>null); }, []);
  if (!requireRole(['dispatcher'])) return <p>Unauthorized</p>;
  return <main><h1>Product Catalog</h1>{getSession()?.role==='admin' && <div><input type='file' accept='.csv' onChange={(e)=>setFile(e.target.files?.[0] || null)} /><button onClick={async()=>{if(!file) return; const fd = new FormData(); fd.append('file', file); const res = await fetch('http://localhost:8000/api/v1/product-catalog/import',{method:'POST',headers:{Authorization:`Bearer ${getSession()?.token}`},body:fd}); const data=await res.json(); setMessage(JSON.stringify(data)); load();}}>Import CSV</button><p>{message}</p></div>}<ul>{items.map((i)=><li key={i.id}>{i.sku} - {i.name} ({i.delivery_mode}) {i.active?'':'[disabled]'}</li>)}</ul></main>;
}
