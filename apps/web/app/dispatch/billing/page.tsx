'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, requireRole } from '../../lib/auth';
import DropRescheduleSlideOver from '../../components/DropRescheduleSlideOver';

type InvoiceOrder = {
  drop_id: string;
  order_number: string;
  customer_name: string;
  company_name: string | null;
  phone: string | null;
  email: string | null;
  stripe_customer_id: string | null;
  local_customer_id: string | null;
  payment_note: string | null;
  payment_status: string;
  delivery_method: string;
  scheduled_date: string | null;
  created_at: string | null;
  wc_order_id: string | null;
  order_total: number | null;
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
  const [markingPaid, setMarkingPaid] = useState<string | null>(null);
  const [markPaidSuccess, setMarkPaidSuccess] = useState<Record<string, boolean>>({});
  const [checkedOrders, setCheckedOrders] = useState<Record<string, Set<string>>>({});
  const [slideDropId, setSlideDropId] = useState<string | null>(null);

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
            stripe_customer_id: order.stripe_customer_id || null,
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

  /* ── Checkbox helpers ── */
  const getChecked = (group: ContractorGroup): Set<string> => {
    const key = group.email || group.customer_name;
    if (checkedOrders[key]) return checkedOrders[key];
    return new Set(group.orders.map(o => o.wc_order_id!).filter(Boolean));
  };

  const toggleOrder = (groupKey: string, wc_order_id: string) => {
    setCheckedOrders(prev => {
      const group = groups.find(g => (g.email || g.customer_name) === groupKey)!;
      const current = prev[groupKey] ? new Set(prev[groupKey]) : new Set(group.orders.map(o => o.wc_order_id!).filter(Boolean));
      if (current.has(wc_order_id)) current.delete(wc_order_id);
      else current.add(wc_order_id);
      return { ...prev, [groupKey]: current };
    });
  };

  const toggleAll = (group: ContractorGroup) => {
    const key = group.email || group.customer_name;
    const checked = getChecked(group);
    const allIds = group.orders.map(o => o.wc_order_id!).filter(Boolean);
    const allChecked = allIds.every(id => checked.has(id));
    setCheckedOrders(prev => ({
      ...prev,
      [key]: allChecked ? new Set() : new Set(allIds),
    }));
  };

  const checkedTotal = (group: ContractorGroup): number => {
    const checked = getChecked(group);
    return group.orders
      .filter(o => o.wc_order_id && checked.has(o.wc_order_id))
      .reduce((s, o) => s + (o.order_total || 0), 0);
  };

  const selectedOrders = (group: ContractorGroup): InvoiceOrder[] => {
    const checked = getChecked(group);
    return group.orders.filter(o => o.wc_order_id && checked.has(o.wc_order_id));
  };

  /* ── Charge card ── */
  const handleCharge = async (group: ContractorGroup) => {
    const key = group.email || group.customer_name;
    if (!group.stripe_customer_id) {
      setChargeError(prev => ({ ...prev, [key]: 'No Stripe card on file for this customer.' }));
      return;
    }
    const selected = selectedOrders(group);
    const wc_order_ids = selected.filter(o => o.wc_order_id).map(o => parseInt(o.wc_order_id!));
    if (wc_order_ids.length === 0) {
      setChargeError(prev => ({ ...prev, [key]: 'No orders selected.' }));
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

  /* ── Mark paid (cash/check) ── */
  const handleMarkPaid = async (group: ContractorGroup) => {
    const key = group.email || group.customer_name;
    const selected = selectedOrders(group);
    const wc_order_ids = selected.filter(o => o.wc_order_id).map(o => parseInt(o.wc_order_id!));
    if (wc_order_ids.length === 0) {
      setChargeError(prev => ({ ...prev, [key]: 'No orders selected.' }));
      return;
    }
    setMarkingPaid(key);
    setChargeError(prev => { const n = { ...prev }; delete n[key]; return n; });
    try {
      const orders_summary = selected.map(o => ({
        order_number: o.order_number,
        date: o.scheduled_date || o.created_at?.slice(0, 10) || '',
        total: o.order_total?.toFixed(2) || '0',
        delivery_method: o.delivery_method,
      }));
      await api('/internal-orders/mark-paid-cash', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wc_order_ids,
          customer_email: group.email,
          customer_name: group.customer_name,
          company_name: group.company_name,
          orders_summary,
          batch_total: checkedTotal(group),
        }),
      });
      setMarkPaidSuccess(prev => ({ ...prev, [key]: true }));
      load();
    } catch (e: any) {
      setChargeError(prev => ({ ...prev, [key]: e.message || 'Failed to mark paid.' }));
    } finally {
      setMarkingPaid(null);
    }
  };

  /* ── Print statement ── */
  const printStatement = (group: ContractorGroup) => {
    const selected = selectedOrders(group);
    const total = checkedTotal(group);
    const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const displayName = group.company_name || group.customer_name;

    const rows = selected.map(o => `
      <tr>
        <td class="td">#${o.order_number}</td>
        <td class="td">${o.scheduled_date || o.created_at?.slice(0, 10) || '—'}</td>
        <td class="td" style="text-transform:capitalize">${o.delivery_method}</td>
        <td class="td right">${o.order_total != null ? '$' + o.order_total.toFixed(2) : '—'}</td>
      </tr>`).join('');

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Statement — ${displayName}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap');
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Plus Jakarta Sans', sans-serif; color: #111; background: #fff; padding: 40px; font-size: 13px; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #111; padding-bottom: 16px; margin-bottom: 24px; }
    .co { font-size: 18px; font-weight: 800; }
    .co-sub { font-size: 11px; color: #555; margin-top: 2px; }
    .stmt-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #555; text-align: right; }
    .stmt-title { font-size: 24px; font-weight: 800; text-align: right; }
    .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 28px; }
    .meta-block dt { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #777; margin-bottom: 3px; }
    .meta-block dd { font-size: 14px; font-weight: 700; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
    th { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #777; border-bottom: 1px solid #ddd; padding: 0 0 8px; text-align: left; }
    th.right { text-align: right; }
    .td { padding: 10px 0; border-bottom: 1px solid #eee; font-size: 13px; font-weight: 600; }
    .right { text-align: right; }
    .total-row { display: flex; justify-content: space-between; padding: 14px 0 0; border-top: 2px solid #111; margin-top: 4px; font-size: 16px; font-weight: 800; }
    .footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #ddd; font-size: 11px; color: #777; text-align: center; }
  </style>
</head>
<body>
  <div class="header">
    <div><div class="co">East Meadow Garden Center</div><div class="co-sub">16 Somers Road, Hampden, MA 01036</div></div>
    <div><div class="stmt-label">Statement</div><div class="stmt-title">Invoice</div></div>
  </div>
  <div class="meta">
    <dl class="meta-block"><dt>Billed To</dt><dd>${displayName}${group.company_name && group.customer_name !== group.company_name ? `<br/><span style="font-weight:400;font-size:12px;color:#555">${group.customer_name}</span>` : ''}</dd></dl>
    <dl class="meta-block"><dt>Statement Date</dt><dd>${today}</dd></dl>
    ${group.email ? `<dl class="meta-block"><dt>Email</dt><dd style="font-size:12px;font-weight:600">${group.email}</dd></dl>` : ''}
    ${group.phone ? `<dl class="meta-block"><dt>Phone</dt><dd style="font-size:12px;font-weight:600">${group.phone}</dd></dl>` : ''}
  </div>
  <table>
    <thead><tr><th>Order</th><th>Date</th><th>Type</th><th class="right">Amount</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="total-row"><span>Total</span><span>$${total.toFixed(2)}</span></div>
  <div class="footer"><p>Thank you for your business — eastmeadowgardencenter.com</p></div>
</body>
</html>`;

    const win = window.open('', '_blank', 'width=700,height=900');
    if (!win) return;
    win.document.write(html);
    win.document.close();
    win.onload = () => win.print();
  };

  /* ══════════════════════════════════════════
     RENDER
     ══════════════════════════════════════════ */
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
              const chargeSucceeded = chargeSuccess[key];
              const markSucceeded = markPaidSuccess[key];
              const checked = getChecked(group);
              const allChecked = group.orders.every(o => o.wc_order_id && checked.has(o.wc_order_id));
              const noneChecked = checked.size === 0;
              const total = checkedTotal(group);

              return (
                <div key={key} className="card billing-card">

                  {/* ── Card header ── */}
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
                      <div className="billing-summary">
                        <span className="billing-order-count">
                          {checked.size} of {group.orders.length} selected
                        </span>
                        <span className="billing-selected-total">
                          ${total.toFixed(2)}
                        </span>
                      </div>

                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => printStatement(group)}
                        disabled={noneChecked}
                        title="Print statement for selected orders"
                      >
                        🖨 Print
                      </button>

                      {!group.stripe_customer_id && (
                        <span className="pill pill-amber">No card on file</span>
                      )}

                      {markSucceeded ? (
                        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--green-600)' }}>✓ Marked Paid</span>
                      ) : (
                        <button
                          className="btn btn-secondary btn-sm"
                          disabled={markingPaid === key || noneChecked}
                          onClick={() => handleMarkPaid(group)}
                        >
                          {markingPaid === key ? 'Saving…' : '✓ Mark Paid'}
                        </button>
                      )}

                      {chargeSucceeded ? (
                        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--green-600)' }}>✓ Charged</span>
                      ) : (
                        <button
                          className="btn btn-primary btn-sm"
                          disabled={charging === key || !group.stripe_customer_id || noneChecked}
                          onClick={() => handleCharge(group)}
                        >
                          {charging === key ? 'Charging…' : 'Charge Now'}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* ── Select all row ── */}
                  <div className="billing-select-all-row">
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={allChecked}
                        onChange={() => toggleAll(group)}
                        style={{ width: 15, height: 15, accentColor: 'var(--blue-600,#2563eb)', cursor: 'pointer' }}
                      />
                      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        Select All
                      </span>
                    </label>
                  </div>

                  {/* ── Order rows ── */}
                  <div className="billing-order-list">
                    {group.orders.map(order => {
                      const isPaid = order.payment_status === 'paid';
                      const isChecked = order.wc_order_id ? checked.has(order.wc_order_id) : false;
                      return (
                        <div key={order.drop_id} className={`billing-order-row${isChecked ? ' checked' : ''}`}>

                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={() => order.wc_order_id && toggleOrder(key, order.wc_order_id)}
                              onClick={e => e.stopPropagation()}
                              style={{ width: 15, height: 15, accentColor: 'var(--blue-600,#2563eb)', cursor: 'pointer', flexShrink: 0 }}
                            />
                            <div className="billing-order-meta">
                              <button
                                className="billing-order-num-btn"
                                onClick={() => setSlideDropId(order.drop_id)}
                              >
                                #{order.order_number}
                              </button>
                              <span className="billing-order-date">
                                {order.scheduled_date || order.created_at?.slice(0, 10) || '—'}
                              </span>
                              <span className={`pill pill-sm ${order.delivery_method === 'delivery' ? 'pill-blue' : 'pill-gray'}`}>
                                <span className="pill-dot" />{order.delivery_method}
                              </span>
                            </div>
                          </div>

                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, flexShrink: 0 }}>
                            {order.order_total != null ? (
                              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--gray-800)' }}>
                                ${order.order_total.toFixed(2)}
                              </span>
                            ) : (
                              <span style={{ fontSize: 12, color: 'var(--gray-300)' }}>—</span>
                            )}
                            {isPaid
                              ? <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--green-600)' }}>Paid</span>
                              : <span style={{ fontSize: 11, color: 'var(--gray-400)' }}>Unpaid</span>}
                          </div>

                          {order.payment_note && (
                            <div className="billing-order-note">{order.payment_note}</div>
                          )}
                        </div>
                      );
                    })}
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

      {slideDropId && (
        <DropRescheduleSlideOver
          dropId={slideDropId}
          onClose={() => setSlideDropId(null)}
          onRescheduled={load}
        />
      )}
    </>
  );
}

const styles = `
  .billing-page { max-width: 820px; }

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
    flex-wrap: wrap;
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
    flex-wrap: wrap;
  }

  .billing-card-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .billing-summary {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 1px;
    margin-right: 4px;
  }

  .billing-order-count {
    font-size: 11px;
    color: var(--gray-400);
  }

  .billing-selected-total {
    font-family: var(--font-heading);
    font-size: 15px;
    font-weight: 700;
    color: var(--gray-800);
  }

  .billing-select-all-row {
    padding: 8px 20px;
    border-bottom: 1px solid var(--border-subtle);
    background: var(--gray-50);
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
    transition: background 0.1s;
  }
  .billing-order-row:last-child { border-bottom: none; }
  .billing-order-row.checked { background: var(--blue-50,#eff6ff); }

  .billing-order-meta {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  .billing-order-num-btn {
    background: none;
    border: none;
    padding: 0;
    font-family: var(--font-heading);
    font-size: 13px;
    font-weight: 700;
    color: var(--blue-600,#2563eb);
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 2px;
    transition: color 0.12s;
  }
  .billing-order-num-btn:hover { color: var(--blue-800,#1e40af); }

  .billing-order-date {
    font-size: 12px;
    color: var(--gray-400);
  }

  .billing-order-note {
    font-size: 12px;
    color: var(--gray-400);
    grid-column: 1 / -1;
    padding-left: 25px;
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
