'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, requireRole } from '../../lib/auth';

type Location = {
  id: string;
  name: string;
  slug: string;
  is_active: boolean;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  phone: string | null;
  timezone: string;
  capacity_per_window: number;
  service_days: string[];
  windowA_start: string | null;
  windowA_end: string | null;
  windowB_start: string | null;
  windowB_end: string | null;
};

const WEEKDAYS = [
  { key: 'mon', label: 'Mon' }, { key: 'tue', label: 'Tue' }, { key: 'wed', label: 'Wed' },
  { key: 'thu', label: 'Thu' }, { key: 'fri', label: 'Fri' },
  { key: 'sat', label: 'Sat' }, { key: 'sun', label: 'Sun' },
];

const emptyForm = () => ({
  name: '', slug: '', is_active: true,
  address_line1: '', address_line2: '', city: '', state: '', postal_code: '', phone: '',
  timezone: 'America/New_York',
  capacity_per_window: 4,
  service_days: ['mon', 'tue', 'wed', 'thu', 'fri'],
  windowA_start: '07:00', windowA_end: '12:00',
  windowB_start: '12:00', windowB_end: '17:00',
});

function slugify(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function fmtTime(t: string | null) {
  if (!t) return '';
  // backend returns HH:MM:SS — trim to HH:MM for <input type="time">
  return t.slice(0, 5);
}

export default function AdminLocationsPage() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [modal, setModal] = useState<'create' | 'edit' | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<ReturnType<typeof emptyForm>>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api('/locations?include_inactive=true');
      setLocations(data.locations || []);
    } catch (err) {
      setError((err as ApiError).message || 'Failed to load locations');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => {
    setForm(emptyForm());
    setFormError('');
    setEditId(null);
    setModal('create');
  };

  const openEdit = (loc: Location) => {
    setForm({
      name: loc.name, slug: loc.slug, is_active: loc.is_active,
      address_line1: loc.address_line1 || '', address_line2: loc.address_line2 || '',
      city: loc.city || '', state: loc.state || '', postal_code: loc.postal_code || '',
      phone: loc.phone || '', timezone: loc.timezone || 'America/New_York',
      capacity_per_window: loc.capacity_per_window,
      service_days: loc.service_days || [],
      windowA_start: fmtTime(loc.windowA_start), windowA_end: fmtTime(loc.windowA_end),
      windowB_start: fmtTime(loc.windowB_start), windowB_end: fmtTime(loc.windowB_end),
    });
    setFormError('');
    setEditId(loc.id);
    setModal('edit');
  };

  const closeModal = () => { setModal(null); setEditId(null); setFormError(''); };

  const toggleDay = (day: string) => {
    setForm(f => ({
      ...f,
      service_days: f.service_days.includes(day)
        ? f.service_days.filter(d => d !== day)
        : [...f.service_days, day],
    }));
  };

  const handleNameChange = (name: string) => {
    setForm(f => ({ ...f, name, ...(modal === 'create' ? { slug: slugify(name) } : {}) }));
  };

  const save = async () => {
    if (!form.name.trim()) { setFormError('Name is required'); return; }
    if (!form.slug.trim()) { setFormError('Slug is required'); return; }
    setSaving(true); setFormError('');
    try {
      // Backend expects HH:MM:SS format
      const toHMS = (t: string) => t.length === 5 ? `${t}:00` : t;
      const payload = {
        ...form,
        address_line1: form.address_line1 || null,
        address_line2: form.address_line2 || null,
        city: form.city || null,
        state: form.state || null,
        postal_code: form.postal_code || null,
        phone: form.phone || null,
        windowA_start: toHMS(form.windowA_start),
        windowA_end: toHMS(form.windowA_end),
        windowB_start: toHMS(form.windowB_start),
        windowB_end: toHMS(form.windowB_end),
      };
      if (modal === 'create') {
        await api('/locations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        setSuccess('Location created');
      } else {
        await api(`/locations/${editId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        setSuccess('Location updated');
      }
      closeModal();
      await load();
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setFormError((err as ApiError).message || 'Save failed');
    } finally { setSaving(false); }
  };

  if (!requireRole(['admin'])) return <div className="page"><p>Unauthorized</p></div>;

  return (
    <>
      <style>{styles}</style>
      <div className="page loc-page">
        <div className="loc-top">
          <div>
            <h1>Locations</h1>
            <p style={{ color: 'var(--gray-500)', marginTop: 2 }}>Delivery locations for your organization</p>
          </div>
          <button className="btn btn-primary btn-sm" onClick={openCreate}>+ Add Location</button>
        </div>

        {error && <div className="alert alert-error" style={{ marginBottom: 12 }}><span>⚠</span> {error}</div>}
        {success && <div className="alert alert-success" style={{ marginBottom: 12 }}><span>✓</span> {success}</div>}

        {loading && <div style={{ textAlign: 'center', padding: 40 }}><div className="spinner spinner-lg" style={{ margin: '0 auto' }} /></div>}

        {!loading && locations.length === 0 && (
          <div className="card card-padded" style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--gray-400)' }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>📍</div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>No locations yet</div>
            <div style={{ fontSize: 14, marginTop: 4 }}>Add your first location to get started</div>
          </div>
        )}

        {!loading && locations.length > 0 && (
          <div className="loc-list">
            {locations.map(loc => (
              <div key={loc.id} className={`card loc-card${!loc.is_active ? ' loc-inactive' : ''}`}>
                <div className="loc-card-inner">
                  <div className="loc-card-left">
                    <div className="loc-name-row">
                      <span className="loc-name">{loc.name}</span>
                      <span className={`pill ${loc.is_active ? 'pill-green' : 'pill-gray'}`}>
                        <span className="pill-dot" />{loc.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                    <div className="loc-slug">/{loc.slug}</div>
                    {(loc.address_line1 || loc.city) && (
                      <div className="loc-addr">
                        {[loc.address_line1, loc.city, loc.state].filter(Boolean).join(', ')}
                      </div>
                    )}
                  </div>
                  <div className="loc-meta">
                    <div className="loc-meta-item">
                      <span className="loc-meta-label">Capacity</span>
                      <span className="loc-meta-val">{loc.capacity_per_window} / window</span>
                    </div>
                    <div className="loc-meta-item">
                      <span className="loc-meta-label">Days</span>
                      <span className="loc-meta-val">
                        {(loc.service_days || []).map(d => d.charAt(0).toUpperCase() + d.slice(1)).join(', ') || '—'}
                      </span>
                    </div>
                    <div className="loc-meta-item">
                      <span className="loc-meta-label">Timezone</span>
                      <span className="loc-meta-val">{loc.timezone}</span>
                    </div>
                  </div>
                  <button className="btn btn-secondary btn-sm loc-edit-btn" onClick={() => openEdit(loc)}>
                    Edit
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {modal && (
        <div className="loc-backdrop" onClick={closeModal}>
          <div className="loc-modal card" onClick={e => e.stopPropagation()}>
            <div className="loc-modal-head">
              <span className="loc-modal-title">{modal === 'create' ? 'Add Location' : 'Edit Location'}</span>
              <button className="loc-modal-close" onClick={closeModal}>✕</button>
            </div>

            <div className="loc-modal-body">
              {formError && <div className="alert alert-error" style={{ marginBottom: 12 }}><span>⚠</span> {formError}</div>}

              <div className="loc-section-label">Basic Info</div>
              <div className="loc-grid-2">
                <div className="form-group">
                  <label className="form-label">Name <span style={{ color: 'var(--red-500)' }}>*</span></label>
                  <input value={form.name} onChange={e => handleNameChange(e.target.value)} placeholder="East Meadow" />
                </div>
                <div className="form-group">
                  <label className="form-label">Slug <span style={{ color: 'var(--red-500)' }}>*</span></label>
                  <input value={form.slug} onChange={e => setForm(f => ({ ...f, slug: e.target.value }))} placeholder="east-meadow" />
                </div>
              </div>
              <div className="form-group" style={{ marginTop: 8 }}>
                <label className="form-label">Timezone</label>
                <select value={form.timezone} onChange={e => setForm(f => ({ ...f, timezone: e.target.value }))}>
                  <optgroup label="United States">
                    <option value="America/New_York">Eastern — New York</option>
                    <option value="America/Chicago">Central — Chicago</option>
                    <option value="America/Denver">Mountain — Denver</option>
                    <option value="America/Los_Angeles">Pacific — Los Angeles</option>
                    <option value="America/Phoenix">Mountain (no DST) — Phoenix</option>
                    <option value="America/Anchorage">Alaska — Anchorage</option>
                    <option value="Pacific/Honolulu">Hawaii — Honolulu</option>
                  </optgroup>
                </select>
              </div>
              <div className="loc-toggle-row" style={{ marginTop: 12 }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>Active</div>
                  <div className="form-hint">Inactive locations are hidden from dispatchers</div>
                </div>
                <label className="toggle">
                  <input type="checkbox" checked={form.is_active} onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))} />
                  <span className="toggle-slider" />
                </label>
              </div>

              <div className="loc-section-label" style={{ marginTop: 20 }}>Address</div>
              <div className="form-group">
                <label className="form-label">Street</label>
                <input value={form.address_line1} onChange={e => setForm(f => ({ ...f, address_line1: e.target.value }))} placeholder="123 Main St" />
              </div>
              <div className="loc-grid-3" style={{ marginTop: 8 }}>
                <div className="form-group">
                  <label className="form-label">City</label>
                  <input value={form.city} onChange={e => setForm(f => ({ ...f, city: e.target.value }))} placeholder="Boston" />
                </div>
                <div className="form-group">
                  <label className="form-label">State</label>
                  <input value={form.state} onChange={e => setForm(f => ({ ...f, state: e.target.value }))} placeholder="MA" maxLength={2} style={{ textTransform: 'uppercase' }} />
                </div>
                <div className="form-group">
                  <label className="form-label">ZIP</label>
                  <input value={form.postal_code} onChange={e => setForm(f => ({ ...f, postal_code: e.target.value }))} placeholder="11554" />
                </div>
              </div>
              <div className="form-group" style={{ marginTop: 8 }}>
                <label className="form-label">Phone</label>
                <input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} placeholder="(555) 555-0100" />
              </div>

              <div className="loc-section-label" style={{ marginTop: 20 }}>Capacity & Schedule</div>
              <div className="form-group">
                <label className="form-label">Loads per window</label>
                <input type="number" min={1} max={99} value={form.capacity_per_window}
                  onChange={e => setForm(f => ({ ...f, capacity_per_window: parseInt(e.target.value) || 1 }))}
                  style={{ maxWidth: 100 }} />
              </div>
              <div className="form-group" style={{ marginTop: 12 }}>
                <label className="form-label">Service Days</label>
                <div className="loc-day-row">
                  {WEEKDAYS.map(d => (
                    <button key={d.key} type="button"
                      className={`loc-day-btn${form.service_days.includes(d.key) ? ' active' : ''}`}
                      onClick={() => toggleDay(d.key)}>
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>
              <div style={{ marginTop: 12 }}>
                <div className="loc-win-label">Window A — Morning</div>
                <div className="loc-grid-2">
                  <div className="form-group">
                    <label className="form-label">Start</label>
                    <input type="time" value={form.windowA_start} onChange={e => setForm(f => ({ ...f, windowA_start: e.target.value }))} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">End</label>
                    <input type="time" value={form.windowA_end} onChange={e => setForm(f => ({ ...f, windowA_end: e.target.value }))} />
                  </div>
                </div>
              </div>
              <div style={{ marginTop: 8 }}>
                <div className="loc-win-label">Window B — Afternoon</div>
                <div className="loc-grid-2">
                  <div className="form-group">
                    <label className="form-label">Start</label>
                    <input type="time" value={form.windowB_start} onChange={e => setForm(f => ({ ...f, windowB_start: e.target.value }))} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">End</label>
                    <input type="time" value={form.windowB_end} onChange={e => setForm(f => ({ ...f, windowB_end: e.target.value }))} />
                  </div>
                </div>
              </div>
            </div>

            <div className="loc-modal-foot">
              <button className="btn btn-ghost" onClick={closeModal}>Cancel</button>
              <button className="btn btn-primary" onClick={save} disabled={saving}>
                {saving ? 'Saving…' : modal === 'create' ? 'Create Location' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const styles = `
  .loc-page { max-width: 800px; padding-bottom: 80px; }
  .loc-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 24px; }
  .loc-top h1 { font-size: 28px; font-weight: 800; letter-spacing: -0.02em; margin: 0; }

  .loc-list { display: flex; flex-direction: column; gap: 12px; }
  .loc-card { transition: box-shadow 0.15s; }
  .loc-inactive { opacity: 0.55; }
  .loc-card-inner { display: flex; align-items: center; gap: 20px; padding: 20px 24px; flex-wrap: wrap; }

  .loc-card-left { flex: 1; min-width: 180px; }
  .loc-name-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .loc-name { font-family: var(--font-heading); font-size: 16px; font-weight: 700; color: var(--gray-900); }
  .loc-slug { font-size: 12px; color: var(--gray-400); font-family: monospace; margin-top: 3px; }
  .loc-addr { font-size: 13px; color: var(--gray-500); margin-top: 4px; }

  .loc-meta { display: flex; gap: 24px; flex-wrap: wrap; }
  .loc-meta-item { display: flex; flex-direction: column; gap: 2px; }
  .loc-meta-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--gray-400); }
  .loc-meta-val { font-size: 13px; font-weight: 600; color: var(--gray-700); }
  .loc-edit-btn { flex-shrink: 0; }

  /* Modal */
  .loc-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 400; display: flex; align-items: center; justify-content: center; padding: 16px; }
  .loc-modal { width: 100%; max-width: 560px; max-height: 90vh; display: flex; flex-direction: column; border-radius: var(--radius-xl); overflow: hidden; }
  .loc-modal-head { display: flex; align-items: center; justify-content: space-between; padding: 18px 24px; border-bottom: 1px solid var(--border-light); flex-shrink: 0; }
  .loc-modal-title { font-family: var(--font-heading); font-size: 16px; font-weight: 700; }
  .loc-modal-close { background: none; border: none; font-size: 16px; color: var(--gray-400); cursor: pointer; padding: 4px; line-height: 1; }
  .loc-modal-close:hover { color: var(--gray-700); }
  .loc-modal-body { padding: 20px 24px; overflow-y: auto; flex: 1; }
  .loc-modal-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 16px 24px; border-top: 1px solid var(--border-light); flex-shrink: 0; }

  .loc-section-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--gray-400); margin-bottom: 10px; }
  .loc-toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .loc-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .loc-grid-3 { display: grid; grid-template-columns: 1fr 72px 96px; gap: 10px; }
  @media (max-width: 480px) { .loc-grid-2 { grid-template-columns: 1fr; } .loc-grid-3 { grid-template-columns: 1fr 1fr; } }

  .loc-day-row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
  .loc-day-btn { padding: 7px 13px; border: 2px solid var(--border); border-radius: var(--radius-md); background: var(--surface); font-family: inherit; font-size: 13px; font-weight: 600; color: var(--gray-500); cursor: pointer; transition: all 0.12s; }
  .loc-day-btn:hover { border-color: var(--gray-300); }
  .loc-day-btn.active { border-color: var(--green-400); background: var(--green-50); color: var(--green-700); }
  .loc-win-label { font-size: 13px; font-weight: 700; color: var(--gray-600); margin-bottom: 8px; }
`;
