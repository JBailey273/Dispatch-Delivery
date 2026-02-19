'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, requireRole } from '../../lib/auth';

const WEEKDAYS = [
  { key: 'mon', label: 'Mon' }, { key: 'tue', label: 'Tue' }, { key: 'wed', label: 'Wed' },
  { key: 'thu', label: 'Thu' }, { key: 'fri', label: 'Fri' }, { key: 'sat', label: 'Sat' }, { key: 'sun', label: 'Sun' },
];
const AGGRESSIVENESS = ['low', 'medium', 'high'];

export default function TenantSettingsPage() {
  const [form, setForm] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api('/tenant/settings');
      setForm(data);
    } catch (err) { setError((err as ApiError).message || 'Failed to load settings'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleDay = (day: string) => {
    const days = form.service_days || [];
    setForm({ ...form, service_days: days.includes(day) ? days.filter((d: string) => d !== day) : [...days, day] });
  };

  const save = async () => {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      await api('/tenant/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      setSuccess('Settings saved successfully');
    } catch (err) { setError((err as ApiError).message || 'Save failed'); }
    finally { setSaving(false); }
  };

  if (!requireRole(['admin'])) return <div className="page"><p>Unauthorized</p></div>;

  return (
    <>
      <style>{styles}</style>
      <div className="page ts-page">
        <div className="ts-top">
          <div>
            <h1>Tenant Settings</h1>
            <p style={{ color: 'var(--gray-500)', marginTop: 2 }}>Organization-wide configuration</p>
          </div>
        </div>

        {error && <div className="alert alert-error" style={{ marginBottom: 12 }}><span>⚠</span> {error}</div>}
        {success && <div className="alert alert-success" style={{ marginBottom: 12 }}><span>✓</span> {success}</div>}

        {loading && <div style={{ textAlign: 'center', padding: 40 }}><div className="spinner spinner-lg" style={{ margin: '0 auto' }} /></div>}

        {!loading && form && (
          <div className="ts-sections">
            {/* General */}
            <div className="card ts-section">
              <div className="ts-section-head"><span className="ts-section-icon">🏢</span><span className="ts-section-title">General</span></div>
              <div className="ts-section-body">
                <div className="ts-grid-2">
                  <div className="form-group">
                    <label className="form-label">Organization Name</label>
                    <input value={form.name || ''} onChange={e => setForm({ ...form, name: e.target.value })} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Slug</label>
                    <input value={form.slug || ''} disabled style={{ opacity: 0.5 }} />
                    <span className="form-hint">Cannot be changed after creation</span>
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">Timezone</label>
                  <input value={form.timezone || ''} onChange={e => setForm({ ...form, timezone: e.target.value })} placeholder="America/Chicago" />
                  <span className="form-hint">IANA timezone (e.g. America/New_York)</span>
                </div>
              </div>
            </div>

            {/* Service Schedule */}
            <div className="card ts-section">
              <div className="ts-section-head"><span className="ts-section-icon">📅</span><span className="ts-section-title">Service Schedule</span></div>
              <div className="ts-section-body">
                <div className="form-group">
                  <label className="form-label">Service Days</label>
                  <div className="ts-day-row">
                    {WEEKDAYS.map(d => (
                      <button
                        key={d.key}
                        type="button"
                        className={`ts-day-btn${(form.service_days || []).includes(d.key) ? ' active' : ''}`}
                        onClick={() => toggleDay(d.key)}
                      >
                        {d.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="form-group" style={{ marginTop: 16 }}>
                  <label className="form-label">Capacity per Window</label>
                  <input type="number" min={1} value={form.capacity_per_window || ''} onChange={e => setForm({ ...form, capacity_per_window: parseInt(e.target.value) || 1 })} style={{ maxWidth: 160 }} />
                  <span className="form-hint">Maximum truck loads per delivery window</span>
                </div>
              </div>
            </div>

            {/* Windows */}
            <div className="card ts-section">
              <div className="ts-section-head"><span className="ts-section-icon">🕐</span><span className="ts-section-title">Delivery Windows</span></div>
              <div className="ts-section-body">
                <div className="ts-win-group">
                  <div className="ts-win-label">Window A (Morning)</div>
                  <div className="ts-grid-2">
                    <div className="form-group">
                      <label className="form-label">Start</label>
                      <input type="time" value={form.windowA_start || ''} onChange={e => setForm({ ...form, windowA_start: e.target.value })} />
                    </div>
                    <div className="form-group">
                      <label className="form-label">End</label>
                      <input type="time" value={form.windowA_end || ''} onChange={e => setForm({ ...form, windowA_end: e.target.value })} />
                    </div>
                  </div>
                </div>
                <div className="ts-win-group" style={{ marginTop: 16 }}>
                  <div className="ts-win-label">Window B (Afternoon)</div>
                  <div className="ts-grid-2">
                    <div className="form-group">
                      <label className="form-label">Start</label>
                      <input type="time" value={form.windowB_start || ''} onChange={e => setForm({ ...form, windowB_start: e.target.value })} />
                    </div>
                    <div className="form-group">
                      <label className="form-label">End</label>
                      <input type="time" value={form.windowB_end || ''} onChange={e => setForm({ ...form, windowB_end: e.target.value })} />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Optimization */}
            <div className="card ts-section">
              <div className="ts-section-head"><span className="ts-section-icon">⚙️</span><span className="ts-section-title">Optimization</span></div>
              <div className="ts-section-body">
                <div className="ts-toggle-row">
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>Route Reordering</div>
                    <div className="form-hint">Allow optimizer to reorder loads within a window</div>
                  </div>
                  <label className="toggle">
                    <input type="checkbox" checked={form.optimization_reordering_enabled ?? true} onChange={e => setForm({ ...form, optimization_reordering_enabled: e.target.checked })} />
                    <span className="toggle-slider" />
                  </label>
                </div>
                <div className="ts-toggle-row">
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>Driver Reassignment</div>
                    <div className="form-hint">Allow optimizer to reassign loads between drivers</div>
                  </div>
                  <label className="toggle">
                    <input type="checkbox" checked={form.optimization_reassignment_enabled ?? true} onChange={e => setForm({ ...form, optimization_reassignment_enabled: e.target.checked })} />
                    <span className="toggle-slider" />
                  </label>
                </div>
                <div className="ts-toggle-row">
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>Drop Splitting</div>
                    <div className="form-hint">Allow splitting multi-load drops across windows</div>
                  </div>
                  <label className="toggle">
                    <input type="checkbox" checked={form.optimization_drop_split_enabled ?? false} onChange={e => setForm({ ...form, optimization_drop_split_enabled: e.target.checked })} />
                    <span className="toggle-slider" />
                  </label>
                </div>
                <div className="form-group" style={{ marginTop: 16 }}>
                  <label className="form-label">Aggressiveness</label>
                  <div className="ts-agg-row">
                    {AGGRESSIVENESS.map(a => (
                      <button
                        key={a}
                        type="button"
                        className={`ts-agg-btn${form.optimization_aggressiveness === a ? ' active' : ''}`}
                        onClick={() => setForm({ ...form, optimization_aggressiveness: a })}
                      >
                        {a.charAt(0).toUpperCase() + a.slice(1)}
                      </button>
                    ))}
                  </div>
                  <span className="form-hint">How aggressively the optimizer proposes changes</span>
                </div>
              </div>
            </div>

            {/* Save bar */}
            <div className="ts-save-bar">
              <div className="alert alert-info" style={{ flex: 1, margin: 0, fontSize: 13 }}>
                <span>ℹ️</span> Changes apply to future scheduling only and affect all dispatchers and channels.
              </div>
              <button className="btn btn-primary btn-lg" onClick={save} disabled={saving}>
                {saving ? 'Saving…' : 'Save Settings'}
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

const styles = `
  .ts-page { max-width: 680px; padding-bottom: 100px; }
  .ts-top { margin-bottom: 20px; }
  .ts-top h1 { font-size: 28px; font-weight: 800; letter-spacing: -0.02em; margin: 0; }

  .ts-sections { display: flex; flex-direction: column; gap: 16px; }
  .ts-section-head { display: flex; align-items: center; gap: 10px; padding: 16px 20px; border-bottom: 1px solid var(--border-light); }
  .ts-section-icon { font-size: 18px; }
  .ts-section-title { font-size: 15px; font-weight: 700; color: var(--gray-800); }
  .ts-section-body { padding: 20px; display: flex; flex-direction: column; gap: 0; }
  .ts-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 500px) { .ts-grid-2 { grid-template-columns: 1fr; } }

  .ts-day-row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
  .ts-day-btn { padding: 8px 16px; border: 2px solid var(--border); border-radius: var(--radius-md); background: var(--surface); font-family: inherit; font-size: 13px; font-weight: 600; color: var(--gray-500); cursor: pointer; transition: all 0.12s; }
  .ts-day-btn:hover { border-color: var(--gray-300); }
  .ts-day-btn.active { border-color: var(--green-400); background: var(--green-50); color: var(--green-700); }

  .ts-win-label { font-size: 14px; font-weight: 700; color: var(--gray-700); margin-bottom: 8px; }

  .ts-toggle-row { display: flex; align-items: center; gap: 16px; padding: 12px 0; border-bottom: 1px solid var(--border-light); }
  .ts-toggle-row:last-of-type { border-bottom: none; }

  .ts-agg-row { display: flex; gap: 6px; margin-top: 4px; }
  .ts-agg-btn { flex: 1; padding: 10px; border: 2px solid var(--border); border-radius: var(--radius-md); background: var(--surface); font-family: inherit; font-size: 14px; font-weight: 600; color: var(--gray-500); cursor: pointer; transition: all 0.12s; text-align: center; }
  .ts-agg-btn:hover { border-color: var(--gray-300); }
  .ts-agg-btn.active { border-color: var(--green-400); background: var(--green-50); color: var(--green-700); }

  .ts-save-bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 8px; }
  @media (max-width: 600px) { .ts-save-bar { flex-direction: column; align-items: stretch; } }
`;
