'use client';

import Link from 'next/link';
import { useRouter, useParams, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, CardElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { ApiError, api, requireRole } from '../../../lib/auth';
import { useLocation, fmtWindowRange } from '../../../lib/location-context';
import DropRescheduleSlideOver from '../../../components/DropRescheduleSlideOver';
import type { SlideOverDropDetail } from '../../../components/DropRescheduleSlideOver';

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || '');

/* ── Types ── */
type Address = { line1: string; line2?: string | null; city: string; state: string; postal_code: string };
type LoadItem = {
  id: string; material: string; qty: number; unit: string;
  status: string; driver_user_id: string | null; driver_name: string | null;
  pod_photo_url: string | null;
  exception_photo_url: string | null;
  exception_reason_code: string | null;
  exception_notes: string | null;
  condition_photo_url: string | null;
  condition_notes: string | null;
};
type DropDetail = {
  id: string; ref: string; source: string;
  scheduled_date: string | null; scheduled_window: string | null; is_priority: boolean;
  customer_id: string | null;
  customer_name: string; customer_phone: string; delivery_address: Address | null;
  notes: string | null; required_loads: number; loads: LoadItem[];
  notify_sent_at: string | null; last_reschedule_sms_at: string | null;
  drop_photos: string[];
  customer_email?: string | null; customer_sms_opt_in?: boolean; customer_email_opt_in?: boolean;
  payment_method?: string | null;
  payment_status?: string | null;
  payment_note?: string | null;
  order_total?: number | null;
  stripe_payment_intent_id?: string | null;
  wc_customer_id?: number | null;
  delivery_method?: string | null;
  external_order_id?: string | null;
};

type InvoiceLineItem = {
  name: string;
  sku: string;
  quantity: number;
  unit_price: number | null;
  subtotal: number | null;
};

type InvoiceData = {
  ref: string;
  order_number: number | null;
  created_at: string | null;
  scheduled_date: string | null;
  delivery_method: string | null;
  customer_name: string;
  customer_phone: string | null;
  customer_email: string | null;
  customer_company: string | null;
  delivery_address: { line1: string; line2?: string; city: string; state: string; postal_code: string } | null;
  line_items: InvoiceLineItem[];
  shipping_total: number;
  tax_total: number;
  order_total: number | null;
  payment_method: string | null;
  payment_status: string | null;
  payment_note: string | null;
  wc_source: boolean;
};

type WcProduct = {
  id: number; name: string; sku: string; price: string;
  regular_price: string; contractor_price: string | null; wholesale_price: string | null;
  sold_by_yard: boolean;
};

type ModifyLineItem = { product_id: number; name: string; quantity: number; unit_price: number };

/* ── Helpers ── */
const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function fmtDate(ds: string) {
  const d = new Date(ds + 'T12:00:00');
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}
function fmtPhone(p: string) {
  const d = p.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') return `(${d.slice(1,4)}) ${d.slice(4,7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
  return p;
}
function fmtAddr(a: Address) {
  let s = a.line1;
  if (a.line2) s += ', ' + a.line2;
  return `${s}, ${a.city}, ${a.state} ${a.postal_code}`;
}
function fmt(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

const STATUS_PILL: Record<string, string> = {
  assigned: 'pill-gray', loaded_leaving: 'pill-blue', delivered: 'pill-green',
  exception: 'pill-red', cancelled: 'pill-red', new: 'pill-amber',
};
const STATUS_LABEL: Record<string, string> = {
  assigned: 'Scheduled', loaded_leaving: 'En Route', delivered: 'Delivered',
  exception: 'Exception', cancelled: 'Cancelled', new: 'Pending',
};
const EXCEPTION_LABELS: Record<string, string> = {
  WRONG_ADDRESS: 'Wrong Address', CUSTOMER_REFUSED: 'Customer Refused',
  ACCESS_BLOCKED: 'Access Blocked', DAMAGED_GOODS: 'Damaged Material',
  CUSTOMER_UNAVAILABLE: 'Not Home', SAFETY_RISK: 'Safety Risk',
  OUT_OF_STOCK: 'Out of Stock', OTHER: 'Other',
};
const PAYMENT_METHOD_LABEL: Record<string, string> = {
  cash: 'Cash', card: 'Card', invoice: 'Invoice', payment_link: 'Payment Link',
};
const PAYMENT_STATUS_PILL: Record<string, string> = {
  paid: 'pill-green', unpaid: 'pill-amber', pending_link: 'pill-blue', refunded: 'pill-gray',
};
const PAYMENT_STATUS_LABEL: Record<string, string> = {
  paid: 'Paid', unpaid: 'Unpaid', pending_link: 'Awaiting Payment', refunded: 'Refunded',
};

function toSlideOverDetail(drop: DropDetail): SlideOverDropDetail {
  return {
    id: drop.id, ref: drop.ref, source: drop.source,
    is_priority: drop.is_priority,
    scheduled_date: drop.scheduled_date, scheduled_window: drop.scheduled_window,
    customer_id: drop.customer_id, customer_name: drop.customer_name, customer_phone: drop.customer_phone,
    customer_email: drop.customer_email, customer_sms_opt_in: drop.customer_sms_opt_in, customer_email_opt_in: drop.customer_email_opt_in,
    delivery_address: drop.delivery_address, notes: drop.notes,
    required_loads: drop.required_loads,
    loads: drop.loads.map(l => ({
      id: l.id, material: l.material, qty: l.qty, unit: l.unit,
      status: l.status, driver_user_id: l.driver_user_id, driver_name: l.driver_name,
      exception_reason_code: l.exception_reason_code,
      exception_notes: l.exception_notes,
      exception_photo_url: l.exception_photo_url,
      condition_photo_url: l.condition_photo_url,
      condition_notes: l.condition_notes,
      pod_photo_url: l.pod_photo_url,
    })),
    notify_sent_at: drop.notify_sent_at,
    last_reschedule_sms_at: drop.last_reschedule_sms_at,
  };
}

/* ── Stripe card form for delta capture ── */
function DeltaCardForm({
  deltaCents,
  stripeCustomerId,
  dropId,
  onSuccess,
  onCancel,
  onError,
}: {
  deltaCents: number;
  stripeCustomerId: string | null;
  dropId: string;
  onSuccess: (piId: string) => void;
  onCancel: () => void;
  onError: (msg: string) => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [processing, setProcessing] = useState(false);

  const handleCharge = async () => {
    if (!stripe || !elements) return;
    setProcessing(true);
    try {
      const intentRes = await api('/internal-orders/create-payment-intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount_cents: deltaCents,
          stripe_customer_id: stripeCustomerId,
          customer_name: '',
          save_card: false,
          description: `Order modification additional charge`,
        }),
      });
      const cardEl = elements.getElement(CardElement);
      if (!cardEl) { onError('Card element not found'); setProcessing(false); return; }
      const { error, paymentIntent } = await stripe.confirmCardPayment(intentRes.client_secret, {
        payment_method: { card: cardEl },
      });
      if (error) { onError(error.message || 'Card declined'); setProcessing(false); return; }
      if (paymentIntent?.status === 'succeeded') {
        onSuccess(paymentIntent.id);
      } else {
        onError('Payment did not complete'); setProcessing(false);
      }
    } catch (err) {
      onError((err as ApiError).message || 'Payment failed'); setProcessing(false);
    }
  };

  return (
    <div className="dd-delta-card">
      <div className="dd-delta-card-label">Charge additional {fmt(deltaCents / 100)}</div>
      <div className="dd-card-element-wrap">
        <CardElement options={{ style: { base: { fontSize: '15px', color: '#1a2e1a' } } }} />
      </div>
      <div className="dd-delta-card-actions">
        <button className="btn btn-primary" onClick={handleCharge} disabled={processing}>
          {processing ? 'Charging…' : `Charge ${fmt(deltaCents / 100)}`}
        </button>
        <button className="btn btn-ghost" onClick={onCancel} disabled={processing}>Cancel</button>
      </div>
    </div>
  );
}

