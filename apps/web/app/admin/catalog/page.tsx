'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, requireRole, getSession } from '../../lib/auth';

type CatalogItem = { id: string; sku: string; name: string; delivery_mode: string; unit: string; active: boolean; bulk_group: string; category?: string };

const MODE_LABEL: Record<string, string> = { bulk_load: 'Bulk Load', bag: 'Bag', pallet: 'Pallet' };
const MODE_PILL: Record<string, string> = { bulk_load: 'pill-green', bag: 'pill-blue', pallet: 'pill-amber' };

export default function AdminCatalogPage() {
  const isAdmin = getSession()?.role === 'admin';
  const fileRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [filter, setFilter] = useState('');
  const [showInactive, setShowInactive] = useState(false);

  // Modal
  const [modal, setModal] = useState<'create' | 'edit' | 'import' | null>(null);
  const [editItem, setEditItem] = useState<CatalogItem | null>(null);
  const [form, setForm] = useState({ sku: '', name: '', delivery_mode: 'bulk_load', unit: 'yard', category: '', bulk_group: '' });
  const [saving, setSaving] = useState(false);
  const [importResult, setImportResult] = useState<any>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api('/product-catalog');
      setItems(data.items || []);
    } catch (err) { setError((err as ApiError).message || 'Failed to load catalog'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = items.filter(i => {
    if (!showInactive && !i.active) return false;
    if (!filter) return true;
    const q = filter.toLowerCase();
    return i.sku.toLowerCase().includes(q) || i.name.toLowerCase().includes(q) || (i.bulk_group || '').toLowerCase().includes(q);
  });

  const openCreate = () => {
    setForm({ sku: '', name: '', delivery_mode: 'bulk_load', unit: 'yard', category: '', bulk_group: '' });
    setEditItem(null);
    setModal('create');
  };

  const openEdit = (item: CatalogItem) => {
    setForm({ sku: item.sku, name: item.name, delivery_mode: item.delivery_mode, unit: item.unit, category: item.category || '', bulk_group: item.bulk_group || '' });
    setEditItem(item);
    setModal('edit');
  };

  const saveProduct = async () => {
    setSaving(true);
    setError('');
    try {
      const body = { ...form, active: true, bulk_group: form.bulk_group || form.sku };
      if (modal === 'edit' && editItem) {
        await api(`/product-catalog/${editItem.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        setSuccess('Product updated');
      } else {
        await api('/product-catalog', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        setSuccess('Product created');
      }
      setModal(null);
      load();
    } catch (err) { setError((err as ApiError).message || 'Save failed'); }
    finally { setSaving(false); }
  };

  const disableProduct = async (id: string) => {
    try {
      await api(`/product-catalog/${id}/disable`, { method: 'POST' });
      load();
    } catch (err) { setError((err as ApiError).message || 'Disable failed'); }
  };

  const doImport = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setSaving(true);
    setImportResult(null);
    try {
      const text = await file.text();
      const res = await api('/product-catalog/import', {
        method: 'POST',
        headers: { 'Content-Type': 'text/csv' },
        body: text,
      });
      setImportResult(res);
      load();
    } catch (err) { setError((err as ApiError).message || 'Import failed'); }
    finally { setSaving(false); }
  };

  if (!requireRole(['dispatcher'])) return <div className="page"><p>Unauthorized</p></div>;

  return (
    <>
      <style>{styles}</style>
      <div className="page cat-page">
        <div className="cat-top">
          <div>
            <h1>Product Catalog</h1>
            <p style={{ color: 'var(--gray-500)', marginTop: 2 }}>{items.filter(i => i.active).length} active products</p>
          </div>
          {isAdmin && (
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-secondary btn-sm" onClick={() => { setImportResult(null); setModal('import'); }}>⬆ Import CSV</button>
              <button className="btn btn-primary btn-sm" onClick={openCreate}>+ Add Product</button>
            </div>
          )}
        </div>

        {error && <div className="alert alert-error" style={{ marginBottom: 12 }}><span>⚠</span> {error} <button className="btn btn-ghost btn-sm" onClick={() => setError('')} style={{ marginLeft: 'auto' }}>✕</button></div>}
        {success && <div className="alert alert-success" style={{ marginBottom: 12 }}><span>✓</span> {success} <button className="btn btn-ghost btn-sm" onClick={() => setSuccess('')} style={{ marginLeft: 'auto' }}>✕</button></div>}

        {/* Filter bar */}
        <div className="cat-filter card" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', marginBottom: 16 }}>
          <span style={{ color: 'var(--gray-400)' }}>🔍</span>
          <input style={{ border: 'none', boxShadow: 'none', padding: '6px 4px', flex: 1 }} placeholder="Filter by SKU, name, or bulk group…" value={filter} onChange={e => setFilter(e.target.value)} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--gray-500)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} style={{ width: 'auto' }} />
            Show inactive
          </label>
        </div>

        {loading && <div style={{ textAlign: 'center', padding: 40 }}><div className="spinner spinner-lg" style={{ margin: '0 auto' }} /></div>}

        {!loading && filtered.length === 0 && (
          <div className="card">
            <div className="empty-state">
              <div className="empty-state-icon">📦</div>
              <div className="empty-state-title">No products found</div>
              <div className="empty-state-desc">{filter ? 'Try a different search.' : 'Import a CSV or add products manually.'}</div>
            </div>
          </div>
        )}

        {!loading && filtered.length > 0 && (
          <div className="card">
            <table className="data-table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Product Name</th>
                  <th>Mode</th>
                  <th>Unit</th>
                  <th>Bulk Group</th>
                  <th>Status</th>
                  {isAdmin && <th style={{ width: 80 }}></th>}
                </tr>
              </thead>
              <tbody>
                {filtered.map(item => (
                  <tr key={item.id} style={{ opacity: item.active ? 1 : 0.5 }}>
                    <td><span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600 }}>{item.sku}</span></td>
                    <td style={{ fontWeight: 600, color: 'var(--gray-900)' }}>{item.name}</td>
                    <td><span className={`pill ${MODE_PILL[item.delivery_mode] || 'pill-gray'}`}>{MODE_LABEL[item.delivery_mode] || item.delivery_mode}</span></td>
                    <td>{item.unit}</td>
                    <td style={{ fontSize: 13, color: 'var(--gray-500)' }}>{item.bulk_group}</td>
                    <td>{item.active ? <span className="pill pill-green"><span className="pill-dot" />Active</span> : <span className="pill pill-gray">Inactive</span>}</td>
                    {isAdmin && (
                      <td>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button className="btn btn-ghost btn-sm" onClick={() => openEdit(item)}>Edit</button>
                          {item.active && <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red-600)' }} onClick={() => disableProduct(item.id)}>✕</button>}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Create/Edit modal */}
        {(modal === 'create' || modal === 'edit') && (
          <div className="modal-overlay" onClick={() => setModal(null)}>
            <div className="modal-card" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h2>{modal === 'edit' ? 'Edit Product' : 'Add Product'}</h2>
                <button className="btn btn-ghost btn-sm" onClick={() => setModal(null)}>✕</button>
              </div>
              <div className="modal-body">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div className="form-group">
                    <label className="form-label">SKU</label>
                    <input value={form.sku} onChange={e => setForm(f => ({ ...f, sku: e.target.value }))} placeholder="STONE-3-4" disabled={modal === 'edit'} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Unit</label>
                    <input value={form.unit} onChange={e => setForm(f => ({ ...f, unit: e.target.value }))} placeholder="yard" />
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">Product Name</label>
                  <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="3/4 Crushed Stone" autoFocus />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div className="form-group">
                    <label className="form-label">Delivery Mode</label>
                    <select value={form.delivery_mode} onChange={e => setForm(f => ({ ...f, delivery_mode: e.target.value }))}>
                      <option value="bulk_load">Bulk Load</option>
                      <option value="bag">Bag</option>
                      <option value="pallet">Pallet</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Bulk Group</label>
                    <input value={form.bulk_group} onChange={e => setForm(f => ({ ...f, bulk_group: e.target.value }))} placeholder="Defaults to SKU" />
                    <span className="form-hint">Products sharing a group combine into one load</span>
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">Category</label>
                  <input value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} placeholder="Stone, Mulch, Soil…" />
                </div>
              </div>
              <div className="modal-footer">
                <button className="btn btn-ghost" onClick={() => setModal(null)}>Cancel</button>
                <button className="btn btn-primary" onClick={saveProduct} disabled={saving || !form.sku || !form.name}>
                  {saving ? 'Saving…' : modal === 'edit' ? 'Update' : 'Create'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Import modal */}
        {modal === 'import' && (
          <div className="modal-overlay" onClick={() => setModal(null)}>
            <div className="modal-card" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h2>Import Products from CSV</h2>
                <button className="btn btn-ghost btn-sm" onClick={() => setModal(null)}>✕</button>
              </div>
              <div className="modal-body">
                <p style={{ fontSize: 14, color: 'var(--gray-600)' }}>
                  Upload a CSV with columns: <code style={{ fontSize: 12, background: 'var(--gray-100)', padding: '1px 6px', borderRadius: 4 }}>sku, name, delivery_mode, unit, active</code>. Optional: <code style={{ fontSize: 12, background: 'var(--gray-100)', padding: '1px 6px', borderRadius: 4 }}>category, bulk_group</code>.
                </p>
                <input ref={fileRef} type="file" accept=".csv" />
                {importResult && (
                  <div className="alert alert-info">
                    <span>📊</span>
                    <div>Created: {importResult.created} · Updated: {importResult.updated} · Skipped: {importResult.skipped}{importResult.errors?.length > 0 && ` · Errors: ${importResult.errors.length}`}</div>
                  </div>
                )}
              </div>
              <div className="modal-footer">
                <button className="btn btn-ghost" onClick={() => setModal(null)}>Close</button>
                <button className="btn btn-primary" onClick={doImport} disabled={saving}>{saving ? 'Importing…' : 'Import'}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

const styles = `
  .cat-page { max-width: 960px; }
  .cat-top { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 20px; flex-wrap: wrap; gap: 12px; }
  .cat-top h1 { font-size: 28px; font-weight: 800; letter-spacing: -0.02em; margin: 0; }
  .cat-filter input:focus { border: none !important; box-shadow: none !important; }
`;
