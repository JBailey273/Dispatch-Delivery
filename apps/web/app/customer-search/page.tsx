'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, api, requireRole } from '../lib/auth';

type CustomerResult = { id: string; name: string; phone_e164: string; customer_type?: string; exact_phone_match?: boolean; last_ordered?: string | null };
type Address = { id: string; line1: string; line2?: string; city: string; state: string; postal_code: string; is_default?: boolean };

export default function CustomerSearchPage() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [allCustomers, setAllCustomers] = useState<CustomerResult[]>([]);
  const [searchResults, setSearchResults] = useState<CustomerResult[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchLoading, setSearchLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Expanded customer
  const [expanded, setExpanded] = useState<string | null>(null);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [addrLoading, setAddrLoading] = useState(false);

  // Create customer
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newType, setNewType] = useState<'residential' | 'commercial'>('residential');
  const [creating, setCreating] = useState(false);

  // Type toggle loading
  const [typeToggling, setTypeToggling] = useState<string | null>(null);

  // Load all customers on mount
  useEffect(() => {
    api('/customers').then(d => { setAllCustomers(d.results || []); }).catch(err => setError((err as ApiError).message || 'Failed to load customers')).finally(() => setLoading(false));
  }, []);

  // Live filter
  const [debounceTimer, setDebounceTimer] = useState<NodeJS.Timeout | null>(null);

  const handleQueryChange = (val: string) => {
    setQ(val);
    if (debounceTimer) clearTimeout(debounceTimer);

    if (!val.trim()) {
      setSearchResults(null);
      return;
    }

    const timer = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const data = await api(`/customers/search?q=${encodeURIComponent(val)}`);
        setSearchResults(data.results || []);
      } catch { /* fall back to client filter */ }
      finally { setSearchLoading(false); }
    }, 300);
    setDebounceTimer(timer);
  };

  // Determine which list to display
  const displayed = (() => {
    if (searchResults !== null) return searchResults;
    if (!q.trim()) return allCustomers;
    const lower = q.toLowerCase();
    return allCustomers.filter(c =>
      c.name.toLowerCase().includes(lower) ||
      c.phone_e164.includes(q)
    );
  })();

  const toggleExpand = async (id: string) => {
    if (expanded === id) { setExpanded(null); return; }
    setExpanded(id);
    setAddrLoading(true);
    try {
      const data = await api(`/customers/${id}/addresses`);
      setAddresses(data.addresses || []);
    } catch {
      setAddresses([]);
    } finally {
      setAddrLoading(false);
    }
  };

  const toggleCustomerType = async (customerId: string, currentType: string) => {
    const newType = currentType === 'commercial' ? 'residential' : 'commercial';
    setTypeToggling(customerId);
    setError('');
    try {
      await api(`/customers/${customerId}/type`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_type: newType }),
      });
      // Update in both lists
      const update = (list: CustomerResult[]) =>
        list.map(c => c.id === customerId ? { ...c, customer_type: newType } : c);
      setAllCustomers(update);
      if (searchResults) setSearchResults(update(searchResults));
      setSuccess(`Customer updated to ${newType}`);
      setTimeout(() => setSuccess(''), 2000);
    } catch (err) {
      setError((err as ApiError).message || 'Failed to update customer type');
    } finally {
      setTypeToggling(null);
    }
  };

  const createCustomer = async () => {
    if (!newPhone.trim()) return;
    setCreating(true);
    setError('');
    try {
      await api('/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName || 'Walk-in Customer', phone: newPhone, customer_type: newType }),
      });
      setShowCreate(false);
      setNewName('');
      setNewPhone('');
      setNewType('residential');
      const refreshed = await api('/customers');
      setAllCustomers(refreshed.results || []);
      setQ('');
      setSearchResults(null);
    } catch (err) {
      setError((err as ApiError).message || 'Create failed');
    } finally {
      setCreating(false);
    }
  };

  if (!requireRole(['dispatcher'])) return <div className="page"><p>Unauthorized</p></div>;

  const commercialCount = allCustomers.filter(c => c.customer_type === 'commercial').length;

  return (
    <>
      <style>{styles}</style>
      <div className="page cs-page">
        <div className="cs-top">
          <div>
            <h1>Customers</h1>
            <p style={{ color: 'var(--gray-500)', marginTop: 2 }}>
              {allCustomers.length} customer{allCustomers.length !== 1 ? 's' : ''}
              {commercialCount > 0 && <> &middot; <span style={{ color: 'var(--blue-600)' }}>{commercialCount} commercial</span></>}
            </p>
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => setShowCreate(true)}>+ New Customer</button>
        </div>

        {/* Search bar */}
        <div className="cs-search-bar card">
          <span className="cs-search-icon">{'\uD83D\uDD0D'}</span>
          <input
            ref={inputRef}
            className="cs-search-input"
            placeholder="Filter by name, phone, or address\u2026"
            value={q}
            onChange={e => handleQueryChange(e.target.value)}
            autoFocus
          />
          {q && <button className="btn btn-ghost btn-sm" onClick={() => { setQ(''); setSearchResults(null); }}>{'\u2715'}</button>}
          {searchLoading && <div className="spinner" />}
        </div>

        {error && <div className="alert alert-error" style={{ marginBottom: 16 }}><span>{'\u26A0'}</span> {error}</div>}
        {success && <div className="alert alert-success" style={{ marginBottom: 16 }}><span>{'\u2713'}</span> {success}</div>}

        {/* Loading */}
        {loading && <div style={{ textAlign: 'center', padding: 40 }}><div className="spinner spinner-lg" style={{ margin: '0 auto' }} /></div>}

        {/* Empty state */}
        {!loading && displayed.length === 0 && (
          <div className="card">
            <div className="empty-state">
              <div className="empty-state-icon">{'\uD83D\uDC64'}</div>
              <div className="empty-state-title">{q ? 'No matching customers' : 'No customers yet'}</div>
              <div className="empty-state-desc">{q ? 'Try a different search term or create a new customer.' : 'Create your first customer to get started.'}</div>
              <button className="btn btn-secondary btn-sm" onClick={() => { setShowCreate(true); if (q) setNewPhone(q); }} style={{ marginTop: 8 }}>
                + Create Customer
              </button>
            </div>
          </div>
        )}

        {/* Customer table */}
        {!loading && displayed.length > 0 && (
          <div className="card">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th className="cs-type-col">Type</th>
                  <th className="cs-phone-col">Phone</th>
                  <th className="cs-last-col">Last Order</th>
                  <th style={{ width: 100 }}></th>
                </tr>
              </thead>
              <tbody>
                {displayed.map(r => {
                  const isCommercial = r.customer_type === 'commercial';
                  return (
                    <> 
                      <tr key={r.id} onClick={() => toggleExpand(r.id)} style={{ cursor: 'pointer' }}>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div className={`cs-avatar${isCommercial ? ' commercial' : ''}`}>
                              {isCommercial ? '\uD83C\uDFE2' : (r.name?.charAt(0)?.toUpperCase() || '?')}
                            </div>
                            <div>
                              <div style={{ fontWeight: 600, color: 'var(--gray-900)' }}>{r.name}</div>
                              {r.exact_phone_match && <span className="pill pill-green" style={{ fontSize: 10, marginTop: 2 }}><span className="pill-dot" />Exact match</span>}
                            </div>
                          </div>
                        </td>
                        <td className="cs-type-col">
                          <button
                            className={`cs-type-toggle ${isCommercial ? 'commercial' : 'residential'}`}
                            onClick={e => { e.stopPropagation(); toggleCustomerType(r.id, r.customer_type || 'residential'); }}
                            disabled={typeToggling === r.id}
                            title={`Click to switch to ${isCommercial ? 'residential' : 'commercial'}`}
                          >
                            {typeToggling === r.id ? '\u2026' : (isCommercial ? 'Commercial' : 'Residential')}
                          </button>
                        </td>
                        <td className="cs-phone-col" style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{r.phone_e164}</td>
                        <td className="cs-last-col">{r.last_ordered ? <span style={{ fontSize: 13 }}>{r.last_ordered}</span> : <span style={{ color: 'var(--gray-300)', fontSize: 13 }}>{'\u2014'}</span>}</td>
                        <td>
                          <button className="btn btn-secondary btn-sm" onClick={e => { e.stopPropagation(); router.push(`/new-drop?customerId=${r.id}`); }}>
                            New Order
                          </button>
                        </td>
                      </tr>
                      {expanded === r.id && (
                        <tr key={`${r.id}-exp`}>
                          <td colSpan={5} style={{ padding: 0 }}>
                            <div className="cs-expand-panel">
                              <div className="cs-expand-label">Saved Addresses</div>
                              {addrLoading && <div className="spinner" style={{ margin: '8px 0' }} />}
                              {!addrLoading && addresses.length === 0 && <p style={{ color: 'var(--gray-400)', fontSize: 13 }}>No saved addresses yet.</p>}
                              {!addrLoading && addresses.map(a => (
                                <div key={a.id} className="cs-addr-row">
                                  <div style={{ flex: 1 }}>
                                    <div style={{ fontWeight: 600, fontSize: 14 }}>{a.line1}{a.line2 ? `, ${a.line2}` : ''}</div>
                                    <div style={{ fontSize: 13, color: 'var(--gray-500)' }}>{a.city}, {a.state} {a.postal_code}</div>
                                  </div>
                                  {a.is_default && <span className="pill pill-green" style={{ fontSize: 10 }}>Default</span>}
                                </div>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Create customer modal */}
        {showCreate && (
          <div className="modal-overlay" onClick={() => setShowCreate(false)}>
            <div className="modal-card" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h2>New Customer</h2>
                <button className="btn btn-ghost btn-sm" onClick={() => setShowCreate(false)}>{'\u2715'}</button>
              </div>
              <div className="modal-body">
                <div className="form-group">
                  <label className="form-label">Phone Number *</label>
                  <input type="tel" placeholder="(555) 555-0142" value={newPhone} onChange={e => setNewPhone(e.target.value)} autoFocus />
                </div>
                <div className="form-group">
                  <label className="form-label">Name</label>
                  <input placeholder="Customer name (optional)" value={newName} onChange={e => setNewName(e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Customer Type</label>
                  <div className="cs-type-selector">
                    <button
                      className={`cs-type-opt${newType === 'residential' ? ' active' : ''}`}
                      onClick={() => setNewType('residential')}
                      type="button"
                    >
                      <span className="cs-type-opt-icon">{'\uD83C\uDFE0'}</span>
                      <span className="cs-type-opt-label">Residential</span>
                      <span className="cs-type-opt-desc">Standard homeowner delivery</span>
                    </button>
                    <button
                      className={`cs-type-opt${newType === 'commercial' ? ' active' : ''}`}
                      onClick={() => setNewType('commercial')}
                      type="button"
                    >
                      <span className="cs-type-opt-icon">{'\uD83C\uDFE2'}</span>
                      <span className="cs-type-opt-label">Commercial</span>
                      <span className="cs-type-opt-desc">Contractor / landscaper — priority delivery</span>
                    </button>
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button className="btn btn-ghost" onClick={() => setShowCreate(false)}>Cancel</button>
                <button className="btn btn-primary" onClick={createCustomer} disabled={creating || !newPhone.trim()}>
                  {creating ? 'Creating\u2026' : 'Create Customer'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

const styles = `
  .cs-page { max-width: 920px; }
  .cs-top { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 20px; flex-wrap: wrap; gap: 12px; }
  .cs-top h1 { font-size: 28px; font-weight: 800; letter-spacing: -0.02em; margin: 0; }

  .cs-search-bar { display: flex; align-items: center; gap: 10px; padding: 10px 16px; margin-bottom: 16px; }
  .cs-search-icon { font-size: 16px; color: var(--gray-400); flex-shrink: 0; }
  .cs-search-input { border: none !important; box-shadow: none !important; padding: 6px 4px; font-size: 15px; flex: 1; }
  .cs-search-input:focus { border: none !important; box-shadow: none !important; }

  .cs-avatar { width: 34px; height: 34px; border-radius: 50%; background: var(--green-100); color: var(--green-700); display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 14px; flex-shrink: 0; }
  .cs-avatar.commercial { background: var(--blue-100, #dbeafe); color: var(--blue-700, #1d4ed8); font-size: 16px; font-weight: normal; }

  /* Type toggle button in table */
  .cs-type-toggle { display: inline-block; padding: 3px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; border: 1px solid transparent; cursor: pointer; transition: all 0.15s; font-family: inherit; line-height: 1.4; }
  .cs-type-toggle.residential { background: var(--gray-100); color: var(--gray-600); border-color: var(--gray-200); }
  .cs-type-toggle.residential:hover { background: var(--blue-50, #eff6ff); color: var(--blue-700, #1d4ed8); border-color: var(--blue-200, #bfdbfe); }
  .cs-type-toggle.commercial { background: var(--blue-50, #eff6ff); color: var(--blue-700, #1d4ed8); border-color: var(--blue-200, #bfdbfe); }
  .cs-type-toggle.commercial:hover { background: var(--gray-100); color: var(--gray-600); border-color: var(--gray-200); }
  .cs-type-toggle:disabled { opacity: 0.5; cursor: wait; }

  /* Type selector in create modal */
  .cs-type-selector { display: flex; gap: 10px; }
  .cs-type-opt { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 14px 10px; border: 2px solid var(--border); border-radius: var(--radius-md); background: var(--surface); cursor: pointer; transition: all 0.15s; font-family: inherit; }
  .cs-type-opt:hover { border-color: var(--gray-300); }
  .cs-type-opt.active { border-color: var(--green-400); background: var(--green-50); }
  .cs-type-opt-icon { font-size: 22px; }
  .cs-type-opt-label { font-size: 14px; font-weight: 700; color: var(--gray-800); }
  .cs-type-opt-desc { font-size: 11px; color: var(--gray-500); text-align: center; }

  /* Responsive columns */
  @media (max-width: 640px) {
    .cs-phone-col, .cs-last-col { display: none; }
  }

  .cs-expand-panel { padding: 16px 20px; background: var(--gray-50); border-top: 1px solid var(--border-light); }
  .cs-expand-label { font-size: 12px; font-weight: 700; color: var(--gray-400); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 8px; }
  .cs-addr-row { display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-radius: var(--radius-md); background: var(--surface); border: 1px solid var(--border-light); margin-bottom: 6px; }
  .cs-addr-row:last-child { margin-bottom: 0; }
`;
