'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { setSession } from '../lib/auth';

export default function LoginPage() {
  const [email, setEmail] = useState('dispatcher@example.com');
  const [password, setPassword] = useState('password');
  const [error, setError] = useState('');
  const router = useRouter();

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const res = await fetch('http://localhost:8000/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) return setError(data?.detail?.message || 'Login failed');

    let tenantSettings: any = null;
    try {
      const tRes = await fetch('http://localhost:8000/api/v1/tenant/settings', { headers: { Authorization: `Bearer ${data.access_token}` } });
      tenantSettings = await tRes.json();
    } catch {
      tenantSettings = null;
    }

    setSession({ token: data.access_token, role: data.role, tenant_id: data.tenant_id, tenant_slug: tenantSettings?.slug, tenant_name: tenantSettings?.name });
    router.push(data.role === 'driver' ? '/driver/loads' : '/dispatch-schedule');
  };

  return <main><h1>Login</h1><form onSubmit={onSubmit}><input value={email} onChange={(e)=>setEmail(e.target.value)} /><input type="password" value={password} onChange={(e)=>setPassword(e.target.value)} /><button type="submit">Sign in</button></form>{error && <p>{error}</p>}</main>;
}
