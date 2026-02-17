'use client';

import { useEffect, useState } from 'react';
import { api, requireRole } from '../lib/auth';

export default function NewDropPage() {
  const [phone, setPhone] = useState('');
  const [customer, setCustomer] = useState<any>(null);
  const [addresses, setAddresses] = useState<any[]>([]);
  const [addressId, setAddressId] = useState('');
  const [items, setItems] = useState<any[]>([]);
  const [sku, setSku] = useState('');
  const [qty, setQty] = useState(1);
  const [catalog, setCatalog] = useState<any[]>([]);
  const [window, setWindow] = useState('A');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [availability, setAvailability] = useState<any[]>([]);
  const [result, setResult] = useState('');

  useEffect(() => { api('/product-catalog').then((d) => setCatalog(d.items)).catch(() => null); }, []);
  if (!requireRole(['dispatcher'])) return <p>Unauthorized</p>;

  return <main><h1>New Drop</h1>
    <h3>1. Lookup/Create Customer</h3>
    <input placeholder='Phone' value={phone} onChange={(e)=>setPhone(e.target.value)} />
    <button onClick={async()=>{const s=await api(`/customers/search?q=${encodeURIComponent(phone)}`); if(s.results[0]){setCustomer(s.results[0]); const ad=await api(`/customers/${s.results[0].id}/addresses`); setAddresses(ad.addresses);} }}>Lookup</button>
    <button onClick={async()=>{const c=await api('/customers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Walk-in Customer',phone})}); setCustomer(c.customer);}}>Create</button>
    {customer && <p>Selected: {customer.name}</p>}
    <h3>2. Select Address</h3><select value={addressId} onChange={(e)=>setAddressId(e.target.value)}><option value=''>Select</option>{addresses.map(a=><option key={a.id} value={a.id}>{a.line1}, {a.city}</option>)}</select>
    <h3>3. Add Products</h3><select value={sku} onChange={(e)=>setSku(e.target.value)}><option value=''>Select SKU</option>{catalog.filter(c=>c.active).map(c=><option key={c.sku} value={c.sku}>{c.sku} - {c.name}</option>)}</select><input type='number' value={qty} onChange={(e)=>setQty(Number(e.target.value))} /><button onClick={()=>setItems([...items,{sku,qty}])}>Add</button>
    <ul>{items.map((i,idx)=><li key={idx}>{i.sku} x{i.qty}</li>)}</ul>
    <h3>4. Capacity Check</h3>
    <input type='date' value={date} onChange={(e)=>setDate(e.target.value)} /><select value={window} onChange={(e)=>setWindow(e.target.value)}><option>A</option><option>B</option></select>
    <button onClick={async()=>{const req= new Set(items.map(i=>catalog.find(c=>c.sku===i.sku)).filter(Boolean).filter(c=>c.delivery_mode==='bulk_load').map(c=>c.bulk_group)).size; const a=await api(`/availability?required_loads=${req}&start_date=${date}&days=3`); setAvailability(a.windows);} }>Check Availability</button>
    <pre>{JSON.stringify(availability, null, 2)}</pre>
    <h3>5. Create</h3>
    <button onClick={async()=>{const out=await api('/drops/manual',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({customer:{id:customer.id},address:{address_id:addressId},scheduled_date:date,scheduled_window:window,items})}); setResult(JSON.stringify(out));}}>Create Drop</button>
    <p>{result}</p>
  </main>;
}
