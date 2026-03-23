'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState, useCallback } from 'react';
import { ApiError, api, requireRole } from '../lib/auth';
import { useLocation } from '../lib/location-context';

/* ── Types ── */
type OrderRow = {
  drop_id: string;
  load_id: string;
  order_ref: string;
  scheduled_date: string | null;
  window: string | null;
  is_priority: boolean;
  customer_name: string;
  customer_phone: string | null;
  address_short: string;
  material: string;
  qty: number;
  unit: string;
  status: string;
  driver_name: string | null;
  delivery_method: string | null;
  created_at: string | null;
};
type Driver = { id: string; name: string };

/* ── Helpers ── */
const FULL_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
function toKey(d: Date) { return d.toISOString().slice(0, 10); }
function fmtDate(ds: string | null) {
  if (!ds) return '—';
  const d = new Date(ds + 'T12:00:00');
  return `${DAYS[d.getDay()].slice(0, 3)}, ${FULL_MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}`;
}
function fmtDateTime(iso: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${DAYS[d.getDay()].slice(0, 3)}, ${FULL_MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()} · ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`;
}

const STATUS_OPTIONS = [
  { value: '', label: 'All Statuses' },
  { value: 'NEW', label: 'Pending' },
  { value: 'ASSIGNED', label: 'Assigned' },
  { value: 'LOADED_LEAVING', label: 'Out for Delivery' },
  { value: 'DELIVERED', label: 'Delivered' },
  { value: 'EXCEPTION', label: 'Exception' },
  { value: 'CANCELLED', label: 'Cancelled' },
];
const STATUS_LABELS: Record<string, string> = {
  NEW: 'Pending', ASSIGNED: 'Assigned', LOADED_LEAVING: 'Out for Delivery',
  DELIVERED: 'Delivered', EXCEPTION: 'Exception', CANCELLED: 'Cancelled',
  new: 'Pending', assigned: 'Assigned', loaded_leaving: 'Out for Delivery',
  delivered: 'Delivered', exception: 'Exception', cancelled: 'Cancelled',
  fulfilled: 'Fulfilled',
};
const STATUS_COLORS: Record<string, string> = {
  NEW: 'var(--amber-600)', ASSIGNED: 'var(--blue-600)', LOADED_LEAVING: 'var(--amber-600)',
  DELIVERED: 'var(--green-600)', EXCEPTION: 'var(--red-600)', CANCELLED: 'var(--gray-400)',
  new: 'var(--amber-600)', assigned: 'var(--blue-600)', loaded_leaving: 'var(--amber-600)',
  delivered: 'var(--green-600)', exception: 'var(--red-600)', cancelled: 'var(--gray-400)',
  fulfilled: 'var(--green-600)',
};

export default function AllOrdersPage() {
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<'deliveries' | 'pickups'>('deliveries');

  // Filters
  const defaultStart = useMemo(() => {
    const d = new Date(); d.setDate(d.getDate() - 14); return toKey(d);
  }, []);
  const defaultEnd = useMemo(() => {
    const d = new Date(); d.setDate(d.getDate() + 3); return toKey(d);
  }, []);
  const [startDate, setStartDate] = useState(defaultStart);
  const [endDate, setEndDate] = useState(defaultEnd);
  const [statusFilter, setStatusFilter] = useState('');
  const [driverFilter, setDriverFilter] = useState('');
  const [customerSearch, setCustomerSearch] = useState('');
  const [materialFilter, setMaterialFilter] = useState('');

  // Sort — deliveries sort by date desc, pickups sort by created_at desc
  const [sortCol, setSortCol] = useState<'date' | 'customer' | 'status' | 'driver' | 'material'>('date');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const toggleSort = (col: typeof sortCol) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir(col === 'date' ? 'desc' : 'asc'); }
  };

  const { activeLocation } = useLocation();

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ start_date: startDate, end_date: endDate });
      if (statusFilter) params.set('status', statusFilter);
      if (driverFilter) params.set('driver_name', driverFilter);
      if (activeLocation) params.set('location_id', activeLocation.id);
      const resp = await api(`/dispatch/orders?${params.toString()}`);
      setOrders(resp.orders || []);
    } catch (err) {
      setError((err as ApiError).message || 'Failed to load orders');
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate, statusFilter, driverFilter, activeLocation]);

  useEffect(() => { fetchOrders(); }, [fetchOrders]);

  useEffect(() => {
    api('/dispatch/drivers').then(d => setDrivers(d.drivers || [])).catch(() => null);
  }, []);

  useEffect(() => {
  const handleVisibility = () => {
    if (document.visibilityState === 'visible') fetchOrders();
  };
  document.addEventListener('visibilitychange', handleVisibility);
  return () => document.removeEventListener('visibilitychange', handleVisibility);
}, [fetchOrders]);
  
  // Split by tab
  const deliveryOrders = useMemo(() => orders.filter(o => o.delivery_method !== 'pickup'), [orders]);
  const pickupOrders = useMemo(() => orders.filter(o => o.delivery_method === 'pickup'), [orders]);
  const tabOrders = activeTab === 'deliveries' ? deliveryOrders : pickupOrders;

  const materialOptions = useMemo(() => {
    const mats = new Set(tabOrders.map(o => o.material).filter(Boolean));
    return Array.from(mats).sort();
  }, [tabOrders]);

  const filtered = useMemo(() => {
    let result = tabOrders;
    if (customerSearch.trim()) {
      const q = customerSearch.toLowerCase();
      result = result.filter(o =>
        o.customer_name?.toLowerCase().includes(q) ||
        o.customer_phone?.includes(q) ||
        o.address_short?.toLowerCase().includes(q)
      );
    }
    if (materialFilter) {
      result = result.filter(o => o.material === materialFilter);
    }
    return result;
  }, [tabOrders, customerSearch, materialFilter]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    const dir = sortDir === 'asc' ? 1 : -1;
    arr.sort((a, b) => {
      switch (sortCol) {
        case 'date':
          if (activeTab === 'pickups') {
            return dir * (a.created_at ?? '').localeCompare(b.created_at ?? '');
          }
          return dir * ((a.scheduled_date ?? '') + (a.window ?? '')).localeCompare((b.scheduled_date ?? '') + (b.window ?? ''));
        case 'customer': return dir * (a.customer_name || '').localeCompare(b.customer_name || '');
        case 'status': return dir * (a.status || '').localeCompare(b.status || '');
        case 'driver': return dir * (a.driver_name || 'zzz').localeCompare(b.driver_name || 'zzz');
        case 'material': return dir * (a.material || '').localeCompare(b.material || '');
        default: return 0;
      }
    });
    return arr;
  }, [filtered, sortCol, sortDir, activeTab]);

  const totalCount = filtered.length;
  const deliveredCount = filtered.filter(o => ['DELIVERED', 'delivered'].includes(o.status)).length;
  const exceptionCount = filtered.filter(o => ['EXCEPTION', 'exception'].includes(o.status)).length;

  const sortIcon = (col: typeof sortCol) => {
    if (sortCol !== col) return '';
    return sortDir === 'asc' ? ' \u25B2' : ' \u25BC';
  };

  if (!requireRole(['dispatcher'])) return <div className="page"><p>Unauthorized</p></div>;

  return (
    <>
      <style>{pageStyles}</style>
      <div className="page ao-page">
        <div className="ao-top">
          <div>
            <h1>All Orders</h1>
            <p className="ao-sub">
              {totalCount} {activeTab === 'pickups' ? 'pickup' : 'delivery'} order{totalCount !== 1 ? 's' : ''}
              {customerSearch || statusFilter || driverFilter || materialFilter ? ' (filtered)' : ''}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-secondary btn-sm" onClick={fetchOrders}>Refresh</button>
            <Link href="/new-drop" className="btn btn-primary btn-sm" style={{ textDecoration: 'none' }}>+ New Order</Link>
          </div>
        </div>

        {/* ── Tabs ── */}
        <div className="ao-tabs">
          <button
            className={`ao-tab ${activeTab === 'deliveries' ? 'ao-tab-active' : ''}`}
            onClick={() => setActiveTab('deliveries')}
          >
            Deliveries
            <span className="ao-tab-count">{deliveryOrders.length}</span>
          </button>
          <button
            className={`ao-tab ${activeTab === 'pickups' ? 'ao-tab-active' : ''}`}
            onClick={() => setActiveTab('pickups')}
          >
            Pickups
            <span className="ao-tab-count">{pickupOrders.length}</span>
          </button>
        </div>

        {/* ── Filters ── */}
        <div className="ao-filters card">
          <div className="ao-filter-row">
            {activeTab === 'deliveries' && (
              <>
                <div className="ao-filter-group">
                  <label className="ao-filter-label">From</label>
                  <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="ao-date-input" />
                </div>
                <div className="ao-filter-group">
                  <label className="ao-filter-label">To</label>
                  <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="ao-date-input" />
                </div>
                <div className="ao-filter-group">
                  <label className="ao-filter-label">Status</label>
                  <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="ao-select">
                    {STATUS_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </div>
                <div className="ao-filter-group">
                  <label className="ao-filter-label">Driver</label>
                  <select value={driverFilter} onChange={e => setDriverFilter(e.target.value)} className="ao-select">
                    <option value="">All Drivers</option>
                    <option value="Unassigned">Unassigned</option>
                    {drivers.map(d => <option key={d.id} value={d.name}>{d.name}</option>)}
                  </select>
                </div>
              </>
            )}
            <div className="ao-filter-group ao-filter-grow">
              <label className="ao-filter-label">Customer</label>
              <input
                type="text"
                placeholder="Search Name, Phone, Address"
                value={customerSearch}
                onChange={e => setCustomerSearch(e.target.value)}
                className="ao-search-input"
              />
            </div>
            <div className="ao-filter-group">
              <label className="ao-filter-label">Material</label>
              <select value={materialFilter} onChange={e => setMaterialFilter(e.target.value)} className="ao-select">
                <option value="">All Materials</option>
                {materialOptions.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          </div>
          {(statusFilter || driverFilter || customerSearch || materialFilter) && (
            <button
              className="btn btn-ghost btn-sm"
              style={{ marginTop: 8, fontSize: 12 }}
              onClick={() => { setStatusFilter(''); setDriverFilter(''); setCustomerSearch(''); setMaterialFilter(''); }}
            >
              Clear all filters
            </button>
          )}
        </div>

        {/* ── Summary ── */}
        <div className="ao-summary">
          <span>{totalCount} order{totalCount !== 1 ? 's' : ''}</span>
          {activeTab === 'deliveries' && (
            <>
              <span className="ao-summary-sep">{'\u00B7'}</span>
              <span style={{ color: 'var(--green-600)' }}>{deliveredCount} delivered</span>
              {exceptionCount > 0 && (
                <>
                  <span className="ao-summary-sep">{'\u00B7'}</span>
                  <span style={{ color: 'var(--red-600)' }}>{exceptionCount} exception{exceptionCount !== 1 ? 's' : ''}</span>
                </>
              )}
            </>
          )}
          {activeTab === 'pickups' && (
            <>
              <span className="ao-summary-sep">{'\u00B7'}</span>
              <span style={{ color: 'var(--green-600)' }}>{deliveredCount} fulfilled</span>
            </>
          )}
        </div>

        {error && <div className="alert alert-error" style={{ marginBottom: 16 }}><span>{'\u26A0'}</span> {error}</div>}
        {loading && <div style={{ textAlign: 'center', padding: 40 }}><div className="spinner spinner-lg" style={{ margin: '0 auto' }} /></div>}

        {/* ── Table ── */}
        {!loading && (
          <div className="ao-table-wrap card">
            {sorted.length === 0 ? (
              <div style={{ padding: '32px 20px', textAlign: 'center', color: 'var(--gray-400)', fontSize: 14 }}>
                No {activeTab === 'pickups' ? 'pickup ' : ''}orders found for the selected filters.
              </div>
            ) : (
              <div className="ao-table-scroll">
                <table className="ao-table">
                  <thead>
                    <tr>
                      <th className="ao-th ao-th-sort" onClick={() => toggleSort('date')}>
                        {activeTab === 'pickups' ? 'Order Received' : 'Date'}{sortIcon('date')}
                      </th>
                      {activeTab === 'deliveries' && <th className="ao-th">Window</th>}
                      <th className="ao-th">Order #</th>
                      <th className="ao-th ao-th-sort" onClick={() => toggleSort('customer')}>Customer{sortIcon('customer')}</th>
                      <th className="ao-th ao-hide-mobile">{activeTab === 'pickups' ? 'Contact' : 'Address'}</th>
                      <th className="ao-th ao-th-sort" onClick={() => toggleSort('material')}>Material{sortIcon('material')}</th>
                      <th className="ao-th ao-hide-sm">Qty</th>
                      <th className="ao-th ao-th-sort" onClick={() => toggleSort('status')}>Status{sortIcon('status')}</th>
                      {activeTab === 'deliveries' && (
                        <th className="ao-th ao-th-sort ao-hide-mobile" onClick={() => toggleSort('driver')}>Driver{sortIcon('driver')}</th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((o, i) => (
                      <tr key={`${o.load_id}-${i}`} className="ao-row" onClick={() => window.location.href = `/dispatch/drops/${o.drop_id}`}>
                        <td className="ao-td ao-td-date">
                          {activeTab === 'pickups' ? fmtDateTime(o.created_at) : fmtDate(o.scheduled_date)}
                        </td>
                        {activeTab === 'deliveries' && (
                          <td className="ao-td">
                            {o.is_priority ? (
                              <span className="ao-win-badge" style={{ background: 'rgba(37,99,235,0.08)', color: 'var(--blue-700)' }}>⚡ Priority</span>
                            ) : (
                              <span className={`ao-win-badge ${o.window === 'A' ? 'ao-win-am' : 'ao-win-pm'}`}>
                                {o.window === 'A' ? 'Morning' : 'Afternoon'}
                              </span>
                            )}
                          </td>
                        )}
                        <td className="ao-td" style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 13 }}>
                          {o.order_ref || '—'}
                        </td>
                        <td className="ao-td">
                          <div className="ao-customer-name">{o.customer_name}</div>
                          <div className="ao-customer-phone">{o.customer_phone}</div>
                        </td>
                        <td className="ao-td ao-hide-mobile ao-td-addr">
                          {activeTab === 'pickups' ? (
                            <span style={{ fontSize: 12, color: 'var(--gray-500)' }}>{o.customer_phone}</span>
                          ) : (
                            o.address_short
                          )}
                        </td>
                        <td className="ao-td ao-td-material">{o.material}</td>
                        <td className="ao-td ao-hide-sm">{o.qty} {o.unit}</td>
                        <td className="ao-td">
                          <span className="ao-status" style={{ color: STATUS_COLORS[o.status] || 'var(--gray-500)' }}>
                            {activeTab === 'pickups' && o.status.toLowerCase() === 'assigned'
                              ? 'Pending Pickup'
                              : STATUS_LABELS[o.status] || o.status}
                          </span>
                        </td>
                        {activeTab === 'deliveries' && (
                          <td className="ao-td ao-hide-mobile">
                            {o.driver_name || <span style={{ color: 'var(--amber-500)', fontWeight: 600 }}>Unassigned</span>}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

const pageStyles = `
  .ao-page { max-width: 1100px; }
  .ao-top { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 16px; flex-wrap: wrap; gap: 12px; }
  .ao-top h1 { font-size: 28px; font-weight: 800; letter-spacing: -0.02em; margin: 0; }
  .ao-sub { color: var(--gray-500); font-size: 14px; margin-top: 2px; }

  /* Tabs */
  .ao-tabs {
    display: flex;
    gap: 0;
    margin-bottom: 16px;
    border-bottom: 2px solid var(--border-light);
  }
  .ao-tab {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 20px;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    margin-bottom: -2px;
    font-family: var(--font-heading);
    font-size: 14px;
    font-weight: 700;
    color: var(--gray-500);
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
  }
  .ao-tab:hover { color: var(--gray-800); }
  .ao-tab-active { color: var(--green-700); border-bottom-color: var(--green-600); }
  .ao-tab-count {
    font-size: 11px;
    font-weight: 800;
    background: var(--gray-100);
    color: var(--gray-500);
    border-radius: 10px;
    padding: 1px 7px;
    min-width: 20px;
    text-align: center;
  }
  .ao-tab-active .ao-tab-count {
    background: var(--green-50);
    color: var(--green-700);
  }

  /* Filters */
  .ao-filters { padding: 16px 20px; margin-bottom: 12px; }
  .ao-filter-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
  .ao-filter-group { display: flex; flex-direction: column; gap: 4px; min-width: 120px; }
  .ao-filter-grow { flex: 1; min-width: 180px; }
  .ao-filter-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--gray-400); }
  .ao-date-input, .ao-select, .ao-search-input {
    padding: 7px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    font-family: inherit;
    font-size: 13px;
    background: var(--surface);
    color: var(--gray-800);
  }
  .ao-date-input:focus, .ao-select:focus, .ao-search-input:focus {
    outline: none;
    border-color: var(--green-400);
    box-shadow: 0 0 0 2px rgba(15,133,48,0.08);
  }

  /* Summary */
  .ao-summary { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; color: var(--gray-500); margin-bottom: 12px; padding: 0 4px; }
  .ao-summary-sep { color: var(--gray-300); }

  /* Table */
  .ao-table-wrap { overflow: hidden; }
  .ao-table-scroll { overflow-x: auto; }
  .ao-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .ao-th {
    text-align: left;
    padding: 10px 14px;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--gray-400);
    border-bottom: 1px solid var(--border-light);
    white-space: nowrap;
    background: var(--gray-50);
    position: sticky;
    top: 0;
  }
  .ao-th-sort { cursor: pointer; user-select: none; }
  .ao-th-sort:hover { color: var(--gray-600); }
  .ao-row { cursor: pointer; transition: background 0.1s; }
  .ao-row:hover { background: var(--green-25, var(--gray-50)); }
  .ao-td { padding: 10px 14px; border-bottom: 1px solid var(--border-light); vertical-align: middle; }
  .ao-td-date { white-space: nowrap; font-weight: 600; color: var(--gray-700); }
  .ao-td-addr { max-width: 200px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--gray-500); font-size: 12px; }
  .ao-td-material { font-weight: 600; }

  .ao-customer-name { font-weight: 600; color: var(--gray-900); }
  .ao-customer-phone { font-size: 11px; color: var(--gray-400); }
  .ao-status { font-weight: 700; font-size: 12px; }

  .ao-win-badge {
    font-size: 10px;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 8px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .ao-win-am { background: rgba(26,158,58,0.08); color: var(--green-700); }
  .ao-win-pm { background: rgba(37,99,235,0.06); color: var(--blue-700); }

  @media (max-width: 900px) {
    .ao-hide-mobile { display: none; }
  }
  @media (max-width: 600px) {
    .ao-hide-sm { display: none; }
    .ao-filter-row { flex-direction: column; }
    .ao-filter-group { min-width: 100%; }
  }
`;
