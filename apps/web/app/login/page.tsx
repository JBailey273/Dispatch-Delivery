'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { setSession } from '../lib/auth';

export default function LoginPage() {
  const [email, setEmail] = useState('dispatcher@example.com');
  const [password, setPassword] = useState('password');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const base = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:8000/api/v1';
      const res = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data?.detail?.message || data?.detail || 'Login failed'); return; }

      let tenantSettings: any = null;
      try {
        const tRes = await fetch(`${base}/tenant/settings`, { headers: { Authorization: `Bearer ${data.access_token}` } });
        tenantSettings = await tRes.json();
      } catch { tenantSettings = null; }

      setSession({ token: data.access_token, role: data.role, tenant_id: data.tenant_id, tenant_slug: tenantSettings?.slug, tenant_name: tenantSettings?.name });
      router.push(data.role === 'driver' ? '/driver/loads' : '/ops-dashboard');
    } catch {
      setError('Network error — is the API running?');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <style>{loginStyles}</style>
      <div className="login-page">
        <div className="login-card card">
          <div className="login-header">
            <div className="login-logo">D</div>
            <h1 className="login-title">Dispatch & Delivery</h1>
            <p className="login-subtitle">Sign in to your account</p>
          </div>

          <form className="login-form" onSubmit={onSubmit}>
            {error && <div className="alert alert-error"><span>⚠</span>{error}</div>}

            <div className="form-group">
              <label className="form-label">Email</label>
              <input
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                autoComplete="email"
                autoFocus
              />
            </div>

            <div className="form-group">
              <label className="form-label">Password</label>
              <input
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </div>

            <button className="btn btn-primary btn-lg" type="submit" disabled={loading} style={{ width: '100%', marginTop: 4 }}>
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <div className="login-footer">
            <div className="login-dev-label">Dev accounts</div>
            <div className="login-dev-accounts">
              {[
                { email: 'admin@example.com', role: 'Admin' },
                { email: 'dispatcher@example.com', role: 'Dispatcher' },
                { email: 'driver@example.com', role: 'Driver' },
              ].map(a => (
                <button
                  key={a.email}
                  className="login-dev-btn"
                  type="button"
                  onClick={() => { setEmail(a.email); setPassword('password'); }}
                >
                  <span className="login-dev-role">{a.role}</span>
                  <span className="login-dev-email">{a.email}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

const loginStyles = `
  .login-page {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: linear-gradient(135deg, var(--green-50) 0%, var(--bg-secondary) 50%, var(--surface) 100%);
  }
  .login-card {
    width: 100%;
    max-width: 400px;
  }
  .login-header {
    text-align: center;
    padding: 32px 32px 0;
  }
  .login-logo {
    width: 48px;
    height: 48px;
    border-radius: var(--radius-lg);
    background: var(--green-600);
    color: white;
    font-size: 22px;
    font-weight: 800;
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 0 auto 16px;
    box-shadow: var(--shadow-sm);
  }
  .login-title {
    font-size: 22px;
    font-weight: 800;
    letter-spacing: -0.02em;
    color: var(--gray-900);
  }
  .login-subtitle {
    font-size: 14px;
    color: var(--gray-500);
    margin-top: 4px;
  }
  .login-form {
    padding: 24px 32px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .login-footer {
    padding: 16px 32px 24px;
    border-top: 1px solid var(--border-light);
  }
  .login-dev-label {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--gray-400);
    margin-bottom: 8px;
    text-align: center;
  }
  .login-dev-accounts {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .login-dev-btn {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    border: 1px solid var(--border-light);
    border-radius: var(--radius-md);
    background: var(--surface);
    cursor: pointer;
    transition: all 0.12s;
    font-family: inherit;
  }
  .login-dev-btn:hover {
    background: var(--green-50);
    border-color: var(--green-200);
  }
  .login-dev-role {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--green-700);
    background: var(--green-50);
    padding: 2px 8px;
    border-radius: 10px;
    min-width: 72px;
    text-align: center;
  }
  .login-dev-email {
    font-size: 13px;
    color: var(--gray-600);
  }
`;
