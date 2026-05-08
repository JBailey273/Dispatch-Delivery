'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ApiError, api, requireRole } from '../lib/auth';

type CustomerResult = { id: string; first_name: string; last_name: string; company_name: string | null; name: string; phone_e164: string; customer_type: string; last_ordered: string | null; email: string | null; sms_opt_in: boolean; email_opt_in: boolean; invoice_billing: boolean; stripe_customer_id: string | null; exact_phone_match?: boolean; };
type Address = {
  id: string; line1: string; line2?: string | null;
  city: string; state: string; postal_code: string; is_default?: boolean;
};

type AddrForm = { line1: string; line2: string; city: string; state: string; postal_code: string };
const emptyAddrForm = (): AddrForm => ({ line1: '', line2: '', city: '', state: '', postal_code: '' });

function fmtPhone(p: string) {
  const d = p.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') return `(${d.slice(1,4)}) ${d.slice(4,7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
  return p;
}

function fmtDate(ds: string) {
  const d = new Date(ds + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtAddrLine(a: Address) {
  return `${a.line1}${a.line2 ? `, ${a.line2}` : ''}, ${a.city}, ${a.state} ${a.postal_code}`;
}

const stripePromise = typeof window !== 'undefined'
  ? import('@stripe/stripe-js').then(m => m.loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || ''))
  : Promise.resolve(null);

function CardCaptureModal({
  customer,
  onClose,
  onSuccess,
}: {
  customer: CustomerResult;
  onClose: () => void;
  onSuccess: (stripeCustomerId: string) => void;
}) {
  const [stripeInstance, setStripeInstance] = useState<any>(null);
  const [cardElements, setCardElements] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cardEl: any = null;
    stripePromise.then(s => {
      if (!s || !cardRef.current) return;
      setStripeInstance(s);
      const els = (s as any).elements();
      setCardElements(els);
      cardEl = els.create('card', {
        style: {
          base: { fontSize: '15px', fontFamily: 'inherit', color: '#1f2937', '::placeholder': { color: '#9ca3af' } },
          invalid: { color: '#dc2626' },
        },
      });
      cardEl.mount(cardRef.current);
    });
    return () => { try { cardEl?.destroy(); } catch {} };
  }, []);

  const handleSave = async () => {
    if (!stripeInstance || !cardElements) return;
    setSaving(true);
    setError('');
    try {
      const intentData = await api('/internal-orders/create-setup-intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stripe_customer_id: customer.stripe_customer_id || null,
          customer_name: `${customer.first_name} ${customer.last_name}`.trim(),
          customer_email: customer.email || null,
        }),
      });
      const cardElement = cardElements.getElement('card');
      const { error: stripeError } = await stripeInstance.confirmCardSetup(
        intentData.client_secret,
        { payment_method: { card: cardElement } }
      );
      if (stripeError) throw new Error(stripeError.message);
      await api(`/internal-orders/customer/${customer.id}/invoice-billing`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          invoice_billing: customer.invoice_billing,
          wc_customer_id: null,
          stripe_customer_id: intentData.stripe_customer_id,
        }),
      });
      onSuccess(intentData.stripe_customer_id);
    } catch (err: any) {
      setError(err.message || 'Failed to save card');
    } finally { setSaving(false); }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={e => e.stopPropagation()} style={{ maxWidth: 440 }}>
        <div className="modal-header">
          <h2>Card on File — {customer.first_name} {customer.last_name}</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <p style={{ fontSize: 13, color: 'var(--gray-500)', marginTop: 0, marginBottom: 16 }}>
            This card will be charged weekly for outstanding invoice orders. Stored securely in Stripe — card numbers are never saved here.
          </p>
          <div ref={cardRef} style={{ border: '1.5px solid var(--border)', borderRadius: 8, padding: '12px 14px', background: 'var(--bg-primary)' }} />
          {error && <div className="alert alert-error" style={{ marginTop: 10 }}><span>⚠</span> {error}</div>}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={saving || !stripeInstance} onClick={handleSave}>
            {saving ? 'Saving…' : 'Save Card'}
          </button>
        </div>
      </div>
    </div>
  );
}

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

  /* ── Expanded customer ── */
  const [expanded, setExpanded] = useState<string | null>(null);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [addrLoading, setAddrLoading] = useState(false);

  /* ── Customer inline edit ── */
  const [editingName, setEditingName] = useState<string | null>(null);   // customer id
  const [editingPhone, setEditingPhone] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [savingField, setSavingField] = useState('');
  const [editingEmail, setEditingEmail] = useState<string | null>(null);
  const [editEmail, setEditEmail] = useState('');
  const [savingEmail, setSavingEmail] = useState(false);
  const [togglingOptIn, setTogglingOptIn] = useState<string | null>(null);
  const [editingCompany, setEditingCompany] = useState<string | null>(null);
  const [editCompany, setEditCompany] = useState('');
  const [savingCompany, setSavingCompany] = useState(false);

  /* ── Address edit/add ── */
  const [editingAddrId, setEditingAddrId] = useState<string | null>(null);  // address id being edited
  const [editAddrForm, setEditAddrForm] = useState<AddrForm>(emptyAddrForm());
  const [showAddAddr, setShowAddAddr] = useState(false);
  const [addAddrForm, setAddAddrForm] = useState<AddrForm>(emptyAddrForm());
  const [savingAddr, setSavingAddr] = useState(false);

  /* ── Delete confirmations ── */
  const [confirmDeleteAddr, setConfirmDeleteAddr] = useState<string | null>(null);  // address id
  const [confirmDeleteCustomer, setConfirmDeleteCustomer] = useState<string | null>(null); // customer id
  const [deleting, setDeleting] = useState(false);

 /* ── Type toggle ── */
  const [typeToggling, setTypeToggling] = useState<string | null>(null);

  /* ── Invoice billing toggle ── */
  const [togglingInvoice, setTogglingInvoice] = useState<string | null>(null);

  /* ── Card capture ── */
  const [showCardCapture, setShowCardCapture] = useState<string | null>(null);

  /* ── Create customer modal ── */
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newType, setNewType] = useState<'residential' | 'commercial'>('residential');
  const [newEmail, setNewEmail] = useState('');
  const [newSmsOptIn, setNewSmsOptIn] = useState(false);
  const [newEmailOptIn, setNewEmailOptIn] = useState(false);
  const [newAddr, setNewAddr] = useState({ line1: '', line2: '', city: '', state: '', postal_code: '' });
  const [creating, setCreating] = useState(false);
  const [newCompany, setNewCompany] = useState('');

  /* ── Sort ── */
  type SortKey = 'name' | 'type' | 'last_ordered';
  type SortDir = 'asc' | 'desc';
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir(key === 'last_ordered' ? 'desc' : 'asc'); }
  };

  /* ── Debounce timer ── */
  const [debounceTimer, setDebounceTimer] = useState<NodeJS.Timeout | null>(null);

  /* Load all on mount */
  useEffect(() => {
    api('/customers')
      .then(d => setAllCustomers(d.results || []))
      .catch(err => setError((err as ApiError).message || 'Failed to load customers'))
      .finally(() => setLoading(false));
  }, []);

  /* Pre-populate search from URL param */
