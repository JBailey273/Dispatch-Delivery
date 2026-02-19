'use client';

import { useState } from 'react';
import { requireRole } from '../../lib/auth';

type CartItem = { sku: string; qty: number };

export default function AvailabilityTestPage() {
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [sku, setSku] = useState('');
  const [qty, setQty] = useState(1);
  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [result, setResult] = useState<any>(null);
  const [hold, setHold] = useState<any>(null);
  const [selectedDate, setSelectedDate] = useState('');
  const [selectedWindow, setSelectedWindow] = useState('A');
  const [channelKey, setChannelKey] = useState('');
  const [confirmResult, setConfirmResult] = useState<any>(null);
  const [ingestResult, setIngestResult] = useState<any>(null);

  const channelApi = async (path: string, body: any) => {
    const base = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:8000/api/v1';
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Channel-Key': channelKey },
      body: JSON.stringify(body),
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload?.detail?.message || 'Request failed');
    return payload;
  };

  if (!requireRole(['admin'])) return <p>Unauthorized</p>;

  return (
    <main>
      <h1>Availability Test</h1>
      <p>Internal QA tool to validate availability, hold, and hold confirmation flow.</p>
      <input placeholder="X-Channel-Key" value={channelKey} onChange={(e) => setChannelKey(e.target.value)} />

      <section>
        <h3>Cart</h3>
        <input placeholder="SKU" value={sku} onChange={(e) => setSku(e.target.value)} />
        <input type="number" min={1} value={qty} onChange={(e) => setQty(Number(e.target.value))} />
        <button onClick={() => { if (!sku) return; setCartItems([...cartItems, { sku, qty }]); setSku(''); setQty(1); }}>Add item</button>
        <ul>{cartItems.map((i, idx) => <li key={idx}>{i.sku} x {i.qty}</li>)}</ul>
      </section>

      <section>
        <h3>Check availability</h3>
        <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        <button onClick={async () => {
          setResult(await channelApi('/availability', { date_range: { start_date: startDate, end_date: endDate }, cart_items: cartItems }));
        }}>Run</button>
        <pre>{JSON.stringify(result, null, 2)}</pre>
      </section>

      <section>
        <h3>Create hold (manual QA)</h3>
        <input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} />
        <select value={selectedWindow} onChange={(e) => setSelectedWindow(e.target.value)}><option value="A">A</option><option value="B">B</option></select>
        <button onClick={async () => {
          const requiredLoads = result?.required_loads ?? 0;
          setHold(await channelApi('/holds', { date: selectedDate, window: selectedWindow, required_loads: requiredLoads, cart_hash: `qa-${Date.now()}`, cart_items: cartItems }));
        }}>Create hold</button>
        <pre>{JSON.stringify(hold, null, 2)}</pre>
      </section>


      <section>
        <h3>Ingest order (requires hold token)</h3>
        <button disabled={!hold?.hold_token} onClick={async () => {
          const payload = {
            hold_token: hold.hold_token,
            external_order: { id: `woo-qa-${Date.now()}`, placed_at: new Date().toISOString(), url: null },
            customer: { name: 'QA Customer', phone: '+15555551212', email: 'qa@example.com' },
            drop: {
              address: { line1: '123 QA St', city: 'Testville', state: 'TX', postal_code: '75001', country: 'US' },
              notes: 'QA ingest order',
              photos: [],
              requested_date: selectedDate,
              requested_window: selectedWindow,
            },
            items: cartItems,
          };
          setIngestResult(await channelApi('/orders/ingest', payload));
        }}>Run ingest</button>
        <pre>{JSON.stringify(ingestResult, null, 2)}</pre>
      </section>

      <section>
        <h3>Confirm hold to create drop</h3>
        <button disabled={!hold?.hold_token} onClick={async () => {
          const payload = {
            external_order: { id: `qa-${Date.now()}`, placed_at: new Date().toISOString(), url: null },
            customer: { name: 'QA Customer', phone: '+15555551212', email: 'qa@example.com' },
            drop: {
              address: { line1: '123 QA St', city: 'Testville', state: 'TX', postal_code: '75001', country: 'US' },
              notes: 'QA confirm hold',
              photos: [],
              requested_date: selectedDate,
              requested_window: selectedWindow,
            },
            items: cartItems,
          };
          setConfirmResult(await channelApi(`/holds/${hold.hold_token}/confirm`, payload));
        }}>Confirm hold</button>
        <pre>{JSON.stringify(confirmResult, null, 2)}</pre>
      </section>
    </main>
  );
}
