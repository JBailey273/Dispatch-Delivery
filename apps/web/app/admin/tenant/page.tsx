'use client';

import { useEffect, useState } from 'react';
import { api, requireRole } from '../../lib/auth';

export default function TenantSettingsPage() {
  const [data, setData] = useState<any>(null);
  useEffect(()=>{api('/tenant/settings').then(setData).catch(()=>null);},[]);
  if (!requireRole(['dispatcher'])) return <p>Unauthorized</p>;
  return <main><h1>Tenant Settings</h1><pre>{JSON.stringify(data,null,2)}</pre></main>;
}
