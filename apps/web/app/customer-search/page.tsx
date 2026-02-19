'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, api, requireRole } from '../lib/auth';

type CustomerResult = { id: string; name: string; phone_e164: string; exact_phone_match?: boolean; last_ordered?: string | null };
type Address = { id: string; line1: string; line2?: string; city: string; state: string; postal_code: string; is_default?: boolean };

export default function CustomerSearchPage() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<CustomerResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState('');

  // Expanded customer
  const [expanded, setExpanded] = useState<string | null>(null);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [addrLoading, setAddrLoading] = useState(false);

  // Create customer
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [creating, setCreating] = useState(false);

  const search = useCallback(async () => {
    if (!q.trim()) return;
    setError('');
    setLoading(true);
    setSearched(true);
    setExpanded(null);
    try {
      const data = await api(`/customers/search?q=${encodeURIComponent(q)}`);
      setResults(data.results || []);
    } catch (err) {
      setError((err as ApiError).message || 'Search failed');
    } finally {
      setLoading(false);
    }
  }, [q]);

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

  const createCustomer = async () => {
    if (!newPhone.trim()) return;
    setCreating(true);
    setError('');
    try {
      const data = await api('/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName || 'Walk-in Customer', phone: newPhone }),
      });
      setShowCreate(false);
      setNewName('');
      setNewPhone('');
      setQ(newPhone);
      const refreshed = await api(`/customers/search?q=${encodeURIComponent(newPhone)}`);
      setResults(refreshed.results || []);
      setSearched(true);
    } catch (err) {
      setError((err as ApiError).message || 'Create failed');
    } finally {
      setCreating(false);
    }
  };

  if (!requireRole(['dispatcher'])) return <div className="page"><p>Unauthorized</p></div>;

  return (
    <>
      <style>{styles}</style>
      <div className="page cs-page">
        <div className="cs-top">
          <div>
            <h1>Customers</h1>
            <p style={{ color: 'var(--gray-500)', marginTop: 2 }}>Search by name, phone, or address</p>
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => setShowCreate(true)}>+ New Customer</button>
        </div>

        {/* Search bar */}
        <div className="cs-search-bar card">
          <span className="cs-search-icon">🔍</span>
          <input
            ref={inputRef}
            className="cs-search-input"
            placeholder="Phone number, name, or address…"
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && search()}
            autoFocus
          />
          <button className="btn btn-primary btn-sm" onClick={search} disabled={loading}>
            {loading ? 'Searching…' : 'Search'}
          </button>
        </div>

        {error && <div className="alert alert-error" style={{ marginBottom: 16 }}><span>⚠</span> {error}</div>}

        {/* Results */}
        {searched && !loading && results.length === 0 && (
          <div className="card">
            <div className="empty-state">
              <div className="empty-state-icon">👤</div>
              <div className="empty-state-title">No customers found</div>
              <div className="empty-state-desc">Try a different search term or create a new customer.</div>
              <button className="btn btn-secondary btn-sm" onClick={() => { setShowCreate(true); setNewPhone(q); }} style={{ marginTop: 8 }}>
                + Create Customer
              </button>
            </div>
          </div>
        )}

        {results.length > 0 && (
          <div className="card">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Phone</th>
                  <th>Last Order</th>
                  <th style={{ width: 100 }}></th>
                </tr>
              </thead>
              <tbody>
                {results.map(r => (
                  <>
                    <tr key={r.id} onClick={() => toggleExpand(r.id)} style={{ cursor: 'pointer' }}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div className="cs-avatar">{r.name?.charAt(0)?.toUpperCase() || '?'}</div>
                          <div>
                            <div style={{ fontWeight: 600, color: 'var(--gray-900)' }}>{r.name}</div>
                            {r.exact_phone_match && <span className="pill pill-green" style={{ fontSize: 10, marginTop: 2 }}><span className="pill-dot" />Exact match</span>}
                          </div>
                        </div>
                      </td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{r.phone_e164}</td>
                      <td>{r.last_ordered ? <span style={{ fontSize: 13 }}>{r.last_ordered}</span> : <span style={{ color: 'var(--gray-300)', fontSize: 13 }}>—</span>}</td>
                      <td>
                        <button className="btn btn-secondary btn-sm" onClick={e => { e.stopPropagation(); router.push(`/new-drop?phone=${encodeURIComponent(r.phone_e164)}`); }}>
                          New Order
                        </button>
                      </td>
                    </tr>
                    {expanded === r.id && (
                      <tr key={`${r.id}-exp`}>
                        <td colSpan={4} style={{ padding: 0 }}>
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
                ))}
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
                <button className="btn btn-ghost btn-sm" onClick={() => setShowCreate(false)}>✕</button>
              </div>
              <div className="modal-body">
                <div className="form-group">
                  <label className="form-label">Phone Number</label>
                  <input type="tel" placeholder="(555) 555-0142" value={newPhone} onChange={e => setNewPhone(e.target.value)} autoFocus />
                </div>
                <div className="form-group">
                  <label className="form-label">Name</label>
                  <input placeholder="Customer name (optional)" value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === 'Enter' && createCustomer()} />
                </div>
              </div>
              <div className="modal-footer">
                <button className="btn btn-ghost" onClick={() => setShowCreate(false)}>Cancel</button>
                <button className="btn btn-primary" onClick={createCustomer} disabled={creating || !newPhone.trim()}>
                  {creating ? 'Creating…' : 'Create Customer'}
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
  .cs-page { max-width: 860px; }
  .cs-top { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 20px; flex-wrap: wrap; gap: 12px; }
  .cs-top h1 { font-size: 28px; font-weight: 800; letter-spacing: -0.02em; margin: 0; }

  .cs-search-bar { display: flex; align-items: center; gap: 10px; padding: 10px 16px; margin-bottom: 16px; }
  .cs-search-icon { font-size: 16px; color: var(--gray-400); flex-shrink: 0; }
  .cs-search-input { border: none !important; box-shadow: none !important; padding: 6px 4px; font-size: 15px; flex: 1; }
  .cs-search-input:focus { border: none !important; box-shadow: none !important; }

  .cs-avatar { width: 34px; height: 34px; border-radius: 50%; background: var(--green-100); color: var(--green-700); display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 14px; flex-shrink: 0; }

  .cs-expand-panel { padding: 16px 20px; background: var(--gray-50); border-top: 1px solid var(--border-light); }
  .cs-expand-label { font-size: 12px; font-weight: 700; color: var(--gray-400); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 8px; }
  .cs-addr-row { display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-radius: var(--radius-md); background: var(--surface); border: 1px solid var(--border-light); margin-bottom: 6px; }
  .cs-addr-row:last-child { margin-bottom: 0; }
`;
