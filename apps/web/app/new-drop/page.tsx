'use client';

import { KeyboardEvent, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
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

export default function NewDropPage() {
  const router = useRouter();
  const phoneRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');

  // Customer
  const [phone, setPhone] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customer, setCustomer] = useState<CustomerResult | null>(null);
  const [searchResults, setSearchResults] = useState<CustomerResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  // Address
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [addressId, setAddressId] = useState('');

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
    phoneRef.current?.focus();
    api('/product-catalog').then(d => setCatalog(d.items || [])).catch(() => null);
  }, []);

  /* ── Computed ── */
  const requiredLoads = useMemo(() => {
    if (!items.length || !catalog.length) return 0;
    return new Set(
      items.map(i => catalog.find(c => c.sku === i.sku)).filter(Boolean).filter(c => c?.delivery_mode === 'bulk_load').map(c => c?.bulk_group)
    ).size;
  }, [items, catalog]);

  const selectedAddress = addresses.find(a => a.id === addressId);

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

  /* ── Customer lookup ── */
  const lookup = async () => {
    if (!phone.trim()) return;
    setError('');
    setSearchLoading(true);
    try {
      const s = await api(`/customers/search?q=${encodeURIComponent(phone)}`);
      const results = (s.results || []) as CustomerResult[];
      const sorted = [...results].sort((a, b) => Number(Boolean(b.exact_phone_match)) - Number(Boolean(a.exact_phone_match)));
      setSearchResults(sorted);
      if (sorted[0]) selectCustomer(sorted[0]);
    } catch (err) {
      setError((err as ApiError).message || 'Search failed');
    } finally {
      setSearchLoading(false);
    }
  };

  const createCustomer = async () => {
    if (!phone.trim()) return;
    try {
      const c = await api('/customers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: customerName || 'Walk-in Customer', phone }) });
      selectCustomer(c.customer);
      setSearchResults([c.customer]);
    } catch (err) {
      setError((err as ApiError).message || 'Create failed');
    }
  };

  const selectCustomer = async (c: CustomerResult) => {
    setCustomer(c);
    setCustomerName(c.name || '');
    try {
      const ad = await api(`/customers/${c.id}/addresses`);
      const fetched = ad.addresses || [];
      setAddresses(fetched);
      const lastUsed = typeof window === 'undefined' ? '' : localStorage.getItem(`${LAST_ADDRESS_KEY}${c.id}`) || '';
      const def = fetched.find((a: Address) => a.id === lastUsed) || fetched.find((a: Address) => a.is_default) || fetched[0];
      setAddressId(def?.id || '');
    } catch { setAddresses([]); }
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
          <div className="nd-success-icon">✓</div>
          <h2>Order Created</h2>
          <p style={{ color: 'var(--gray-600)', marginTop: 4 }}>
            Scheduled for {(() => {
              const d = new Date(selDate + 'T12:00:00');
              const dow = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getDay()];
              const mon = ['January','February','March','April','May','June','July','August','September','October','November','December'][d.getMonth()];
              return `${dow}, ${mon} ${d.getDate()} ${d.getFullYear()}`;
            })()}, Window {selectedWindow === 'A' ? 'AM (9–1)' : 'PM (1–5)'}
          </p>
          <div className="nd-success-detail">
            <div className="nd-success-row"><span>Drop ID</span><span style={{ fontFamily: 'monospace', fontSize: 13 }}>{result.drop_id}</span></div>
            <div className="nd-success-row"><span>Loads</span><span>{result.load_ids?.length || 0}</span></div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
            <button className="btn btn-primary" onClick={() => { setResult(null); setCustomer(null); setItems([]); setPhone(''); setSearchResults([]); setAddressId(''); }}>New Order</button>
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
            <p style={{ color: 'var(--gray-500)', marginTop: 2 }}>Phone or walk-in — pick any available delivery date</p>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => router.push('/dispatch-schedule')}>Cancel</button>
        </div>

        {error && <div className="alert alert-error" style={{ marginBottom: 16 }}><span>⚠</span> {error}</div>}

        {/* ═══ CUSTOMER ═══ */}
        <div className="nd-card card">
          <div className="nd-card-head"><span className="nd-card-icon">👤</span><span className="nd-card-title">Customer</span></div>
          <div className="nd-card-body">
            <div className="nd-row-2">
              <div className="form-group">
                <label className="form-label">Phone Number</label>
                <input ref={phoneRef} type="tel" placeholder="(516) 555-0142" value={phone}
                  onChange={e => setPhone(e.target.value)} onKeyDown={e => e.key === 'Enter' && lookup()} />
              </div>
              <div className="form-group">
                <label className="form-label">Name</label>
                <input placeholder="Customer name" value={customerName} onChange={e => setCustomerName(e.target.value)} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button className="btn btn-primary btn-sm" onClick={lookup} disabled={searchLoading}>
                {searchLoading ? 'Searching…' : 'Lookup'}
              </button>
              <button className="btn btn-secondary btn-sm" onClick={createCustomer}>+ New Customer</button>
            </div>

            {/* Search results */}
            {searchResults.length > 0 && !customer && (
              <div className="nd-results">
                {searchResults.slice(0, 5).map(r => (
                  <div key={r.id} className="nd-result-row" onClick={() => selectCustomer(r)}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600 }}>{r.name}</div>
                      <div className="text-sm" style={{ color: 'var(--gray-500)' }}>{r.phone_e164}</div>
                    </div>
                    {r.exact_phone_match && <span className="pill pill-green"><span className="pill-dot" />Exact</span>}
                    {r.last_ordered && <span className="text-xs" style={{ color: 'var(--gray-400)' }}>Last: {r.last_ordered}</span>}
                  </div>
                ))}
              </div>
            )}

            {/* Returning customer banner */}
            {customer && (
              <div className="nd-returning">
                <div className="nd-returning-avatar">{customer.name?.charAt(0)?.toUpperCase() || '?'}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, color: 'var(--gray-900)' }}>{customer.name}</div>
                  <div className="text-sm" style={{ color: 'var(--gray-500)' }}>✓ {customer.phone_e164}{customer.last_ordered ? ` · Last order ${customer.last_ordered}` : ''}</div>
                </div>
                {selectedCustomerLastItems.length > 0 && (
                  <button className="btn btn-secondary btn-sm" onClick={() => setItems(selectedCustomerLastItems)}>Reorder Last</button>
                )}
                <button className="btn btn-ghost btn-sm" onClick={() => { setCustomer(null); setSearchResults([]); }}>Change</button>
              </div>
            )}
          </div>
        </div>

        {/* ═══ ADDRESS ═══ */}
        <div className="nd-card card">
          <div className="nd-card-head"><span className="nd-card-icon">📍</span><span className="nd-card-title">Delivery Address</span></div>
          <div className="nd-card-body">
            {addresses.length === 0 ? (
              <p style={{ color: 'var(--gray-400)', fontSize: 14 }}>Look up a customer first to see saved addresses</p>
            ) : (
              <div className="nd-addr-list">
                {addresses.map(a => (
                  <div key={a.id} className={`nd-addr-opt${addressId === a.id ? ' sel' : ''}`} onClick={() => setAddressId(a.id)}>
                    <div className="nd-addr-radio">{addressId === a.id ? '●' : '○'}</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600 }}>{a.line1}{a.line2 ? `, ${a.line2}` : ''}</div>
                      <div className="text-sm" style={{ color: 'var(--gray-500)' }}>{a.city}, {a.state} {a.postal_code}</div>
                    </div>
                    {a.is_default && <span className="pill pill-green" style={{ fontSize: 11 }}>Default</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ═══ SCHEDULE — MINI CALENDAR ═══ */}
        <div className="nd-card card">
          <div className="nd-card-head"><span className="nd-card-icon">📅</span><span className="nd-card-title">Delivery Date</span></div>
          <div className="nd-card-body">
            <div className="nd-cal-nav">
              <button className="nd-cal-btn" onClick={() => setCalMonth(p => { const nm = p.m - 1; return nm < 0 ? { y: p.y - 1, m: 11 } : { ...p, m: nm }; })}>‹</button>
              <div className="nd-cal-heading">{MONTHS[calMonth.m]} {calMonth.y}</div>
              <button className="nd-cal-btn" onClick={() => setCalMonth(p => { const nm = p.m + 1; return nm > 11 ? { y: p.y + 1, m: 0 } : { ...p, m: nm }; })}>›</button>
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
                          <div className={`nd-cal-dot ${awA ? capColor(awA.used, awA.total) : 'empty'}`} />
                          <div className={`nd-cal-dot ${awB ? capColor(awB.used, awB.total) : 'empty'}`} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Window selector */}
            <div className="nd-win-row">
              <div className="nd-win-label">Window for {(() => {
                const d = new Date(selDate + 'T12:00:00');
                const dow = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getDay()];
                const mon = ['January','February','March','April','May','June','July','August','September','October','November','December'][d.getMonth()];
                return `${dow}, ${mon} ${d.getDate()} ${d.getFullYear()}`;
              })()}:</div>
              <div className="nd-win-toggle">
                <button className={`nd-win-btn${selectedWindow === 'A' ? ' active' : ''}`} onClick={() => setSelectedWindow('A')}>
                  AM (9–1)
                  {(() => { const a = getWindowAvail(selDate, 'A'); return a ? <span className={`nd-win-cap ${capColor(a.used, a.total)}`}>{a.remaining_capacity} open</span> : null; })()}
                </button>
                <button className={`nd-win-btn${selectedWindow === 'B' ? ' active' : ''}`} onClick={() => setSelectedWindow('B')}>
                  PM (1–5)
                  {(() => { const a = getWindowAvail(selDate, 'B'); return a ? <span className={`nd-win-cap ${capColor(a.used, a.total)}`}>{a.remaining_capacity} open</span> : null; })()}
                </button>
              </div>
            </div>

            {selectedDateAvail && !selectedDateAvail.available && (
              <div className="alert alert-error" style={{ marginTop: 8, fontSize: 13 }}><span>✕</span> Not enough capacity for {requiredLoads} load{requiredLoads !== 1 ? 's' : ''} in this window</div>
            )}
          </div>
        </div>

        {/* ═══ PRODUCTS ═══ */}
        <div className="nd-card card">
          <div className="nd-card-head"><span className="nd-card-icon">📦</span><span className="nd-card-title">Products</span></div>
          <div className="nd-card-body">
            <div className="nd-prod-add">
              <select value={sku} onChange={e => setSku(e.target.value)} style={{ flex: 1 }}>
                <option value="">Select product…</option>
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
                      <button className="btn btn-ghost btn-sm" onClick={() => removeItem(idx)} style={{ color: 'var(--red-600)' }}>✕</button>
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
            {submitting ? 'Creating…' : '✓ Confirm & Schedule'}
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

  /* Customer results */
  .nd-results { border: 1px solid var(--border-light); border-radius: var(--radius-md); overflow: hidden; margin-top: 12px; }
  .nd-result-row { display: flex; align-items: center; gap: 12px; padding: 10px 14px; cursor: pointer; transition: background 0.12s; border-bottom: 1px solid var(--border-light); }
  .nd-result-row:last-child { border-bottom: none; }
  .nd-result-row:hover { background: var(--green-50); }

  /* Returning customer banner */
  .nd-returning { display: flex; align-items: center; gap: 12px; margin-top: 12px; padding: 12px 14px; background: var(--green-50); border: 1px solid var(--green-200); border-radius: var(--radius-md); }
  .nd-returning-avatar { width: 36px; height: 36px; border-radius: 50%; background: var(--green-600); color: white; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 16px; flex-shrink: 0; }
  @media (max-width: 500px) { .nd-returning { flex-wrap: wrap; } }

  /* Address */
  .nd-addr-list { display: flex; flex-direction: column; gap: 8px; }
  .nd-addr-opt { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border: 2px solid var(--border-light); border-radius: var(--radius-md); cursor: pointer; transition: all 0.15s; }
  .nd-addr-opt:hover { border-color: var(--gray-300); }
  .nd-addr-opt.sel { border-color: var(--green-400); background: var(--green-50); }
  .nd-addr-radio { font-size: 18px; color: var(--gray-300); flex-shrink: 0; }
  .nd-addr-opt.sel .nd-addr-radio { color: var(--green-600); }

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
  .nd-win-btn { flex: 1; padding: 12px; border: 2px solid var(--border); border-radius: var(--radius-md); background: var(--surface); font-family: inherit; font-size: 14px; font-weight: 600; color: var(--gray-600); cursor: pointer; transition: all 0.15s; display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .nd-win-btn:hover { border-color: var(--gray-300); }
  .nd-win-btn.active { border-color: var(--green-400); background: var(--green-50); color: var(--green-700); }
  .nd-win-cap { font-size: 12px; font-weight: 700; }
  .nd-win-cap.green { color: var(--green-600); }
  .nd-win-cap.amber { color: var(--amber-600); }
  .nd-win-cap.red { color: var(--red-600); }

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
