'use client';

import { Suspense, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError, api, requireRole } from '../lib/auth';

/* ── Types ── */
type CatalogItem = { sku: string; name: string; active: boolean; delivery_mode: string; bulk_group: string; unit?: string };
type CustomerResult = { id: string; name: string; phone_e164: string; last_ordered?: string | null; exact_phone_match?: boolean };
type Address = { id: string; line1: string; line2?: string; city: string; state: string; postal_code: string; is_default?: boolean };
type CartItem = { sku: string; qty: number };
type AvailWindow = { date: string; window: string; used: number; total: number; remaining_capacity: number; available: boolean };

const LAST_WINDOW_KEY = 'dispatch:last-window';
const LAST_ADDRESS_KEY = 'dispatch:last-address:';
const LAST_ITEMS_KEY = 'dispatch:last-items:';
const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function daysInMonth(y: number, m: number) { return new Date(y, m + 1, 0).getDate(); }
function firstDow(y: number, m: number) { return new Date(y, m, 1).getDay(); }
function toKey(d: Date) { return d.toISOString().slice(0, 10); }
function capColor(u: number, t: number) {
  if (t === 0) return 'green';
  const pct = u / t;
  return pct >= 1 ? 'red' : pct >= 0.75 ? 'amber' : 'green';
}

export default function NewDropPageWrapper() {
  return (
    <Suspense fallback={<div className="page" style={{ padding: 40 }}>Loading...</div>}>
      <NewDropPage />
    </Suspense>
  );
}

function NewDropPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const searchRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');

  // Customer search — single unified field
  const [searchQuery, setSearchQuery] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [newCustomerPhone, setNewCustomerPhone] = useState('');
  const [newCustomerName, setNewCustomerName] = useState('');
  const [showNewCustomerForm, setShowNewCustomerForm] = useState(false);
  const [customer, setCustomer] = useState<CustomerResult | null>(null);
  const [searchResults, setSearchResults] = useState<CustomerResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [resultAddresses, setResultAddresses] = useState<Record<string, Address>>({});

  // Address
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [addressId, setAddressId] = useState('');
  const [showNewAddr, setShowNewAddr] = useState(false);
  const [newAddr, setNewAddr] = useState({ line1: '', line2: '', city: '', state: '', postal_code: '' });

  // Products
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [items, setItems] = useState<CartItem[]>([]);
  const [sku, setSku] = useState('');
  const [qty, setQty] = useState(1);

  // Schedule — mini calendar
  const today = useMemo(() => new Date(), []);
  const [calMonth, setCalMonth] = useState({ y: today.getFullYear(), m: today.getMonth() });
  const [selDate, setSelDate] = useState(toKey(today));
  const [selectedWindow, setSelectedWindow] = useState(() =>
    typeof window === 'undefined' ? 'A' : localStorage.getItem(LAST_WINDOW_KEY) || 'A'
  );
  const [availability, setAvailability] = useState<AvailWindow[]>([]);

  // Submit
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<any>(null);

  /* ── Load catalog ── */
  useEffect(() => {
    searchRef.current?.focus();
    api('/product-catalog').then(d => setCatalog(d.items || [])).catch(() => null);
  }, []);

  /* ── Preload customer from URL param ── */
  useEffect(() => {
    const customerId = searchParams.get('customerId');
    if (!customerId || customer) return;
    api(`/customers/${customerId}`).then(data => {
      if (data?.id) selectCustomer(data);
    }).catch(() => null);
  }, [searchParams]);

  /* ── Computed ── */
  const requiredLoads = useMemo(() => {
    if (!items.length || !catalog.length) return 0;
    return new Set(
      items.map(i => catalog.find(c => c.sku === i.sku)).filter(Boolean).filter(c => c?.delivery_mode === 'bulk_load').map(c => c?.bulk_group)
    ).size;
  }, [items, catalog]);

  const selectedCustomerLastItems = useMemo(() => {
    if (!customer || typeof window === 'undefined') return [];
    return JSON.parse(localStorage.getItem(`${LAST_ITEMS_KEY}${customer.id}`) || '[]') as CartItem[];
  }, [customer]);

  /* ── Availability for calendar ── */
  const fetchAvailability = useCallback(async () => {
    const start = new Date(calMonth.y, calMonth.m, 1);
    const days = daysInMonth(calMonth.y, calMonth.m);
    try {
      const a = await api(`/availability?required_loads=${Math.max(1, requiredLoads)}&start_date=${toKey(start)}&days=${days}`);
      setAvailability(a.windows || []);
    } catch { /* silent */ }
  }, [calMonth, requiredLoads]);

  useEffect(() => { fetchAvailability(); }, [fetchAvailability]);

  /* ── Calendar grid ── */
  const calGrid = useMemo(() => {
    const dim = daysInMonth(calMonth.y, calMonth.m);
    const dow = firstDow(calMonth.y, calMonth.m);
    const cells: { date: Date; day: number; other: boolean }[] = [];
    const prevDim = daysInMonth(calMonth.y, calMonth.m === 0 ? 11 : calMonth.m - 1);
    for (let i = dow - 1; i >= 0; i--) cells.push({ date: new Date(calMonth.y, calMonth.m - 1, prevDim - i), day: prevDim - i, other: true });
    for (let d = 1; d <= dim; d++) cells.push({ date: new Date(calMonth.y, calMonth.m, d), day: d, other: false });
    while (cells.length % 7 !== 0) { const n = cells.length - (dow + dim) + 1; cells.push({ date: new Date(calMonth.y, calMonth.m + 1, n), day: n, other: true }); }
    return cells;
  }, [calMonth]);

  const getWindowAvail = (dateStr: string, win: string) => availability.find(w => w.date === dateStr && w.window === win);
  const selectedDateAvail = getWindowAvail(selDate, selectedWindow);

  /* ── Window display labels ── */
  const windowLabel = (win: string) => {
    return win === 'A' ? 'Morning Delivery (9am \u2013 1pm)' : 'Afternoon Delivery (1pm \u2013 5pm)';
  };

  /* ── Format date helper ── */
  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr + 'T12:00:00');
    const dow = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getDay()];
    const mon = MONTHS[d.getMonth()];
    return `${dow}, ${mon} ${d.getDate()} ${d.getFullYear()}`;
  };

  /* ── Normalize search input: strip formatting if it looks like a phone ── */
  const normalizeSearch = (raw: string): string => {
    const stripped = raw.replace(/[\s()\-+.]/g, '');
    // If after stripping it's all digits (and at least 7), treat as phone
    if (/^\d{7,}$/.test(stripped)) return stripped;
    return raw.trim();
  };

  /* ── Customer lookup — works for name or phone ── */
  const lookup = async () => {
    if (!searchQuery.trim()) return;
    setError('');
    setSearchLoading(true);
    setCustomer(null);
    setAddresses([]);
    setAddressId('');
    setShowNewCustomerForm(false);
    setResultAddresses({});
    try {
      const q = normalizeSearch(searchQuery);
      const s = await api(`/customers/search?q=${encodeURIComponent(q)}`);
      const results = (s.results || []) as CustomerResult[];
      const sorted = [...results].sort((a, b) => Number(Boolean(b.exact_phone_match)) - Number(Boolean(a.exact_phone_match)));
      setSearchResults(sorted);
      if (sorted.length === 1) selectCustomer(sorted[0]);
      // Fetch default address for each result to show in the list
      if (sorted.length > 1) {
        sorted.slice(0, 5).forEach(async (r) => {
          try {
            const ad = await api(`/customers/${r.id}/addresses`);
            const addrs = ad.addresses || [];
            const def = addrs.find((a: Address) => a.is_default) || addrs[0];
            if (def) setResultAddresses(prev => ({ ...prev, [r.id]: def }));
          } catch { /* silent */ }
        });
      }
    } catch (err) {
      setError((err as ApiError).message || 'Search failed');
    } finally {
      setSearchLoading(false);
    }
  };

  const startNewCustomer = () => {
    setCustomer(null);
    setSearchResults([]);
    setResultAddresses({});
    setAddresses([]);
    setAddressId('');
    setShowNewCustomerForm(true);
    setNewCustomerPhone('');
    setNewCustomerName('');
  };

  const createCustomer = async () => {
    if (!newCustomerPhone.trim()) { setError('Phone number is required to create a customer.'); return; }
    setError('');
    try {
      const c = await api('/customers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newCustomerName.trim() || 'Walk-in Customer', phone: newCustomerPhone.trim() }) });
      const created = c.customer || c;
      setShowNewCustomerForm(false);
      setSearchQuery('');
      selectCustomer(created);
    } catch (err) {
      setError((err as ApiError).message || 'Create failed');
    }
  };

  const selectCustomer = async (c: CustomerResult) => {
    setCustomer(c);
    setCustomerName(c.name || '');
    setSearchResults([]);
    setShowNewCustomerForm(false);
    try {
      const ad = await api(`/customers/${c.id}/addresses`);
      const fetched = ad.addresses || [];
      setAddresses(fetched);
      const lastUsed = typeof window === 'undefined' ? '' : localStorage.getItem(`${LAST_ADDRESS_KEY}${c.id}`) || '';
      const def = fetched.find((a: Address) => a.id === lastUsed) || fetched.find((a: Address) => a.is_default) || fetched[0];
      setAddressId(def?.id || '');
      if (fetched.length === 0) setShowNewAddr(true);
      else setShowNewAddr(false);
    } catch {
      setAddresses([]);
      setShowNewAddr(true);
    }
  };

  const changeCustomer = () => {
    setCustomer(null);
    setSearchResults([]);
    setResultAddresses({});
    setAddresses([]);
    setAddressId('');
    setSearchQuery('');
    setShowNewAddr(false);
    setTimeout(() => searchRef.current?.focus(), 50);
  };

  /* ── Address management ── */
  const saveNewAddress = async () => {
    if (!customer) return;
    if (!newAddr.line1.trim() || !newAddr.city.trim() || !newAddr.state.trim() || !newAddr.postal_code.trim()) {
      setError('Please fill in all required address fields (street, city, state, ZIP).');
      return;
    }
    setError('');
    try {
      const res = await api(`/customers/${customer.id}/addresses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...newAddr, is_default: addresses.length === 0 }),
      });
      const saved: Address = {
        id: res.id,
        line1: newAddr.line1,
        line2: newAddr.line2,
        city: newAddr.city,
        state: newAddr.state,
        postal_code: newAddr.postal_code,
        is_default: addresses.length === 0,
      };
      setAddresses(prev => [...prev, saved]);
      setAddressId(saved.id);
      setNewAddr({ line1: '', line2: '', city: '', state: '', postal_code: '' });
      setShowNewAddr(false);
    } catch (err) {
      setError((err as ApiError).message || 'Save address failed');
    }
  };

  /* ── Item management ── */
  const addItem = () => {
    if (!sku || qty <= 0) return;
    const existing = items.findIndex(i => i.sku === sku);
    if (existing >= 0) { const u = [...items]; u[existing].qty += qty; setItems(u); }
    else setItems([...items, { sku, qty }]);
    setSku(''); setQty(1);
  };
  const removeItem = (idx: number) => setItems(items.filter((_, i) => i !== idx));

  /* ── Submit ── */
  const canSubmit = customer && addressId && items.length > 0 && selDate;
  const createDrop = async () => {
    if (!customer || !addressId || !items.length) { setError('Complete all sections before creating.'); return; }
    setError('');
    setSubmitting(true);
    try {
      if (customerName.trim() && customerName.trim() !== customer.name) {
        await api(`/customers/${customer.id}/name`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: customerName.trim() }) });
      }
      const out = await api('/drops/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer: { id: customer.id }, address: { address_id: addressId }, scheduled_date: selDate, scheduled_window: selectedWindow, items }),
      });
      localStorage.setItem(LAST_WINDOW_KEY, selectedWindow);
      localStorage.setItem(`${LAST_ADDRESS_KEY}${customer.id}`, addressId);
      localStorage.setItem(`${LAST_ITEMS_KEY}${customer.id}`, JSON.stringify(items));
      setResult(out);
    } catch (err) {
      setError((err as ApiError).message || 'Create drop failed.');
    } finally { setSubmitting(false); }
  };

  if (!requireRole(['dispatcher'])) return <div className="page"><p>Unauthorized</p></div>;

  // ── Success screen ──
  if (result) return (
    <>
      <style>{pageStyles}</style>
      <div className="page nd-page">
        <div className="nd-success-card card card-padded">
          <div className="nd-success-icon">{'\u2713'}</div>
          <h2>Order Created</h2>
          <p style={{ color: 'var(--gray-600)', marginTop: 4 }}>
            Scheduled for {formatDate(selDate)}, {windowLabel(selectedWindow)}
          </p>
          <div className="nd-success-detail">
            <div className="nd-success-row"><span>Drop ID</span><span style={{ fontFamily: 'monospace', fontSize: 13 }}>{result.drop_id}</span></div>
            <div className="nd-success-row"><span>Loads</span><span>{result.load_ids?.length || 0}</span></div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
            <button className="btn btn-primary" onClick={() => { setResult(null); setCustomer(null); setItems([]); setSearchQuery(''); setSearchResults([]); setAddressId(''); setAddresses([]); setShowNewAddr(false); }}>New Order</button>
            <button className="btn btn-secondary" onClick={() => router.push('/dispatch-schedule')}>Schedule</button>
          </div>
        </div>
      </div>
    </>
  );

  return (
    <>
      <style>{pageStyles}</style>
      <div className="page nd-page">
        <div className="nd-top">
          <div>
            <h1>New Order</h1>
            <p style={{ color: 'var(--gray-500)', marginTop: 2 }}>Search by name or phone — pick any available delivery date</p>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => router.push('/dispatch-schedule')}>Cancel</button>
        </div>

        {error && <div className="alert alert-error" style={{ marginBottom: 16 }}><span>{'\u26A0'}</span> {error}</div>}

        {/* ═══ CUSTOMER ═══ */}
        <div className="nd-card card">
          <div className="nd-card-head"><span className="nd-card-icon">{'\uD83D\uDC64'}</span><span className="nd-card-title">Customer</span></div>
          <div className="nd-card-body">
            {!customer && !showNewCustomerForm && (
              <>
                <div className="form-group">
                  <label className="form-label">Search by Name or Phone</label>
                  <input
                    ref={searchRef}
                    type="text"
                    placeholder="Enter name or phone number\u2026"
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && lookup()}
                  />
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button className="btn btn-primary btn-sm" onClick={lookup} disabled={searchLoading}>
                    {searchLoading ? 'Searching\u2026' : 'Lookup'}
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={startNewCustomer}>+ New Customer</button>
                </div>

                {searchResults.length > 0 && (
                  <div className="nd-results">
                    {searchResults.slice(0, 5).map(r => {
                      const addr = resultAddresses[r.id];
                      return (
                        <div key={r.id} className="nd-result-row" onClick={() => selectCustomer(r)}>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontWeight: 600 }}>{r.name}</div>
                            <div className="text-sm" style={{ color: 'var(--gray-500)' }}>{r.phone_e164}</div>
                            {addr && <div className="text-sm" style={{ color: 'var(--gray-400)', marginTop: 2 }}>{addr.line1}, {addr.city}, {addr.state} {addr.postal_code}</div>}
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                            {r.exact_phone_match && <span className="pill pill-green"><span className="pill-dot" />Exact</span>}
                            {r.last_ordered && <span className="text-xs" style={{ color: 'var(--gray-400)' }}>Last: {r.last_ordered}</span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {searchResults.length === 0 && searchQuery && !searchLoading && (
                  <p className="text-sm" style={{ color: 'var(--gray-400)', marginTop: 10 }}>No results found. Try a different search or create a new customer.</p>
                )}
              </>
            )}

            {!customer && showNewCustomerForm && (
              <div className="nd-new-customer-form">
                <div className="nd-row-2">
                  <div className="form-group">
                    <label className="form-label">Phone Number *</label>
                    <input
                      type="tel"
                      placeholder="(516) 555-0142"
                      value={newCustomerPhone}
                      onChange={e => setNewCustomerPhone(e.target.value)}
                      autoFocus
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Customer Name</label>
                    <input
                      placeholder="Customer name (optional)"
                      value={newCustomerName}
                      onChange={e => setNewCustomerName(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && createCustomer()}
                    />
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button className="btn btn-primary btn-sm" onClick={createCustomer}>Create Customer</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => { setShowNewCustomerForm(false); setError(''); }}>Back to Search</button>
                </div>
              </div>
            )}

            {customer && (
              <div className="nd-returning">
                <div className="nd-returning-avatar">{customer.name?.charAt(0)?.toUpperCase() || '?'}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, color: 'var(--gray-900)' }}>{customer.name}</div>
                  <div className="text-sm" style={{ color: 'var(--gray-500)' }}>{'\u2713'} {customer.phone_e164}{customer.last_ordered ? ` \u00B7 Last order ${customer.last_ordered}` : ''}</div>
                </div>
                {selectedCustomerLastItems.length > 0 && (
                  <button className="btn btn-secondary btn-sm" onClick={() => setItems(selectedCustomerLastItems)}>Reorder Last</button>
                )}
                <button className="btn btn-ghost btn-sm" onClick={changeCustomer}>Change</button>
              </div>
            )}
          </div>
        </div>

        {/* ═══ ADDRESS ═══ */}
        <div className="nd-card card">
          <div className="nd-card-head"><span className="nd-card-icon">{'\uD83D\uDCCD'}</span><span className="nd-card-title">Delivery Address</span></div>
          <div className="nd-card-body">
            {!customer ? (
              <p style={{ color: 'var(--gray-400)', fontSize: 14 }}>Select a customer first to manage delivery addresses</p>
            ) : (
              <>
                {addresses.length > 0 && (
                  <div className="nd-addr-list">
                    {addresses.map(a => (
                      <div key={a.id} className={`nd-addr-opt${addressId === a.id ? ' sel' : ''}`} onClick={() => setAddressId(a.id)}>
                        <div className="nd-addr-radio">{addressId === a.id ? '\u25CF' : '\u25CB'}</div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 600 }}>{a.line1}{a.line2 ? `, ${a.line2}` : ''}</div>
                          <div className="text-sm" style={{ color: 'var(--gray-500)' }}>{a.city}, {a.state} {a.postal_code}</div>
                        </div>
                        {a.is_default && <span className="pill pill-green" style={{ fontSize: 11 }}>Default</span>}
                      </div>
                    ))}
                  </div>
                )}

                {!showNewAddr ? (
                  <button className="btn btn-secondary btn-sm" style={{ marginTop: addresses.length > 0 ? 12 : 0 }} onClick={() => setShowNewAddr(true)}>+ Add New Address</button>
                ) : (
                  <div className="nd-new-addr" style={{ marginTop: addresses.length > 0 ? 12 : 0 }}>
                    <div className="form-group">
                      <label className="form-label">Street Address *</label>
                      <input placeholder="123 Main St" value={newAddr.line1} onChange={e => setNewAddr({ ...newAddr, line1: e.target.value })} autoFocus />
                    </div>
                    <div className="form-group">
                      <label className="form-label">Apt / Unit</label>
                      <input placeholder="Apt 2B (optional)" value={newAddr.line2} onChange={e => setNewAddr({ ...newAddr, line2: e.target.value })} />
                    </div>
                    <div className="nd-addr-row-3">
                      <div className="form-group">
                        <label className="form-label">City *</label>
                        <input placeholder="East Meadow" value={newAddr.city} onChange={e => setNewAddr({ ...newAddr, city: e.target.value })} />
                      </div>
                      <div className="form-group">
                        <label className="form-label">State *</label>
                        <input placeholder="NY" maxLength={2} value={newAddr.state} onChange={e => setNewAddr({ ...newAddr, state: e.target.value.toUpperCase() })} />
                      </div>
                      <div className="form-group">
                        <label className="form-label">ZIP *</label>
                        <input placeholder="11554" value={newAddr.postal_code} onChange={e => setNewAddr({ ...newAddr, postal_code: e.target.value })} />
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      <button className="btn btn-primary btn-sm" onClick={saveNewAddress}>Save Address</button>
                      {addresses.length > 0 && <button className="btn btn-ghost btn-sm" onClick={() => setShowNewAddr(false)}>Cancel</button>}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* ═══ SCHEDULE — MINI CALENDAR ═══ */}
        <div className="nd-card card">
          <div className="nd-card-head"><span className="nd-card-icon">{'\uD83D\uDCC5'}</span><span className="nd-card-title">Delivery Date</span></div>
          <div className="nd-card-body">
            <div className="nd-cal-nav">
              <button className="nd-cal-btn" onClick={() => setCalMonth(p => { const nm = p.m - 1; return nm < 0 ? { y: p.y - 1, m: 11 } : { ...p, m: nm }; })}>{'\u2039'}</button>
              <div className="nd-cal-heading">{MONTHS[calMonth.m]} {calMonth.y}</div>
              <button className="nd-cal-btn" onClick={() => setCalMonth(p => { const nm = p.m + 1; return nm > 11 ? { y: p.y + 1, m: 0 } : { ...p, m: nm }; })}>{'\u203A'}</button>
            </div>
            <div className="nd-cal-grid">
              <div className="nd-cal-header">{DAYS.map(d => <div key={d} className="nd-cal-dow">{d}</div>)}</div>
              <div className="nd-cal-body">
                {calGrid.map((cell, i) => {
                  const k = toKey(cell.date);
                  const awA = getWindowAvail(k, 'A');
                  const awB = getWindowAvail(k, 'B');
                  const isPast = cell.date < today && toKey(cell.date) !== toKey(today);
                  const isSel = k === selDate;
                  const isToday = toKey(cell.date) === toKey(today);
                  return (
                    <div
                      key={i}
                      className={`nd-cal-cell${cell.other ? ' other' : ''}${isPast ? ' past' : ''}${isSel ? ' sel' : ''}${isToday ? ' today' : ''}`}
                      onClick={() => !cell.other && !isPast && setSelDate(k)}
                    >
                      <div className="nd-cal-d">{cell.day}</div>
                      {!cell.other && !isPast && (
                        <div className="nd-cal-dots">
                          <div className={`nd-cal-dot ${awA ? capColor(awA.used, awA.total) : 'empty'}`} title="Morning" />
                          <div className={`nd-cal-dot ${awB ? capColor(awB.used, awB.total) : 'empty'}`} title="Afternoon" />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Window selector */}
            <div className="nd-win-row">
              <div className="nd-win-label">Delivery window for {formatDate(selDate)}:</div>
              <div className="nd-win-toggle">
                <button className={`nd-win-btn${selectedWindow === 'A' ? ' active' : ''}`} onClick={() => setSelectedWindow('A')}>
                  <span className="nd-win-name">Morning Delivery</span>
                  <span className="nd-win-time">9:00 AM {'\u2013'} 1:00 PM</span>
                  {(() => { const a = getWindowAvail(selDate, 'A'); return a ? <span className={`nd-win-cap ${capColor(a.used, a.total)}`}>{a.remaining_capacity} slot{a.remaining_capacity !== 1 ? 's' : ''} open</span> : null; })()}
                </button>
                <button className={`nd-win-btn${selectedWindow === 'B' ? ' active' : ''}`} onClick={() => setSelectedWindow('B')}>
                  <span className="nd-win-name">Afternoon Delivery</span>
                  <span className="nd-win-time">1:00 PM {'\u2013'} 5:00 PM</span>
                  {(() => { const a = getWindowAvail(selDate, 'B'); return a ? <span className={`nd-win-cap ${capColor(a.used, a.total)}`}>{a.remaining_capacity} slot{a.remaining_capacity !== 1 ? 's' : ''} open</span> : null; })()}
                </button>
              </div>
            </div>

            {selectedDateAvail && !selectedDateAvail.available && (
              <div className="alert alert-error" style={{ marginTop: 8, fontSize: 13 }}><span>{'\u2715'}</span> Not enough capacity for {requiredLoads} load{requiredLoads !== 1 ? 's' : ''} in this window</div>
            )}
          </div>
        </div>

        {/* ═══ PRODUCTS ═══ */}
        <div className="nd-card card">
          <div className="nd-card-head"><span className="nd-card-icon">{'\uD83D\uDCE6'}</span><span className="nd-card-title">Products</span></div>
          <div className="nd-card-body">
            <div className="nd-prod-add">
              <select value={sku} onChange={e => setSku(e.target.value)} style={{ flex: 1 }}>
                <option value="">Select product{'\u2026'}</option>
                {catalog.filter(c => c.active).map(c => (
                  <option key={c.sku} value={c.sku}>{c.name}</option>
                ))}
              </select>
              <input type="number" value={qty} onChange={e => setQty(Number(e.target.value))} onKeyDown={e => e.key === 'Enter' && addItem()} style={{ width: 70, textAlign: 'center' }} min={1} />
              <button className="btn btn-primary btn-sm" onClick={addItem} disabled={!sku}>Add</button>
            </div>
            {items.length > 0 && (
              <div className="nd-load-list">
                {items.map((item, idx) => {
                  const cat = catalog.find(c => c.sku === item.sku);
                  return (
                    <div key={idx} className="nd-load-row">
                      <div style={{ flex: 1 }}>
                        <span style={{ fontWeight: 600 }}>{cat?.name || item.sku}</span>
                        <span style={{ color: 'var(--gray-500)', marginLeft: 6 }}>x {item.qty}{cat?.unit ? ` ${cat.unit}${item.qty !== 1 ? 's' : ''}` : ` ${item.qty === 1 ? 'Yard' : 'Yards'}`}</span>
                      </div>
                      <button className="btn btn-ghost btn-sm" onClick={() => removeItem(idx)} style={{ color: 'var(--red-600)' }}>{'\u2715'}</button>
                    </div>
                  );
                })}
                <div className="nd-load-summary">
                  <span>Loads required</span>
                  <span style={{ fontWeight: 800, fontSize: 18, color: 'var(--green-700)' }}>{requiredLoads}</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ═══ SUBMIT BAR ═══ */}
        <div className="nd-submit-bar">
          <button className="btn btn-ghost" onClick={() => router.push('/dispatch-schedule')}>Cancel</button>
          <div style={{ flex: 1 }} />
          <button className="btn btn-primary btn-lg" onClick={createDrop} disabled={!canSubmit || submitting}>
            {submitting ? 'Creating\u2026' : '\u2713 Confirm & Schedule'}
          </button>
        </div>
      </div>
    </>
  );
}

const pageStyles = `
  .nd-page { max-width: 680px; padding-bottom: 100px; }
  .nd-top { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 20px; }
  .nd-top h1 { font-size: 28px; font-weight: 800; letter-spacing: -0.02em; margin: 0; }

  /* Cards */
  .nd-card { margin-bottom: 16px; }
  .nd-card-head { display: flex; align-items: center; gap: 10px; padding: 16px 20px; border-bottom: 1px solid var(--border-light); }
  .nd-card-icon { font-size: 18px; }
  .nd-card-title { font-size: 15px; font-weight: 700; color: var(--gray-800); }
  .nd-card-body { padding: 16px 20px; }
  .nd-row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 500px) { .nd-row-2 { grid-template-columns: 1fr; } }

  /* New customer form */
  .nd-new-customer-form { padding: 16px; background: var(--gray-50); border: 1px solid var(--border-light); border-radius: var(--radius-md); }

  /* Customer results */
  .nd-results { border: 1px solid var(--border-light); border-radius: var(--radius-md); overflow: hidden; margin-top: 12px; }
  .nd-result-row { display: flex; align-items: center; gap: 12px; padding: 10px 14px; cursor: pointer; transition: background 0.12s; border-bottom: 1px solid var(--border-light); }
  .nd-result-row:last-child { border-bottom: none; }
  .nd-result-row:hover { background: var(--green-50); }

  /* Returning customer banner */
  .nd-returning { display: flex; align-items: center; gap: 12px; padding: 12px 14px; background: var(--green-50); border: 1px solid var(--green-200); border-radius: var(--radius-md); }
  .nd-returning-avatar { width: 36px; height: 36px; border-radius: 50%; background: var(--green-600); color: white; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 16px; flex-shrink: 0; }
  @media (max-width: 500px) { .nd-returning { flex-wrap: wrap; } }

  /* Address */
  .nd-addr-list { display: flex; flex-direction: column; gap: 8px; }
  .nd-addr-opt { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border: 2px solid var(--border-light); border-radius: var(--radius-md); cursor: pointer; transition: all 0.15s; }
  .nd-addr-opt:hover { border-color: var(--gray-300); }
  .nd-addr-opt.sel { border-color: var(--green-400); background: var(--green-50); }
  .nd-addr-radio { font-size: 18px; color: var(--gray-300); flex-shrink: 0; }
  .nd-addr-opt.sel .nd-addr-radio { color: var(--green-600); }

  /* New address form */
  .nd-new-addr { padding: 16px; background: var(--gray-50); border: 1px solid var(--border-light); border-radius: var(--radius-md); display: flex; flex-direction: column; gap: 10px; }
  .nd-addr-row-3 { display: grid; grid-template-columns: 1fr 80px 100px; gap: 10px; }
  @media (max-width: 500px) { .nd-addr-row-3 { grid-template-columns: 1fr; } }

  /* Mini calendar */
  .nd-cal-nav { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .nd-cal-btn { width: 32px; height: 32px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--surface); cursor: pointer; font-size: 18px; display: flex; align-items: center; justify-content: center; color: var(--gray-600); font-family: inherit; }
  .nd-cal-btn:hover { background: var(--gray-50); }
  .nd-cal-heading { font-size: 16px; font-weight: 700; }
  .nd-cal-grid { user-select: none; }
  .nd-cal-header { display: grid; grid-template-columns: repeat(7, 1fr); }
  .nd-cal-dow { text-align: center; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--gray-400); padding: 4px 0; }
  .nd-cal-body { display: grid; grid-template-columns: repeat(7, 1fr); }
  .nd-cal-cell { text-align: center; padding: 6px 2px; cursor: pointer; border-radius: var(--radius-sm); transition: background 0.1s; }
  .nd-cal-cell:hover:not(.other):not(.past) { background: var(--gray-100); }
  .nd-cal-cell.other { opacity: 0.25; pointer-events: none; }
  .nd-cal-cell.past { opacity: 0.3; pointer-events: none; }
  .nd-cal-cell.sel { background: var(--green-100); }
  .nd-cal-cell.sel .nd-cal-d { color: var(--green-700); font-weight: 800; }
  .nd-cal-cell.today .nd-cal-d { background: var(--green-600); color: white; border-radius: 50%; width: 28px; height: 28px; line-height: 28px; margin: 0 auto; }
  .nd-cal-d { font-size: 14px; font-weight: 600; color: var(--gray-700); }
  .nd-cal-dots { display: flex; justify-content: center; gap: 3px; margin-top: 3px; }
  .nd-cal-dot { width: 5px; height: 5px; border-radius: 50%; }
  .nd-cal-dot.green { background: var(--green-500); }
  .nd-cal-dot.amber { background: var(--amber-400); }
  .nd-cal-dot.red { background: var(--red-500); }
  .nd-cal-dot.empty { background: var(--gray-200); }

  /* Window selector */
  .nd-win-row { margin-top: 16px; }
  .nd-win-label { font-size: 14px; font-weight: 600; color: var(--gray-600); margin-bottom: 8px; }
  .nd-win-toggle { display: flex; gap: 8px; }
  .nd-win-btn { flex: 1; padding: 14px 12px; border: 2px solid var(--border); border-radius: var(--radius-md); background: var(--surface); font-family: inherit; cursor: pointer; transition: all 0.15s; display: flex; flex-direction: column; align-items: center; gap: 2px; }
  .nd-win-btn:hover { border-color: var(--gray-300); }
  .nd-win-btn.active { border-color: var(--green-400); background: var(--green-50); }
  .nd-win-name { font-size: 14px; font-weight: 700; color: var(--gray-700); }
  .nd-win-btn.active .nd-win-name { color: var(--green-700); }
  .nd-win-time { font-size: 12px; color: var(--gray-500); }
  .nd-win-btn.active .nd-win-time { color: var(--green-600); }
  .nd-win-cap { font-size: 12px; font-weight: 700; margin-top: 2px; }
  .nd-win-cap.green { color: var(--green-600); }
  .nd-win-cap.amber { color: var(--amber-600); }
  .nd-win-cap.red { color: var(--red-600); }
  @media (max-width: 400px) { .nd-win-toggle { flex-direction: column; } }

  /* Products */
  .nd-prod-add { display: flex; gap: 8px; }
  @media (max-width: 500px) { .nd-prod-add { flex-direction: column; } }
  .nd-load-list { margin-top: 12px; border: 1px solid var(--border-light); border-radius: var(--radius-md); overflow: hidden; }
  .nd-load-row { display: flex; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--border-light); font-size: 14px; }
  .nd-load-row:last-child { border-bottom: none; }
  .nd-load-summary { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: var(--green-50); border-top: 1px solid var(--green-100); font-size: 14px; font-weight: 600; color: var(--gray-700); }

  /* Submit bar */
  .nd-submit-bar { position: fixed; bottom: 0; left: 0; right: 0; padding: 14px 24px; background: var(--surface); border-top: 1px solid var(--border); box-shadow: 0 -4px 12px rgba(0,0,0,0.06); display: flex; align-items: center; gap: 8px; z-index: 100; }

  /* Success */
  .nd-success-card { max-width: 460px; margin: 40px auto; text-align: center; }
  .nd-success-icon { width: 56px; height: 56px; border-radius: 50%; background: var(--green-100); color: var(--green-700); font-size: 24px; font-weight: 800; display: flex; align-items: center; justify-content: center; margin: 0 auto 16px; }
  .nd-success-detail { margin-top: 16px; text-align: left; border: 1px solid var(--border-light); border-radius: var(--radius-md); overflow: hidden; }
  .nd-success-row { display: flex; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid var(--border-light); font-size: 14px; }
  .nd-success-row:last-child { border-bottom: none; }
  .nd-success-row span:first-child { color: var(--gray-500); }
  .nd-success-row span:last-child { color: var(--gray-900); font-weight: 600; }
`;
