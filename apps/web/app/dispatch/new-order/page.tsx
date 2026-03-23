'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { loadStripe } from '@stripe/stripe-js';
import {
  Elements,
  CardElement,
  useStripe,
  useElements,
} from '@stripe/react-stripe-js';
import { ApiError, api, requireRole } from '../../lib/auth';

// ── Stripe init ───────────────────────────────────────────────────────────────

const stripePromise = loadStripe(
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || ''
);

// ── Types ─────────────────────────────────────────────────────────────────────

type WcProduct = {
  id: number;
  name: string;
  sku: string;
  price: string;
  regular_price: string;
  contractor_price: string | null;
  wholesale_price: string | null;
  sold_by_yard: boolean;
};

type SavedCard = {
  payment_method_id: string;
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
};

type OrderHistoryItem = {
  wc_order_id: number;
  order_number: string;
  date: string;
  status: string;
  total: string;
  items: string[];
  line_items_raw: { product_id: number; name: string; quantity: number }[];
};

type WcCustomer = {
  found: boolean;
  wc_id?: number;
  email?: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
  role?: string | null;
  billing?: Record<string, string>;
  stripe_customer_id?: string | null;
  saved_card?: SavedCard | null;
  order_history?: OrderHistoryItem[];
  local_customer_id?: string | null;
  sms_opt_in?: boolean;
  email_opt_in?: boolean;
};

type LineItem = {
  product_id: number;
  name: string;
  quantity: number;
  unit_price: number;
};

type ShippingResult = {
  found: boolean;
  zone_id?: number;
  zone_title?: string;
  fee?: string;
  instance_id?: string;
};

