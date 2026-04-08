'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, requireRole } from '../../lib/auth';

type InvoiceOrder = {
  drop_id: string;
  order_number: string;
  customer_name: string;
  company_name: string | null;
  phone: string | null;
  email: string | null;
  payment_note: string | null;
  payment_status: string;
  delivery_method: string;
  scheduled_date: string | null;
  created_at: string | null;
  wc_order_id: string | null;
};

type ContractorGroup = {
  customer_name: string;
  company_name: string | null;
  email: string | null;
  phone: string | null;
  local_customer_id: string | null;
  stripe_customer_id: string | null;
  orders: InvoiceOrder[];
  total: number;
};

function fmt(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export default function BillingPage() {
  const [groups, setGroups] = useState<ContractorGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [charging, setCharging] = useState<string | null>(null);
  const [chargeError, setChargeError] = useState<Record<string, string>>({});
  const [chargeSuccess, setChargeSuccess] = useState<Record<string, boolean>>({});

  if (!requireRole(['dispatcher', 'admin'])) {
    return <div className="page"><p>Unauthorized</p></div>;
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api('/internal-orders/invoiced-orders');
      // Group by customer name+email
      const map = new Map<string, ContractorGroup>();
      for (const order of data.invoiced as InvoiceOrder[]) {
        const key = order.email || order.customer_name;
        if (!map.has(key)) {
          map.set(key, {
            customer_name: order.customer_name,
            company_name: order.company_name,
            email: order.email,
            phone: order.phone,
            local_customer_id: null,
            stripe_customer_id: null,
            orders: [],
            total: 0,
          });
        }
        // We'll need to fetch totals from WC — for now use payment_note or mark as pending
        map.get(key)!.orders.push(order);
      }
      setGroups(Array.from(map.values()));
    } catch (e) {
      setError('Failed to load invoiced orders.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCharge = async (group: ContractorGroup) => {
    const key = group.email || group.customer_name;
    if (!group.stripe_customer_id) {
      setChargeError(prev => ({ ...prev, [key]: 'No Stripe card on file for this customer.' }));
      return;
    }
    const wc_order_ids = group.orders
      .filter(o => o.wc_order_id)
      .map(o => parseInt(o.wc_order_id!));
    if (wc_order_ids.length === 0) {
      setChargeError(prev => ({ ...prev, [key]: 'No WooCommerce order IDs found.' }));
      return;
    }
    setCharging(key);
    setChargeError(prev => { const n = { ...prev }; delete n[key]; return n; });
    try {
      await api('/internal-orders/charge-contractor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wc_customer_id: 0,
          stripe_customer_id: group.stripe_customer_id,
          wc_order_ids,
        }),
      });
      setChargeSuccess(prev => ({ ...prev, [key]: true }));
      load();
    } catch (e: any) {
      setChargeError(prev => ({ ...prev, [key]: e.message || 'Charge failed.' }));
    } finally {
      setCharging(null);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Contractor Billing</h1>
          <p className="page-subtitle">Outstanding invoice orders by contractor</p>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={load}>↻ Refresh</button>
      </div>

      {loading && <div className="page-empty">Loading…</div>}
      {error && <div className="alert alert-error">{error}</div>}

      {!loading && groups.length === 0 && (
        <div className="page-empty">No outstanding invoiced orders. All clear.</div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 780 }}>
        {groups.map(group => {
          const key = group.email || group.customer_name;
          const succeeded = chargeSuccess[key];
          return (
            <div key={key} className="card" style={{ padding: 0, overflow: 'hidden' }}>
              {/* Header */}
              <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--gray-100)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>
                    {group.customer_name}
                    {group.company_name && <span style={{ fontWeight: 400, color: 'var(--gray-400)', marginLeft: 8, fontSize: 13 }}>{group.company_name}</span>}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--gray-400)', marginTop: 2 }}>
                    {group.email && <span>{group.email}</span>}
                    {group.phone && <span style={{ marginLeft: 12 }}>{group.phone}</span>}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ fontSize: 13, color: 'var(--gray-500)' }}>
                    {group.orders.length} order{group.orders.length !== 1 ? 's' : ''}
                  </div>
                  {!group.stripe_customer_id && (
                    <span style={{ fontSize: 11, background: '#fef3c7', color: '#92400e', borderRadius: 6, padding: '2px 8px', fontWeight: 600 }}>
                      No card on file
                    </span>
                  )}
                  {succeeded ? (
                    <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--green-600)' }}>✓ Charged</span>
                  ) : (
                    <button
                      className="btn btn-primary btn-sm"
                      disabled={charging === key || !group.stripe_customer_id}
                      onClick={() => handleCharge(group)}
                    >
                      {charging === key ? 'Charging…' : 'Charge Now'}
                    </button>
                  )}
                </div>
              </div>

              {/* Order rows */}
              <div style={{ padding: '8px 0' }}>
                {group.orders.map(order => (
                  <div key={order.drop_id} style={{ padding: '10px 20px', display: 'grid', gridTemplateColumns: '1fr auto', gap: '4px 16px', borderBottom: '1px solid var(--gray-50)' }}>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>#{order.order_number}</span>
                      <span style={{ fontSize: 12, color: 'var(--gray-400)' }}>{order.scheduled_date || order.created_at?.slice(0, 10) || '—'}</span>
                      <span style={{ fontSize: 11, background: 'var(--gray-100)', color: 'var(--gray-500)', borderRadius: 4, padding: '1px 6px', textTransform: 'capitalize' }}>{order.delivery_method}</span>
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--gray-400)', textAlign: 'right' }}>
                      {order.payment_status === 'paid'
                        ? <span style={{ color: 'var(--green-600)', fontWeight: 600 }}>Paid</span>
                        : <span style={{ color: 'var(--gray-500)' }}>Unpaid</span>}
                    </div>
                    {order.payment_note && (
                      <div style={{ fontSize: 12, color: 'var(--gray-400)', gridColumn: '1 / -1' }}>{order.payment_note}</div>
                    )}
                  </div>
                ))}
              </div>

              {chargeError[key] && (
                <div style={{ padding: '10px 20px', background: '#fef2f2', color: '#dc2626', fontSize: 13 }}>
                  ⚠ {chargeError[key]}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
