'use client';

export type Session = { token: string; role: string; tenant_id: string };

export function getSession(): Session | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem('session');
  return raw ? (JSON.parse(raw) as Session) : null;
}

export function requireRole(roles: string[]): boolean {
  const s = getSession();
  if (!s) return false;
  return s.role === 'admin' || roles.includes(s.role);
}

export async function api(path: string, opts: RequestInit = {}) {
  const s = getSession();
  const headers: HeadersInit = {
    ...(opts.headers || {}),
    ...(s ? { Authorization: `Bearer ${s.token}` } : {}),
  };
  const res = await fetch(`http://localhost:8000/api/v1${path}`, { ...opts, headers, cache: 'no-store' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.detail?.message || body?.detail || 'Request failed');
  return body;
}
