'use client';

import { useEffect, useState } from 'react';
import { api, requireRole } from '../../lib/auth';

export default function BillingSettingsPage() {
  const [status, setStatus] = useState<any>(null);
  const [plans, setPlans] = useState<any[]>([]);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [changingPlan, setChangingPlan] = useState<string | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);

  const load = async () => {
    const [statusRes, plansRes, invRes] = await Promise.all([
      api('/billing/status'),
      api('/billing/plans'),
      api('/billing/invoices').catch(() => ({ items: [] })),
    ]);
    setStatus(statusRes);
    setPlans(plansRes.items || []);
    setInvoices(invRes.items || []);
  };

  useEffect(() => { load().catch((e) => setError(e.message)); }, []);
  if (!requireRole(['admin'])) return <div className="page"><p>Unauthorized</p></div>;

  const fmtCurrency = (total: number, currency: string) => {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency?.toUpperCase() || 'USD' }).format(total / 100);
  };

  const fmtDate = (iso: string) => {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const STATUS_PILL: Record<string, string> = {
    active: 'pill-green',
    trialing: 'pill-blue',
    past_due: 'pill-red',
    suspended: 'pill-red',
    cancelled: 'pill-gray',
  };

  const INV_PILL: Record<string, string> = {
    paid: 'pill-green',
    open: 'pill-amber',
    void: 'pill-gray',
    uncollectible: 'pill-red',
  };

  return (
    <>
      <style>{styles}</style>
      <div className="page bl-page">
        <div className="bl-top">
          <div>
            <h1>Billing</h1>
            <p style={{ color: 'var(--gray-500)', marginTop: 2 }}>Manage your plan, usage, and payment details</p>
          </div>
        </div>

        {error && (
          <div className="alert alert-error" style={{ marginBottom: 16 }}>
            <span>⚠</span> {error}
            <button className="btn btn-ghost btn-sm" onClick={() => setError('')} style={{ marginLeft: 'auto' }}>✕</button>
          </div>
        )}
        {success && (
          <div className="alert alert-success" style={{ marginBottom: 16 }}>
            <span>✓</span> {success}
            <button className="btn btn-ghost btn-sm" onClick={() => setSuccess('')} style={{ marginLeft: 'auto' }}>✕</button>
          </div>
        )}

        {!status ? (
          <div style={{ textAlign: 'center', padding: 60 }}>
            <div className="spinner spinner-lg" style={{ margin: '0 auto' }} />
          </div>
        ) : (
          <div className="bl-grid">

            {/* ── Current Plan ── */}
            <div className="card bl-card">
              <div className="bl-card-head">
                <div className="bl-card-title">Current Plan</div>
                <span className={`pill ${STATUS_PILL[status.account.status] || 'pill-gray'}`}>
                  <span className="pill-dot" />{status.account.status}
                </span>
              </div>
              <div className="bl-plan-name">{status.account.plan_id}</div>
              <div className="bl-meta-row">
                <span className="bl-meta-label">Next billing date</span>
                <span className="bl-meta-value">{fmtDate(status.account.next_billing_date)}</span>
              </div>
              {status.account.trial_ends_at && (
                <div className="bl-meta-row">
                  <span className="bl-meta-label">Trial ends</span>
                  <span className="bl-meta-value">{fmtDate(status.account.trial_ends_at)}</span>
                </div>
              )}
              <div className="bl-card-actions">
                <button
                  className="btn btn-secondary btn-sm"
                  disabled={portalLoading}
                  onClick={async () => {
                    setPortalLoading(true);
                    try {
                      const result = await api('/billing/portal', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ return_url: window.location.href }),
                      });
                      window.location.href = result.url;
                    } catch (e: any) {
                      setError(e.message || 'Failed to open billing portal');
                      setPortalLoading(false);
                    }
                  }}
                >
                  {portalLoading ? 'Opening…' : '💳 Manage Payment Method'}
                </button>
              </div>
            </div>

            {/* ── Usage ── */}
            <div className="card bl-card">
              <div className="bl-card-head">
                <div className="bl-card-title">Usage</div>
              </div>
              {[
                { label: 'Drivers', used: status.usage.max_drivers, limit: status.limits.max_drivers },
                { label: 'Dispatchers', used: status.usage.max_dispatchers, limit: status.limits.max_dispatchers },
                { label: 'Daily Loads', used: status.usage.max_daily_loads, limit: status.limits.max_daily_loads },
              ].map(({ label, used, limit }) => {
                const pct = limit ? Math.min(Math.round(used / limit * 100), 100) : 0;
                const color = !limit ? 'green' : pct >= 100 ? 'red' : pct >= 80 ? 'amber' : 'green';
                return (
                  <div key={label} className="bl-usage-row">
                    <div className="bl-usage-label">
                      <span>{label}</span>
                      <span className="bl-usage-count">{used} / {limit ?? '∞'}</span>
                    </div>
                    <div className="bl-usage-track">
                      <div className={`bl-usage-fill bl-fill-${color}`} style={{ width: limit ? `${pct}%` : '0%' }} />
                    </div>
                  </div>
                );
              })}

              {status.warnings?.length > 0 && (
                <div className="bl-warnings">
                  {status.warnings.map((w: any, i: number) => (
                    <div key={i} className="bl-warning-item">
                      ⚠ {w.message || `${w.resource} at ${w.used}/${w.limit}`}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ── Change Plan ── */}
            {plans.length > 0 && (
              <div className="card bl-card bl-card-full">
                <div className="bl-card-head">
                  <div className="bl-card-title">Available Plans</div>
                </div>
                <div className="bl-plans-grid">
                  {plans.map((p) => {
                    const isCurrent = p.plan_id === status.account.plan_id;
                    return (
                      <div key={p.plan_id} className={`bl-plan-card${isCurrent ? ' current' : ''}`}>
                        <div className="bl-plan-card-name">{p.name}</div>
                        <div className="bl-plan-limits">
                          <div className="bl-plan-limit-item">
                            <span>Drivers</span><span>{p.limits.max_drivers ?? '∞'}</span>
                          </div>
                          <div className="bl-plan-limit-item">
                            <span>Dispatchers</span><span>{p.limits.max_dispatchers ?? '∞'}</span>
                          </div>
                          <div className="bl-plan-limit-item">
                            <span>Daily Loads</span><span>{p.limits.max_daily_loads ?? '∞'}</span>
                          </div>
                        </div>
                        {isCurrent ? (
                          <div className="bl-plan-current-badge">Current Plan</div>
                        ) : (
                          <button
                            className="btn btn-secondary btn-sm"
                            style={{ width: '100%', marginTop: 12 }}
                            disabled={changingPlan === p.plan_id}
                            onClick={async () => {
                              setChangingPlan(p.plan_id);
                              try {
                                await api('/billing/change-plan', {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ plan_id: p.plan_id }),
                                });
                                setSuccess(`Switched to ${p.name}`);
                                await load();
                              } catch (e: any) {
                                setError(e.message || 'Failed to change plan');
                              } finally {
                                setChangingPlan(null);
                              }
                            }}
                          >
                            {changingPlan === p.plan_id ? 'Switching…' : `Switch to ${p.name}`}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ── Invoices ── */}
            <div className="card bl-card bl-card-full">
              <div className="bl-card-head">
                <div className="bl-card-title">Invoices</div>
              </div>
              {invoices.length === 0 ? (
                <div className="no-loads" style={{ padding: '16px 0' }}>No invoices yet.</div>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Invoice</th>
                      <th>Status</th>
                      <th>Amount</th>
                      <th>Date</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.map((inv) => (
                      <tr key={inv.id}>
                        <td style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{inv.number || inv.id}</td>
                        <td><span className={`pill ${INV_PILL[inv.status] || 'pill-gray'}`}><span className="pill-dot" />{inv.status}</span></td>
                        <td style={{ fontWeight: 600 }}>{fmtCurrency(inv.total, inv.currency)}</td>
                        <td style={{ color: 'var(--gray-500)', fontSize: 13 }}>{fmtDate(inv.created)}</td>
                        <td>
                          {inv.hosted_invoice_url && (
                            <a href={inv.hosted_invoice_url} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">
                              View ↗
                            </a>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

          </div>
        )}
      </div>
    </>
  );
}

const styles = `
  .bl-page { max-width: 960px; }
  .bl-top { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 24px; flex-wrap: wrap; gap: 12px; }
  .bl-top h1 { font-size: 28px; font-weight: 800; letter-spacing: -0.02em; margin: 0; }

  .bl-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .bl-card { padding: 20px 24px; display: flex; flex-direction: column; gap: 14px; }
  .bl-card-full { grid-column: 1 / -1; }
  .bl-card-head { display: flex; align-items: center; justify-content: space-between; }
  .bl-card-title { font-family: var(--font-heading); font-size: 14px; font-weight: 700; color: var(--gray-500); text-transform: uppercase; letter-spacing: 0.06em; }
  .bl-card-actions { margin-top: 4px; }

  .bl-plan-name { font-family: var(--font-heading); font-size: 26px; font-weight: 800; color: var(--gray-900); letter-spacing: -0.02em; }
  .bl-meta-row { display: flex; justify-content: space-between; align-items: center; font-size: 13px; }
  .bl-meta-label { color: var(--gray-500); }
  .bl-meta-value { font-weight: 600; color: var(--gray-800); }

  .bl-usage-row { display: flex; flex-direction: column; gap: 5px; }
  .bl-usage-label { display: flex; justify-content: space-between; font-size: 13px; font-family: var(--font-heading); font-weight: 600; color: var(--gray-700); }
  .bl-usage-count { color: var(--gray-500); font-weight: 500; }
  .bl-usage-track { height: 6px; border-radius: 3px; background: var(--gray-100); overflow: hidden; }
  .bl-usage-fill { height: 100%; border-radius: 3px; transition: width 0.3s var(--ease-out); }
  .bl-fill-green { background: var(--green-500); }
  .bl-fill-amber { background: var(--amber-400); }
  .bl-fill-red { background: var(--red-500); }

  .bl-warnings { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
  .bl-warning-item { font-size: 13px; color: #92400e; background: #fffbeb; border: 1px solid #fde68a; border-radius: var(--radius-md); padding: 8px 12px; }

  .bl-plans-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
  .bl-plan-card { border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 16px; display: flex; flex-direction: column; gap: 8px; transition: box-shadow 0.15s; }
  .bl-plan-card:hover { box-shadow: var(--shadow-sm); }
  .bl-plan-card.current { border-color: var(--blue-500); background: rgba(37,99,235,0.04); }
  .bl-plan-card-name { font-family: var(--font-heading); font-size: 16px; font-weight: 800; color: var(--gray-900); }
  .bl-plan-limits { display: flex; flex-direction: column; gap: 4px; margin-top: 4px; }
  .bl-plan-limit-item { display: flex; justify-content: space-between; font-size: 12px; color: var(--gray-500); }
  .bl-plan-limit-item span:last-child { font-weight: 700; color: var(--gray-700); }
  .bl-plan-current-badge { font-family: var(--font-heading); font-size: 12px; font-weight: 700; color: var(--blue-600); text-align: center; margin-top: 12px; padding: 6px; border-radius: var(--radius-sm); background: rgba(37,99,235,0.08); }

  @media (max-width: 640px) {
    .bl-grid { grid-template-columns: 1fr; }
    .bl-card-full { grid-column: 1; }
  }
`;
