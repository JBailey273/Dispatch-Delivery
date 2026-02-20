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
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Session;
  // Normalize role to lowercase for consistent frontend checks
  if (parsed.role) parsed.role = parsed.role.toLowerCase();
  return parsed;
}

export function setSession(session: Session) {
  localStorage.setItem('session', JSON.stringify(session));
}

export function clearSession() {
  localStorage.removeItem('session');
  localStorage.removeItem('tenantContext');
}

export function requireRole(roles: string[]): boolean {
  // During SSR, render optimistically to avoid hydration mismatch.
  // API calls enforce auth server-side; unauthorized users get redirected on 401.
  if (typeof window === 'undefined') return true;
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
  const base = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:8000/api/v1';
  const res = await fetch(`${base}${path}`, { ...opts, headers, cache: 'no-store' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errCode = body?.detail?.code;
    if (res.status === 401) {
      throw new ApiError('Session expired. Please sign in again.', res.status, 'auth_expired');
    }
    throw new ApiError(body?.detail?.message || body?.detail || 'Request failed', res.status, errCode);
  }
  return body;
}
