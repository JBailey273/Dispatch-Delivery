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
  stripe_customer_id: string | null;
  orders: InvoiceOrder[];
};

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
      const map = new Map<string, ContractorGroup>();
      for (const order of data.invoiced as InvoiceOrder[]) {
        const key = order.email || order.customer_name;
        if (!map.has(key)) {
          map.set(key, {
            customer_name: order.customer_name,
            company_name: order.company_name,
            email: order.email,
            phone: order.phone,
            stripe_customer_id: null,
            orders: [],
          });
        }
        map.get(key)!.orders.push(order);
      }
      setGroups(Array.from(map.values()));
    } catch {
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
    <>
      <style>{styles}</style>
      <div className="page billing-page">

        <div className="page-header">
          <div>
            <h1>Contractor Billing</h1>
            <p className="page-header-sub">Outstanding invoice orders by contractor</p>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={load} disabled={loading}>↻ Refresh</button>
        </div>

        {error && (
          <div className="alert alert-error" style={{ marginBottom: 16 }}>
            <span>⚠</span> {error}
            <button className="btn btn-ghost btn-sm" onClick={() => setError('')} style={{ marginLeft: 'auto' }}>✕</button>
          </div>
        )}

        {loading && (
          <div style={{ textAlign: 'center', padding: 60 }}>
            <div className="spinner spinner-lg" style={{ margin: '0 auto' }} />
          </div>
        )}

        {!loading && groups.length === 0 && !error && (
          <div className="card">
            <div className="empty-state">
              <div className="empty-state-icon">🧾</div>
              <div className="empty-state-title">No outstanding invoices</div>
              <div className="empty-state-desc">Invoice orders will appear here once contractors place orders with invoice billing.</div>
            </div>
          </div>
        )}

        {!loading && groups.length > 0 && (
          <div className="billing-list">
            {groups.map(group => {
              const key = group.email || group.customer_name;
              const succeeded = chargeSuccess[key];
              return (
                <div key={key} className="card billing-card">
                  <div className="billing-card-header">
                    <div className="billing-card-customer">
                      <div className="billing-card-name">
                        {group.customer_name}
                        {group.company_name && (
                          <span className="billing-card-company">{group.company_name}</span>
                        )}
                      </div>
                      <div className="billing-card-contact">
                        {group.email && <span>{group.email}</span>}
                        {group.phone && <span>{group.phone}</span>}
                      </div>
                    </div>
                    <div className="billing-card-actions">
                      <span className="billing-order-count">
                        {group.orders.length} order{group.orders.length !== 1 ? 's' : ''}
                      </span>
                      {!group.stripe_customer_id && (
                        <span className="pill pill-amber">No card on file</span>
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

                  <div className="billing-order-list">
                    {group.orders.map(order => (
                      <div key={order.drop_id} className="billing-order-row">
                        <div className="billing-order-meta">
                          <span className="billing-order-num">#{order.order_number}</span>
                          <span className="billing-order-date">
                            {order.scheduled_date || order.created_at?.slice(0, 10) || '—'}
                          </span>
                          <span className="pill pill-gray" style={{ fontSize: 11, padding: '1px 6px' }}>
                            {order.delivery_method}
                          </span>
                        </div>
                        <div>
                          {order.payment_status === 'paid'
                            ? <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--green-600)' }}>Paid</span>
                            : <span style={{ fontSize: 12, color: 'var(--gray-400)' }}>Unpaid</span>}
                        </div>
                        {order.payment_note && (
                          <div className="billing-order-note">{order.payment_note}</div>
                        )}
                      </div>
                    ))}
                  </div>

                  {chargeError[key] && (
                    <div className="billing-charge-error">⚠ {chargeError[key]}</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

const styles = `
  .billing-page { max-width: 780px; }

  .billing-list {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .billing-card { padding: 0; }

  .billing-card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border-subtle);
    flex-wrap: wrap;
  }

  .billing-card-name {
    font-family: var(--font-heading);
    font-size: 15px;
    font-weight: 700;
    color: var(--gray-900);
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .billing-card-company {
    font-size: 13px;
    font-weight: 400;
    color: var(--gray-400);
  }

  .billing-card-contact {
    display: flex;
    gap: 12px;
    font-size: 12px;
    color: var(--gray-400);
    margin-top: 3px;
  }

  .billing-card-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }

  .billing-order-count {
    font-size: 13px;
    color: var(--gray-400);
  }

  .billing-order-list {
    padding: 4px 0;
  }

  .billing-order-row {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: 8px 16px;
    padding: 10px 20px;
    border-bottom: 1px solid var(--border-subtle);
  }
  .billing-order-row:last-child { border-bottom: none; }

  .billing-order-meta {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  .billing-order-num {
    font-family: var(--font-heading);
    font-size: 13px;
    font-weight: 600;
    color: var(--gray-800);
  }

  .billing-order-date {
    font-size: 12px;
    color: var(--gray-400);
  }

  .billing-order-note {
    font-size: 12px;
    color: var(--gray-400);
    grid-column: 1 / -1;
  }

  .billing-charge-error {
    padding: 10px 20px;
    background: var(--red-50);
    color: var(--red-600);
    font-size: 13px;
    border-top: 1px solid var(--border-subtle);
  }

  @media (max-width: 600px) {
    .billing-card-header { flex-direction: column; align-items: flex-start; }
    .billing-card-actions { width: 100%; justify-content: flex-end; }
  }
`;
