'use client';

import { useState } from 'react';
import { api, requireRole } from '../lib/auth';

export default function CustomerSearchPage() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<any[]>([]);
  if (!requireRole(['dispatcher'])) return <p>Unauthorized</p>;
  return <main><h1>Customer Search</h1><input value={q} onChange={(e)=>setQ(e.target.value)} /><button onClick={async ()=>setResults((await api(`/customers/search?q=${encodeURIComponent(q)}`)).results)}>Search</button><ul>{results.map(r=><li key={r.id}>{r.name} {r.phone_e164}</li>)}</ul></main>;
}