export default function DispatchDropDetailPageWrapper() {
  return (
    <Suspense fallback={<div className="page" style={{ padding: 40 }}>Loading…</div>}>
      <DispatchDropDetailPage />
    </Suspense>
  );
}

function DispatchDropDetailPage() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [drop, setDrop] = useState<DropDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showPanel, setShowPanel] = useState(false);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const { activeLocation } = useLocation();
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [invoiceData, setInvoiceData] = useState<InvoiceData | null>(null);
  const [invoiceLoading, setInvoiceLoading] = useState(false);

  /* ── Modify order state ── */
  const [modifyMode, setModifyMode] = useState(false);
  const [products, setProducts] = useState<WcProduct[]>([]);
  const [productsLoading, setProductsLoading] = useState(false);
  const [modifyItems, setModifyItems] = useState<ModifyLineItem[]>([]);
  const [addSku, setAddSku] = useState<number | ''>('');
  const [addQty, setAddQty] = useState(1);
  const [modifyReason, setModifyReason] = useState('');
  const [modifySubmitting, setModifySubmitting] = useState(false);
  const [modifyError, setModifyError] = useState('');
  const [modifySuccess, setModifySuccess] = useState('');
  // Delta card capture state
  const [requiresCapture, setRequiresCapture] = useState(false);
  const [deltaCents, setDeltaCents] = useState(0);
  const [pendingStripeCustomerId, setPendingStripeCustomerId] = useState<string | null>(null);
  const [pendingPayload, setPendingPayload] = useState<null>(null);
  const fetchInvoice = async () => {
    if (invoiceLoading) return;
    setInvoiceLoading(true);
    try {
      const data = await api(`/dispatch/drops/${id}/invoice`);
      setInvoiceData(data);
      return data;
    } catch {
      return null;
    } finally {
      setInvoiceLoading(false);
    }
  };

  const printInvoice = async () => {
    const inv = invoiceData || await fetchInvoice();
    if (!inv) return;

    const fmtCurrency = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
    const dateStr = inv.scheduled_date
      ? new Date(inv.scheduled_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
      : inv.created_at
        ? new Date(inv.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
        : '—';
    const addrStr = inv.delivery_address
      ? [inv.delivery_address.line1, inv.delivery_address.line2, `${inv.delivery_address.city}, ${inv.delivery_address.state} ${inv.delivery_address.postal_code}`].filter(Boolean).join('<br>')
      : 'Pickup';

    const itemRows = inv.line_items.map(item => {
      const unitPriceCell = item.unit_price != null ? fmtCurrency(item.unit_price) : '—';
      const subtotalCell = item.subtotal != null ? fmtCurrency(item.subtotal) : '—';
      return `<tr><td>${item.name}</td><td class="pt-right">${item.quantity}</td><td class="pt-right">${unitPriceCell}</td><td class="pt-right">${subtotalCell}</td></tr>`;
    }).join('');

    const shippingRow = inv.shipping_total > 0
      ? `<tr><td colspan="3" style="text-align:right;color:#666;font-style:italic">Delivery Fee</td><td class="pt-right">${fmtCurrency(inv.shipping_total)}</td></tr>`
      : '';
    const taxRow = inv.tax_total > 0
      ? `<tr><td colspan="3" style="text-align:right;color:#666;font-style:italic">Tax</td><td class="pt-right">${fmtCurrency(inv.tax_total)}</td></tr>`
      : '';

    const paymentLabel = { cash: 'Cash', card: 'Card', invoice: 'Invoice', payment_link: 'Payment Link' }[inv.payment_method || ''] || (inv.payment_method || '');
    const paymentStatusLabel = { paid: 'Paid', unpaid: 'Unpaid', pending_link: 'Awaiting Payment', refunded: 'Refunded' }[inv.payment_status || ''] || '';

    const w = window.open('', '_blank', 'width=800,height=900');
    if (!w) return;
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Invoice ${inv.ref}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 13px; color: #222; background: #fff; padding: 40px; }
  .pt-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 28px; padding-bottom: 20px; border-bottom: 2px solid #2d6a2d; }
  .pt-logo { height: 72px; width: auto; }
  .pt-header-right { text-align: right; }
  .pt-invoice-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #666; }
  .pt-invoice-num { font-size: 26px; font-weight: 800; color: #2d6a2d; }
  .pt-meta { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 28px; padding: 20px; background: #f9fafb; border-radius: 6px; }
  .pt-meta-block dt { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #888; margin-bottom: 3px; }
  .pt-meta-block dd { font-size: 13px; font-weight: 500; color: #222; line-height: 1.4; }
  .pt-section-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em; color: #555; margin-bottom: 10px; }
  .pt-items-table { width: 100%; border-collapse: collapse; margin-bottom: 0; }
  .pt-items-table thead tr { background: #2d6a2d; color: #fff; }
  .pt-items-table th { padding: 9px 12px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; text-align: left; }
  .pt-items-table th.pt-right, .pt-items-table td.pt-right { text-align: right; }
  .pt-items-table tbody tr { border-bottom: 1px solid #eee; }
  .pt-items-table tbody tr:last-child { border-bottom: none; }
  .pt-items-table td { padding: 10px 12px; font-size: 13px; }
  .pt-total-row { display: flex; justify-content: space-between; align-items: center; padding: 14px 12px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 4px; margin-top: 8px; font-size: 16px; font-weight: 800; color: #166534; }
  .pt-payment { margin-top: 20px; padding: 14px; background: #f9fafb; border-radius: 6px; }
  .pt-payment-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #888; margin-bottom: 4px; }
  .pt-footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #ddd; text-align: center; font-size: 11px; color: #999; }
  @media print { body { padding: 20px; } }
</style>
</head><body>
<div class="pt-header">
  <img class="pt-logo" src="https://pub-2acb2bd410ad4b7094ea64a66e6531f5.r2.dev/logo/Garden%20Center%20PNG.png" alt="East Meadow Garden Center" />
  <div class="pt-header-right">
    <div class="pt-invoice-label">Invoice</div>
    <div class="pt-invoice-num">${inv.ref}</div>
    <div style="font-size:12px;color:#666;margin-top:4px">${dateStr}</div>
  </div>
</div>
<div class="pt-meta">
  <dl class="pt-meta-block"><dt>Bill To</dt><dd>${inv.customer_name}${inv.customer_company ? `<br><span style="color:#666">${inv.customer_company}</span>` : ''}</dd></dl>
  <dl class="pt-meta-block"><dt>${inv.delivery_method === 'delivery' ? 'Delivery Address' : 'Pickup'}</dt><dd>${addrStr}</dd></dl>
  ${inv.customer_phone ? `<dl class="pt-meta-block"><dt>Phone</dt><dd>${inv.customer_phone}</dd></dl>` : ''}
  ${inv.customer_email ? `<dl class="pt-meta-block"><dt>Email</dt><dd>${inv.customer_email}</dd></dl>` : ''}
</div>
<div class="pt-section-label">Items</div>
<table class="pt-items-table">
  <thead><tr><th>Description</th><th class="pt-right">Qty</th><th class="pt-right">Unit Price</th><th class="pt-right">Amount</th></tr></thead>
  <tbody>${itemRows}${shippingRow}${taxRow}</tbody>
</table>
${inv.order_total != null ? `<div class="pt-total-row"><span>Total</span><span>${fmtCurrency(inv.order_total)}</span></div>` : ''}
<div class="pt-payment">
  <div class="pt-payment-label">Payment</div>
  <div style="font-weight:700">${paymentLabel}${paymentStatusLabel ? ` — ${paymentStatusLabel}` : ''}${inv.payment_note ? ` · ${inv.payment_note}` : ''}</div>
</div>
<div class="pt-footer">East Meadow Garden Center &nbsp;·&nbsp; 47 Somers Rd, Hampden, MA 01036 &nbsp;·&nbsp; (413) 566-3602</div>
</body></html>`);
    w.document.close();
    setTimeout(() => w.print(), 400);
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const result = await api(`/drops/${id}`, { method: 'DELETE' });
      if (result.stripe_refund_error) {
        // Drop deleted but refund failed — show error before navigating
        setError(`Order deleted, but Stripe refund failed: ${result.stripe_refund_error}`);
        setDeleting(false);
        setConfirmDelete(false);
        return;
      }
      router.back();
    } catch (err) {
      setError((err as ApiError).message || 'Failed to delete order.');
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const fetchDrop = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api(`/dispatch/drops/${id}`);
      setDrop(d);
    } catch (err) {
      setError((err as ApiError).message || 'Failed to load drop');
    } finally { setLoading(false); }
  }, [id]);

  useEffect(() => { setMounted(true); }, []);
  useEffect(() => { fetchDrop(); }, [fetchDrop]);
  useEffect(() => {
    if (searchParams.get('action') === 'reschedule' && drop) setShowPanel(true);
  }, [searchParams, drop]);

  /* ── Enter modify mode ── */
  const enterModifyMode = async () => {
    setModifyMode(true);
    setModifyError('');
    setModifySuccess('');
    setRequiresCapture(false);
    // Seed current loads as starting items (qty only, no price — dispatcher must confirm)
    setModifyItems([]);
    if (products.length === 0) {
      setProductsLoading(true);
      try {
        const res = await api('/internal-orders/wc-products');
        setProducts(res.products || []);
      } catch {
        setModifyError('Could not load products.');
      } finally { setProductsLoading(false); }
    }
  };

  const exitModifyMode = () => {
    setModifyMode(false);
    setModifyItems([]);
    setModifyReason('');
    setModifyError('');
    setModifySuccess('');
    setRequiresCapture(false);
  };

  const addModifyItem = () => {
    if (!addSku) return;
    const product = products.find(p => p.id === addSku);
    if (!product) return;
    const existing = modifyItems.findIndex(i => i.product_id === addSku);
    if (existing >= 0) {
      const updated = [...modifyItems];
      updated[existing].quantity += addQty;
      setModifyItems(updated);
    } else {
      setModifyItems(prev => [...prev, {
        product_id: product.id,
        name: product.name,
        quantity: addQty,
        unit_price: parseFloat(product.price || '0'),
      }]);
    }
    setAddSku('');
    setAddQty(1);
  };

  const removeModifyItem = (idx: number) => setModifyItems(prev => prev.filter((_, i) => i !== idx));

  const updateQty = (idx: number, qty: number) => {
    if (qty < 1) return;
    const updated = [...modifyItems];
    updated[idx].quantity = qty;
    setModifyItems(updated);
  };

  const modifySubtotal = modifyItems.reduce((s, i) => s + i.unit_price * i.quantity, 0);

  const submitModify = async (overrideStripePaymentIntentId?: string) => {
    if (modifyItems.length === 0) { setModifyError('Add at least one item.'); return; }
    setModifySubmitting(true);
    setModifyError('');
    try {
      const body = {
        line_items: modifyItems.map(i => ({
          product_id: i.product_id,
          quantity: i.quantity,
          price: i.unit_price.toFixed(2),
          name: i.name,
        })),
        reason: modifyReason || undefined,
        stripe_payment_intent_id: overrideStripePaymentIntentId || undefined,
      };
      const res = await api(`/internal-orders/drops/${id}/modify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.requires_card_capture) {
        setDeltaCents(res.delta_cents);
        setPendingStripeCustomerId(res.stripe_customer_id || null);
        setRequiresCapture(true);
        setModifySubmitting(false);
        return;
      }
      const actionMsg: Record<string, string> = {
        refunded: `Refund of ${fmt(Math.abs(res.delta))} issued.`,
        charged_delta: `Additional ${fmt(res.delta)} charged.`,
        no_charge: 'Order updated.',
        local_only: 'Order updated (no Stripe action).',
        none: 'Order updated.',
      };
      setModifySuccess(`Order updated to ${fmt(res.new_total)}. ${actionMsg[res.action] || ''}`);
      setModifyMode(false);
      setRequiresCapture(false);
      setPendingPayload(null);
      await fetchDrop();
    } catch (err) {
      setModifyError((err as ApiError).message || 'Modification failed.');
    } finally { setModifySubmitting(false); }
  };

  if (!requireRole(['dispatcher'])) return <div className="page"><p>Unauthorized</p></div>;
  if (!mounted) return <div style={{ minHeight: '100vh' }} />;

  /* ── Photo sections ── */
  const buildPhotoSections = (drop: DropDetail) => {
    const sections: { label: string; icon: string; color: string; photos: { url: string; caption: string }[] }[] = [];
    if (drop.drop_photos?.length > 0) {
      sections.push({ label: 'Drop Site', icon: '📍', color: '#1d4ed8',
        photos: drop.drop_photos.map((url, i) => ({ url, caption: `Site photo ${i + 1}` })) });
    }
    const conditionPhotos = drop.loads.filter(l => l.condition_photo_url || l.condition_notes)
      .map(l => ({ url: l.condition_photo_url || '', caption: l.condition_notes ? `${l.material}: ${l.condition_notes}` : `${l.material} — condition documented`, notesOnly: !l.condition_photo_url, notes: l.condition_notes }));
    if (conditionPhotos.length > 0) {
      sections.push({ label: 'Site Conditions', icon: '📋', color: '#92400e',
        photos: conditionPhotos.filter(p => !p.notesOnly).map(p => ({ url: p.url, caption: p.caption })),
        ...(conditionPhotos.some(p => p.notesOnly) ? { notesOnly: conditionPhotos.filter(p => p.notesOnly) } : {}) } as any);
    }
    const podPhotos = drop.loads.filter(l => l.pod_photo_url).map(l => ({ url: l.pod_photo_url!, caption: `POD — ${l.material}` }));
    if (podPhotos.length > 0) sections.push({ label: 'Proof of Delivery', icon: '✅', color: '#15803d', photos: podPhotos });
    const exceptionPhotos = drop.loads.filter(l => l.exception_photo_url || l.exception_reason_code)
      .map(l => ({ url: l.exception_photo_url || '', caption: [EXCEPTION_LABELS[l.exception_reason_code || ''] || l.exception_reason_code || 'Exception', l.exception_notes].filter(Boolean).join(' — '), notesOnly: !l.exception_photo_url, notes: l.exception_notes, reason: l.exception_reason_code }));
    if (exceptionPhotos.length > 0) {
      sections.push({ label: 'Exception', icon: '⚠️', color: '#b91c1c',
        photos: exceptionPhotos.filter(p => !p.notesOnly).map(p => ({ url: p.url, caption: p.caption })),
        ...(exceptionPhotos.some(p => p.notesOnly) ? { notesOnly: exceptionPhotos.filter(p => p.notesOnly) } : {}) } as any);
    }
    return sections;
  };

  const photoSections = drop ? buildPhotoSections(drop) : [];
  const hasAnyPhotos = photoSections.length > 0;

  return (
    <>
      <style>{styles}</style>
      <div className="page dd-page">

        {/* Header */}
        <div className="dd-header">
          <button className="dd-back" onClick={() => router.back()}>← Back</button>
          <div className="dd-title-row">
            <h1 className="dd-title">
              Order <span className="dd-ref">#{drop?.ref || '…'}</span>
              {drop?.source && drop.source !== 'manual' && (
                <span className="dd-source-badge">{drop.source}</span>
              )}
              {drop?.source === 'manual' && (
                <span className="dd-source-badge manual">Manual</span>
              )}
            </h1>
            {drop && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {confirmDelete ? (
                  <>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                      <span style={{ fontSize: 13, color: 'var(--red-600)', fontWeight: 600 }}>Delete this order?</span>
                      {drop.payment_method === 'card' && drop.order_total ? (
                        <span style={{ fontSize: 12, color: 'var(--gray-500)' }}>
                          A refund of {fmt(drop.order_total)} will be issued to the card on file.
                        </span>
                      ) : null}
                    </div>
                    <button className="btn btn-sm" style={{ background: 'var(--red-600)', color: '#fff', borderColor: 'var(--red-600)' }} onClick={handleDelete} disabled={deleting}>
                      {deleting ? 'Deleting…' : 'Yes, delete'}
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(false)}>Cancel</button>
                  </>
                ) : (
                  <>
                    <button
                      className="btn btn-ghost btn-sm"
                      style={{ color: 'var(--gray-600)' }}
                      onClick={printInvoice}
                      disabled={invoiceLoading}
                    >
                      {invoiceLoading ? '…' : '🖨 Print Invoice'}
                    </button>
                    <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red-500)' }} onClick={() => setConfirmDelete(true)}>Delete</button>
                    <button className="btn btn-primary dd-manage-btn" onClick={() => setShowPanel(true)}>Manage Order</button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {error && (
          <div className="alert alert-error dd-alert">
            <span>⚠</span> {error}
            <button className="dd-alert-close" onClick={() => setError('')}>✕</button>
          </div>
        )}

        {modifySuccess && (
          <div className="alert alert-success dd-alert">
            <span>✓</span> {modifySuccess}
            <button className="dd-alert-close" onClick={() => setModifySuccess('')}>✕</button>
          </div>
        )}

        {loading && (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <div className="spinner spinner-lg" style={{ margin: '0 auto' }} />
          </div>
        )}

        {!loading && drop && (
          <>
            {/* Hero grid */}
            <div className="dd-hero-grid">
              <div className="card dd-hero-card">
                <div className="dd-hero-label">👤 Customer</div>
                <div className="dd-hero-name">{drop.customer_name}</div>
                <div className="dd-hero-phone">{fmtPhone(drop.customer_phone)}</div>
                {drop.delivery_address && (
                  <div className="dd-hero-addr">📍 {fmtAddr(drop.delivery_address)}</div>
                )}
              </div>
              <div className="card dd-hero-card">
                <div className="dd-hero-label">📅 Scheduled Delivery</div>
                <div className="dd-hero-name">{drop.scheduled_date ? fmtDate(drop.scheduled_date) : 'Not Yet Scheduled'}</div>
                <div className="dd-hero-window">
                  {drop.is_priority
                    ? <span className="dd-window-badge priority">⚡ Priority</span>
                    : drop.scheduled_window ? <span className={`dd-window-badge ${drop.scheduled_window === 'A' ? 'am' : 'pm'}`}>
                        {drop.scheduled_window === 'A' ? `Morning Window (${fmtWindowRange('A', activeLocation)})` : `Afternoon Window (${fmtWindowRange('B', activeLocation)})`}
                      </span> : null}
                </div>
                <div className="dd-hero-loads">{drop.required_loads} load{drop.required_loads !== 1 ? 's' : ''}</div>
                {!drop.scheduled_date && (
                  <button className="btn btn-secondary btn-sm" style={{ marginTop: 12 }} onClick={() => setShowPanel(true)}>
                    🔗 Send Scheduling Link
                  </button>
                )}
              </div>
            </div>

            {/* Payment */}
            {(drop.payment_method || drop.order_total) && (
              <div className="card dd-section">
                <div className="dd-section-head">Payment</div>
                <div className="dd-payment-grid">
                  {drop.payment_method && (
                    <div className="dd-payment-item">
                      <div className="dd-payment-label">Method</div>
                      <div className="dd-payment-value">{PAYMENT_METHOD_LABEL[drop.payment_method] || drop.payment_method}</div>
                    </div>
                  )}
                  {drop.payment_status && (
                    <div className="dd-payment-item">
                      <div className="dd-payment-label">Status</div>
                      <span className={`pill pill-sm ${PAYMENT_STATUS_PILL[drop.payment_status] || 'pill-gray'}`}>
                        <span className="pill-dot" />{PAYMENT_STATUS_LABEL[drop.payment_status] || drop.payment_status}
                      </span>
                    </div>
                  )}
                  {drop.order_total != null && (
                    <div className="dd-payment-item">
                      <div className="dd-payment-label">Total</div>
                      <div className="dd-payment-value dd-payment-total">{fmt(drop.order_total)}</div>
                    </div>
                  )}
                  {drop.payment_note && (
                    <div className="dd-payment-item dd-payment-note-item">
                      <div className="dd-payment-label">Note</div>
                      <div className="dd-payment-note-text">{drop.payment_note}</div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Notifications */}
            <div className="card dd-section">
              <div className="dd-section-head">Notifications</div>
              <div className="dd-notif-grid">
                <div className="dd-notif-item">
                  <div className="dd-notif-label">Delivery Notification</div>
                  {drop.notify_sent_at
                    ? <span className="pill pill-green pill-sm"><span className="pill-dot"/>Sent {new Date(drop.notify_sent_at).toLocaleString()}</span>
                    : <span className="pill pill-gray pill-sm"><span className="pill-dot"/>Not sent</span>}
                </div>
                <div className="dd-notif-item">
                  <div className="dd-notif-label">Reschedule SMS</div>
                  {drop.last_reschedule_sms_at
                    ? <span className="pill pill-amber pill-sm"><span className="pill-dot"/>Sent {new Date(drop.last_reschedule_sms_at).toLocaleString()}</span>
                    : <span className="pill pill-gray pill-sm"><span className="pill-dot"/>Not sent</span>}
                </div>
              </div>
            </div>

            {/* Loads + Modify */}
            <div className="card dd-section">
              <div className="dd-section-head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>Loads ({drop.loads.length})</span>
                {!modifyMode && drop.external_order_id && (
                  <button className="btn btn-ghost btn-sm" onClick={enterModifyMode}>✏️ Modify Order</button>
                )}
                {modifyMode && (
                  <button className="btn btn-ghost btn-sm" onClick={exitModifyMode}>✕ Cancel</button>
                )}
              </div>

              {!modifyMode ? (
                drop.loads.length === 0 ? (
                  <div className="dd-section-body" style={{ color: 'var(--gray-400)', fontStyle: 'italic', fontSize: 14 }}>
                    No loads attached to this drop.
                  </div>
                ) : (
                  <table className="dd-loads-table">
                    <thead>
                      <tr><th>Material</th><th>Driver</th><th>Status</th></tr>
                    </thead>
                    <tbody>
                      {drop.loads.map(l => (
                        <tr key={l.id}>
                          <td className="dd-load-mat">{l.material} × {l.qty} {l.unit}</td>
                          <td className="dd-load-driver">
                            {l.driver_name ? <span>🚚 {l.driver_name}</span> : <span className="dd-unassigned">⚠ Unassigned</span>}
                          </td>
                          <td>
                            <span className={`pill pill-sm ${l.status === 'assigned' && !l.driver_user_id ? 'pill-amber' : STATUS_PILL[l.status] || 'pill-gray'}`}>
                              <span className="pill-dot" />{l.status === 'assigned' && !l.driver_user_id ? 'Pending' : STATUS_LABEL[l.status] || l.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              ) : (
                /* ── Modify mode ── */
                <div className="dd-modify-body">
                  {productsLoading ? (
                    <div style={{ padding: '20px 24px', color: 'var(--gray-400)', fontSize: 14 }}>Loading products…</div>
                  ) : (
                    <>
                      {/* Current modified items */}
                      {modifyItems.length > 0 && (
                        <table className="dd-loads-table dd-modify-table">
                          <thead>
                            <tr><th>Material</th><th>Unit Price</th><th>Qty</th><th>Line Total</th><th></th></tr>
                          </thead>
                          <tbody>
                            {modifyItems.map((item, idx) => (
                              <tr key={item.product_id}>
                                <td className="dd-load-mat">{item.name}</td>
                                <td style={{ fontSize: 13, color: 'var(--gray-500)' }}>{fmt(item.unit_price)}</td>
                                <td>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <button className="dd-qty-btn" onClick={() => updateQty(idx, item.quantity - 1)}>−</button>
                                    <span style={{ minWidth: 20, textAlign: 'center', fontWeight: 600 }}>{item.quantity}</span>
                                    <button className="dd-qty-btn" onClick={() => updateQty(idx, item.quantity + 1)}>+</button>
                                  </div>
                                </td>
                                <td style={{ fontWeight: 600 }}>{fmt(item.unit_price * item.quantity)}</td>
                                <td>
                                  <button className="dd-remove-btn" onClick={() => removeModifyItem(idx)}>✕</button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}

                      {/* Add item row */}
                      <div className="dd-add-item-row">
                        <select
                          className="dd-modify-select"
                          value={addSku}
                          onChange={e => setAddSku(e.target.value ? Number(e.target.value) : '')}
                        >
                          <option value="">Select material…</option>
                          {products.map(p => (
                            <option key={p.id} value={p.id}>{p.name} — {fmt(parseFloat(p.price))}</option>
                          ))}
                        </select>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <button className="dd-qty-btn" onClick={() => setAddQty(q => Math.max(1, q - 1))}>−</button>
                          <span style={{ minWidth: 20, textAlign: 'center', fontWeight: 600 }}>{addQty}</span>
                          <button className="dd-qty-btn" onClick={() => setAddQty(q => q + 1)}>+</button>
                        </div>
                        <button className="btn btn-secondary btn-sm" onClick={addModifyItem} disabled={!addSku}>Add</button>
                      </div>

                      {/* Totals preview */}
                      {modifyItems.length > 0 && (
                        <div className="dd-modify-totals">
                          <div className="dd-modify-total-row">
                            <span>Items subtotal</span>
                            <span>{fmt(modifySubtotal)}</span>
                          </div>
                          <div className="dd-modify-total-row dd-modify-total-note">
                            <span>+ Shipping & tax calculated at submit</span>
                          </div>
                          {drop.order_total != null && (
                            <div className="dd-modify-total-row dd-modify-total-old">
                              <span>Current order total</span>
                              <span>{fmt(drop.order_total)}</span>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Reason */}
                      <div className="dd-modify-reason-row">
                        <input
                          className="dd-modify-reason-input"
                          placeholder="Reason for modification (optional)"
                          value={modifyReason}
                          onChange={e => setModifyReason(e.target.value)}
                        />
                      </div>

                      {/* Delta card capture */}
                      {requiresCapture && (
                        <Elements stripe={stripePromise}>
                          <DeltaCardForm
                            deltaCents={deltaCents}
                            stripeCustomerId={pendingStripeCustomerId}
                            dropId={id}
                            onSuccess={async (piId) => {
                              setRequiresCapture(false);
                              await submitModify(piId);
                            }}
                            onCancel={() => { setRequiresCapture(false); }}
                            onError={(msg) => setModifyError(msg)}
                          />
                        </Elements>
                      )}

                      {modifyError && (
                        <div className="dd-modify-error">{modifyError}</div>
                      )}

                      {!requiresCapture && (
                        <div className="dd-modify-actions">
                          <button
                            className="btn btn-primary"
                            onClick={() => submitModify()}
                            disabled={modifySubmitting || modifyItems.length === 0}
                          >
                            {modifySubmitting ? 'Saving…' : 'Confirm Modification'}
                          </button>
                          <button className="btn btn-ghost" onClick={exitModifyMode} disabled={modifySubmitting}>Cancel</button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Notes */}
            {drop.notes && (
              <div className="card dd-section">
                <div className="dd-section-head">Notes</div>
                <div className="dd-section-body" style={{ fontSize: 14, color: 'var(--gray-700)', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                  {drop.notes}
                </div>
              </div>
            )}

            {/* Photos */}
            {hasAnyPhotos && (
              <div className="card dd-section">
                <div className="dd-section-head">Photos & Documentation</div>
                <div className="dd-photos-body">
                  {photoSections.map((section, si) => (
                    <div key={si} className={`dd-photo-section ${si < photoSections.length - 1 ? 'dd-photo-section--border' : ''}`}>
                      <div className="dd-photo-section-label" style={{ color: section.color }}>{section.icon} {section.label}</div>
                      {section.photos.length > 0 && (
                        <div className="dd-photo-grid">
                          {section.photos.map((photo, pi) => (
                            <div key={pi} className="dd-photo-tile" onClick={() => setLightboxUrl(photo.url)}>
                              <img src={photo.url} alt={photo.caption} className="dd-photo-img" />
                              <div className="dd-photo-caption">{photo.caption}</div>
                            </div>
                          ))}
                        </div>
                      )}
                      {(section as any).notesOnly?.map((item: any, ni: number) => (
                        <div key={ni} className="dd-photo-note">
                          <span className="dd-photo-note-icon">📝</span>
                          <div>
                            {item.reason && <div className="dd-photo-note-reason">{EXCEPTION_LABELS[item.reason] || item.reason}</div>}
                            {item.notes && <div className="dd-photo-note-text">{item.notes}</div>}
                            {!item.reason && !item.notes && <div className="dd-photo-note-text">{item.caption}</div>}
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="dd-id-footer">Drop ID: <code>{drop.id}</code></div>
          </>
        )}
      </div>

      {/* Lightbox */}
      {lightboxUrl && (
        <div className="dd-lightbox-overlay" onClick={() => setLightboxUrl(null)}>
          <div className="dd-lightbox" onClick={e => e.stopPropagation()}>
            <img src={lightboxUrl} alt="Photo" className="dd-lightbox-img" />
            <button className="dd-lightbox-close" onClick={() => setLightboxUrl(null)}>✕</button>
          </div>
        </div>
      )}

      {showPanel && drop && (
        <DropRescheduleSlideOver
          dropId={drop.id}
          dropDetail={toSlideOverDetail(drop)}
          onClose={() => setShowPanel(false)}
          onRescheduled={fetchDrop}
          startOnReschedule={searchParams.get('action') === 'reschedule'}
          locationId={activeLocation?.id ?? null}
        />
      )}
    </>
  );
}

const styles = `
  .dd-page { max-width: 820px; }

  .dd-header { margin-bottom: 24px; }
  .dd-back { color: var(--gray-400); text-decoration: none; font-size: 13px; font-weight: 500; transition: color 0.15s; display: inline-block; margin-bottom: 6px; background: none; border: none; cursor: pointer; padding: 0; }
  .dd-back:hover { color: var(--green-600); }
  .dd-title-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
  .dd-title { font-family: var(--font-heading); font-size: 28px; font-weight: 800; letter-spacing: -0.02em; margin: 0; }
  .dd-ref { color: var(--green-700); }
  .dd-source-badge { display: inline-block; font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 12px; margin-left: 10px; vertical-align: middle; background: var(--blue-50,#eff6ff); color: var(--blue-700,#1d4ed8); text-transform: uppercase; letter-spacing: 0.04em; }
  .dd-source-badge.manual { background: var(--gray-100); color: var(--gray-500); }
  .dd-manage-btn { flex-shrink: 0; margin-top: 4px; }

  .dd-alert { margin-bottom: 12px; display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-radius: var(--radius-md); font-size: 14px; }
  .dd-alert-close { background: none; border: none; cursor: pointer; font-size: 16px; color: inherit; opacity: 0.6; padding: 0 4px; margin-left: auto; }

  .dd-hero-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
  @media (max-width: 640px) { .dd-hero-grid { grid-template-columns: 1fr; } }
  .dd-hero-card { padding: 20px 24px; display: flex; flex-direction: column; gap: 5px; }
  .dd-hero-label { font-family: var(--font-heading); font-size: 11px; font-weight: 700; color: var(--gray-400); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 4px; }
  .dd-hero-name { font-family: var(--font-heading); font-size: 18px; font-weight: 700; color: var(--gray-900); line-height: 1.3; }
  .dd-hero-phone { font-size: 15px; color: var(--gray-600); }
  .dd-hero-addr { font-size: 13px; color: var(--gray-500); line-height: 1.5; }
  .dd-hero-window { margin-top: 4px; }
  .dd-window-badge { display: inline-block; padding: 5px 12px; border-radius: var(--radius-md); font-size: 13px; font-weight: 600; }
  .dd-window-badge.am { background: var(--amber-50,#fffbeb); color: var(--amber-700,#b45309); }
  .dd-window-badge.pm { background: var(--blue-50,#eff6ff); color: var(--blue-700,#1d4ed8); }
  .dd-window-badge.priority { background: var(--amber-100,#fef3c7); color: var(--amber-800,#92400e); }
  .dd-hero-loads { font-size: 13px; color: var(--gray-400); font-weight: 600; }

  .dd-section { margin-bottom: 16px; overflow: hidden; }
  .dd-section-head { padding: 14px 24px; border-bottom: 1px solid var(--border-light); font-family: var(--font-heading); font-weight: 700; font-size: 15px; color: var(--gray-800); }

  /* Payment card */
  .dd-payment-grid { display: flex; flex-wrap: wrap; gap: 0; }
  .dd-payment-item { padding: 14px 24px; border-right: 1px solid var(--border-light); min-width: 120px; }
  .dd-payment-item:last-child { border-right: none; }
  .dd-payment-note-item { border-right: none; flex: 1 1 100%; border-top: 1px solid var(--border-light); }
  @media (max-width: 540px) { .dd-payment-item { border-right: none; border-bottom: 1px solid var(--border-light); flex: 1 1 50%; } .dd-payment-item:last-child { border-bottom: none; } }
  .dd-payment-label { font-family: var(--font-heading); font-size: 11px; font-weight: 700; color: var(--gray-400); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px; }
  .dd-payment-value { font-size: 14px; font-weight: 600; color: var(--gray-800); }
  .dd-payment-total { font-size: 18px; font-family: var(--font-heading); color: var(--gray-900); }
  .dd-payment-note-text { font-size: 13px; color: var(--gray-500); }

  .dd-section-body { padding: 16px 24px; }

  .dd-notif-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
  @media (max-width: 540px) { .dd-notif-grid { grid-template-columns: 1fr; } }
  .dd-notif-item { padding: 14px 24px; border-right: 1px solid var(--border-light); }
  .dd-notif-item:last-child { border-right: none; }
  @media (max-width: 540px) { .dd-notif-item { border-right: none; border-bottom: 1px solid var(--border-light); } .dd-notif-item:last-child { border-bottom: none; } }
  .dd-notif-label { font-family: var(--font-heading); font-size: 12px; font-weight: 600; color: var(--gray-500); margin-bottom: 6px; }

  .dd-loads-table { width: 100%; border-collapse: collapse; font-size: 14px; }
  .dd-loads-table th { padding: 10px 24px; text-align: left; font-family: var(--font-heading); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--gray-400); border-bottom: 1px solid var(--border-light); }
  .dd-loads-table td { padding: 13px 24px; border-bottom: 1px solid var(--border-light); vertical-align: middle; }
  .dd-loads-table tbody tr:last-child td { border-bottom: none; }
  .dd-load-mat { font-weight: 600; color: var(--gray-800); }
  .dd-load-driver { font-size: 13px; color: var(--gray-600); }
  .dd-unassigned { color: var(--amber-600,#d97706); font-weight: 600; font-size: 13px; }

  /* Modify mode */
  .dd-modify-body { padding-bottom: 8px; }
  .dd-modify-table td { padding: 10px 24px; }
  .dd-qty-btn { width: 28px; height: 28px; border-radius: 6px; border: 1.5px solid var(--border-light); background: var(--gray-50); font-size: 16px; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; color: var(--gray-700); flex-shrink: 0; }
  .dd-qty-btn:hover { background: var(--gray-100); }
  .dd-remove-btn { background: none; border: none; cursor: pointer; color: var(--gray-300); font-size: 14px; padding: 4px; border-radius: 4px; }
  .dd-remove-btn:hover { color: var(--red-500); background: var(--red-50, #fef2f2); }
  .dd-add-item-row { display: flex; align-items: center; gap: 10px; padding: 12px 24px; border-top: 1px solid var(--border-light); flex-wrap: wrap; }
  .dd-modify-select { flex: 1 1 200px; min-width: 0; padding: 8px 12px; border-radius: var(--radius-md); border: 1.5px solid var(--border-light); font-size: 14px; background: var(--surface); color: var(--gray-800); }
  .dd-modify-totals { padding: 12px 24px; background: var(--gray-50); border-top: 1px solid var(--border-light); }
  .dd-modify-total-row { display: flex; justify-content: space-between; font-size: 14px; color: var(--gray-700); padding: 3px 0; }
  .dd-modify-total-row span:last-child { font-weight: 600; }
  .dd-modify-total-note { color: var(--gray-400); font-size: 12px; font-style: italic; }
  .dd-modify-total-old { color: var(--gray-400); }
  .dd-modify-reason-row { padding: 12px 24px; border-top: 1px solid var(--border-light); }
  .dd-modify-reason-input { width: 100%; padding: 9px 12px; border-radius: var(--radius-md); border: 1.5px solid var(--border-light); font-size: 14px; background: var(--surface); color: var(--gray-800); box-sizing: border-box; }
  .dd-modify-error { margin: 8px 24px; padding: 10px 14px; background: var(--red-50,#fef2f2); border: 1.5px solid var(--red-200,#fecaca); border-radius: 8px; font-size: 13px; color: var(--red-700,#b91c1c); }
  .dd-modify-actions { display: flex; gap: 10px; padding: 16px 24px; border-top: 1px solid var(--border-light); flex-wrap: wrap; }

  /* Delta card capture */
  .dd-delta-card { margin: 12px 24px; padding: 16px; background: var(--gray-50); border: 1.5px solid var(--border-light); border-radius: 10px; }
  .dd-delta-card-label { font-family: var(--font-heading); font-size: 14px; font-weight: 700; color: var(--gray-800); margin-bottom: 12px; }
  .dd-card-element-wrap { padding: 11px 14px; border-radius: 8px; border: 1.5px solid var(--border-light); background: #fff; margin-bottom: 12px; }
  .dd-delta-card-actions { display: flex; gap: 10px; }

  /* Photos */
  .dd-photos-body { padding: 8px 0; }
  .dd-photo-section { padding: 16px 24px; }
  .dd-photo-section--border { border-bottom: 1px solid var(--border-light); }
  .dd-photo-section-label { font-family: var(--font-heading); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 12px; }
  .dd-photo-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; }
  .dd-photo-tile { border-radius: 10px; overflow: hidden; border: 1.5px solid var(--border-light); cursor: pointer; transition: transform 0.15s, box-shadow 0.15s; }
  .dd-photo-tile:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
  .dd-photo-img { width: 100%; height: 130px; object-fit: cover; display: block; }
  .dd-photo-caption { padding: 6px 10px; font-size: 12px; color: var(--gray-500); font-weight: 500; background: var(--gray-50); line-height: 1.3; }
  .dd-photo-note { display: flex; align-items: flex-start; gap: 10px; padding: 10px 14px; background: var(--gray-50); border-radius: 8px; margin-top: 8px; }
  .dd-photo-note-icon { font-size: 18px; flex-shrink: 0; margin-top: 1px; }
  .dd-photo-note-reason { font-family: var(--font-heading); font-size: 13px; font-weight: 700; color: var(--gray-700); margin-bottom: 2px; }
  .dd-photo-note-text { font-size: 13px; color: var(--gray-600); line-height: 1.4; }

  /* Lightbox */
  .dd-lightbox-overlay { position: fixed; inset: 0; z-index: 200; background: rgba(0,0,0,0.85); display: flex; align-items: center; justify-content: center; animation: dd-fade 0.15s; }
  @keyframes dd-fade { from { opacity: 0; } to { opacity: 1; } }
  .dd-lightbox { position: relative; max-width: 90vw; max-height: 90vh; }
  .dd-lightbox-img { max-width: 90vw; max-height: 85vh; object-fit: contain; border-radius: 12px; display: block; }
  .dd-lightbox-close { position: absolute; top: -16px; right: -16px; width: 40px; height: 40px; border-radius: 50%; background: #fff; border: none; font-size: 18px; box-shadow: 0 2px 8px rgba(0,0,0,0.3); cursor: pointer; display: flex; align-items: center; justify-content: center; }

  .dd-id-footer { font-size: 12px; color: var(--gray-300); margin-top: 24px; margin-bottom: 40px; }
  .dd-id-footer code { font-size: 11px; background: var(--gray-50); padding: 2px 6px; border-radius: 4px; }
`;