useEffect(() => {
  const params = new URLSearchParams(window.location.search);
  const initialSearch = params.get('search');
  if (initialSearch) {
    handleQueryChange(initialSearch);
  }
}, []);
  
  const refreshCustomers = async () => {
    const d = await api('/customers');
    setAllCustomers(d.results || []);
  };

  /* Search */
  const handleQueryChange = (val: string) => {
    setQ(val);
    if (debounceTimer) clearTimeout(debounceTimer);
    if (!val.trim()) { setSearchResults(null); return; }
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

  const displayed = (() => {
    const base = searchResults !== null
      ? searchResults
      : !q.trim()
        ? allCustomers
        : allCustomers.filter(c => c.name.toLowerCase().includes(q.toLowerCase()) || c.phone_e164.includes(q));

    return [...base].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'name') {
        cmp = (a.name || '').localeCompare(b.name || '');
      } else if (sortKey === 'type') {
        cmp = (a.customer_type || '').localeCompare(b.customer_type || '') || (a.name || '').localeCompare(b.name || '');
      } else if (sortKey === 'last_ordered') {
        const aDate = a.last_ordered || '';
        const bDate = b.last_ordered || '';
        cmp = aDate < bDate ? -1 : aDate > bDate ? 1 : 0;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
  })();

  /* ── Expand / fetch addresses ── */
  const toggleExpand = async (id: string) => {
    if (expanded === id) {
      setExpanded(null);
      resetEditState();
      return;
    }
    setExpanded(id);
    resetEditState();
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

  const resetEditState = () => {
    setEditingName(null); setEditingPhone(null); setEditingEmail(null);
    setEditingAddrId(null); setShowAddAddr(false);
    setAddAddrForm(emptyAddrForm()); setEditAddrForm(emptyAddrForm());
    setConfirmDeleteAddr(null); setConfirmDeleteCustomer(null);
  };

  /* ── Inline customer edit ── */
  const startEditName = (c: CustomerResult) => {
    setEditingName(c.id); setEditName(`${c.first_name} ${c.last_name}`.trim());
    setEditingPhone(null);
  };
  const startEditPhone = (c: CustomerResult) => {
    setEditingPhone(c.id); setEditPhone(fmtPhone(c.phone_e164));
    setEditingName(null);
  };

  const saveName = async (customerId: string) => {
    if (!editName.trim()) return;
    setSavingField('name');
    try {
      const parts = editName.trim().split(' ');
      const first_name = parts[0] || '';
      const last_name = parts.slice(1).join(' ');
      await api(`/customers/${customerId}/name`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ first_name, last_name }),
      });
      const fullName = `${first_name} ${last_name}`.trim();
      const update = (list: CustomerResult[]) =>
        list.map(c => c.id === customerId ? { ...c, first_name, last_name, name: fullName } : c);
      setAllCustomers(update);
      if (searchResults) setSearchResults(update(searchResults));
      setEditingName(null);
      setSuccess('Name updated');
      setTimeout(() => setSuccess(''), 2000);
    } catch (err) {
      setError((err as ApiError).message || 'Failed to update name');
    } finally { setSavingField(''); }
  };

  const savePhone = async (customerId: string) => {
    setSavingField('phone');
    try {
      const data = await api(`/customers/${customerId}/phone`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: editPhone }),
      });
      const update = (list: CustomerResult[]) =>
        list.map(c => c.id === customerId ? { ...c, phone_e164: data.phone_e164 } : c);
      setAllCustomers(update);
      if (searchResults) setSearchResults(update(searchResults));
      setEditingPhone(null);
      setSuccess('Phone updated');
      setTimeout(() => setSuccess(''), 2000);
    } catch (err) {
      setError((err as ApiError).message || 'Failed to update phone');
    } finally { setSavingField(''); }
  };

  const toggleCustomerType = async (customerId: string, currentType: string) => {
    const newType = currentType === 'commercial' ? 'residential' : 'commercial';
    setTypeToggling(customerId);
    setError('');
    try {
      await api(`/customers/${customerId}/type`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_type: newType }),
      });
      const update = (list: CustomerResult[]) =>
        list.map(c => c.id === customerId ? { ...c, customer_type: newType } : c);
      setAllCustomers(update);
      if (searchResults) setSearchResults(update(searchResults));
      setSuccess(`Switched to ${newType}`);
      setTimeout(() => setSuccess(''), 2000);
    } catch (err) {
      setError((err as ApiError).message || 'Failed to update type');
    } finally { setTypeToggling(null); }
  };

  const saveEmail = async (customerId: string) => {
    setSavingEmail(true);
    try {
      await api(`/customers/${customerId}/email`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: editEmail.trim() || null }),
      });
      const update = (list: CustomerResult[]) =>
        list.map(c => c.id === customerId ? { ...c, email: editEmail.trim() || null } : c);
      setAllCustomers(update);
      if (searchResults) setSearchResults(update(searchResults));
      setEditingEmail(null);
      setSuccess('Email updated');
      setTimeout(() => setSuccess(''), 2000);
    } catch (err) {
      setError((err as ApiError).message || 'Failed to update email');
    } finally { setSavingEmail(false); }
  };
  
