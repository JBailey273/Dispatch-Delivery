'use client';

import { KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api, requireRole } from '../lib/auth';

type CatalogItem = { sku: string; name: string; active: boolean; delivery_mode: string; bulk_group: string };
type CustomerSearchResult = { id: string; name: string; phone_e164: string; last_ordered?: string | null; exact_phone_match?: boolean };

type Item = { sku: string; qty: number };

const LAST_WINDOW_KEY = 'dispatch:last-window';
const LAST_ADDRESS_KEY = 'dispatch:last-address:';
const LAST_ITEMS_KEY = 'dispatch:last-items:';

export default function NewDropPage() {
  const [phone, setPhone] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customer, setCustomer] = useState<CustomerSearchResult | null>(null);
  const [searchResults, setSearchResults] = useState<CustomerSearchResult[]>([]);
  const [addresses, setAddresses] = useState<any[]>([]);
  const [addressId, setAddressId] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [sku, setSku] = useState('');
  const [qty, setQty] = useState(1);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [selectedWindow, setSelectedWindow] = useState(() => (typeof window === 'undefined' ? 'A' : localStorage.getItem(LAST_WINDOW_KEY) || 'A'));
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [availability, setAvailability] = useState<any[]>([]);
  const [requiredLoads, setRequiredLoads] = useState<number | null>(null);
  const [showReorderSummary, setShowReorderSummary] = useState(false);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');

  const phoneInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    phoneInputRef.current?.focus();
    api('/product-catalog')
      .then((d) => setCatalog(d.items || []))
      .catch(() => null);
  }, []);

  const computeRequiredLoads = (selectedItems: Item[]) =>
    new Set(
      selectedItems
        .map((i) => catalog.find((c) => c.sku === i.sku))
        .filter(Boolean)
        .filter((c) => c?.delivery_mode === 'bulk_load')
        .map((c) => c?.bulk_group),
    ).size;

  useEffect(() => {
    if (!items.length || !catalog.length) {
      setRequiredLoads(null);
      setAvailability([]);
      return;
    }
    setRequiredLoads(computeRequiredLoads(items));
  }, [items, catalog]);

  const windowAvailability = useMemo(
    () => availability.find((a) => a.date === date && a.window === selectedWindow),
    [availability, date, selectedWindow],
  );

  const selectedCustomerLastItems = useMemo(() => {
    if (!customer) return [] as Item[];
    if (typeof window === 'undefined') return [] as Item[];
    return JSON.parse(localStorage.getItem(`${LAST_ITEMS_KEY}${customer.id}`) || '[]') as Item[];
  }, [customer]);

  const loadAddresses = async (customerId: string) => {
    const ad = await api(`/customers/${customerId}/addresses`);
    const fetched = ad.addresses || [];
    setAddresses(fetched);
    const lastUsedAddress = typeof window === 'undefined' ? '' : localStorage.getItem(`${LAST_ADDRESS_KEY}${customerId}`) || '';
    const defaultAddress = fetched.find((a: any) => a.id === lastUsedAddress) || fetched.find((a: any) => a.is_default) || fetched[0];
    setAddressId(defaultAddress?.id || '');
  };

  const lookup = async () => {
    setError('');
    const s = await api(`/customers/search?q=${encodeURIComponent(phone)}`);
    const results = (s.results || []) as CustomerSearchResult[];
    const sorted = [...results].sort((a, b) => Number(Boolean(b.exact_phone_match)) - Number(Boolean(a.exact_phone_match)));
    setSearchResults(sorted);
    if (sorted[0]) {
      setCustomer(sorted[0]);
      setCustomerName(sorted[0].name || '');
      await loadAddresses(sorted[0].id);
    }
  };

  const addItem = () => {
    if (!sku || qty <= 0) return;
    setItems([...items, { sku, qty }]);
    setSku('');
    setQty(1);
  };

  const checkAvailability = async () => {
    setError('');
    const req = computeRequiredLoads(items);
    setRequiredLoads(req);
    const a = await api(`/availability?required_loads=${req}&start_date=${date}&days=3`);
    setAvailability(a.windows || []);
    const preferred = typeof window === 'undefined' ? 'A' : localStorage.getItem(LAST_WINDOW_KEY) || 'A';
    const preferredWindow = (a.windows || []).find((w: any) => w.date === date && w.window === preferred && w.available);
    if (preferredWindow) setSelectedWindow(preferred);
  };

  const updateCustomerNameIfChanged = async () => {
    if (!customer) return;
    if (customerName.trim() && customerName.trim() !== customer.name) {
      await api(`/customers/${customer.id}/name`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: customerName.trim() }),
      });
    }
  };

  const createDrop = async () => {
    if (!customer || !addressId) {
      setError('Select customer and address first.');
      return;
    }
    try {
      setError('');
      await updateCustomerNameIfChanged();
      const out = await api('/drops/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer: { id: customer.id }, address: { address_id: addressId }, scheduled_date: date, scheduled_window: selectedWindow, items }),
      });
      localStorage.setItem(LAST_WINDOW_KEY, selectedWindow);
      localStorage.setItem(`${LAST_ADDRESS_KEY}${customer.id}`, addressId);
      localStorage.setItem(`${LAST_ITEMS_KEY}${customer.id}`, JSON.stringify(items));
      setResult(JSON.stringify(out));
    } catch (err) {
      const apiErr = err as ApiError;
      setError(apiErr.message || 'Create drop failed.');
    }
  };

  const onPhoneEnter = async (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    await lookup();
  };

  if (!requireRole(['dispatcher'])) return <p>Unauthorized</p>;

  return (
    <main>
      <h1>New Drop</h1>
      {error && <p style={{ color: '#b00020' }}>{error}</p>}
      <h3>1. Customer</h3>
      <input ref={phoneInputRef} placeholder="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} onKeyDown={onPhoneEnter} />
      <button onClick={lookup}>Lookup</button>
      <button
        onClick={async () => {
          const c = await api('/customers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Walk-in Customer', phone }) });
          setCustomer(c.customer);
          setCustomerName(c.customer.name || '');
          setSearchResults([c.customer]);
          await loadAddresses(c.customer.id);
        }}
      >
        Create
      </button>
      {searchResults.length > 0 && (
        <ul>
          {searchResults.slice(0, 5).map((r) => (
            <li key={r.id}>
              <button
                onClick={async () => {
                  setCustomer(r);
                  setCustomerName(r.name || '');
                  await loadAddresses(r.id);
                }}
              >
                {r.name} ({r.phone_e164}) {r.exact_phone_match ? '• exact match' : ''} {r.last_ordered ? `• Last ordered ${r.last_ordered}` : ''}
              </button>
            </li>
          ))}
        </ul>
      )}
      {customer && (
        <>
          <p>Selected: {customer.name}</p>
          <label>
            Name
            <input value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
          </label>
          {customerName.trim() && customerName.trim() !== customer.name && <p style={{ color: '#a15c00' }}>Name changed — customer record will be updated on create.</p>}
          {selectedCustomerLastItems.length > 0 && (
            <div>
              <button
                onClick={() => {
                  setItems(selectedCustomerLastItems);
                  setShowReorderSummary(true);
                }}
              >
                Reorder last
              </button>
              {showReorderSummary && <p>Reorder summary: {selectedCustomerLastItems.map((i) => `${i.sku} x${i.qty}`).join(', ')}</p>}
            </div>
          )}
        </>
      )}

      <h3>2. Address</h3>
      <select value={addressId} onChange={(e) => setAddressId(e.target.value)}>
        <option value="">Select</option>
        {addresses.map((a) => (
          <option key={a.id} value={a.id}>
            {a.line1}, {a.city}
          </option>
        ))}
      </select>

      <h3>3. Products</h3>
      <select value={sku} onChange={(e) => setSku(e.target.value)}>
        <option value="">Select SKU</option>
        {catalog
          .filter((c) => c.active)
          .map((c) => (
            <option key={c.sku} value={c.sku}>
              {c.sku} - {c.name}
            </option>
          ))}
      </select>
      <input type="number" value={qty} onChange={(e) => setQty(Number(e.target.value))} onKeyDown={(e) => e.key === 'Enter' && addItem()} />
      <button onClick={addItem}>Add</button>
      <ul>
        {items.map((i, idx) => (
          <li key={idx}>
            {i.sku} x{i.qty}
          </li>
        ))}
      </ul>

      <h3>4. Capacity Check</h3>
      <p>Required loads: {requiredLoads ?? 'Add items to calculate'}</p>
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      <select value={selectedWindow} onChange={(e) => setSelectedWindow(e.target.value)} disabled={requiredLoads === null}>
        <option>A</option>
        <option>B</option>
      </select>
      <button onClick={checkAvailability} disabled={requiredLoads === null}>
        Check Availability
      </button>
      {windowAvailability && (
        <p style={{ color: windowAvailability.available ? '#0f5132' : '#b00020' }}>
          Window {selectedWindow}: {windowAvailability.used}/{windowAvailability.total} used, {windowAvailability.remaining_capacity} remaining.
        </p>
      )}

      <h3>5. Create</h3>
      <button onClick={createDrop}>Create Drop</button>
      <p>{result}</p>
    </main>
  );
}
