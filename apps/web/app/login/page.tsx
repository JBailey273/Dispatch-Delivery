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
            <div className="login-logo">
            <svg width="24" height="24" viewBox="0 0 22 22" fill="none">
              <circle cx="4" cy="15" r="2.5" fill="white"/>
              <circle cx="11" cy="7" r="2.5" fill="white"/>
              <circle cx="18" cy="12" r="2.5" fill="white"/>
              <path d="M6 14L9.5 8.5M13 8L16 11.5" stroke="white" strokeWidth="1.8" strokeLinecap="round"/>
            </svg>
          </div>
          <h1 className="login-title">Loadout</h1>
          <p className="login-subtitle">Sign in to your account</p>

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
    background: #0C0F14;
    position: relative;
    overflow: hidden;
  }
  .login-page::before {
    content: '';
    position: absolute;
    top: -30%;
    left: 50%;
    transform: translateX(-50%);
    width: 600px;
    height: 600px;
    background: radial-gradient(ellipse, rgba(37,99,235,0.08) 0%, transparent 70%);
    pointer-events: none;
  }
  .login-card {
    width: 100%;
    max-width: 400px;
    position: relative;
    z-index: 1;
    border-radius: var(--radius-2xl);
    box-shadow: 0 24px 64px rgba(0,0,0,0.5);
    background: #161B24;
    border: 1px solid rgba(255,255,255,0.08);
  }
  .login-header {
    text-align: center;
    padding: 36px 32px 0;
  }
  .login-logo {
    width: 52px;
    height: 52px;
    border-radius: 13px;
    background: #2563EB;
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 0 auto 18px;
    box-shadow: 0 4px 16px rgba(37,99,235,0.40);
  }
  .login-title {
    font-family: var(--font-heading);
    font-size: 26px;
    font-weight: 800;
    letter-spacing: -0.03em;
    color: #FFFFFF;
  }
  .login-subtitle {
    font-size: 14px;
    color: rgba(255,255,255,0.40);
    margin-top: 6px;
  }
  .login-form {
    padding: 28px 32px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .login-form .form-label {
    color: rgba(255,255,255,0.50);
  }
  .login-form input {
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.10);
    color: #FFFFFF;
    border-radius: var(--radius-md);
  }
  .login-form input::placeholder {
    color: rgba(255,255,255,0.20);
  }
  .login-form input:focus {
    border-color: #2563EB;
    box-shadow: 0 0 0 3px rgba(37,99,235,0.20);
    background: rgba(255,255,255,0.07);
  }
  .login-footer {
    padding: 16px 32px 28px;
    border-top: 1px solid rgba(255,255,255,0.07);
  }
  .login-dev-label {
    font-family: var(--font-heading);
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: rgba(255,255,255,0.22);
    margin-bottom: 10px;
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
    padding: 9px 12px;
    border: 1px solid rgba(255,255,255,0.07);
    border-radius: var(--radius-md);
    background: rgba(255,255,255,0.03);
    cursor: pointer;
    transition: all 0.12s;
    font-family: inherit;
  }
  .login-dev-btn:hover {
    background: rgba(255,255,255,0.07);
    border-color: rgba(255,255,255,0.12);
  }
  .login-dev-role {
    font-family: var(--font-heading);
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #2563EB;
    background: rgba(37,99,235,0.12);
    padding: 3px 8px;
    border-radius: 6px;
    min-width: 72px;
    text-align: center;
  }
  .login-dev-email {
    font-size: 12px;
    color: rgba(255,255,255,0.35);
  }
`;