const saveCompany = async (customerId: string) => {
    setSavingCompany(true);
    try {
      await api(`/customers/${customerId}/company`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company_name: editCompany.trim() || null }),
      });
      const update = (list: CustomerResult[]) =>
        list.map(c => c.id === customerId ? { ...c, company_name: editCompany.trim() || null } : c);
      setAllCustomers(update);
      if (searchResults) setSearchResults(update(searchResults));
      setEditingCompany(null);
      setSuccess('Company updated');
      setTimeout(() => setSuccess(''), 2000);
    } catch (err) {
      setError((err as ApiError).message || 'Failed to update company');
    } finally { setSavingCompany(false); }
  };
  
  const toggleInvoiceBilling = async (customerId: string, current: boolean) => {
    setTogglingInvoice(customerId);
    setError('');
    try {
      await api(`/internal-orders/customer/${customerId}/invoice-billing`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice_billing: !current, wc_customer_id: null }),
      });
      const update = (list: CustomerResult[]) =>
        list.map(c => c.id === customerId ? { ...c, invoice_billing: !current } : c);
      setAllCustomers(update);
      if (searchResults) setSearchResults(update(searchResults));
      setSuccess(`Invoice billing ${!current ? 'enabled' : 'disabled'}`);
      setTimeout(() => setSuccess(''), 2000);
    } catch (err) {
      setError((err as ApiError).message || 'Failed to update invoice billing');
    } finally { setTogglingInvoice(null); }
  };

  const toggleOptIn = async (customerId: string, field: 'sms_opt_in' | 'email_opt_in', current: boolean) => {
    setTogglingOptIn(`${customerId}_${field}`);
    try {
      await api(`/customers/${customerId}/opt-ins`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: !current }),
      });
      const update = (list: CustomerResult[]) =>
        list.map(c => c.id === customerId ? { ...c, [field]: !current } : c);
      setAllCustomers(update);
      if (searchResults) setSearchResults(update(searchResults));
    } catch (err) {
      setError((err as ApiError).message || 'Failed to update preference');
    } finally { setTogglingOptIn(null); }
  };

  /* ── Address editing ── */
  const startEditAddr = (a: Address) => {
    setEditingAddrId(a.id);
    setEditAddrForm({
      line1: a.line1 || '', line2: a.line2 || '',
      city: a.city || '', state: a.state || '', postal_code: a.postal_code || '',
    });
    setShowAddAddr(false);
  };

  const saveEditAddr = async (customerId: string, addrId: string) => {
    if (!editAddrForm.line1.trim() || !editAddrForm.city.trim() || !editAddrForm.state.trim() || !editAddrForm.postal_code.trim()) {
      setError('Street, city, state, and ZIP are required.');
      return;
    }
    setSavingAddr(true);
    try {
      const updated = await api(`/customers/${customerId}/addresses/${addrId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editAddrForm),
      });
      setAddresses(prev => prev.map(a => a.id === addrId ? { ...a, ...updated } : a));
      setEditingAddrId(null);
      setSuccess('Address updated');
      setTimeout(() => setSuccess(''), 2000);
    } catch (err) {
      setError((err as ApiError).message || 'Failed to update address');
    } finally { setSavingAddr(false); }
  };

  const deleteAddr = async (customerId: string, addrId: string) => {
    setDeleting(true);
    try {
      await api(`/customers/${customerId}/addresses/${addrId}`, { method: 'DELETE' });
      setAddresses(prev => prev.filter(a => a.id !== addrId));
      setConfirmDeleteAddr(null);
      setSuccess('Address deleted');
      setTimeout(() => setSuccess(''), 2000);
    } catch (err) {
      setError((err as ApiError).message || 'Failed to delete address');
    } finally { setDeleting(false); }
  };

  const saveNewAddr = async (customerId: string) => {
    if (!addAddrForm.line1.trim() || !addAddrForm.city.trim() || !addAddrForm.state.trim() || !addAddrForm.postal_code.trim()) {
      setError('Street, city, state, and ZIP are required.');
      return;
    }
    setSavingAddr(true);
    try {
      const res = await api(`/customers/${customerId}/addresses`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...addAddrForm, is_default: addresses.length === 0 }),
      });
      // Refresh the addresses list to get normalized values back from server
      const data = await api(`/customers/${customerId}/addresses`);
      setAddresses(data.addresses || []);
      setShowAddAddr(false);
      setAddAddrForm(emptyAddrForm());
      setSuccess('Address added');
      setTimeout(() => setSuccess(''), 2000);
    } catch (err) {
      setError((err as ApiError).message || 'Failed to add address');
    } finally { setSavingAddr(false); }
  };

  /* ── Delete customer ── */
  const deleteCustomer = async (customerId: string) => {
    setDeleting(true);
    try {
      await api(`/customers/${customerId}`, { method: 'DELETE' });
      setAllCustomers(prev => prev.filter(c => c.id !== customerId));
      if (searchResults) setSearchResults(prev => prev ? prev.filter(c => c.id !== customerId) : null);
      setExpanded(null);
      setConfirmDeleteCustomer(null);
      setSuccess('Customer deleted');
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError((err as ApiError).message || 'Failed to delete customer');
      setConfirmDeleteCustomer(null);
    } finally { setDeleting(false); }
  };

  /* ── Create customer ── */
const createCustomer = async () => {
    if (!newPhone.trim()) return;
    setCreating(true); setError('');
    try {
      const parts = newName.trim().split(/\s+/);
      const first_name = parts[0] || 'Unknown';
      const last_name = parts.slice(1).join(' ');
      const c = await api('/customers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ first_name, last_name, company_name: newCompany.trim() || null, email: newEmail.trim() || null, phone: newPhone, customer_type: newType }),
      });
      const created = c.customer || c;
      if (newSmsOptIn || newEmailOptIn) {
        try {
          await api(`/customers/${created.id}/opt-ins`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sms_opt_in: newSmsOptIn, email_opt_in: newEmailOptIn && !!newEmail.trim() }),
          });
        } catch { /* non-fatal */ }
      }
      if (newAddr.line1.trim() && newAddr.city.trim() && newAddr.state.trim() && newAddr.postal_code.trim()) {
        try {
          await api(`/customers/${created.id}/addresses`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...newAddr, is_default: true }),
          });
        } catch { /* non-fatal */ }
      }
      setShowCreate(false); setNewName(''); setNewPhone(''); setNewType('residential'); setNewEmail(''); setNewSmsOptIn(false); setNewEmailOptIn(false); setNewCompany(''); setNewAddr({ line1: '', line2: '', city: '', state: '', postal_code: '' });
      await refreshCustomers();
      setQ(''); setSearchResults(null);
    } catch (err) {
      setError((err as ApiError).message || 'Create failed');
    } finally { setCreating(false); }
  };

  if (!requireRole(['dispatcher'])) return <div className="page"><p>Unauthorized</p></div>;

  const commercialCount = allCustomers.filter(c => c.customer_type === 'commercial').length;

  return (
    <>
      <style>{styles}</style>
      <div className="page cs-page">

        {/* Top bar */}
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
          <span className="cs-search-icon">🔍</span>
          <input
            ref={inputRef}
            className="cs-search-input"
            placeholder="Filter by name, company, phone, or address…"
            value={q}
            onChange={e => handleQueryChange(e.target.value)}
            autoFocus
          />
          {q && <button className="btn btn-ghost btn-sm" onClick={() => { setQ(''); setSearchResults(null); }}>✕</button>}
          {searchLoading && <div className="spinner" />}
        </div>

        {error && (
          <div className="alert alert-error" style={{ marginBottom: 16 }}>
            <span>⚠</span> {error}
            <button style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', opacity: 0.6 }} onClick={() => setError('')}>✕</button>
          </div>
        )}
        {success && <div className="alert alert-success" style={{ marginBottom: 16 }}><span>✓</span> {success}</div>}

        {loading && (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <div className="spinner spinner-lg" style={{ margin: '0 auto' }} />
          </div>
        )}

        {!loading && displayed.length === 0 && (
          <div className="card">
            <div className="empty-state">
              <div className="empty-state-icon">👤</div>
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
                  <th onClick={() => toggleSort('name')} className="cs-th-sort">
                    Customer {sortKey === 'name' ? (sortDir === 'asc' ? '↑' : '↓') : <span className="cs-sort-idle">↕</span>}
                  </th>
                  <th className={`cs-type-col cs-th-sort`} onClick={() => toggleSort('type')}>
                    Type {sortKey === 'type' ? (sortDir === 'asc' ? '↑' : '↓') : <span className="cs-sort-idle">↕</span>}
                  </th>
                  <th className="cs-phone-col">Phone</th>
                  <th className={`cs-last-col cs-th-sort`} onClick={() => toggleSort('last_ordered')}>
                    Last Order {sortKey === 'last_ordered' ? (sortDir === 'asc' ? '↑' : '↓') : <span className="cs-sort-idle">↕</span>}
                  </th>
                  <th style={{ width: 100 }}></th>
                </tr>
              </thead>
              <tbody>
                {displayed.map(r => {
                  const isCommercial = r.customer_type === 'commercial';
                  const isExpanded = expanded === r.id;
                  return (
                    <>
                      <tr key={r.id} onClick={() => toggleExpand(r.id)} style={{ cursor: 'pointer' }} className={isExpanded ? 'cs-row-expanded' : ''}>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div className={`cs-avatar${isCommercial ? ' commercial' : ''}`}>
                              {isCommercial ? '🏢' : (r.name?.charAt(0)?.toUpperCase() || '?')}
                            </div>
                            <div>
                              <div style={{ fontWeight: 600, color: 'var(--gray-900)' }}>{r.name}</div>
                              {r.company_name && (
                                <div style={{ fontSize: 12, color: 'var(--gray-500)', marginTop: 1 }}>{r.company_name}</div>
                              )}
                              {r.exact_phone_match && (
                                <span className="pill pill-green" style={{ fontSize: 10, marginTop: 2 }}>
                                  <span className="pill-dot" />Exact match
                                </span>
                              )}
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
                            {typeToggling === r.id ? '…' : (isCommercial ? 'Commercial' : 'Residential')}
                          </button>
                        </td>
                        <td className="cs-phone-col" style={{ fontSize: 13 }}>{fmtPhone(r.phone_e164)}</td>
                        <td className="cs-last-col">
                          {r.last_ordered
                            ? <span style={{ fontSize: 13 }}>{fmtDate(r.last_ordered)}</span>
                            : <span style={{ color: 'var(--gray-300)', fontSize: 13 }}>—</span>}
                        </td>
                        <td>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={e => { e.stopPropagation(); router.push(`/dispatch/new-order?customer=${encodeURIComponent(r.name)}`); }}
                          >
                            New Order
                          </button>
                        </td>
                      </tr>

                      {/* ── Expanded panel ── */}
                      {isExpanded && (
                        <tr key={`${r.id}-exp`} className="cs-exp-row">
                          <td colSpan={5} style={{ padding: 0 }}>
                            <div className="cs-expand-panel">

                             {/* Customer info edit */}
                              <div className="cs-section">
                                <div className="cs-section-label">Customer Info</div>
                                <div className="cs-info-grid">

                                  {/* First Name + Last Name */}
                                  {editingName === r.id ? (
                                    <>
                                      <div className="cs-info-field">
                                        <div className="cs-field-label">First Name</div>
                                        <div className="cs-inline-edit">
                                          <input
                                            className="cs-inline-input"
                                            value={editName.split(' ')[0] || ''}
                                            onChange={e => setEditName(`${e.target.value} ${editName.split(' ').slice(1).join(' ')}`.trim())}
                                            onKeyDown={e => { if (e.key === 'Enter') saveName(r.id); if (e.key === 'Escape') setEditingName(null); }}
                                            autoFocus
                                            placeholder="First name"
                                          />
                                        </div>
                                      </div>
                                      <div className="cs-info-field">
                                        <div className="cs-field-label">Last Name</div>
                                        <div className="cs-inline-edit">
                                          <input
                                            className="cs-inline-input"
                                            value={editName.split(' ').slice(1).join(' ') || ''}
                                            onChange={e => setEditName(`${editName.split(' ')[0]} ${e.target.value}`.trim())}
                                            onKeyDown={e => { if (e.key === 'Enter') saveName(r.id); if (e.key === 'Escape') setEditingName(null); }}
                                            placeholder="Last name"
                                          />
                                          <button className="btn btn-primary btn-xs" disabled={savingField === 'name'} onClick={() => saveName(r.id)}>
                                            {savingField === 'name' ? '…' : 'Save'}
                                          </button>
                                          <button className="btn btn-ghost btn-xs" onClick={() => setEditingName(null)}>Cancel</button>
                                        </div>
                                      </div>
                                    </>
                                  ) : (
                                    <>
                                      <div className="cs-info-field">
                                        <div className="cs-field-label">First Name</div>
                                        <div className="cs-field-value">
                                          {r.first_name}
                                          <button className="cs-edit-btn" onClick={e => { e.stopPropagation(); startEditName(r); }}>Edit</button>
                                        </div>
                                      </div>
                                      <div className="cs-info-field">
                                        <div className="cs-field-label">Last Name</div>
                                        <div className="cs-field-value">{r.last_name}</div>
                                      </div>
                                    </>
                                  )}

                                  {/* Company */}
                                  <div className="cs-info-field">
                                    <div className="cs-field-label">Company</div>
                                    {editingCompany === r.id ? (
                                      <div className="cs-inline-edit">
                                        <input
                                          className="cs-inline-input"
                                          value={editCompany}
                                          onChange={e => setEditCompany(e.target.value)}
                                          onKeyDown={e => { if (e.key === 'Enter') saveCompany(r.id); if (e.key === 'Escape') setEditingCompany(null); }}
                                          autoFocus
                                          placeholder="Company name"
                                        />
                                        <button className="btn btn-primary btn-xs" disabled={savingCompany} onClick={() => saveCompany(r.id)}>
                                          {savingCompany ? '…' : 'Save'}
                                        </button>
                                        <button className="btn btn-ghost btn-xs" onClick={() => setEditingCompany(null)}>Cancel</button>
                                      </div>
                                    ) : (
                                      <div className="cs-field-value">
                                        {r.company_name || <span style={{ color: 'var(--gray-300)' }}>—</span>}
                                        <button className="cs-edit-btn" onClick={e => { e.stopPropagation(); setEditingCompany(r.id); setEditCompany(r.company_name || ''); }}>Edit</button>
                                      </div>
                                    )}
                                  </div>

                                  {/* Phone */}
                                  <div className="cs-info-field">
                                    <div className="cs-field-label">Phone</div>
                                    {editingPhone === r.id ? (
                                      <div className="cs-inline-edit">
                                        <input
                                          className="cs-inline-input"
                                          value={editPhone}
                                          onChange={e => setEditPhone(e.target.value)}
                                          onKeyDown={e => { if (e.key === 'Enter') savePhone(r.id); if (e.key === 'Escape') setEditingPhone(null); }}
                                          autoFocus
                                          placeholder="(555) 000-0000"
                                        />
                                        <button className="btn btn-primary btn-xs" disabled={savingField === 'phone'} onClick={() => savePhone(r.id)}>
                                          {savingField === 'phone' ? '…' : 'Save'}
                                        </button>
                                        <button className="btn btn-ghost btn-xs" onClick={() => setEditingPhone(null)}>Cancel</button>
                                      </div>
                                    ) : (
                                      <div className="cs-field-value">
                                        {fmtPhone(r.phone_e164)}
                                        <button className="cs-edit-btn" onClick={e => { e.stopPropagation(); startEditPhone(r); }}>Edit</button>
                                      </div>
                                    )}
                                  </div>

                                  {/* Last order */}
                                  <div className="cs-info-field">
                                    <div className="cs-field-label">Last Order</div>
                                    <div className="cs-field-value">
                                      {r.last_ordered ? fmtDate(r.last_ordered) : <span style={{ color: 'var(--gray-400)' }}>No orders yet</span>}
                                    </div>
                                  </div>

                                  {/* Email */}
                                  <div className="cs-info-field">
                                    <div className="cs-field-label">Email</div>
                                    {editingEmail === r.id ? (
                                      <div className="cs-inline-edit">
                                        <input
                                          className="cs-inline-input"
                                          value={editEmail}
                                          onChange={e => setEditEmail(e.target.value)}
                                          onKeyDown={e => { if (e.key === 'Enter') saveEmail(r.id); if (e.key === 'Escape') setEditingEmail(null); }}
                                          autoFocus
                                          placeholder="customer@example.com"
                                          type="email"
                                        />
                                        <button className="btn btn-primary btn-xs" disabled={savingEmail} onClick={() => saveEmail(r.id)}>
                                          {savingEmail ? '…' : 'Save'}
                                        </button>
                                        <button className="btn btn-ghost btn-xs" onClick={() => setEditingEmail(null)}>Cancel</button>
                                      </div>
                                    ) : (
                                      <div className="cs-field-value">
                                        {r.email || <span style={{ color: 'var(--gray-300)' }}>—</span>}
                                        <button className="cs-edit-btn" onClick={e => { e.stopPropagation(); setEditingEmail(r.id); setEditEmail(r.email || ''); }}>Edit</button>
                                      </div>
                                    )}
                                  </div>

                                  {/* Notification opt-ins */}
                                  <div className="cs-info-field" style={{ gridColumn: '1 / -1' }}>
                                    <div className="cs-field-label">Notification Preferences</div>
                                    <div style={{ display: 'flex', gap: 12, marginTop: 4, flexWrap: 'wrap' }}>
                                      <button
                                        className={`btn btn-sm ${r.sms_opt_in ? 'btn-primary' : 'btn-secondary'}`}
                                        disabled={togglingOptIn === `${r.id}_sms_opt_in`}
                                        onClick={e => { e.stopPropagation(); toggleOptIn(r.id, 'sms_opt_in', r.sms_opt_in); }}
                                      >
                                        {r.sms_opt_in ? '✓ SMS' : '○ SMS'}
                                      </button>
                                      <button
                                        className={`btn btn-sm ${r.email_opt_in ? 'btn-primary' : 'btn-secondary'}`}
                                        disabled={togglingOptIn === `${r.id}_email_opt_in` || !r.email}
                                        onClick={e => { e.stopPropagation(); toggleOptIn(r.id, 'email_opt_in', r.email_opt_in); }}
                                        title={!r.email ? 'Add an email address first' : ''}
                                      >
                                        {r.email_opt_in ? '✓ Email' : '○ Email'}
                                      </button>
                                    </div>
                                  </div>

                                </div>{/* end cs-info-grid */}
                              </div>{/* end cs-section */}
                              {/* Addresses */}
                              <div className="cs-section">
                                <div className="cs-section-label">Delivery Addresses</div>

                                {addrLoading && <div className="spinner" style={{ margin: '8px 0' }} />}

                                {!addrLoading && addresses.length === 0 && !showAddAddr && (
                                  <p style={{ color: 'var(--gray-400)', fontSize: 13, margin: '4px 0 10px' }}>No saved addresses yet.</p>
                                )}

                                {!addrLoading && addresses.map(a => (
                                  <div key={a.id} className="cs-addr-card">
                                    {editingAddrId === a.id ? (
                                      /* Edit form */
                                      <div className="cs-addr-form">
                                        <div className="cs-addr-form-grid">
                                          <div className="cs-form-field cs-form-full">
                                            <label>Street</label>
                                            <input value={editAddrForm.line1} onChange={e => setEditAddrForm(f => ({ ...f, line1: e.target.value }))} placeholder="123 Colony Drive" />
                                          </div>
                                          <div className="cs-form-field cs-form-full">
                                            <label>Apt / Suite (optional)</label>
                                            <input value={editAddrForm.line2} onChange={e => setEditAddrForm(f => ({ ...f, line2: e.target.value }))} placeholder="Unit 4B" />
                                          </div>
                                          <div className="cs-form-field">
                                            <label>City</label>
                                            <input value={editAddrForm.city} onChange={e => setEditAddrForm(f => ({ ...f, city: e.target.value }))} placeholder="Hampden" />
                                          </div>
                                          <div className="cs-form-field cs-form-short">
                                            <label>State</label>
                                            <input value={editAddrForm.state} onChange={e => setEditAddrForm(f => ({ ...f, state: e.target.value }))} placeholder="MA" maxLength={2} />
                                          </div>
                                          <div className="cs-form-field cs-form-short">
                                            <label>ZIP</label>
                                            <input value={editAddrForm.postal_code} onChange={e => setEditAddrForm(f => ({ ...f, postal_code: e.target.value }))} placeholder="01036" maxLength={10} />
                                          </div>
                                        </div>
                                        <div className="cs-form-actions">
                                          <button className="btn btn-primary btn-sm" disabled={savingAddr} onClick={() => saveEditAddr(r.id, a.id)}>
                                            {savingAddr ? 'Saving…' : 'Save Address'}
                                          </button>
                                          <button className="btn btn-ghost btn-sm" onClick={() => setEditingAddrId(null)}>Cancel</button>
                                        </div>
                                      </div>
                                    ) : (
                                      /* Read view */
                                      <div className="cs-addr-read">
                                        <div className="cs-addr-text">
                                          <div className="cs-addr-line1">{a.line1}{a.line2 ? `, ${a.line2}` : ''}</div>
                                          <div className="cs-addr-line2">{a.city}, {a.state} {a.postal_code}</div>
                                        </div>
                                        <div className="cs-addr-actions">
                                          {a.is_default && <span className="pill pill-green pill-sm"><span className="pill-dot" />Default</span>}
                                          <button className="cs-edit-btn" onClick={e => { e.stopPropagation(); startEditAddr(a); }}>Edit</button>
                                          {confirmDeleteAddr === a.id ? (
                                            <span className="cs-confirm-delete">
                                              Delete?
                                              <button className="cs-confirm-yes" disabled={deleting} onClick={e => { e.stopPropagation(); deleteAddr(r.id, a.id); }}>
                                                {deleting ? '…' : 'Yes'}
                                              </button>
                                              <button className="cs-confirm-no" onClick={e => { e.stopPropagation(); setConfirmDeleteAddr(null); }}>No</button>
                                            </span>
                                          ) : (
                                            <button className="cs-delete-btn" onClick={e => { e.stopPropagation(); setConfirmDeleteAddr(a.id); }}>Delete</button>
                                          )}
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                ))}

                                {/* Add address form */}
                                {showAddAddr ? (
                                  <div className="cs-addr-card cs-addr-card-new">
                                    <div className="cs-addr-form">
                                      <div className="cs-addr-form-grid">
                                        <div className="cs-form-field cs-form-full">
                                          <label>Street</label>
                                          <input value={addAddrForm.line1} onChange={e => setAddAddrForm(f => ({ ...f, line1: e.target.value }))} placeholder="123 Colony Drive" autoFocus />
                                        </div>
                                        <div className="cs-form-field cs-form-full">
                                          <label>Apt / Suite (optional)</label>
                                          <input value={addAddrForm.line2} onChange={e => setAddAddrForm(f => ({ ...f, line2: e.target.value }))} placeholder="Unit 4B" />
                                        </div>
                                        <div className="cs-form-field">
                                          <label>City</label>
                                          <input value={addAddrForm.city} onChange={e => setAddAddrForm(f => ({ ...f, city: e.target.value }))} placeholder="Hampden" />
                                        </div>
                                        <div className="cs-form-field cs-form-short">
                                          <label>State</label>
                                          <input value={addAddrForm.state} onChange={e => setAddAddrForm(f => ({ ...f, state: e.target.value }))} placeholder="MA" maxLength={2} />
                                        </div>
                                        <div className="cs-form-field cs-form-short">
                                          <label>ZIP</label>
                                          <input value={addAddrForm.postal_code} onChange={e => setAddAddrForm(f => ({ ...f, postal_code: e.target.value }))} placeholder="01036" maxLength={10} />
                                        </div>
                                      </div>
                                      <div className="cs-form-actions">
                                        <button className="btn btn-primary btn-sm" disabled={savingAddr} onClick={() => saveNewAddr(r.id)}>
                                          {savingAddr ? 'Saving…' : 'Add Address'}
                                        </button>
                                        <button className="btn btn-ghost btn-sm" onClick={() => { setShowAddAddr(false); setAddAddrForm(emptyAddrForm()); }}>Cancel</button>
                                      </div>
                                    </div>
                                  </div>
                                ) : (
                                  <button
                                    className="cs-add-addr-btn"
                                    onClick={e => { e.stopPropagation(); setShowAddAddr(true); setEditingAddrId(null); }}
                                  >
                                    + Add Address
                                  </button>
                                )}
                              </div>

                              {/* Billing */}
                              <div className="cs-section">
                                <div className="cs-section-label">Billing</div>
                                <div className="cs-info-grid">
                                  <div className="cs-info-field">
                                    <div className="cs-field-label">Invoice Billing</div>
                                    <div className="cs-field-value">
                                      <button
                                        className={`btn btn-sm ${r.invoice_billing ? 'btn-primary' : 'btn-secondary'}`}
                                        disabled={togglingInvoice === r.id}
                                        onClick={e => { e.stopPropagation(); toggleInvoiceBilling(r.id, r.invoice_billing); }}
                                      >
                                        {togglingInvoice === r.id ? '…' : r.invoice_billing ? '✓ Enabled' : '○ Disabled'}
                                      </button>
                                    </div>
                                  </div>
                                  <div className="cs-info-field">
                                    <div className="cs-field-label">Card on File</div>
                                    <div className="cs-field-value">
                                      {r.stripe_customer_id ? (
                                        <span style={{ fontSize: 13, color: 'var(--green-600)', fontWeight: 600 }}>✓ Card saved</span>
                                      ) : (
                                        <span style={{ fontSize: 13, color: 'var(--gray-400)' }}>No card on file</span>
                                      )}
                                      <button
                                        className="cs-edit-btn"
                                        onClick={e => { e.stopPropagation(); setShowCardCapture(r.id); }}
                                      >
                                        {r.stripe_customer_id ? 'Update' : 'Add Card'}
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              </div>

                              {/* Footer: New Order + Delete Customer */}
                              <div className="cs-expand-footer">
                                <button
                                  className="btn btn-primary btn-sm"
                                  onClick={e => { e.stopPropagation(); router.push(`/dispatch/new-order?customer=${encodeURIComponent(r.name)}`); }}
                                >
                                  New Order →
                                </button>

                                {confirmDeleteCustomer === r.id ? (
                                  <span className="cs-confirm-delete cs-confirm-destructive">
                                    <span>Delete <strong>{r.name}</strong>?</span>
                                    <button className="cs-confirm-yes" disabled={deleting} onClick={e => { e.stopPropagation(); deleteCustomer(r.id); }}>
                                      {deleting ? 'Deleting…' : 'Yes, delete'}
                                    </button>
                                    <button className="cs-confirm-no" onClick={e => { e.stopPropagation(); setConfirmDeleteCustomer(null); }}>Cancel</button>
                                  </span>
                                ) : (
                                  <button
                                    className="cs-delete-customer-btn"
                                    onClick={e => { e.stopPropagation(); setConfirmDeleteCustomer(r.id); }}
                                  >
                                    Delete Customer
                                  </button>
                                )}
                              </div>

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

      </div>

      {showCardCapture && (() => {
        const customer = displayed.find(c => c.id === showCardCapture);
        if (!customer) return null;
        return (
          <CardCaptureModal
            customer={customer}
            onClose={() => setShowCardCapture(null)}
            onSuccess={(stripeCustomerId) => {
              const update = (list: CustomerResult[]) =>
                list.map(c => c.id === customer.id ? { ...c, stripe_customer_id: stripeCustomerId } : c);
              setAllCustomers(update);
              if (searchResults) setSearchResults(update(searchResults));
              setShowCardCapture(null);
              setSuccess('Card saved successfully');
              setTimeout(() => setSuccess(''), 3000);
            }}
          />
        );
      })()}

      {showCreate && (
        <div className="modal-overlay" onClick={() => setShowCreate(false)}>
          <div className="modal-card cs-new-customer-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>New Customer</h2>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowCreate(false)} style={{ fontSize: 18, padding: '4px 8px' }}>✕</button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="cs-modal-section-label">Contact Info</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">First Name <span style={{ color: 'var(--red-500)' }}>*</span></label>
                  <input value={newName.split(' ')[0] || ''} onChange={e => setNewName(`${e.target.value} ${newName.split(' ').slice(1).join(' ')}`.trim())} placeholder="First name" autoFocus />
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Last Name <span style={{ color: 'var(--red-500)' }}>*</span></label>
                  <input value={newName.split(' ').slice(1).join(' ') || ''} onChange={e => setNewName(`${newName.split(' ')[0]} ${e.target.value}`.trim())} placeholder="Last name" />
                </div>
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">Company Name <span style={{ color: 'var(--gray-400)', fontWeight: 400 }}>(optional)</span></label>
                <input value={newCompany} onChange={e => setNewCompany(e.target.value)} placeholder="Company or business name" />
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">Email <span style={{ color: 'var(--red-500)' }}>*</span></label>
                <input type="email" placeholder="customer@example.com" value={newEmail} onChange={e => setNewEmail(e.target.value)} />
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">Phone <span style={{ color: 'var(--red-500)' }}>*</span></label>
                <input type="tel" value={newPhone} onChange={e => setNewPhone(e.target.value)} placeholder="(555) 000-0000" />
              </div>
              <div>
                <div className="cs-modal-section-label">Account Type</div>
                <div className="cs-type-selector">
                  <button className={`cs-type-opt${newType === 'residential' ? ' active' : ''}`} onClick={() => setNewType('residential')} type="button">
                    <span className="cs-type-opt-icon">🏠</span>
                    <span className="cs-type-opt-label">Residential</span>
                    <span className="cs-type-opt-desc">Standard homeowner delivery</span>
                  </button>
                  <button className={`cs-type-opt${newType === 'commercial' ? ' active' : ''}`} onClick={() => setNewType('commercial')} type="button">
                    <span className="cs-type-opt-icon">🏢</span>
                    <span className="cs-type-opt-label">Commercial</span>
                    <span className="cs-type-opt-desc">Contractor / landscaper</span>
                  </button>
                </div>
              </div>
              <div>
                <div className="cs-modal-section-label">Notification Preferences</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" className={`cs-notif-opt${newSmsOptIn ? ' active' : ''}`} onClick={() => setNewSmsOptIn(v => !v)}>
                    {newSmsOptIn ? '✓' : '○'} SMS
                  </button>
                  <button type="button" className={`cs-notif-opt${newEmailOptIn ? ' active' : ''}`}
                    onClick={() => { if (newEmail.trim()) setNewEmailOptIn(v => !v); }}
                    disabled={!newEmail.trim()} title={!newEmail.trim() ? 'Enter an email address first' : ''}>
                    {newEmailOptIn ? '✓' : '○'} Email
                  </button>
                </div>
              </div>
              <div>
                <div className="cs-modal-section-label">Primary Delivery Address <span style={{ color: 'var(--gray-400)', fontWeight: 400, textTransform: 'none', fontSize: 11 }}>(optional)</span></div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <input placeholder="Street address" value={newAddr.line1} onChange={e => setNewAddr(a => ({ ...a, line1: e.target.value }))} />
                  <input placeholder="Apt, suite, etc. (optional)" value={newAddr.line2} onChange={e => setNewAddr(a => ({ ...a, line2: e.target.value }))} />
                  <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 8 }}>
                    <input placeholder="City" value={newAddr.city} onChange={e => setNewAddr(a => ({ ...a, city: e.target.value }))} />
                    <input placeholder="State" value={newAddr.state} onChange={e => setNewAddr(a => ({ ...a, state: e.target.value }))} maxLength={2} />
                    <input placeholder="ZIP" value={newAddr.postal_code} onChange={e => setNewAddr(a => ({ ...a, postal_code: e.target.value }))} />
                  </div>
                </div>
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

  /* Avatar */
  .cs-avatar { width: 34px; height: 34px; border-radius: 50%; background: var(--green-100); color: var(--green-700); display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 14px; flex-shrink: 0; }
  .cs-avatar.commercial { background: var(--blue-100,#dbeafe); color: var(--blue-700,#1d4ed8); font-size: 16px; font-weight: normal; }

  /* Type toggle */
  .cs-type-toggle { display: inline-block; padding: 3px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; border: 1px solid transparent; cursor: pointer; transition: all 0.15s; font-family: inherit; line-height: 1.4; }
  .cs-type-toggle.residential { background: var(--gray-100); color: var(--gray-600); border-color: var(--gray-200); }
  .cs-type-toggle.residential:hover { background: var(--blue-50,#eff6ff); color: var(--blue-700,#1d4ed8); border-color: var(--blue-200,#bfdbfe); }
  .cs-type-toggle.commercial { background: var(--blue-50,#eff6ff); color: var(--blue-700,#1d4ed8); border-color: var(--blue-200,#bfdbfe); }
  .cs-type-toggle.commercial:hover { background: var(--gray-100); color: var(--gray-600); border-color: var(--gray-200); }
  .cs-type-toggle:disabled { opacity: 0.5; cursor: wait; }
  .cs-th-sort { cursor: pointer; user-select: none; white-space: nowrap; }
  .cs-th-sort:hover { color: var(--gray-700); }
  .cs-sort-idle { opacity: 0.3; font-size: 11px; }

  /* Expanded row */
  .cs-row-expanded td { background: var(--green-25,#f0fdf4); }
  .cs-exp-row td { padding: 0 !important; }
  .cs-expand-panel { border-top: 2px solid var(--green-200,#bbf7d0); background: var(--gray-25,#fafafa); }

  /* Sections inside expand panel */
  .cs-section { padding: 16px 20px; border-bottom: 1px solid var(--border-light); }
  .cs-section:last-of-type { border-bottom: none; }
  .cs-section-label { font-family: var(--font-heading); font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em; color: var(--gray-400); margin-bottom: 12px; }

  /* Customer info grid */
  .cs-info-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 14px; }
  .cs-info-field { display: flex; flex-direction: column; gap: 4px; }
  .cs-field-label { font-size: 11px; font-weight: 600; color: var(--gray-400); text-transform: uppercase; letter-spacing: 0.05em; }
  .cs-field-value { font-size: 14px; font-weight: 500; color: var(--gray-800); display: flex; align-items: center; gap: 8px; }
  .cs-edit-btn { font-size: 11px; font-weight: 600; color: var(--green-600); background: none; border: none; cursor: pointer; padding: 2px 6px; border-radius: 4px; transition: all 0.12s; }
  .cs-edit-btn:hover { background: var(--green-50); }

  /* Inline edit */
  .cs-inline-edit { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .cs-inline-input { padding: 5px 8px; border: 1px solid var(--green-400); border-radius: var(--radius-sm); font-size: 13px; font-family: inherit; flex: 1; min-width: 120px; }
  .cs-inline-input:focus { outline: none; box-shadow: 0 0 0 2px rgba(15,133,48,0.15); }

  /* btn-xs */
  .btn-xs { padding: 4px 10px !important; font-size: 12px !important; }

  /* Address cards */
  .cs-addr-card { background: var(--surface); border: 1px solid var(--border-light); border-radius: var(--radius-md); margin-bottom: 8px; overflow: hidden; }
  .cs-addr-card:last-of-type { margin-bottom: 0; }
  .cs-addr-card-new { border-color: var(--green-300); border-style: dashed; }
  .cs-addr-read { display: flex; align-items: flex-start; justify-content: space-between; padding: 10px 14px; gap: 12px; }
  .cs-addr-text { flex: 1; min-width: 0; }
  .cs-addr-line1 { font-size: 14px; font-weight: 600; color: var(--gray-800); }
  .cs-addr-line2 { font-size: 12px; color: var(--gray-500); margin-top: 2px; }
  .cs-addr-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; flex-wrap: wrap; }
  .cs-delete-btn { font-size: 11px; font-weight: 600; color: var(--red-500); background: none; border: none; cursor: pointer; padding: 2px 6px; border-radius: 4px; transition: all 0.12s; }
  .cs-delete-btn:hover { background: var(--red-50); }

  /* Address form */
  .cs-addr-form { padding: 14px; }
  .cs-addr-form-grid { display: grid; grid-template-columns: 1fr 1fr 80px 80px; gap: 8px; align-items: end; }
  @media (max-width: 600px) { .cs-addr-form-grid { grid-template-columns: 1fr 1fr; } }
  .cs-form-field { display: flex; flex-direction: column; gap: 4px; }
  .cs-form-field label { font-size: 11px; font-weight: 600; color: var(--gray-500); text-transform: uppercase; letter-spacing: 0.05em; }
  .cs-form-field input { padding: 7px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 13px; font-family: inherit; background: var(--surface); }
  .cs-form-field input:focus { outline: none; border-color: var(--green-400); box-shadow: 0 0 0 2px rgba(15,133,48,0.1); }
  .cs-form-full { grid-column: 1 / -1; }
  .cs-form-short { min-width: 0; }
  .cs-form-actions { display: flex; gap: 8px; margin-top: 10px; }

  /* Confirm delete inline */
  .cs-confirm-delete { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--gray-600); }
  .cs-confirm-yes { font-size: 12px; font-weight: 700; color: var(--red-600); background: var(--red-50); border: 1px solid var(--red-200); border-radius: 4px; padding: 2px 8px; cursor: pointer; }
  .cs-confirm-yes:hover { background: var(--red-100); }
  .cs-confirm-no { font-size: 12px; color: var(--gray-500); background: none; border: none; cursor: pointer; padding: 2px 6px; }
  .cs-confirm-destructive { padding: 8px 0; flex-wrap: wrap; row-gap: 4px; }
  .cs-confirm-destructive span:first-child { font-size: 13px; color: var(--gray-700); }

  /* Add address button */
  .cs-add-addr-btn { margin-top: 8px; padding: 7px 14px; border: 1.5px dashed var(--border); border-radius: var(--radius-md); background: none; font-family: var(--font-heading); font-size: 12px; font-weight: 600; color: var(--gray-500); cursor: pointer; transition: all 0.15s; width: 100%; text-align: center; }
  .cs-add-addr-btn:hover { border-color: var(--green-400); color: var(--green-700); background: var(--green-25,#f0fdf4); }

  /* Delete customer */
  .cs-expand-footer { display: flex; align-items: center; justify-content: space-between; padding: 14px 20px; background: var(--surface); border-top: 1px solid var(--border-light); flex-wrap: wrap; gap: 10px; }
  .cs-delete-customer-btn { font-size: 12px; font-weight: 600; color: var(--gray-400); background: none; border: none; cursor: pointer; padding: 4px 8px; border-radius: 4px; transition: all 0.12s; }
  .cs-delete-customer-btn:hover { color: var(--red-500); background: var(--red-50); }

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
    .cs-info-grid { grid-template-columns: 1fr; }
    .cs-type-selector { flex-direction: column; }
    .cs-addr-read { flex-direction: column; }
    .cs-addr-actions { justify-content: flex-start; }
  }

  .cs-new-customer-modal { max-width: 560px; width: 100%; }
  .cs-modal-section-label { font-family: var(--font-heading); font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em; color: var(--gray-400); margin-bottom: 8px; }
  .cs-notif-opt { padding: 7px 16px; border: 1.5px solid var(--border); border-radius: var(--radius-md); background: var(--surface); font-family: inherit; font-size: 13px; font-weight: 600; color: var(--gray-600); cursor: pointer; transition: all 0.15s; }
  .cs-notif-opt:hover:not(:disabled) { border-color: var(--green-300); color: var(--green-700); }
  .cs-notif-opt.active { border-color: var(--green-400); background: var(--green-50); color: var(--green-700); }
  .cs-notif-opt:disabled { opacity: 0.4; cursor: not-allowed; }

  .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 20px; }
  .modal-card { background: var(--surface); border-radius: var(--radius-lg); box-shadow: 0 20px 60px rgba(0,0,0,0.2); width: 100%; max-width: 480px; max-height: 90vh; overflow-y: auto; display: flex; flex-direction: column; }
  .modal-header { display: flex; align-items: center; justify-content: space-between; padding: 20px 24px 16px; border-bottom: 1px solid var(--border-light); }
  .modal-header h2 { font-size: 18px; font-weight: 800; margin: 0; }
  .modal-body { padding: 20px 24px; display: flex; flex-direction: column; gap: 16px; overflow-y: auto; }
  .modal-footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 16px 24px; border-top: 1px solid var(--border-light); }
  }
`;
