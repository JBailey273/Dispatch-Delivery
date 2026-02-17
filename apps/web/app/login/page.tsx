'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';

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
    localStorage.setItem('session', JSON.stringify({ token: data.access_token, role: data.role, tenant_id: data.tenant_id }));
    router.push(data.role === 'driver' ? '/driver/loads' : '/dispatch-schedule');
  };

  return <main><h1>Login</h1><form onSubmit={onSubmit}><input value={email} onChange={(e)=>setEmail(e.target.value)} /><input type="password" value={password} onChange={(e)=>setPassword(e.target.value)} /><button type="submit">Sign in</button></form>{error && <p>{error}</p>}</main>;
}
