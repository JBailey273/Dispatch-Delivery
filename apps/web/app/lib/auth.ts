'use client';

export type Session = { token: string; role: string; tenant_id: string; tenant_slug?: string; tenant_name?: string };

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function getSession(): Session | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem('session');
  return raw ? (JSON.parse(raw) as Session) : null;
}

export function setSession(session: Session) {
  localStorage.setItem('session', JSON.stringify(session));
}

export function clearSession() {
  localStorage.removeItem('session');
  localStorage.removeItem('tenantContext');
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
    ...(s?.tenant_slug ? { 'X-Tenant-Slug': s.tenant_slug } : {}),
  };
  const res = await fetch(`http://localhost:8000/api/v1${path}`, { ...opts, headers, cache: 'no-store' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errCode = body?.detail?.code;
    if (res.status === 401) {
      clearSession();
      throw new ApiError('Session expired. Please sign in again.', res.status, 'auth_expired');
    }
    throw new ApiError(body?.detail?.message || body?.detail || 'Request failed', res.status, errCode);
  }
  return body;
}
