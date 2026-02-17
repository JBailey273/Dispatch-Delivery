'use client';

import { useEffect, useState } from 'react';
import { api, requireRole } from '../../lib/auth';

export default function BillingSettingsPage() {
  const [status, setStatus] = useState<any>(null);
  const [plans, setPlans] = useState<any[]>([]);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [error, setError] = useState('');

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
  if (!requireRole(['admin'])) return <p>Unauthorized</p>;
  if (!status) return <p>Loading...</p>;

  return <main>
    <h1>Administration / Billing</h1>
    {error && <p>{error}</p>}
    <p><strong>Current plan:</strong> {status.account.plan_id} ({status.account.status})</p>
    <p><strong>Next billing date:</strong> {status.account.next_billing_date || 'n/a'}</p>

    {status.warnings?.map((w: any, idx: number) => (
      <p key={idx} style={{ color: '#b45309' }}>
        ⚠️ {w.message || `${w.resource}: ${w.used}/${w.limit}`}
      </p>
    ))}

    <h2>Usage vs limits</h2>
    <ul>
      <li>Drivers: {status.usage.max_drivers} / {status.limits.max_drivers ?? 'unlimited'}</li>
      <li>Dispatchers: {status.usage.max_dispatchers} / {status.limits.max_dispatchers ?? 'unlimited'}</li>
      <li>Daily loads: {status.usage.max_daily_loads} / {status.limits.max_daily_loads ?? 'unlimited'}</li>
    </ul>

    <h2>Change plan</h2>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {plans.map((p) => (
        <button
          key={p.plan_id}
          onClick={async () => {
            await api('/billing/change-plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan_id: p.plan_id }) });
            await load();
          }}
        >
          {p.name}
        </button>
      ))}
    </div>

    <h2>Payment method</h2>
    <button onClick={async () => {
      const result = await api('/billing/portal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ return_url: window.location.href }) });
      window.location.href = result.url;
    }}>Update payment method</button>

    <h2>Invoices</h2>
    <ul>
      {invoices.length === 0 && <li>No invoices yet.</li>}
      {invoices.map((inv) => (
        <li key={inv.id}>
          {inv.number || inv.id} - {inv.status} - {inv.total} {inv.currency}
          {inv.hosted_invoice_url && <a href={inv.hosted_invoice_url} target="_blank"> view</a>}
        </li>
      ))}
    </ul>
  </main>;
}
