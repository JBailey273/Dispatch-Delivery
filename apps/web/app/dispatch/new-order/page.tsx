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
import DropRescheduleSlideOver from '../../components/DropRescheduleSlideOver';
import { useLocation } from '../../lib/location-context';

const stripePromise = loadStripe(
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || ''
);

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
  invoice_billing?: boolean;
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

export default function NewOrderPage() {
  const router = useRouter();
  const { activeLocation } = useLocation();

  // Customer state
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
  const [invoiceBilling, setInvoiceBilling] = useState(false);
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
  const [taxRate, setTaxRate] = useState<number>(0);
  const [taxLabel, setTaxLabel] = useState<string>('Sales Tax');
  const [taxLoading, setTaxLoading] = useState(false);
  const [taxExempt, setTaxExempt] = useState(false);

  // Payment
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'card' | 'payment_link' | 'invoice'>('cash');
  const [saveCard, setSaveCard] = useState(false);
  const [paymentNote, setPaymentNote] = useState('');
  const chargeRef = useRef<(() => Promise<{ paymentIntentId: string; stripeCustomerId: string } | null>) | null>(null);
  const [cashTendered, setCashTendered] = useState('');

  // Submit & confirmation
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  // Post-order scheduling
  const [dropId, setDropId] = useState<string | null>(null);
  const [dropPolling, setDropPolling] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduled, setScheduled] = useState<string | null>(null);
  const [deliveryNotes, setDeliveryNotes] = useState('');

  if (!requireRole(['dispatcher', 'admin'])) {
    return <div className="page"><p>Unauthorized</p></div>;
  }

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
        const resolvedRole = data.role || (data.invoice_billing ? 'contractor' : null);
        setWcRole(resolvedRole);
        setIsContractor(resolvedRole === 'contractor');
        setInvoiceBilling(data.invoice_billing || false);
        if (data.invoice_billing) setPaymentMethod('invoice');
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
        if (resolvedRole) loadProducts(resolvedRole);
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
    setWcRole(null); setIsContractor(false); setInvoiceBilling(false); setStripeCustomerId(null); setSavedCard(null);
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

  useEffect(() => {
    if (deliveryMethod === 'pickup') {
      setShipping(null);
      // Pickup always taxed at MA rate
      api(`/internal-orders/tax-rate?postal_code=`).then(taxData => {
        setTaxRate(parseFloat(taxData.rate || '0') / 100);
        setTaxLabel(taxData.label || 'Sales Tax');
      }).catch(() => setTaxRate(0));
      return;
    }
    if (deliveryMethod !== 'delivery' || addrZip.length < 5) { 
      setShipping(null); 
      setTaxRate(0);
      return; 
    }
    if (addrState !== 'MA') {
      setTaxRate(0);
    }
    if (zipTimer.current) clearTimeout(zipTimer.current);
    zipTimer.current = setTimeout(async () => {
      setShippingLoading(true);
      setTaxLoading(true);
      try {
        const [shippingData, taxData] = await Promise.all([
          api(`/internal-orders/shipping-fee?postal_code=${addrZip.trim()}`),
          api(`/internal-orders/tax-rate?postal_code=${addrZip.trim()}`),
        ]);
        setShipping(shippingData);
        if (addrState.toUpperCase() === 'MA') {
          setTaxRate(parseFloat(taxData.rate || '0') / 100);
          setTaxLabel(taxData.label || 'Sales Tax');
        } else {
          setTaxRate(0);
        }
      } catch { setShipping(null); setTaxRate(0); }
      finally { setShippingLoading(false); setTaxLoading(false); }
    }, 700);
  }, [addrZip, deliveryMethod, addrState]);

  const handleRoleChange = (role: string | null) => {
    setWcRole(role);
    setIsContractor(role === 'contractor');
    // Load fresh products for this role, then reprice cart from the fresh data
    setProductsLoading(true);
    const params = role ? `?role=${role}` : '';
    api(`/internal-orders/wc-products${params}`)
      .then(data => {
        const freshProducts: WcProduct[] = data.products || [];
        setProducts(freshProducts);
        setLineItems(prev => prev.map(l => {
          const prod = freshProducts.find(p => p.id === l.product_id);
          return prod ? { ...l, unit_price: priceForRole(prod, role) } : l;
        }));
      })
      .catch(() => {})
      .finally(() => setProductsLoading(false));
  };

  const addProduct = (product: WcProduct) => {
    setLineItems(prev => {
      if (prev.find(l => l.product_id === product.id)) return prev;
      const defaultQty = deliveryMethod === 'pickup' ? 1 : 3;
      return [...prev, { product_id: product.id, name: product.name, quantity: defaultQty, unit_price: priceForRole(product, wcRole) }];
    });
  };

  const updateQty = (productId: number, qty: number) => {
    if (qty < 1) { removeItem(productId); return; }
    setLineItems(prev => prev.map(l => l.product_id === productId ? { ...l, quantity: qty } : l));
  };

  const removeItem = (productId: number) => setLineItems(prev => prev.filter(l => l.product_id !== productId));

  const subtotal = lineItems.reduce((s, l) => s + l.unit_price * l.quantity, 0);
  const qualifyingDeliveryItems = deliveryMethod === 'delivery'
    ? lineItems.filter(l => l.quantity >= 3 || overrideDeliveryFee)
    : [];
  const deliveryFee = qualifyingDeliveryItems.length > 0 && shipping?.found
    ? parseFloat(shipping.fee || '0') * qualifyingDeliveryItems.length : 0;
  const taxAmount = taxExempt ? 0 : subtotal * taxRate;
  const total = subtotal + deliveryFee + taxAmount;
  const totalCents = Math.round(total * 100);
  const underMinItems = deliveryMethod === 'delivery' ? lineItems.filter(l => l.quantity < 3) : [];
  const zipOutOfZone = deliveryMethod === 'delivery' && shipping !== null && !shipping.found && addrZip.length >= 5;

  const pollForDrop = useCallback(async (wcOrderId: number) => {
    setDropPolling(true);
    let attempts = 0;
    const maxAttempts = 15;
    const interval = setInterval(async () => {
      attempts++;
      try {
        const data = await api(`/dispatch/orders?search=${wcOrderId}&start_date=2020-01-01&end_date=2099-01-01`);
        const match = (data.orders || []).find((o: any) =>
          String(o.external_order_id) === String(wcOrderId) ||
          String(o.order_ref) === String(wcOrderId)
        );
        if (match) {
          clearInterval(interval);
          setDropId(match.drop_id);
          setDropPolling(false);
        }
      } catch { /* silent */ }
      if (attempts >= maxAttempts) {
        clearInterval(interval);
        setDropPolling(false);
      }
    }, 2000);
  }, []);

  const printReceipt = () => {
    if (!confirmation) return;
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

    const itemRows = lineItems.map(l => `
      <tr>
        <td class="pt-item">${l.name}</td>
        <td class="pt-item pt-right">${l.quantity} yd</td>
        <td class="pt-item pt-right">$${l.unit_price.toFixed(2)}/yd</td>
        <td class="pt-item pt-right">$${(l.unit_price * l.quantity).toFixed(2)}</td>
      </tr>
    `).join('');

    const deliveryRow = deliveryFee > 0
      ? `<tr><td class="pt-item" colspan="3">Delivery Fee</td><td class="pt-item pt-right">$${deliveryFee.toFixed(2)}</td></tr>`
      : '';

    const taxRow = taxAmount > 0
      ? `<tr><td class="pt-item" colspan="3">${taxLabel}</td><td class="pt-item pt-right">$${taxAmount.toFixed(2)}</td></tr>`
      : '';

    const addrStr = deliveryMethod === 'delivery' && addrLine1
      ? `${addrLine1}${addrLine2 ? ` ${addrLine2}` : ''}, ${addrCity}, ${addrState} ${addrZip}`
      : 'Pickup at Hampden location';

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Receipt — Order #${confirmation.order_number}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap');
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Plus Jakarta Sans', sans-serif; color: #111; background: #fff; padding: 32px; font-size: 13px; }
    .pt-header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #111; padding-bottom: 14px; margin-bottom: 18px; }
    .pt-gc { font-size: 18px; font-weight: 800; letter-spacing: -0.02em; }
    .pt-gc-sub { font-size: 11px; color: #555; margin-top: 2px; }
    .pt-order-num { font-size: 28px; font-weight: 800; letter-spacing: -0.03em; text-align: right; }
    .pt-order-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #555; text-align: right; }
    .pt-meta { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 24px; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid #ddd; }
    .pt-meta-block dt { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #777; margin-bottom: 3px; }
    .pt-meta-block dd { font-size: 14px; font-weight: 700; }
    .pt-meta-block dd.small { font-size: 12px; font-weight: 600; }
    .pt-section-label { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.1em; color: #555; margin-bottom: 8px; }
    .pt-items-table { width: 100%; border-collapse: collapse; margin-bottom: 4px; }
    .pt-items-table th { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #777; border-bottom: 1px solid #ddd; padding: 0 0 6px; text-align: left; }
    .pt-items-table th.pt-right { text-align: right; }
    .pt-item { padding: 8px 0; border-bottom: 1px solid #eee; font-size: 13px; font-weight: 600; }
    .pt-right { text-align: right; }
    .pt-total-row { display: flex; justify-content: space-between; padding: 12px 0 0; border-top: 2px solid #111; margin-top: 8px; font-size: 17px; font-weight: 800; }
    .pt-payment { margin-top: 16px; padding: 10px 14px; background: #f5f5f5; border-radius: 6px; font-size: 12px; }
    .pt-payment-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #777; margin-bottom: 4px; }
    .pt-footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #ddd; text-align: center; font-size: 11px; color: #777; }
    .pt-sig { margin-top: 24px; padding-top: 16px; border-top: 1px solid #ddd; }
    .pt-sig-line { border-bottom: 1px solid #999; height: 28px; margin-bottom: 6px; width: 60%; }
    .pt-sig-label { font-size: 10px; color: #777; text-transform: uppercase; letter-spacing: 0.06em; }
  </style>
</head>
<body>
  <div class="pt-header">
    <div>
      <div class="pt-gc">East Meadow Garden Center</div>
      <div class="pt-gc-sub">Sales Receipt</div>
    </div>
    <div>
      <div class="pt-order-label">Order</div>
      <div class="pt-order-num">#${confirmation.order_number}</div>
    </div>
  </div>
  <div class="pt-meta">
    <dl class="pt-meta-block"><dt>Customer</dt><dd>${confirmation.first_name} ${confirmation.last_name}</dd></dl>
    <dl class="pt-meta-block"><dt>Date</dt><dd class="small">${dateStr}</dd></dl>
    ${phone ? `<dl class="pt-meta-block"><dt>Phone</dt><dd class="small">${phone}</dd></dl>` : ''}
    <dl class="pt-meta-block"><dt>Time</dt><dd class="small">${timeStr}</dd></dl>
    ${email ? `<dl class="pt-meta-block"><dt>Email</dt><dd class="small">${email}</dd></dl>` : ''}
    <dl class="pt-meta-block"><dt>Method</dt><dd class="small" style="text-transform:capitalize">${confirmation.delivery_method}</dd></dl>
    <dl class="pt-meta-block" style="grid-column: 1 / -1"><dt>${deliveryMethod === 'delivery' ? 'Delivery Address' : 'Pickup Location'}</dt><dd class="small">${addrStr}</dd></dl>
    ${scheduled ? `<dl class="pt-meta-block" style="grid-column: 1 / -1"><dt>Scheduled</dt><dd class="small">${scheduled}</dd></dl>` : ''}
  </div>
  <div class="pt-section-label">Items</div>
  <table class="pt-items-table">
    <thead><tr><th>Description</th><th class="pt-right">Qty</th><th class="pt-right">Unit Price</th><th class="pt-right">Amount</th></tr></thead>
    <tbody>${itemRows}${deliveryRow}${taxRow}</tbody>
  </table>
  <div class="pt-total-row"><span>Total</span><span>$${confirmation.total.toFixed(2)}</span></div>
  <div class="pt-payment">
    <div class="pt-payment-label">Payment</div>
    <div style="text-transform:capitalize;font-weight:700">${confirmation.payment_method.replace('_', ' ')}${paymentNote ? ` — ${paymentNote}` : ''}</div>
  </div>
  ${deliveryMethod === 'delivery' ? `<div class="pt-sig"><div class="pt-sig-line"></div><div class="pt-sig-label">Customer signature</div></div>` : ''}
  <div class="pt-footer"><p>Thank you for your business!</p><p style="margin-top:4px">eastmeadowgardencenter.com · Hampden, MA</p></div>
</body>
</html>`;

    const win = window.open('', '_blank', 'width=700,height=900');
    if (!win) return;
    win.document.write(html);
    win.document.close();
    win.onload = () => { win.print(); };
  };

  const handleSubmit = async () => {
    setError('');
    if (!firstName.trim() || !lastName.trim() || !phone.trim()) {
      setError('First name, last name, and phone are required.'); return;
    }
    if (lineItems.length === 0) {
      setError('Add at least one product.'); return;
    }
    if (deliveryMethod === 'delivery') {
      if (!addrLine1.trim() || !addrCity.trim() || !addrZip.trim()) {
        setError('Full delivery address required.'); return;
      }
      if (zipOutOfZone) {
        setError('This zip code is outside our delivery zones.'); return;
      }
      if (qualifyingDeliveryItems.length === 0) {
        setError('All items are under 3 yards — this order will be pickup only. Switch to pickup or increase quantities.'); return;
      }
    }

    setSubmitting(true);
    try {
      let stripePaymentIntentId: string | null = null;
      let resolvedStripeCustomerId: string | null = stripeCustomerId;

      if (paymentMethod === 'card') {
        if (!chargeRef.current) { setError('Card payment not ready — please try again.'); setSubmitting(false); return; }
        const result = await chargeRef.current();
        if (!result) { setSubmitting(false); return; }
        stripePaymentIntentId = result.paymentIntentId;
        resolvedStripeCustomerId = result.stripeCustomerId;
      }

      const result = await api('/internal-orders/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          email: email.trim() || null,
          phone: phone.trim(),
          company_name: companyName.trim() || null,
          sms_opt_in: smsOptIn,
          email_opt_in: emailOptIn,
          wc_customer_id: wcCustomer?.wc_id || null,
          wc_role: wcRole,
          is_contractor: isContractor,
          line_items: lineItems.map(l => ({
            product_id: l.product_id,
            quantity: l.quantity,
            price: l.unit_price.toFixed(2),
            name: l.name,
          })),
          delivery_method: deliveryMethod,
          address_line1: addrLine1.trim(),
          address_line2: addrLine2.trim(),
          address_city: addrCity.trim(),
          address_state: addrState.trim(),
          address_postal_code: addrZip.trim(),
          delivery_fee: deliveryFee.toFixed(2),
          shipping_instance_id: shipping?.instance_id || '3',
          notes: deliveryNotes.trim() || null,
          payment_method: paymentMethod,
          payment_note: paymentNote.trim(),
          stripe_payment_intent_id: stripePaymentIntentId,
          stripe_customer_id: resolvedStripeCustomerId,
          payment_status: (paymentMethod === 'cash' || paymentMethod === 'card') ? 'paid' : 'unpaid',
        }),
      });

      setConfirmation({
        wc_order_id: result.wc_order_id,
        order_number: result.order_number,
        first_name: firstName,
        last_name: lastName,
        delivery_method: deliveryMethod,
        total,
        payment_method: paymentMethod,
        payment_link_url: result.payment_link_url,
      });

      if (deliveryMethod === 'delivery') {
        if (result.drop_id) {
          setDropId(result.drop_id);
        } else {
          pollForDrop(result.wc_order_id);
        }
      }
    } catch (err) {
      setError((err as ApiError).message || 'Order creation failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  // ── Confirmation screen ────────────────────────────────────────────────────

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
              <div className="no-confirm-row">
                <span>WC Order #</span><strong>#{confirmation.order_number}</strong>
              </div>
              <div className="no-confirm-row">
                <span>Method</span>
                <strong style={{ textTransform: 'capitalize' }}>{confirmation.delivery_method}</strong>
              </div>
              <div className="no-confirm-row">
                <span>Payment</span>
                <strong style={{ textTransform: 'capitalize' }}>{confirmation.payment_method.replace('_', ' ')}</strong>
              </div>
              <div className="no-confirm-row">
                <span>Total</span><strong>{fmt(confirmation.total)}</strong>
              </div>
              {scheduled && (
                <div className="no-confirm-row">
                  <span>Scheduled</span>
                  <strong style={{ color: '#15803d' }}>{scheduled}</strong>
                </div>
              )}
            </div>

            {confirmation.payment_link_url && (
              <div className="no-confirm-link-box">
                <div className="no-confirm-link-label">
                  Payment link{(!smsOptIn && !emailOptIn) ? ' — copy and send manually' : ' sent to customer'}
                </div>
                <a href={confirmation.payment_link_url} target="_blank" rel="noreferrer" className="no-confirm-link">
                  {confirmation.payment_link_url}
                </a>
                <button className="btn btn-ghost btn-sm" onClick={() => navigator.clipboard.writeText(confirmation.payment_link_url!)}>
                  Copy link
                </button>
              </div>
            )}

            {confirmation.delivery_method === 'delivery' && (
              <div className="no-confirm-schedule">
                {!dropId && dropPolling && (
                  <div className="no-confirm-polling">
                    <div className="no-spinner" style={{ display: 'inline-block', marginRight: 8 }} />
                    Waiting for order to enter dispatch queue…
                  </div>
                )}
                {dropId && !scheduled && (
                  <button
                    className="btn btn-primary"
                    style={{ width: '100%', marginBottom: 8 }}
                    onClick={() => setShowSchedule(true)}
                  >
                    📅 Schedule Delivery Now
                  </button>
                )}
                {scheduled && (
                  <div className="no-confirm-scheduled-badge">
                    ✓ Delivery scheduled for {scheduled}
                  </div>
                )}
              </div>
            )}

            <p className="no-confirm-note">Order is entering the dispatch queue now.</p>

            <div className="no-confirm-actions">
              <button
                className="btn btn-primary"
                onClick={() => {
                  setConfirmation(null);
                  clearCustomer();
                  setLineItems([]);
                  setDeliveryMethod('delivery');
                  setPaymentMethod('cash');
                  setPaymentNote('');
                  setDropId(null);
                  setScheduled(null);
                  setShowSchedule(false);
                }}
              >
                New Order
              </button>
              <button className="btn btn-secondary" onClick={printReceipt}>
                🖨 Print Receipt
              </button>
              <button className="btn btn-secondary" onClick={() => router.push(deliveryMethod === 'pickup' ? '/pickup' : '/dispatch-schedule')}>
            {deliveryMethod === 'pickup' ? 'View Pickup Queue' : 'View Schedule'}
          </button>
            </div>
          </div>
        </div>

        {showSchedule && dropId && (
          <DropRescheduleSlideOver
            dropId={dropId}
            onClose={() => setShowSchedule(false)}
            onRescheduled={() => {
              setShowSchedule(false);
              api(`/dispatch/drops/${dropId}`).then(d => {
                if (d.scheduled_date) {
                  const date = new Date(d.scheduled_date + 'T12:00:00');
                  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
                  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                  const win = d.scheduled_window === 'A' ? 'Morning' : 'Afternoon';
                  setScheduled(`${days[date.getDay()]}, ${months[date.getMonth()]} ${date.getDate()} · ${win}`);
                }
              }).catch(() => null);
            }}
            startOnReschedule={true}
            locationId={activeLocation?.id ?? null}
          />
        )}
      </>
    );
  }

  const rl = roleLabel(wcRole);

  // ── Main form ──────────────────────────────────────────────────────────────

  return (
    <>
      <style>{styles}</style>
      <div className="page no-page">

      <div className="no-header">
          <div>
            <h1>New Order</h1>
            <p className="no-header-sub">Phone order · Walk-in · WooCommerce</p>
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
                <input
                  className="no-input"
                  placeholder="Search WooCommerce by phone or email…"
                  value={lookupQuery}
                  onChange={e => handleLookupChange(e.target.value)}
                  autoComplete="off"
                />
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
                  {(email || phone) && (
                    <div className="no-found-meta">{phone}{email ? ` · ${email}` : ''}</div>
                  )}
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
                                <button
                                  className="btn btn-ghost btn-xs no-repeat-btn"
                                  onClick={() => repeatLastOrder(o)}
                                >
                                  ↺ Repeat
                                </button>
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
                  <div className="no-field">
                    <label>First Name *</label>
                    <input className="no-input" value={firstName} onChange={e => setFirstName(e.target.value)} />
                  </div>
                  <div className="no-field">
                    <label>Last Name *</label>
                    <input className="no-input" value={lastName} onChange={e => setLastName(e.target.value)} />
                  </div>
                </div>
                <div className="no-field">
                  <label>Company Name</label>
                  <input className="no-input" value={companyName} onChange={e => setCompanyName(e.target.value)} placeholder="optional" />
                </div>
                <div className="no-row-2">
                  <div className="no-field">
                    <label>Phone *</label>
                    <input className="no-input" value={phone} onChange={e => setPhone(e.target.value)} type="tel" placeholder="(413) 555-0100" />
                  </div>
                  <div className="no-field">
                    <label>Email</label>
                    <input className="no-input" value={email} onChange={e => setEmail(e.target.value)} type="email" placeholder="optional" />
                  </div>
                </div>
                <div className="no-field">
                  <label>Pricing Tier</label>
                 <div className="no-seg">
                    {[
                      { value: null, label: 'Retail' },
                      { value: 'contractor', label: '🏗 Contractor' },
                      { value: 'wholesale', label: '📦 Wholesale' },
                    ].map(opt => (
                      <button
                        key={opt.label}
                        className={`no-seg-btn${wcRole === opt.value ? ' active' : ''}`}
                        onClick={() => handleRoleChange(opt.value)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <label className="no-check-label" style={{ marginTop: 4 }}>
                    <input type="checkbox" checked={taxExempt} onChange={e => setTaxExempt(e.target.checked)} />
                    <span>Tax Exempt</span>
                  </label>
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

            {/* Delivery / Pickup */}
            <div className="card no-section">
              <div className="no-section-head">Delivery or Pickup</div>
              <div className="no-seg" style={{ marginBottom: 14 }}>
                <button
                  className={`no-seg-btn${deliveryMethod === 'delivery' ? ' active' : ''}`}
                  onClick={() => setDeliveryMethod('delivery')}
                >
                  🚛 Delivery
                </button>
                <button
                  className={`no-seg-btn${deliveryMethod === 'pickup' ? ' active' : ''}`}
                  onClick={() => { setDeliveryMethod('pickup'); setOverrideDeliveryFee(false); }}
                >
                  🏪 Pickup
                </button>
              </div>

              {deliveryMethod === 'delivery' && (
                <div className="no-fields">
                  <div className="no-field">
                    <label>Street Address *</label>
                    <input className="no-input" value={addrLine1} onChange={e => setAddrLine1(e.target.value)} placeholder="123 Main St" />
                  </div>
                  <div className="no-field">
                    <label>Apt / Unit</label>
                    <input className="no-input" value={addrLine2} onChange={e => setAddrLine2(e.target.value)} placeholder="optional" />
                  </div>
                  <div className="no-row-3">
                    <div className="no-field" style={{ flex: 2 }}>
                      <label>City *</label>
                      <input className="no-input" value={addrCity} onChange={e => setAddrCity(e.target.value)} />
                    </div>
                    <div className="no-field" style={{ flex: 1 }}>
                      <label>State</label>
                      <input className="no-input" value={addrState} onChange={e => setAddrState(e.target.value)} maxLength={2} />
                    </div>
                    <div className="no-field" style={{ flex: 1 }}>
                      <label>ZIP *</label>
                      <input className="no-input" value={addrZip} onChange={e => setAddrZip(e.target.value)} maxLength={5} placeholder="01020" />
                    </div>
                  </div>
                  {shippingLoading && (
                    <div className="no-zone no-zone-checking">Checking delivery zone…</div>
                  )}
                  {!shippingLoading && shipping?.found && (
                    <div className="no-zone no-zone-ok">
                      ✓ {shipping.zone_title} · Fee: {fmt(parseFloat(shipping.fee || '0'))}
                    </div>
                  )}
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
                  {!shippingLoading && zipOutOfZone && (
                    <div className="no-zone no-zone-err">✗ Outside delivery zones — pickup only</div>
                  )}
                </div>
              )}

              {deliveryMethod === 'pickup' && (
                <div className="no-pickup-note">
                  Customer picks up at the Hampden location. No delivery fee.
                </div>
              )}
            </div>

            {/* Delivery Notes */}
            <div className="card no-section">
              <div className="no-section-head">Delivery Notes <span style={{ fontWeight: 400, color: 'var(--gray-400)', textTransform: 'none', letterSpacing: 0, fontSize: 11 }}>Optional</span></div>
              <textarea
                className="no-input"
                placeholder="e.g. Gate code #1234, leave at side door, call before arrival…"
                value={deliveryNotes}
                onChange={e => setDeliveryNotes(e.target.value)}
                rows={3}
                style={{ resize: 'vertical', fontFamily: 'inherit', fontSize: 14 }}
              />
            </div>

            {/* Payment */}
            <div className="card no-section">
              <div className="no-section-head">
                Payment
                {invoiceBilling && (
                  <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, background: '#dbeafe', color: '#1d4ed8', borderRadius: 6, padding: '2px 8px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    Invoice Account
                  </span>
                )}
              </div>
              <div className="no-seg" style={{ marginBottom: 14 }}>
                {([
                  { value: 'cash', label: '💵 Cash' },
                  { value: 'card', label: '💳 Card' },
                  { value: 'payment_link', label: '🔗 Send Link' },
                  { value: 'invoice', label: '🧾 Invoice' },
                ] as const).map(opt => (
                  <button
                    key={opt.value}
                    className={`no-seg-btn${paymentMethod === opt.value ? ' active' : ''}`}
                    onClick={() => setPaymentMethod(opt.value)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              {paymentMethod === 'cash' && (
                <div>
                  <div className="no-pay-note" style={{ marginBottom: 10 }}>
                    Taken at counter — order marked paid on submit.
                  </div>
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
                      fontSize: 15, fontWeight: 700, color: '#15803d',
                    }}>
                      Change due: {fmt(parseFloat(cashTendered) - total)}
                    </div>
                  )}
                  {cashTendered && parseFloat(cashTendered) < total && (
                    <div style={{
                      marginTop: 8, padding: '8px 12px', background: '#fef2f2',
                      border: '1.5px solid #fecaca', borderRadius: 8,
                      fontSize: 13, fontWeight: 600, color: '#dc2626',
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
                  <div className="no-pay-note" style={{ marginTop: 8 }}>
                    Card will be charged {fmt(total)} on submit.
                  </div>
                </Elements>
              )}

              {paymentMethod === 'payment_link' && (
                <div>
                  <div className="no-pay-note">
                    A Stripe payment link will be created and sent
                    {smsOptIn && emailOptIn ? ' via SMS and email'
                      : smsOptIn ? ' via SMS'
                      : emailOptIn ? ' via email'
                      : ''}.
                  </div>
                  {!smsOptIn && !emailOptIn && (
                    <div className="no-zone no-zone-checking" style={{ marginTop: 8 }}>
                      ⚠ No channels opted in — link will show on screen after submit for manual sharing.
                    </div>
                  )}
                </div>
              )}

              {paymentMethod === 'invoice' && (
                <div className="no-pay-note">
                  Order will be invoiced. Appears in the Ops Dashboard accounting queue for billing.
                </div>
              )}

              <div className="no-field" style={{ marginTop: 12 }}>
                <label>
                  Payment note{' '}
                  <span style={{ fontWeight: 400, color: 'var(--gray-400)' }}>(optional)</span>
                </label>
                <input
                  className="no-input"
                  value={paymentNote}
                  onChange={e => setPaymentNote(e.target.value)}
                  placeholder="e.g. net 30, cash left at door…"
                />
              </div>
            </div>
          </div>

          {/* Right column */}
          <div className="no-col">
            <div className="card no-section">
              <div className="no-section-head">
                Products
                {rl && (
                  <span className="no-role-pill" style={{ background: rl.bg, color: rl.color, marginLeft: 8, fontSize: 11 }}>
                    {rl.label} pricing
                  </span>
                )}
              </div>
              {productsLoading ? (
                <div className="no-empty">Loading products…</div>
              ) : (
                <div className="no-product-grid">
                  {products.map(p => {
                    const inCart = lineItems.find(l => l.product_id === p.id);
                    return (
                      <button
                        key={p.id}
                        className={`no-product-btn${inCart ? ' in-cart' : ''}`}
                        onClick={() => addProduct(p)}
                      >
                        <span className="no-product-name">{p.name}</span>
                        <span className="no-product-price">
                          {fmt(priceForRole(p, wcRole))}<span className="no-product-unit">/yd</span>
                        </span>
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
                          <input
                            className="no-qty-input"
                            type="number"
                            min={1}
                            value={item.quantity}
                            onChange={e => updateQty(item.product_id, parseInt(e.target.value) || 1)}
                          />
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
                  <div className="no-total-row">
                    <span>Delivery fee</span>
                    <span>{shipping?.found ? fmt(deliveryFee) : shippingLoading ? '…' : '—'}</span>
                  </div>
                )}
                {taxRate > 0 && (
                  <div className="no-total-row">
                    <span>{taxLabel}</span>
                    <span>{taxLoading ? '…' : fmt(taxAmount)}</span>
                  </div>
                )}
                <div className="no-total-row no-total-grand"><span>Total</span><span>{fmt(total)}</span></div>
              </div>

              <button
                className="btn btn-primary no-submit"
                onClick={handleSubmit}
                disabled={submitting || lineItems.length === 0}
              >
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
.no-header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 28px; gap: 16px; }
.no-header h1 { margin: 0; font-size: 30px; font-weight: 800; letter-spacing: -0.03em; }
.no-header-sub { font-size: 14px; color: var(--gray-500); margin-top: 3px; }
.no-layout { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
@media (max-width: 800px) { .no-layout { grid-template-columns: 1fr; } }
.no-col { display: flex; flex-direction: column; gap: 16px; }
.no-section { padding: 16px; }
.no-section-head { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em; color: var(--gray-500); margin-bottom: 12px; display: flex; align-items: center; gap: 6px; }
.no-lookup-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.no-spinner { width: 16px; height: 16px; border: 2px solid var(--gray-200); border-top-color: var(--brand); border-radius: 50%; animation: no-spin 0.7s linear infinite; flex-shrink: 0; }
@keyframes no-spin { to { transform: rotate(360deg); } }
.no-lookup-miss { font-size: 12px; color: var(--gray-400); margin-bottom: 10px; }
.no-found-banner { background: var(--blue-25); border: 1.5px solid var(--blue-100); border-radius: 9px; padding: 10px 12px; margin-bottom: 12px; }
.no-found-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px; }
.no-found-name { font-size: 15px; font-weight: 600; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.no-found-meta { font-size: 12px; color: var(--gray-500); margin-bottom: 6px; }
.no-role-pill { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 100px; white-space: nowrap; }
.no-history { border-top: 1px solid var(--border-light); padding-top: 8px; margin-top: 6px; }
.no-history-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--gray-400); margin-bottom: 6px; }
.no-history-row { padding: 6px 0; border-bottom: 1px solid var(--border-light); }
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
.no-field label { font-size: 12px; font-weight: 600; color: var(--gray-600); }
.no-input { width: 100%; padding: 8px 10px; border: 1.5px solid var(--border); border-radius: 7px; font-size: 14px; font-family: inherit; background: var(--surface); transition: border-color 0.15s; box-sizing: border-box; color: var(--gray-900); }
.no-input:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px rgba(37,99,235,0.12); background: var(--surface); }
.no-input::placeholder { color: var(--gray-400); }
.no-seg { display: flex; border: 1.5px solid var(--border); border-radius: 8px; overflow: hidden; }
.no-seg-btn { flex: 1; padding: 8px 6px; font-size: 12px; font-weight: 500; background: none; border: none; border-right: 1.5px solid var(--border); cursor: pointer; color: var(--gray-600); transition: background 0.1s, color 0.1s; white-space: nowrap; font-family: inherit; }
.no-seg-btn:last-child { border-right: none; }
.no-seg-btn.active { background: var(--brand); color: white; }
.no-optins { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 2px; }
.no-check-label { display: flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; }
.no-check-hint { font-size: 10px; color: var(--amber-600); font-weight: 500; }
.no-zone { font-size: 12px; font-weight: 500; padding: 6px 10px; border-radius: 6px; margin-top: 4px; }
.no-zone-checking { background: var(--gray-100); color: var(--gray-500); }
.no-zone-ok { background: var(--blue-25); color: var(--brand); }
.no-zone-err { background: var(--red-50); color: var(--red-600); }
.no-pickup-note { font-size: 13px; color: var(--gray-500); background: var(--bg-secondary); border-radius: 8px; padding: 10px 12px; }
.no-pay-note { font-size: 13px; color: var(--gray-500); }
.no-card-element { border: 1.5px solid var(--border); border-radius: 8px; padding: 12px; background: var(--bg-primary); margin-bottom: 4px; }
.no-saved-card { display: flex; align-items: center; justify-content: space-between; background: var(--blue-25); border: 1.5px solid var(--blue-100); border-radius: 8px; padding: 10px 12px; margin-bottom: 6px; }
.no-saved-card-info { display: flex; align-items: center; gap: 10px; }
.no-saved-card-label { font-size: 14px; font-weight: 600; }
.no-saved-card-exp { font-size: 11px; color: var(--gray-400); }
.no-saved-card-badge { font-size: 11px; font-weight: 600; color: var(--brand); background: var(--blue-50); padding: 2px 8px; border-radius: 100px; }
.no-product-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.no-product-btn { position: relative; display: flex; flex-direction: column; align-items: flex-start; padding: 10px 12px; background: var(--bg-primary); border: 1.5px solid var(--border); border-radius: 9px; cursor: pointer; text-align: left; gap: 2px; transition: border-color 0.15s, background 0.15s; }
.no-product-btn:hover { border-color: var(--blue-300); background: var(--blue-25); }
.no-product-btn.in-cart { border-color: var(--brand); background: var(--blue-25); }
.no-product-name { font-size: 13px; font-weight: 600; color: var(--gray-800); }
.no-product-price { font-size: 13px; color: var(--brand); font-weight: 600; }
.no-product-unit { font-size: 11px; font-weight: 400; }
.no-in-cart-dot { position: absolute; top: 6px; right: 8px; font-size: 11px; color: var(--brand); }
.no-empty { font-size: 13px; color: var(--gray-400); padding: 16px 0; text-align: center; }
.no-cart { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }
.no-cart-row { display: flex; align-items: center; gap: 10px; padding: 10px; background: var(--bg-primary); border: 1.5px solid var(--border-light); border-radius: 8px; }
.no-cart-row.under-min { border-color: var(--amber-300); background: var(--amber-50); }
.no-cart-info { flex: 1; min-width: 0; }
.no-cart-name { font-size: 13px; font-weight: 600; color: var(--gray-900); }
.no-cart-uprice { font-size: 11px; color: var(--gray-400); }
.no-cart-warn { font-size: 11px; color: var(--amber-700); font-weight: 500; margin-top: 2px; }
.no-qty-wrap { display: flex; align-items: center; gap: 3px; }
.no-qty-btn { width: 28px; height: 28px; border: 1.5px solid var(--border); background: var(--surface); border-radius: 6px; font-size: 14px; cursor: pointer; display: flex; align-items: center; justify-content: center; color: var(--gray-600); font-family: inherit; }
.no-qty-btn:hover { background: var(--bg-secondary); }
.no-qty-btn.no-qty-del { color: var(--red-500); border-color: transparent; }
.no-qty-input { width: 44px; text-align: center; padding: 4px; border: 1.5px solid var(--border); border-radius: 6px; font-size: 14px; font-family: inherit; background: var(--surface); color: var(--gray-900); }
.no-qty-input:focus { outline: none; border-color: var(--brand); }
.no-cart-total { font-size: 14px; font-weight: 600; min-width: 60px; text-align: right; color: var(--gray-900); }
.no-totals { border-top: 1.5px solid var(--border-light); padding-top: 12px; margin-bottom: 14px; display: flex; flex-direction: column; gap: 6px; }
.no-total-row { display: flex; justify-content: space-between; font-size: 13px; color: var(--gray-600); }
.no-total-grand { font-size: 17px; font-weight: 700; color: var(--gray-900); }
.no-submit { width: 100%; padding: 14px; font-size: 15px; font-weight: 700; border-radius: var(--radius-md); }
.no-confirm-card { max-width: 480px; margin: 60px auto; text-align: center; background: var(--surface); border: 1px solid var(--border-subtle); border-radius: var(--radius-2xl); padding: 40px 32px; box-shadow: var(--shadow-lg); }
.no-confirm-check { width: 56px; height: 56px; border-radius: 50%; background: var(--brand); color: white; font-size: 24px; font-weight: 800; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; box-shadow: 0 4px 14px rgba(37,99,235,0.35); }
.no-confirm-name { font-size: 18px; font-weight: 700; color: var(--gray-700); margin-top: 4px; }
.no-confirm-details { margin-top: 20px; border: 1px solid var(--border-light); border-radius: var(--radius-lg); overflow: hidden; text-align: left; }
.no-confirm-row { display: flex; justify-content: space-between; align-items: center; padding: 11px 16px; border-bottom: 1px solid var(--border-light); font-size: 14px; color: var(--gray-600); }
.no-confirm-row:last-child { border-bottom: none; }
.no-confirm-row strong { color: var(--gray-900); font-weight: 700; }
.no-confirm-link-box { margin-top: 16px; padding: 14px; background: var(--bg-primary); border: 1px solid var(--border-light); border-radius: var(--radius-md); text-align: left; }
.no-confirm-link-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--gray-500); margin-bottom: 6px; }
.no-confirm-link { font-size: 12px; color: var(--brand); word-break: break-all; display: block; margin-bottom: 8px; }
.no-confirm-actions { display: flex; gap: 8px; margin-top: 24px; justify-content: center; flex-wrap: wrap; }
.no-schedule-section { margin-top: 24px; border-top: 1px solid var(--border-light); padding-top: 20px; }
.no-schedule-label { font-size: 13px; color: var(--gray-500); margin-bottom: 12px; }
.no-schedule-done { font-size: 14px; font-weight: 600; color: var(--brand); margin-top: 8px; }
`;