type Confirmation = {
  wc_order_id: number;
  order_number: string;
  first_name: string;
  last_name: string;
  delivery_method: string;
  total: number;
  payment_method: string;
  payment_link_url?: string | null;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function priceForRole(product: WcProduct, role: string | null | undefined): number {
  if (role === 'contractor' && product.contractor_price) return parseFloat(product.contractor_price);
  if (role === 'wholesale' && product.wholesale_price) return parseFloat(product.wholesale_price);
  return parseFloat(product.price || '0');
}

function roleLabel(role: string | null | undefined) {
  if (role === 'contractor') return { label: 'Contractor', color: '#92400e', bg: '#fef3c7' };
  if (role === 'wholesale') return { label: 'Wholesale', color: '#5b21b6', bg: '#ede9fe' };
  return null;
}

// ── Card form (needs Stripe context) ─────────────────────────────────────────

function CardForm({
  totalCents,
  customerName,
  customerEmail,
  stripeCustomerId,
  savedCard,
  saveCard,
  onSavedCardClear,
  onPaymentReady,
  onPaymentError,
}: {
  totalCents: number;
  customerName: string;
  customerEmail: string;
  stripeCustomerId: string | null;
  savedCard: SavedCard | null;
  saveCard: boolean;
  onSavedCardClear: () => void;
  onPaymentReady: (fn: () => Promise<{ paymentIntentId: string; stripeCustomerId: string } | null>) => void;
  onPaymentError: (msg: string) => void;
}) {
  const stripe = useStripe();
  const elements = useElements();

  const charge = async (): Promise<{ paymentIntentId: string; stripeCustomerId: string } | null> => {
    if (!stripe) { onPaymentError('Stripe not loaded'); return null; }

    try {
      const intentRes = await api('/internal-orders/create-payment-intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount_cents: totalCents,
          stripe_customer_id: stripeCustomerId,
          payment_method_id: savedCard?.payment_method_id || null,
          customer_name: customerName,
          customer_email: customerEmail,
          save_card: saveCard,
          description: 'East Meadow Garden Center order',
        }),
      });

      if (intentRes.confirmed) {
        return { paymentIntentId: intentRes.payment_intent_id, stripeCustomerId: intentRes.stripe_customer_id };
      }

      // New card — confirm client-side
      const cardEl = elements?.getElement(CardElement);
      if (!cardEl) { onPaymentError('Card element not found'); return null; }

      const { error, paymentIntent } = await stripe.confirmCardPayment(
        intentRes.client_secret,
        { payment_method: { card: cardEl, billing_details: { name: customerName, email: customerEmail } } }
      );

      if (error) { onPaymentError(error.message || 'Card declined'); return null; }
      if (paymentIntent?.status === 'succeeded') {
        return { paymentIntentId: paymentIntent.id, stripeCustomerId: intentRes.stripe_customer_id };
      }
      onPaymentError('Payment did not complete'); return null;
    } catch (err) {
      onPaymentError((err as ApiError).message || 'Payment failed'); return null;
    }
  };

  // Expose charge fn to parent on mount
  useEffect(() => { onPaymentReady(charge); }, [stripe, elements, totalCents, savedCard]);

  return (
    <div>
      {savedCard ? (
        <div className="no-saved-card">
          <div className="no-saved-card-info">
            <span>💳</span>
            <div>
              <div className="no-saved-card-label">
                {savedCard.brand.charAt(0).toUpperCase() + savedCard.brand.slice(1)} ending {savedCard.last4}
              </div>
              <div className="no-saved-card-exp">Expires {savedCard.exp_month}/{savedCard.exp_year}</div>
            </div>
          </div>
          <span className="no-saved-card-badge">On file</span>
        </div>
      ) : (
        <div className="no-card-element">
          <CardElement options={{
            style: {
              base: { fontSize: '15px', fontFamily: 'DM Sans, sans-serif', color: '#1f2937', '::placeholder': { color: '#9ca3af' } },
              invalid: { color: '#dc2626' },
            },
          }} />
        </div>
      )}
      {savedCard && (
        <button className="btn btn-ghost btn-xs" style={{ marginTop: 8 }} onClick={onSavedCardClear}>
          Use a different card
        </button>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function NewOrderPage() {
  const router = useRouter();

  // Customer
  const [lookupQuery, setLookupQuery] = useState('');
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupDone, setLookupDone] = useState(false);
  const [wcCustomer, setWcCustomer] = useState<WcCustomer | null>(null);
  const lookupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [smsOptIn, setSmsOptIn] = useState(false);
  const [emailOptIn, setEmailOptIn] = useState(false);
  const [wcRole, setWcRole] = useState<string | null>(null);
  const [isContractor, setIsContractor] = useState(false);
  const [stripeCustomerId, setStripeCustomerId] = useState<string | null>(null);
  const [savedCard, setSavedCard] = useState<SavedCard | null>(null);

  // Products
  const [products, setProducts] = useState<WcProduct[]>([]);
  const [productsLoading, setProductsLoading] = useState(true);
  const [lineItems, setLineItems] = useState<LineItem[]>([]);

  // Delivery
  const [deliveryMethod, setDeliveryMethod] = useState<'delivery' | 'pickup'>('delivery');
  const [addrLine1, setAddrLine1] = useState('');
  const [addrLine2, setAddrLine2] = useState('');
  const [addrCity, setAddrCity] = useState('');
  const [addrState, setAddrState] = useState('MA');
  const [addrZip, setAddrZip] = useState('');
  const [shipping, setShipping] = useState<ShippingResult | null>(null);
  const [shippingLoading, setShippingLoading] = useState(false);
  const zipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [overrideDeliveryFee, setOverrideDeliveryFee] = useState(false);

  // Payment
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'card' | 'payment_link' | 'invoice'>('cash');
  const [saveCard, setSaveCard] = useState(false);
  const [paymentNote, setPaymentNote] = useState('');
  const chargeRef = useRef<(() => Promise<{ paymentIntentId: string; stripeCustomerId: string } | null>) | null>(null);
  const [cashTendered, setCashTendered] = useState('');

  // Submit
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  if (!requireRole(['dispatcher', 'admin'])) {
    return <div className="page"><p>Unauthorized</p></div>;
  }

  // Load products
  const loadProducts = useCallback(async (role: string | null) => {
    setProductsLoading(true);
    try {
      const params = role ? `?role=${role}` : '';
      const data = await api(`/internal-orders/wc-products${params}`);
      setProducts(data.products || []);
    } catch { /* silent */ }
    finally { setProductsLoading(false); }
  }, []);

  useEffect(() => { loadProducts(null); }, [loadProducts]);

  // Customer lookup
  const runLookup = useCallback(async (q: string) => {
    if (q.trim().length < 3) return;
    setLookupLoading(true);
    try {
      const data: WcCustomer = await api(`/internal-orders/wc-customer?search=${encodeURIComponent(q.trim())}`);
      setLookupDone(true);
      if (data.found) {
        setWcCustomer(data);
        setFirstName(data.first_name || '');
        setLastName(data.last_name || '');
        setEmail(data.email || '');
        setPhone(data.billing?.phone || data.phone || '');
        setWcRole(data.role || null);
        setIsContractor(data.role === 'contractor');
        setStripeCustomerId(data.stripe_customer_id || null);
        setSavedCard(data.saved_card || null);
        setSmsOptIn(data.sms_opt_in || false);
        setEmailOptIn(data.email_opt_in || false);
        if (data.billing?.address_1) {
          setAddrLine1(data.billing.address_1 || '');
          setAddrLine2(data.billing.address_2 || '');
          setAddrCity(data.billing.city || '');
          setAddrState(data.billing.state || 'MA');
          setAddrZip(data.billing.postcode || '');
        }
        if (data.role) loadProducts(data.role);
      } else {
        setWcCustomer({ found: false });
      }
    } catch {
      setLookupDone(true);
      setWcCustomer({ found: false });
    } finally { setLookupLoading(false); }
  }, [loadProducts]);

  const handleLookupChange = (val: string) => {
    setLookupQuery(val);
    setLookupDone(false);
    if (lookupTimer.current) clearTimeout(lookupTimer.current);
    if (val.trim().length >= 3) lookupTimer.current = setTimeout(() => runLookup(val), 600);
  };

  const clearCustomer = () => {
    setWcCustomer(null); setLookupQuery(''); setLookupDone(false);
    setFirstName(''); setLastName(''); setEmail(''); setPhone(''); setCompanyName('');
    setWcRole(null); setIsContractor(false); setStripeCustomerId(null); setSavedCard(null);
    setSmsOptIn(false); setEmailOptIn(false);
    setAddrLine1(''); setAddrLine2(''); setAddrCity(''); setAddrState('MA'); setAddrZip('');
    setShipping(null); loadProducts(null);
    setCashTendered('');
  };

  const repeatLastOrder = (history: OrderHistoryItem) => {
    const newItems: LineItem[] = [];
    for (const li of history.line_items_raw) {
      const prod = products.find(p => p.id === li.product_id);
      if (prod) newItems.push({ product_id: prod.id, name: prod.name, quantity: li.quantity, unit_price: priceForRole(prod, wcRole) });
    }
    if (newItems.length > 0) setLineItems(newItems);
  };

  // Shipping zone
  useEffect(() => {
    if (deliveryMethod !== 'delivery' || addrZip.length < 5) { setShipping(null); return; }
    if (zipTimer.current) clearTimeout(zipTimer.current);
    zipTimer.current = setTimeout(async () => {
      setShippingLoading(true);
      try {
        const data = await api(`/internal-orders/shipping-fee?postal_code=${addrZip.trim()}`);
        setShipping(data);
      } catch { setShipping(null); }
      finally { setShippingLoading(false); }
    }, 700);
  }, [addrZip, deliveryMethod]);

  // Role change
  const handleRoleChange = (role: string | null) => {
    setWcRole(role); setIsContractor(role === 'contractor'); loadProducts(role);
    setLineItems(prev => prev.map(l => {
      const prod = products.find(p => p.id === l.product_id);
      return prod ? { ...l, unit_price: priceForRole(prod, role) } : l;
    }));
  };

  // Line items
  const addProduct = (product: WcProduct) => {
    setLineItems(prev => {
      if (prev.find(l => l.product_id === product.id)) return prev;
      return [...prev, { product_id: product.id, name: product.name, quantity: 3, unit_price: priceForRole(product, wcRole) }];
    });
  };
  const updateQty = (productId: number, qty: number) => {
    if (qty < 1) { removeItem(productId); return; }
    setLineItems(prev => prev.map(l => l.product_id === productId ? { ...l, quantity: qty } : l));
  };
  const removeItem = (productId: number) => setLineItems(prev => prev.filter(l => l.product_id !== productId));

  // Totals
  const subtotal = lineItems.reduce((s, l) => s + l.unit_price * l.quantity, 0);
  const qualifyingDeliveryItems = deliveryMethod === 'delivery'
    ? lineItems.filter(l => l.quantity >= 3 || overrideDeliveryFee)
    : [];
  const deliveryFee = qualifyingDeliveryItems.length > 0 && shipping?.found
    ? parseFloat(shipping.fee || '0') * qualifyingDeliveryItems.length : 0;
  const total = subtotal + deliveryFee;
  const totalCents = Math.round(total * 100);
  const underMinItems = deliveryMethod === 'delivery' ? lineItems.filter(l => l.quantity < 3) : [];
  const zipOutOfZone = deliveryMethod === 'delivery' && shipping !== null && !shipping.found && addrZip.length >= 5;

  // Submit
  const handleSubmit = async () => {
    setError('');
    if (!firstName.trim() || !lastName.trim() || !phone.trim()) { setError('First name, last name, and phone are required.'); return; }
    if (lineItems.length === 0) { setError('Add at least one product.'); return; }
    if (deliveryMethod === 'delivery') {
      if (!addrLine1.trim() || !addrCity.trim() || !addrZip.trim()) { setError('Full delivery address required.'); return; }
      if (zipOutOfZone) { setError('This zip code is outside our delivery zones.'); return; }
      if (qualifyingDeliveryItems.length === 0 && deliveryMethod === 'delivery') {
        setError('All items are under 3 yards — this order will be pickup only. Switch to pickup or increase quantities.'); return;
      }
    }

    setSubmitting(true);
    try {
      let stripePaymentIntentId: string | null = null;
      let resolvedStripeCustomerId: string | null = stripeCustomerId;

      // Process card payment first if needed
      if (paymentMethod === 'card') {
        if (!chargeRef.current) { setError('Card payment not ready — please try again.'); setSubmitting(false); return; }
        const result = await chargeRef.current();
        if (!result) { setSubmitting(false); return; } // error already set in CardForm
        stripePaymentIntentId = result.paymentIntentId;
        resolvedStripeCustomerId = result.stripeCustomerId;
      }

      const result = await api('/internal-orders/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          first_name: firstName.trim(), last_name: lastName.trim(),
          email: email.trim() || null, phone: phone.trim(),
          company_name: companyName.trim() || null,
          sms_opt_in: smsOptIn, email_opt_in: emailOptIn,
          wc_customer_id: wcCustomer?.wc_id || null,
          wc_role: wcRole, is_contractor: isContractor,
          line_items: lineItems.map(l => ({ product_id: l.product_id, quantity: l.quantity, price: l.unit_price.toFixed(2), name: l.name })),
          delivery_method: deliveryMethod,
          address_line1: addrLine1.trim(), address_line2: addrLine2.trim(),
          address_city: addrCity.trim(), address_state: addrState.trim(),
          address_postal_code: addrZip.trim(),
          delivery_fee: deliveryFee.toFixed(2),
          shipping_instance_id: shipping?.instance_id || "3",
          payment_method: paymentMethod, payment_note: paymentNote.trim(),
          stripe_payment_intent_id: stripePaymentIntentId,
          stripe_customer_id: resolvedStripeCustomerId,
          payment_status: (paymentMethod === 'cash' || paymentMethod === 'card') ? 'paid' : 'unpaid',
        }),
      });

      setConfirmation({
        wc_order_id: result.wc_order_id, order_number: result.order_number,
        first_name: firstName, last_name: lastName,
        delivery_method: deliveryMethod, total,
        payment_method: paymentMethod, payment_link_url: result.payment_link_url,
      });
    } catch (err) {
      setError((err as ApiError).message || 'Order creation failed. Please try again.');
    } finally { setSubmitting(false); }
  };

  // ── Confirmation ───────────────────────────────────────────────────────────

  if (confirmation) {
    return (
      <>
        <style>{styles}</style>
        <div className="page no-page">
          <div className="no-confirm-card">
            <div className="no-confirm-check">✓</div>
            <h1>Order Created</h1>
            <p className="no-confirm-name">{confirmation.first_name} {confirmation.last_name}</p>
            <div className="no-confirm-details">
              <div className="no-confirm-row"><span>WC Order #</span><strong>#{confirmation.order_number}</strong></div>
              <div className="no-confirm-row"><span>Method</span><strong style={{ textTransform: 'capitalize' }}>{confirmation.delivery_method}</strong></div>
              <div className="no-confirm-row"><span>Payment</span><strong style={{ textTransform: 'capitalize' }}>{confirmation.payment_method.replace('_', ' ')}</strong></div>
              <div className="no-confirm-row"><span>Total</span><strong>{fmt(confirmation.total)}</strong></div>
            </div>
            {confirmation.payment_link_url && (
              <div className="no-confirm-link-box">
                <div className="no-confirm-link-label">Payment link{(!smsOptIn && !emailOptIn) ? ' — copy and send manually' : ' sent to customer'}</div>
                <a href={confirmation.payment_link_url} target="_blank" rel="noreferrer" className="no-confirm-link">{confirmation.payment_link_url}</a>
                <button className="btn btn-ghost btn-sm" onClick={() => navigator.clipboard.writeText(confirmation.payment_link_url!)}>Copy link</button>
              </div>
            )}
            <p className="no-confirm-note">Order is entering the dispatch queue now.</p>
            <div className="no-confirm-actions">
              <button className="btn btn-primary" onClick={() => {
                setConfirmation(null); clearCustomer(); setLineItems([]);
                setDeliveryMethod('delivery'); setPaymentMethod('cash'); setPaymentNote('');
              }}>New Order</button>
              <button className="btn btn-ghost" onClick={() => router.push('/dispatch-schedule')}>View Schedule</button>
            </div>
          </div>
        </div>
      </>
    );
  }

  const rl = roleLabel(wcRole);

  // ── Form ───────────────────────────────────────────────────────────────────

  return (
    <>
      <style>{styles}</style>
      <div className="page no-page">

        <div className="no-header">
          <div>
            <h1>New Order</h1>
            <p style={{ color: 'var(--gray-500)', marginTop: 2, fontSize: 13 }}>Phone order · Walk-in · WooCommerce</p>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => router.back()}>← Back</button>
        </div>

        {error && (
          <div className="alert alert-error" style={{ marginBottom: 16 }}>
            <span>⚠</span> {error}
            <button className="btn btn-ghost btn-sm" onClick={() => setError('')} style={{ marginLeft: 'auto' }}>✕</button>
          </div>
        )}

        <div className="no-layout">
          <div className="no-col">

            {/* Customer */}
            <div className="card no-section">
              <div className="no-section-head">Customer</div>
              <div className="no-lookup-row">
                <input className="no-input" placeholder="Search WooCommerce by phone or email…" value={lookupQuery} onChange={e => handleLookupChange(e.target.value)} autoComplete="off" />
                {lookupLoading && <div className="no-spinner" />}
              </div>
              {lookupDone && !lookupLoading && !wcCustomer?.found && lookupQuery.length >= 3 && (
                <div className="no-lookup-miss">No WooCommerce match — new customer will be created on submit</div>
              )}

              {wcCustomer?.found && (
                <div className="no-found-banner">
                  <div className="no-found-top">
                    <div className="no-found-name">
                      {firstName} {lastName}
                      {rl && <span className="no-role-pill" style={{ background: rl.bg, color: rl.color }}>{rl.label}</span>}
                    </div>
                    <button className="btn btn-ghost btn-xs" onClick={clearCustomer}>Change</button>
                  </div>
                  {(email || phone) && <div className="no-found-meta">{phone}{email ? ` · ${email}` : ''}</div>}

                  {wcCustomer.order_history && wcCustomer.order_history.length > 0 && (
                    <div className="no-history">
                      <div className="no-history-label">Recent orders</div>
                      {wcCustomer.order_history.slice(0, 3).map((o, i) => (
                        <div key={o.wc_order_id} className="no-history-row">
                          <div className="no-history-info">
                            <span className="no-history-num">#{o.order_number}</span>
                            <span className="no-history-date">{o.date}</span>
                            <span className={`no-history-status no-status-${o.status}`}>{o.status}</span>
                          </div>
                          <div className="no-history-bottom">
                            <span className="no-history-items">{o.items.slice(0, 2).join(', ')}</span>
                            <div className="no-history-right">
                              <span className="no-history-total">{o.total ? fmt(parseFloat(o.total)) : ''}</span>
                              {i === 0 && products.length > 0 && (
                                <button className="btn btn-ghost btn-xs no-repeat-btn" onClick={() => repeatLastOrder(o)}>↺ Repeat</button>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div className="no-fields">
                <div className="no-row-2">
                  <div className="no-field"><label>First Name *</label><input className="no-input" value={firstName} onChange={e => setFirstName(e.target.value)} /></div>
                  <div className="no-field"><label>Last Name *</label><input className="no-input" value={lastName} onChange={e => setLastName(e.target.value)} /></div>
                </div>
                <div className="no-field"><label>Company Name</label><input className="no-input" value={companyName} onChange={e => setCompanyName(e.target.value)} placeholder="optional" /></div>
                <div className="no-row-2">
                  <div className="no-field"><label>Phone *</label><input className="no-input" value={phone} onChange={e => setPhone(e.target.value)} type="tel" placeholder="(413) 555-0100" /></div>
                  <div className="no-field"><label>Email</label><input className="no-input" value={email} onChange={e => setEmail(e.target.value)} type="email" placeholder="optional" /></div>
                </div>
                <div className="no-field">
                  <label>Pricing Tier</label>
                  <div className="no-seg">
                    {[{ value: null, label: 'Retail' }, { value: 'contractor', label: '🏗 Contractor' }, { value: 'wholesale', label: '📦 Wholesale' }].map(opt => (
                      <button key={opt.label} className={`no-seg-btn${wcRole === opt.value ? ' active' : ''}`} onClick={() => handleRoleChange(opt.value)}>{opt.label}</button>
                    ))}
                  </div>
                </div>
                <div className="no-optins">
                  <label className="no-check-label">
                    <input type="checkbox" checked={smsOptIn} onChange={e => setSmsOptIn(e.target.checked)} />
                    <span>SMS opt-in</span>
                    <span className="no-check-hint">Confirm verbal consent</span>
                  </label>
                  <label className="no-check-label">
                    <input type="checkbox" checked={emailOptIn} onChange={e => setEmailOptIn(e.target.checked)} />
                    <span>Email opt-in</span>
                  </label>
                </div>
              </div>
            </div>

            {/* Delivery */}
            <div className="card no-section">
              <div className="no-section-head">Delivery or Pickup</div>
              <div className="no-seg" style={{ marginBottom: 14 }}>
                <button className={`no-seg-btn${deliveryMethod === 'delivery' ? ' active' : ''}`} onClick={() => setDeliveryMethod('delivery')}>🚛 Delivery</button>
                <button className={`no-seg-btn${deliveryMethod === 'pickup' ? ' active' : ''}`} onClick={() => { setDeliveryMethod('pickup'); setOverrideDeliveryFee(false); }}>🏪 Pickup</button>
              </div>
              {deliveryMethod === 'delivery' && (
                <div className="no-fields">
                  <div className="no-field"><label>Street Address *</label><input className="no-input" value={addrLine1} onChange={e => setAddrLine1(e.target.value)} placeholder="123 Main St" /></div>
                  <div className="no-field"><label>Apt / Unit</label><input className="no-input" value={addrLine2} onChange={e => setAddrLine2(e.target.value)} placeholder="optional" /></div>
                  <div className="no-row-3">
                    <div className="no-field" style={{ flex: 2 }}><label>City *</label><input className="no-input" value={addrCity} onChange={e => setAddrCity(e.target.value)} /></div>
                    <div className="no-field" style={{ flex: 1 }}><label>State</label><input className="no-input" value={addrState} onChange={e => setAddrState(e.target.value)} maxLength={2} /></div>
                    <div className="no-field" style={{ flex: 1 }}><label>ZIP *</label><input className="no-input" value={addrZip} onChange={e => setAddrZip(e.target.value)} maxLength={5} placeholder="01020" /></div>
                  </div>
                  {shippingLoading && <div className="no-zone no-zone-checking">Checking delivery zone…</div>}
                  {!shippingLoading && shipping?.found && <div className="no-zone no-zone-ok">✓ {shipping.zone_title} · Fee: {fmt(parseFloat(shipping.fee || '0'))}</div>}
                  {!shippingLoading && shipping?.found && underMinItems.length > 0 && (
                    <label className="no-check-label" style={{ marginTop: 8 }}>
                      <input
                        type="checkbox"
                        checked={overrideDeliveryFee}
                        onChange={e => setOverrideDeliveryFee(e.target.checked)}
                      />
                      <span>Charge delivery fee on under-minimum items</span>
                      <span className="no-check-hint">Override for special circumstances</span>
                    </label>
                  )}
                  {!shippingLoading && zipOutOfZone && <div className="no-zone no-zone-err">✗ Outside delivery zones — pickup only</div>}
                </div>
              )}
              {deliveryMethod === 'pickup' && <div className="no-pickup-note">Customer picks up at the Hampden location. No delivery fee.</div>}
            </div>

            {/* Payment */}
            <div className="card no-section">
              <div className="no-section-head">Payment</div>
              <div className="no-seg" style={{ marginBottom: 14 }}>
                {([{ value: 'cash', label: '💵 Cash' }, { value: 'card', label: '💳 Card' }, { value: 'payment_link', label: '🔗 Send Link' }, { value: 'invoice', label: '🧾 Invoice' }] as const).map(opt => (
                  <button key={opt.value} className={`no-seg-btn${paymentMethod === opt.value ? ' active' : ''}`} onClick={() => setPaymentMethod(opt.value)}>{opt.label}</button>
                ))}
              </div>

              {paymentMethod === 'cash' && (
                <div>
                  <div className="no-pay-note" style={{ marginBottom: 10 }}>Taken at counter — order marked paid on submit.</div>
                  <div className="no-field" style={{ maxWidth: 160 }}>
                    <label>Cash Tendered</label>
                    <input
                      className="no-input"
                      type="number"
                      min={0}
                      step={0.01}
                      placeholder="0.00"
                      value={cashTendered}
                      onChange={e => setCashTendered(e.target.value)}
                    />
                  </div>
                  {cashTendered && parseFloat(cashTendered) >= total && (
                    <div style={{
                      marginTop: 8, padding: '8px 12px', background: '#f0fdf4',
                      border: '1.5px solid #bbf7d0', borderRadius: 8,
                      fontSize: 15, fontWeight: 700, color: '#15803d'
                    }}>
                      Change due: {fmt(parseFloat(cashTendered) - total)}
                    </div>
                  )}
                  {cashTendered && parseFloat(cashTendered) < total && (
                    <div style={{
                      marginTop: 8, padding: '8px 12px', background: '#fef2f2',
                      border: '1.5px solid #fecaca', borderRadius: 8,
                      fontSize: 13, fontWeight: 600, color: '#dc2626'
                    }}>
                      Short by: {fmt(total - parseFloat(cashTendered))}
                    </div>
                  )}
                </div>
              )}

              {paymentMethod === 'card' && (
                <Elements stripe={stripePromise}>
                  <CardForm
                    totalCents={totalCents}
                    customerName={`${firstName} ${lastName}`.trim()}
                    customerEmail={email}
                    stripeCustomerId={stripeCustomerId}
                    savedCard={savedCard}
                    saveCard={saveCard}
                    onSavedCardClear={() => setSavedCard(null)}
                    onPaymentReady={(fn) => { chargeRef.current = fn; }}
                    onPaymentError={(msg) => setError(msg)}
                  />
                  {!savedCard && (
                    <label className="no-check-label" style={{ marginTop: 10 }}>
                      <input type="checkbox" checked={saveCard} onChange={e => setSaveCard(e.target.checked)} />
                      <span>Save card on file for future orders</span>
                    </label>
                  )}
                  <div className="no-pay-note" style={{ marginTop: 8 }}>Card will be charged {fmt(total)} on submit.</div>
                </Elements>
              )}

              {paymentMethod === 'payment_link' && (
                <div>
                  <div className="no-pay-note">
                    A Stripe payment link will be created and sent
                    {smsOptIn && emailOptIn ? ' via SMS and email' : smsOptIn ? ' via SMS' : emailOptIn ? ' via email' : ''}.
                  </div>
                  {!smsOptIn && !emailOptIn && (
                    <div className="no-zone no-zone-checking" style={{ marginTop: 8 }}>⚠ No channels opted in — link will show on screen after submit for manual sharing.</div>
                  )}
                </div>
              )}

              {paymentMethod === 'invoice' && <div className="no-pay-note">Order will be invoiced. Appears in the Ops Dashboard accounting queue for billing.</div>}

              <div className="no-field" style={{ marginTop: 12 }}>
                <label>Payment note <span style={{ fontWeight: 400, color: 'var(--gray-400)' }}>(optional)</span></label>
                <input className="no-input" value={paymentNote} onChange={e => setPaymentNote(e.target.value)} placeholder="e.g. net 30, cash left at door…" />
              </div>
            </div>
          </div>

          {/* Right col */}
          <div className="no-col">
            <div className="card no-section">
              <div className="no-section-head">
                Products
                {rl && <span className="no-role-pill" style={{ background: rl.bg, color: rl.color, marginLeft: 8, fontSize: 11 }}>{rl.label} pricing</span>}
              </div>
              {productsLoading ? (
                <div className="no-empty">Loading products…</div>
              ) : (
                <div className="no-product-grid">
                  {products.map(p => {
                    const inCart = lineItems.find(l => l.product_id === p.id);
                    return (
                      <button key={p.id} className={`no-product-btn${inCart ? ' in-cart' : ''}`} onClick={() => addProduct(p)}>
                        <span className="no-product-name">{p.name}</span>
                        <span className="no-product-price">{fmt(priceForRole(p, wcRole))}<span className="no-product-unit">/yd</span></span>
                        {inCart && <span className="no-in-cart-dot">✓</span>}
                      </button>
                    );
                  })}
                  {products.length === 0 && <div className="no-empty">No products found</div>}
                </div>
              )}
            </div>

            <div className="card no-section">
              <div className="no-section-head">Order Items</div>
              {lineItems.length === 0 ? (
                <div className="no-empty">Tap a product above to add it</div>
              ) : (
                <div className="no-cart">
                  {lineItems.map(item => {
                    const underMin = deliveryMethod === 'delivery' && item.quantity < 3;
                    return (
                      <div key={item.product_id} className={`no-cart-row${underMin ? ' under-min' : ''}`}>
                        <div className="no-cart-info">
                          <div className="no-cart-name">{item.name}</div>
                          <div className="no-cart-uprice">{fmt(item.unit_price)}/yd</div>
                          {underMin && <div className="no-cart-warn">⚠ Under 3 yds — Will Be Pickup</div>}
                        </div>
                        <div className="no-qty-wrap">
                          <button className="no-qty-btn" onClick={() => updateQty(item.product_id, item.quantity - 1)}>−</button>
                          <input className="no-qty-input" type="number" min={1} value={item.quantity} onChange={e => updateQty(item.product_id, parseInt(e.target.value) || 1)} />
                          <button className="no-qty-btn" onClick={() => updateQty(item.product_id, item.quantity + 1)}>+</button>
                          <button className="no-qty-btn no-qty-del" onClick={() => removeItem(item.product_id)}>✕</button>
                        </div>
                        <div className="no-cart-total">{fmt(item.unit_price * item.quantity)}</div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="no-totals">
                <div className="no-total-row"><span>Subtotal</span><span>{fmt(subtotal)}</span></div>
                {deliveryMethod === 'delivery' && (
                  <div className="no-total-row"><span>Delivery fee</span><span>{shipping?.found ? fmt(deliveryFee) : shippingLoading ? '…' : '—'}</span></div>
                )}
                <div className="no-total-row no-total-grand"><span>Total</span><span>{fmt(total)}</span></div>
              </div>

              <button className="btn btn-primary no-submit" onClick={handleSubmit} disabled={submitting || lineItems.length === 0}>
                {submitting ? 'Creating order…' : `Create Order · ${fmt(total)}`}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

const styles = `
.no-page { max-width: 1120px; margin: 0 auto; padding: 20px 16px 80px; }
.no-header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 20px; gap: 12px; }
.no-header h1 { margin: 0; font-size: 22px; }
.no-layout { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
@media (max-width: 800px) { .no-layout { grid-template-columns: 1fr; } }
.no-col { display: flex; flex-direction: column; gap: 16px; }
.no-section { padding: 16px; }
.no-section-head { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em; color: var(--gray-500); margin-bottom: 12px; display: flex; align-items: center; gap: 6px; }
.no-lookup-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.no-spinner { width: 16px; height: 16px; border: 2px solid var(--gray-200); border-top-color: var(--green-500, #22c55e); border-radius: 50%; animation: no-spin 0.7s linear infinite; flex-shrink: 0; }
@keyframes no-spin { to { transform: rotate(360deg); } }
.no-lookup-miss { font-size: 12px; color: var(--gray-400); margin-bottom: 10px; }
.no-found-banner { background: var(--green-50, #f0fdf4); border: 1.5px solid var(--green-200, #bbf7d0); border-radius: 9px; padding: 10px 12px; margin-bottom: 12px; }
.no-found-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px; }
.no-found-name { font-size: 15px; font-weight: 600; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.no-found-meta { font-size: 12px; color: var(--gray-500); margin-bottom: 6px; }
.no-role-pill { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 100px; white-space: nowrap; }
.no-history { border-top: 1px solid var(--green-100, #dcfce7); padding-top: 8px; margin-top: 6px; }
.no-history-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--gray-400); margin-bottom: 6px; }
.no-history-row { padding: 6px 0; border-bottom: 1px solid var(--green-100, #dcfce7); }
.no-history-row:last-child { border-bottom: none; }
.no-history-info { display: flex; align-items: center; gap: 8px; margin-bottom: 3px; }
.no-history-num { font-size: 12px; font-weight: 600; }
.no-history-date { font-size: 11px; color: var(--gray-400); }
.no-history-status { font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 100px; background: var(--gray-100); color: var(--gray-500); text-transform: capitalize; }
.no-status-processing { background: #dbeafe; color: #1d4ed8; }
.no-status-completed { background: #dcfce7; color: #15803d; }
.no-status-cancelled { background: #fee2e2; color: #dc2626; }
.no-history-bottom { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.no-history-items { font-size: 11px; color: var(--gray-500); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
.no-history-right { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.no-history-total { font-size: 12px; font-weight: 600; }
.no-repeat-btn { font-size: 11px !important; padding: 2px 8px !important; }
.no-fields { display: flex; flex-direction: column; gap: 10px; }
.no-row-2 { display: flex; gap: 10px; }
.no-row-3 { display: flex; gap: 8px; }
.no-field { display: flex; flex-direction: column; gap: 4px; flex: 1; }
.no-field label { font-size: 12px; font-weight: 600; color: var(--gray-600, #4b5563); }
.no-input { width: 100%; padding: 8px 10px; border: 1.5px solid var(--gray-200, #e5e7eb); border-radius: 7px; font-size: 14px; font-family: inherit; background: var(--gray-50, #f9fafb); transition: border-color 0.15s; box-sizing: border-box; }
.no-input:focus { outline: none; border-color: var(--green-500, #22c55e); background: white; }
.no-seg { display: flex; border: 1.5px solid var(--gray-200, #e5e7eb); border-radius: 8px; overflow: hidden; }
.no-seg-btn { flex: 1; padding: 8px 6px; font-size: 12px; font-weight: 500; background: none; border: none; border-right: 1.5px solid var(--gray-200, #e5e7eb); cursor: pointer; color: var(--gray-600); transition: background 0.1s, color 0.1s; white-space: nowrap; }
.no-seg-btn:last-child { border-right: none; }
.no-seg-btn.active { background: var(--green-600, #16a34a); color: white; }
.no-optins { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 2px; }
.no-check-label { display: flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; }
.no-check-hint { font-size: 10px; color: var(--amber-600, #d97706); font-weight: 500; }
.no-zone { font-size: 12px; font-weight: 500; padding: 6px 10px; border-radius: 6px; margin-top: 4px; }
.no-zone-checking { background: var(--gray-100, #f3f4f6); color: var(--gray-500); }
.no-zone-ok { background: #f0fdf4; color: #15803d; }
.no-zone-err { background: #fef2f2; color: #dc2626; }
.no-pickup-note { font-size: 13px; color: var(--gray-500); background: var(--gray-50); border-radius: 8px; padding: 10px 12px; }
.no-pay-note { font-size: 13px; color: var(--gray-500); }
.no-card-element { border: 1.5px solid var(--gray-200, #e5e7eb); border-radius: 8px; padding: 12px; background: var(--gray-50); margin-bottom: 4px; }
.no-saved-card { display: flex; align-items: center; justify-content: space-between; background: #f0fdf4; border: 1.5px solid #bbf7d0; border-radius: 8px; padding: 10px 12px; margin-bottom: 6px; }
.no-saved-card-info { display: flex; align-items: center; gap: 10px; }
.no-saved-card-label { font-size: 14px; font-weight: 600; }
.no-saved-card-exp { font-size: 11px; color: var(--gray-400); }
.no-saved-card-badge { font-size: 11px; font-weight: 600; color: #15803d; background: #dcfce7; padding: 2px 8px; border-radius: 100px; }
.no-product-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.no-product-btn { position: relative; display: flex; flex-direction: column; align-items: flex-start; padding: 10px 12px; background: var(--gray-50); border: 1.5px solid var(--gray-200); border-radius: 9px; cursor: pointer; text-align: left; gap: 2px; transition: border-color 0.15s, background 0.15s; }
.no-product-btn:hover { border-color: var(--green-400, #4ade80); background: #f0fdf4; }
.no-product-btn.in-cart { border-color: var(--green-500, #22c55e); background: #f0fdf4; }
.no-product-name { font-size: 13px; font-weight: 600; color: var(--gray-800); }
.no-product-price { font-size: 13px; color: var(--green-700, #15803d); font-weight: 600; }
.no-product-unit { font-size: 11px; font-weight: 400; }
.no-in-cart-dot { position: absolute; top: 6px; right: 8px; font-size: 11px; color: var(--green-600); }
.no-cart { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }
.no-cart-row { display: flex; align-items: center; gap: 10px; padding: 10px; background: var(--gray-50); border: 1.5px solid var(--gray-100); border-radius: 8px; }
.no-cart-row.under-min { border-color: #fde68a; background: #fffbeb; }
.no-cart-info { flex: 1; min-width: 0; }
.no-cart-name { font-size: 13px; font-weight: 600; }
.no-cart-uprice { font-size: 11px; color: var(--gray-400); }
.no-cart-warn { font-size: 11px; color: #b45309; font-weight: 500; margin-top: 2px; }
.no-qty-wrap { display: flex; align-items: center; gap: 3px; }
.no-qty-btn { width: 28px; height: 28px; border: 1.5px solid var(--gray-200); background: white; border-radius: 6px; font-size: 14px; cursor: pointer; display: flex; align-items: center; justify-content: center; color: var(--gray-600); }
.no-qty-btn:hover { background: var(--gray-100); }
.no-qty-btn.no-qty-del { color: var(--red-500, #ef4444); border-color: transparent; }
.no-qty-input { width: 44px; text-align: center; padding: 4px; border: 1.5px solid var(--gray-200); border-radius: 6px; font-size: 14px; font-family: inherit; }
.no-qty-input:focus { outline: none; border-color: var(--green-500); }
.no-cart-total { font-size: 14px; font-weight: 600; min-width: 60px; text-align: right; }
.no-totals { border-top: 1.5px solid var(--gray-100); padding-top: 12px; margin-bottom: 14px; display: flex; flex-direction: column; gap: 6px; }
.no-total-row { display: flex; justify-content: space-between; font-size: 13px; color: var(--gray-600); }
.no-total-grand { font-size: 17px; font-weight: 700; color: var(--gray-900); padding-top: 8px; border-top: 1.5px solid var(--gray-200); margin-top: 2px; }
.no-submit { width: 100%; padding: 13px; font-size: 15px; font-weight: 600; }
.no-empty { font-size: 13px; color: var(--gray-400); text-align: center; padding: 16px 0; }
.no-confirm-card { max-width: 460px; margin: 60px auto; background: white; border-radius: 16px; padding: 36px 32px; text-align: center; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
.no-confirm-check { width: 56px; height: 56px; background: #dcfce7; color: #16a34a; border-radius: 50%; font-size: 24px; display: flex; align-items: center; justify-content: center; margin: 0 auto 16px; }
.no-confirm-card h1 { font-size: 22px; margin: 0 0 6px; }
.no-confirm-name { font-size: 16px; color: var(--gray-500); margin: 0 0 20px; }
.no-confirm-details { background: var(--gray-50); border-radius: 10px; padding: 14px 16px; margin-bottom: 16px; display: flex; flex-direction: column; gap: 8px; text-align: left; }
.no-confirm-row { display: flex; justify-content: space-between; font-size: 14px; }
.no-confirm-row span { color: var(--gray-500); }
.no-confirm-link-box { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 12px; margin-bottom: 14px; text-align: left; }
.no-confirm-link-label { font-size: 12px; font-weight: 600; color: #15803d; margin-bottom: 4px; }
.no-confirm-link { font-size: 12px; color: #15803d; word-break: break-all; display: block; margin-bottom: 8px; }
.no-confirm-note { font-size: 13px; color: var(--gray-400); margin: 0 0 20px; }
.no-confirm-actions { display: flex; gap: 10px; justify-content: center; }
.btn-xs { font-size: 11px !important; padding: 2px 8px !important; }
`;
