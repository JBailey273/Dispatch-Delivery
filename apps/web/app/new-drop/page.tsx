'use client';

import { Suspense, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError, api, requireRole } from '../lib/auth';
import { useLocation } from '../lib/location-context';

/* ── Types ── */
type CatalogItem = { sku: string; name: string; active: boolean; delivery_mode: string; bulk_group: string; unit?: string };
type CustomerResult = { id: string; name: string; phone_e164: string; customer_type?: string; last_ordered?: string | null; exact_phone_match?: boolean };
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

  // Customer search
  const [searchQuery, setSearchQuery] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [newCustomerPhone, setNewCustomerPhone] = useState('');
  const [newCustomerName, setNewCustomerName] = useState('');
  const [newCustomerType, setNewCustomerType] = useState<'residential' | 'commercial'>('residential');
  const [showNewCustomerForm, setShowNewCustomerForm] = useState(false);
  const [customer, setCustomer] = useState<CustomerResult | null>(null);
  const [searchResults, setSearchResults] = useState<CustomerResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [resultAddresses, setResultAddresses] = useState<Record<string, Address>>({});

  // Priority delivery
  const [isPriority, setIsPriority] = useState(false);

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
  const [drivers, setDrivers] = useState<{ id: string; name: string; email: string }[]>([]);
  const [selectedDriverId, setSelectedDriverId] = useState<string>('');

  /* ── Load catalog ── */
  useEffect(() => {
    searchRef.current?.focus();
    api('/product-catalog').then(d => setCatalog(d.items || [])).catch(() => null);
    api('/dispatch/drivers').then(d => setDrivers(d.drivers || [])).catch(() => null);
  }, []);

  /* ── Preload customer from URL param ── */
  useEffect(() => {
    const customerId = searchParams.get('customerId');
    if (!customerId || customer) return;
    api(`/customers/${customerId}`).then(data => {
      if (data?.id) selectCustomer(data);
    }).catch(() => null);
  }, [searchParams]);

  /* ── Auto-set priority when customer type changes ── */
  useEffect(() => {
    if (customer) {
      setIsPriority(customer.customer_type === 'commercial');
    }
  }, [customer]);

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

  const windowLabel = (win: string) => win === 'A' ? 'Morning Delivery (9am \u2013 1pm)' : 'Afternoon Delivery (1pm \u2013 5pm)';

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr + 'T12:00:00');
    const dow = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getDay()];
    const mon = MONTHS[d.getMonth()];
    return `${dow}, ${mon} ${d.getDate()} ${d.getFullYear()}`;
  };

  const normalizeSearch = (raw: string): string => {
    const stripped = raw.replace(/[\s()\-+.]/g, '');
    if (/^\d{7,}$/.test(stripped)) return stripped;
    return raw.trim();
  };

  /* ── Customer lookup ── */
  const lookup = async () => {
    if (!searchQuery.trim()) return;
    setError('');
    setSearchLoading(true);
    setCustomer(null);
    setAddresses([]);
    setAddressId('');
    setShowNewCustomerForm(false);
    setResultAddresses({});
    setIsPriority(false);
    try {
      const q = normalizeSearch(searchQuery);
      const s = await api(`/customers/search?q=${encodeURIComponent(q)}`);
      const results = (s.results || []) as CustomerResult[];
      const sorted = [...results].sort((a, b) => Number(Boolean(b.exact_phone_match)) - Number(Boolean(a.exact_phone_match)));
      setSearchResults(sorted);
      if (sorted.length === 1) selectCustomer(sorted[0]);
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
    setNewCustomerType('residential');
    setIsPriority(false);
  };

  const createCustomer = async () => {
    if (!newCustomerPhone.trim()) { setError('Phone number is required to create a customer.'); return; }
    setError('');
    try {
      const c = await api('/customers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newCustomerName.trim() || 'Walk-in Customer', phone: newCustomerPhone.trim(), customer_type: newCustomerType }) });
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
    // Priority auto-sets from the useEffect above
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
    setIsPriority(false);
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
      const saved: Address = { id: res.id, line1: newAddr.line1, line2: newAddr.line2, city: newAddr.city, state: newAddr.state, postal_code: newAddr.postal_code, is_default: addresses.length === 0 };
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
  const { activeLocation } = useLocation();

  const canSubmit = customer && addressId && items.length > 0 && selDate && (isPriority || selectedWindow);
  const createDrop = async () => {
    if (!customer || !addressId || !items.length) { setError('Complete all sections before creating.'); return; }
    setError('');
    setSubmitting(true);
    try {
      if (customerName.trim() && customerName.trim() !== customer.name) {
        await api(`/customers/${customer.id}/name`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: customerName.trim() }) });
      }
      const payload: any = {
        customer: { id: customer.id },
        address: { address_id: addressId },
        scheduled_date: selDate,
        items,
        is_priority: isPriority,
        ...(activeLocation ? { location_id: activeLocation.id } : {}),
      };
      // Only include window for non-priority drops
      if (!isPriority) {
        payload.scheduled_window = selectedWindow;
      }
      const out = await api('/drops/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      localStorage.setItem(LAST_WINDOW_KEY, selectedWindow);
      localStorage.setItem(`${LAST_ADDRESS_KEY}${customer.id}`, addressId);
      localStorage.setItem(`${LAST_ITEMS_KEY}${customer.id}`, JSON.stringify(items));
      if (selectedDriverId && out.load_ids?.length) {
        try {
          await api('/dispatch/loads/assign', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ load_ids: out.load_ids, driver_user_id: selectedDriverId }),
          });
        } catch { /* non-fatal — order still created, dispatcher can assign in scheduler */ }
      }
      setResult(out);
    } catch (err) {
      setError((err as ApiError).message || 'Create drop failed.');
    } finally { setSubmitting(false); }
  };

  if (!requireRole(['dispatcher'])) return <div className="page"><p>Unauthorized</p></div>;

  // ── Success screen ──
  // ── Success screen ──
  if (result) return (
    <>
      <style>{pageStyles}</style>
      <div className="page nd-page">
        <div className="nd-success-card card card-padded">
          <div className="nd-success-icon">{'\u2713'}</div>
          <h2>Order Created</h2>
          <p style={{ color: 'var(--gray-500)', marginTop: 4, fontSize: 14 }}>
            {isPriority ? `Priority delivery · ${formatDate(selDate)}` : `${formatDate(selDate)} · ${windowLabel(selectedWindow)}`}
          </p>
          {isPriority && <span className="pill pill-blue" style={{ marginTop: 6, fontSize: 12 }}>{'\u26A1'} Priority</span>}

          <div className="nd-success-detail">
            <div className="nd-success-row">
              <span>Order</span>
              <span>{result.order_number ? `#D-${String(result.order_number).padStart(5, '0')}` : '—'}</span>
            </div>
            <div className="nd-success-row">
              <span>Customer</span>
              <span>{customer?.name}</span>
            </div>
            <div className="nd-success-row">
              <span>Address</span>
              <span>{addresses.find(a => a.id === addressId)?.line1 || '—'}</span>
            </div>
            <div className="nd-success-row">
              <span>Items</span>
              <span>{items.map(i => { const cat = catalog.find(c => c.sku === i.sku); return `${cat?.name || i.sku} ×${i.qty}`; }).join(', ')}</span>
            </div>
            <div className="nd-success-row">
              <span>Driver</span>
              <span>{drivers.find(d => d.id === selectedDriverId)?.name || 'Unassigned'}</span>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
            <button className="btn btn-primary" onClick={() => { setResult(null); setCustomer(null); setItems([]); setSearchQuery(''); setSearchResults([]); setAddressId(''); setAddresses([]); setShowNewAddr(false); setIsPriority(false); setSelectedDriverId(''); }}>New Order</button>
            <button className="btn btn-secondary" onClick={() => router.push('/dispatch-schedule')}>View Schedule</button>
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
            <p style={{ color: 'var(--gray-500)', marginTop: 2 }}>Search by name or phone {'\u2014'} pick any available delivery date</p>
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
                    placeholder="Enter Name or Phone Number"
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
                      const isComm = r.customer_type === 'commercial';
                      return (
                        <div key={r.id} className="nd-result-row" onClick={() => selectCustomer(r)}>
                          <div style={{ flex: 1 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <span style={{ fontWeight: 600 }}>{r.name}</span>
                              {isComm && <span className="pill pill-blue" style={{ fontSize: 10 }}>{'\uD83C\uDFE2'} Commercial</span>}
                            </div>
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
                    <input type="tel" placeholder="(516) 555-0142" value={newCustomerPhone} onChange={e => setNewCustomerPhone(e.target.value)} autoFocus />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Customer Name</label>
                    <input placeholder="Customer name (optional)" value={newCustomerName} onChange={e => setNewCustomerName(e.target.value)} />
                  </div>
                </div>
                <div className="form-group" style={{ marginTop: 8 }}>
                  <label className="form-label">Customer Type</label>
                  <div className="nd-type-toggle">
                    <button className={`nd-type-btn${newCustomerType === 'residential' ? ' active' : ''}`} onClick={() => setNewCustomerType('residential')} type="button">
                      {'\uD83C\uDFE0'} Residential
                    </button>
                    <button className={`nd-type-btn${newCustomerType === 'commercial' ? ' active' : ''}`} onClick={() => setNewCustomerType('commercial')} type="button">
                      {'\uD83C\uDFE2'} Commercial
                    </button>
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
                <div className={`nd-returning-avatar${customer.customer_type === 'commercial' ? ' commercial' : ''}`}>
                  {customer.customer_type === 'commercial' ? '\uD83C\uDFE2' : (customer.name?.charAt(0)?.toUpperCase() || '?')}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontWeight: 700, color: 'var(--gray-900)' }}>{customer.name}</span>
                    {customer.customer_type === 'commercial' && <span className="pill pill-blue" style={{ fontSize: 10 }}>{'\uD83C\uDFE2'} Commercial</span>}
                  </div>
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

        {/* ═══ PRIORITY TOGGLE ═══ */}
        {customer && (
          <div className={`nd-priority-card card${isPriority ? ' priority-active' : ''}`}>
            <div className="nd-priority-inner">
              <div className="nd-priority-left">
                <div className="nd-priority-icon">{isPriority ? '\u26A1' : '\uD83D\uDCE6'}</div>
                <div>
                  <div className="nd-priority-title">{isPriority ? 'Priority Delivery' : 'Standard Delivery'}</div>
                  <div className="nd-priority-desc">
                    {isPriority
                      ? 'Bypasses capacity limits \u2022 No window required \u2022 Appears at top of driver schedule'
                      : 'Scheduled within AM/PM delivery windows \u2022 Subject to capacity limits'}
                  </div>
                </div>
              </div>
              <label className="nd-priority-switch">
                <input
                  type="checkbox"
                  checked={isPriority}
                  onChange={e => setIsPriority(e.target.checked)}
                />
                <span className="nd-priority-slider"></span>
              </label>
            </div>
            {isPriority && customer.customer_type !== 'commercial' && (
              <div className="nd-priority-note">
                {'\u2139\uFE0F'} This is a residential customer. Priority is typically for commercial/contractor accounts but can be manually enabled.
              </div>
            )}
          </div>
        )}

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
          <div className="nd-card-head"><span className="nd-card-icon">{'\uD83D\uDCC5'}</span><span className="nd-card-title">Delivery Date{isPriority ? '' : ' & Window'}</span></div>
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
                      {!cell.other && !isPast && !isPriority && (
                        <div className="nd-cal-dots">
                          <div className={`nd-cal-dot ${awA ? capColor(awA.used, awA.total) : 'empty'}`} title="Morning" />
                          <div className={`nd-cal-dot ${awB ? capColor(awB.used, awB.total) : 'empty'}`} title="Afternoon" />
                        </div>
                      )}
                      {!cell.other && !isPast && isPriority && (
                        <div className="nd-cal-dots">
                          <div className="nd-cal-dot" style={{ background: 'var(--blue-400, #60a5fa)', width: 7, height: 7 }} title="Priority — no capacity limit" />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Window selector — hidden for priority */}
            {!isPriority && (
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
            )}

            {isPriority && (
              <div className="nd-priority-schedule-note">
                {'\u26A1'} Priority delivery for <strong>{formatDate(selDate)}</strong> {'\u2014'} no window assignment needed. This delivery will appear at the top of the driver{'\u2019'}s schedule.
              </div>
            )}

            {!isPriority && selectedDateAvail && !selectedDateAvail.available && (
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

{/* ═══ DRIVER ASSIGNMENT (optional) ═══ */}
        {selDate && (
          <div className="nd-card card">
            <div className="nd-card-head">
              <span className="nd-card-icon">🚚</span>
              <span className="nd-card-title">Driver Assignment</span>
              <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--gray-400)', fontWeight: 500 }}>Optional</span>
            </div>
            <div className="nd-card-body">
              {drivers.length === 0 ? (
                <p style={{ color: 'var(--gray-400)', fontSize: 14, margin: 0 }}>No drivers available</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => setSelectedDriverId('')}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '12px 14px', borderRadius: 10, cursor: 'pointer',
                      border: `2px solid ${selectedDriverId === '' ? 'var(--green-600)' : 'var(--gray-200)'}`,
                      background: selectedDriverId === '' ? 'var(--green-50)' : '#fff',
                      textAlign: 'left', width: '100%',
                    }}
                  >
                    <span style={{ fontSize: 20 }}>📋</span>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--gray-800)' }}>Unassigned</div>
                      <div style={{ fontSize: 12, color: 'var(--gray-400)' }}>Assign later in the scheduler</div>
                    </div>
                    {selectedDriverId === '' && <span style={{ marginLeft: 'auto', color: 'var(--green-600)', fontWeight: 700 }}>✓</span>}
                  </button>
                  {drivers.map(d => (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() => setSelectedDriverId(d.id)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        padding: '12px 14px', borderRadius: 10, cursor: 'pointer',
                        border: `2px solid ${selectedDriverId === d.id ? 'var(--green-600)' : 'var(--gray-200)'}`,
                        background: selectedDriverId === d.id ? 'var(--green-50)' : '#fff',
                        textAlign: 'left', width: '100%',
                      }}
                    >
                      <div style={{
                        width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
                        background: selectedDriverId === d.id ? 'var(--green-600)' : 'var(--gray-200)',
                        color: selectedDriverId === d.id ? '#fff' : 'var(--gray-600)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontWeight: 700, fontSize: 15, fontFamily: 'var(--font-heading)',
                      }}>
                        {(d.name || d.email).charAt(0).toUpperCase()}
                      </div>
                      <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--gray-800)' }}>{d.name}</div>
                      {selectedDriverId === d.id && <span style={{ marginLeft: 'auto', color: 'var(--green-600)', fontWeight: 700 }}>✓</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ═══ SUBMIT BAR ═══ */}
        
        {/* ═══ SUBMIT BAR ═══ */}
        <div className="nd-submit-bar">
          <button className="btn btn-ghost" onClick={() => router.push('/dispatch-schedule')}>Cancel</button>
          <div style={{ flex: 1 }} />
          {isPriority && <span className="pill pill-blue" style={{ fontSize: 12, marginRight: 8 }}>{'\u26A1'} Priority</span>}
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

  /* New customer type toggle */
  .nd-type-toggle { display: flex; gap: 6px; }
  .nd-type-btn { padding: 8px 14px; border: 2px solid var(--border); border-radius: var(--radius-md); background: var(--surface); cursor: pointer; font-family: inherit; font-size: 13px; font-weight: 600; color: var(--gray-600); transition: all 0.15s; }
  .nd-type-btn:hover { border-color: var(--gray-300); }
  .nd-type-btn.active { border-color: var(--green-400); background: var(--green-50); color: var(--green-700); }

  /* Customer results */
  .nd-results { border: 1px solid var(--border-light); border-radius: var(--radius-md); overflow: hidden; margin-top: 12px; }
  .nd-result-row { display: flex; align-items: center; gap: 12px; padding: 10px 14px; cursor: pointer; transition: background 0.12s; border-bottom: 1px solid var(--border-light); }
  .nd-result-row:last-child { border-bottom: none; }
  .nd-result-row:hover { background: var(--green-50); }

  /* Returning customer banner */
  .nd-returning { display: flex; align-items: center; gap: 12px; padding: 12px 14px; background: var(--green-50); border: 1px solid var(--green-200); border-radius: var(--radius-md); }
  .nd-returning-avatar { width: 36px; height: 36px; border-radius: 50%; background: var(--green-600); color: white; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 16px; flex-shrink: 0; }
  .nd-returning-avatar.commercial { background: var(--blue-600, #2563eb); font-size: 18px; font-weight: normal; }
  @media (max-width: 500px) { .nd-returning { flex-wrap: wrap; } }

  /* Priority delivery card */
  .nd-priority-card { margin-bottom: 16px; transition: all 0.2s; }
  .nd-priority-card.priority-active { border-color: var(--blue-300, #93c5fd); background: var(--blue-50, #eff6ff); }
  .nd-priority-inner { display: flex; align-items: center; gap: 14px; padding: 16px 20px; }
  .nd-priority-left { display: flex; align-items: center; gap: 12px; flex: 1; }
  .nd-priority-icon { font-size: 24px; flex-shrink: 0; }
  .nd-priority-title { font-size: 15px; font-weight: 700; color: var(--gray-800); }
  .nd-priority-card.priority-active .nd-priority-title { color: var(--blue-800, #1e40af); }
  .nd-priority-desc { font-size: 12px; color: var(--gray-500); margin-top: 2px; line-height: 1.4; }
  .nd-priority-card.priority-active .nd-priority-desc { color: var(--blue-600, #2563eb); }
  .nd-priority-note { padding: 10px 20px 14px; font-size: 12px; color: var(--amber-700, #b45309); background: var(--amber-50, #fffbeb); border-top: 1px solid var(--amber-200, #fde68a); }
  @media (max-width: 500px) { .nd-priority-inner { flex-direction: column; align-items: flex-start; gap: 10px; } }

  /* Priority toggle switch */
  .nd-priority-switch { position: relative; display: inline-block; width: 48px; height: 26px; flex-shrink: 0; }
  .nd-priority-switch input { opacity: 0; width: 0; height: 0; }
  .nd-priority-slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background: var(--gray-300); border-radius: 26px; transition: 0.2s; }
  .nd-priority-slider:before { content: ''; position: absolute; height: 20px; width: 20px; left: 3px; bottom: 3px; background: white; border-radius: 50%; transition: 0.2s; }
  .nd-priority-switch input:checked + .nd-priority-slider { background: var(--blue-500, #3b82f6); }
  .nd-priority-switch input:checked + .nd-priority-slider:before { transform: translateX(22px); }

  /* Priority schedule note */
  .nd-priority-schedule-note { margin-top: 16px; padding: 12px 16px; background: var(--blue-50, #eff6ff); border: 1px solid var(--blue-200, #bfdbfe); border-radius: var(--radius-md); font-size: 13px; color: var(--blue-700, #1d4ed8); line-height: 1.5; }

  /* Blue pill for priority badges */
  .pill-blue { background: var(--blue-50, #eff6ff); color: var(--blue-700, #1d4ed8); }

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
