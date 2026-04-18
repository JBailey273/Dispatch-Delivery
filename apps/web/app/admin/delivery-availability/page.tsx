'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, requireRole } from '../../lib/auth';

// ── Types ────────────────────────────────────────────────────────────────────

type Blackout = {
  id: string;
  service_date: string;
  window_code: string | null;
  reason_code: string;
  reason_note: string | null;
  active: boolean;
  location_id: string;
};

type CapacityOverride = {
  id: string;
  location_id: string;
  start_date: string;
  end_date: string;
  window_a_capacity: number;
  window_b_capacity: number;
  label: string | null;
  created_at: string;
};

type BaseCapacity = {
  location_id: string;
  location_name: string;
  capacity_per_window: number;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseLocalDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtDateShort(s: string): string {
  const d = parseLocalDate(s);
  return `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`;
}

function fmtDateFull(s: string): string {
  const d = parseLocalDate(s);
  return `${DAYS[d.getDay()]}, ${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

const REASON_LABELS: Record<string, string> = {
  weather: 'Weather',
  equipment: 'Equipment',
  staffing: 'Staffing',
  other: 'Other',
};

// ── Main Component ────────────────────────────────────────────────────────────

export default function DeliveryAvailabilityPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [blackouts, setBlackouts] = useState<Blackout[]>([]);
  const [overrides, setOverrides] = useState<CapacityOverride[]>([]);
  const [baseCap, setBaseCap] = useState<BaseCapacity | null>(null);

  // Calendar state
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [calMonth, setCalMonth] = useState(today.getMonth());
  const [calYear, setCalYear] = useState(today.getFullYear());

  // Blackout modal
  const [blackoutModal, setBlackoutModal] = useState<{ date: string; existingId: string | null } | null>(null);
  const [blackoutReason, setBlackoutReason] = useState('other');
  const [blackoutNote, setBlackoutNote] = useState('');
  const [blackoutSaving, setBlackoutSaving] = useState(false);

  // Override modal
  const [overrideModal, setOverrideModal] = useState(false);
  const [overrideForm, setOverrideForm] = useState({
    start_date: '',
    end_date: '',
    window_a_capacity: '',
    window_b_capacity: '',
    label: '',
  });
  const [overrideSaving, setOverrideSaving] = useState(false);
  const [overrideError, setOverrideError] = useState('');

  // Base capacity editing
  const [editingBase, setEditingBase] = useState(false);
  const [baseCapInput, setBaseCapInput] = useState('');
  const [baseSaving, setBaseSaving] = useState(false);

  // Window DOW rules
  // Python weekday: 0=Mon,1=Tue,2=Wed,3=Thu,4=Fri,5=Sat,6=Sun
  type DowRules = { A: { disabled_days: number[] }; B: { disabled_days: number[] } };
  const [dowRules, setDowRules] = useState<DowRules>({ A: { disabled_days: [] }, B: { disabled_days: [] } });
  const [dowSaving, setDowSaving] = useState(false);

  // ── Data loading ────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const today = new Date();
      const start = toDateStr(today);
      const end = toDateStr(addDays(today, 90));
      const [blackoutsData, overridesData, baseCapData] = await Promise.all([
        api(`/admin/blackouts?start_date=${start}&end_date=${end}`),
        api('/admin/capacity-overrides'),
        api('/admin/base-capacity'),
      ]);
      setBlackouts(blackoutsData.blackouts || []);
      setOverrides(overridesData.overrides || []);
      setBaseCap(baseCapData);
      setBaseCapInput(String(baseCapData.capacity_per_window));
      // Load window DOW rules from location
      if (baseCapData.location_id) {
        try {
          const locData = await api(`/locations/${baseCapData.location_id}`);
          const rules = locData.window_dow_rules || { A: { disabled_days: [] }, B: { disabled_days: [] } };
          setDowRules(rules);
        } catch { /* silent — rules default to no disabled days */ }
      }
    } catch (err) {
      setError((err as ApiError).message || 'Failed to load availability data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Calendar helpers ────────────────────────────────────────────────────────

  function getCalendarDays(): (Date | null)[] {
    const first = new Date(calYear, calMonth, 1);
    const last = new Date(calYear, calMonth + 1, 0);
    const days: (Date | null)[] = [];
    for (let i = 0; i < first.getDay(); i++) days.push(null);
    for (let i = 1; i <= last.getDate(); i++) days.push(new Date(calYear, calMonth, i));
    return days;
  }

  function isBlackedOut(dateStr: string): boolean {
    return blackouts.some(b => b.service_date === dateStr && b.active && b.window_code === null);
  }

  function getBlackout(dateStr: string): Blackout | null {
    return blackouts.find(b => b.service_date === dateStr && b.active && b.window_code === null) || null;
  }

  function getOverrideForDate(dateStr: string): CapacityOverride | null {
    const d = parseLocalDate(dateStr);
    // Last-created wins
    const matches = overrides
      .filter(o => parseLocalDate(o.start_date) <= d && parseLocalDate(o.end_date) >= d)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return matches[0] || null;
  }

  function isPast(d: Date): boolean {
    return d < today;
  }

  // ── Blackout actions ────────────────────────────────────────────────────────

  function openBlackoutModal(dateStr: string) {
    const existing = getBlackout(dateStr);
    setBlackoutModal({ date: dateStr, existingId: existing?.id || null });
    setBlackoutReason(existing?.reason_code || 'other');
    setBlackoutNote(existing?.reason_note || '');
  }

  async function saveBlackout() {
    if (!blackoutModal) return;
    setBlackoutSaving(true);
    try {
      await api('/admin/blackouts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          service_date: blackoutModal.date,
          window_code: null,
          reason_code: blackoutReason,
          reason_note: blackoutNote || null,
        }),
      });
      setSuccess(`${fmtDateFull(blackoutModal.date)} blocked`);
      setBlackoutModal(null);
      await load();
      setTimeout(() => setSuccess(''), 4000);
    } catch (err) {
      setError((err as ApiError).message || 'Failed to block date');
    } finally {
      setBlackoutSaving(false);
    }
  }

  async function unblockDate(id: string, dateStr: string) {
    try {
      await api(`/admin/blackouts/${id}`, { method: 'DELETE' });
      setSuccess(`${fmtDateShort(dateStr)} unblocked`);
      await load();
      setBlackoutModal(null);
      setTimeout(() => setSuccess(''), 4000);
    } catch (err) {
      setError((err as ApiError).message || 'Failed to unblock date');
    }
  }

  async function blockAllSundays() {
    if (!confirm('Block all Sundays in the next 90 days?')) return;
    const d = new Date();
    const promises = [];
    for (let i = 0; i < 90; i++) {
      const check = addDays(d, i);
      if (check.getDay() === 0) {
        const ds = toDateStr(check);
        if (!isBlackedOut(ds)) {
          promises.push(
            api('/admin/blackouts', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ service_date: ds, window_code: null, reason_code: 'other', reason_note: 'No Sunday deliveries' }),
            })
          );
        }
      }
    }
    try {
      await Promise.all(promises);
      setSuccess(`Blocked ${promises.length} Sunday${promises.length !== 1 ? 's' : ''}`);
      await load();
      setTimeout(() => setSuccess(''), 4000);
    } catch (err) {
      setError('Some Sundays could not be blocked');
    }
  }

  async function unblockAllSundays() {
    const sundays = blackouts.filter(b => {
      const d = parseLocalDate(b.service_date);
      return d.getDay() === 0 && b.active && b.window_code === null;
    });
    if (!sundays.length) { setSuccess('No blocked Sundays to unblock'); return; }
    if (!confirm(`Unblock ${sundays.length} Sunday${sundays.length !== 1 ? 's' : ''}?`)) return;
    try {
      await Promise.all(sundays.map(b => api(`/admin/blackouts/${b.id}`, { method: 'DELETE' })));
      setSuccess(`Unblocked ${sundays.length} Sunday${sundays.length !== 1 ? 's' : ''}`);
      await load();
      setTimeout(() => setSuccess(''), 4000);
    } catch (err) {
      setError('Some Sundays could not be unblocked');
    }
  }

  // ── Capacity override actions ───────────────────────────────────────────────

  async function saveOverride() {
    setOverrideError('');
    const { start_date, end_date, window_a_capacity, window_b_capacity } = overrideForm;
    if (!start_date || !end_date) { setOverrideError('Start and end date are required'); return; }
    if (end_date < start_date) { setOverrideError('End date must be on or after start date'); return; }
    const a = parseInt(window_a_capacity);
    const b = parseInt(window_b_capacity);
    if (isNaN(a) || a < 0) { setOverrideError('Morning capacity must be a non-negative number'); return; }
    if (isNaN(b) || b < 0) { setOverrideError('Afternoon capacity must be a non-negative number'); return; }

    setOverrideSaving(true);
    try {
      await api('/admin/capacity-overrides', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start_date,
          end_date,
          window_a_capacity: a,
          window_b_capacity: b,
          label: overrideForm.label || null,
        }),
      });
      setSuccess('Capacity override saved');
      setOverrideModal(false);
      setOverrideForm({ start_date: '', end_date: '', window_a_capacity: '', window_b_capacity: '', label: '' });
      await load();
      setTimeout(() => setSuccess(''), 4000);
    } catch (err) {
      setOverrideError((err as ApiError).message || 'Failed to save override');
    } finally {
      setOverrideSaving(false);
    }
  }

  async function deleteOverride(id: string) {
    if (!confirm('Remove this capacity override? Dates in this range will revert to base capacity.')) return;
    try {
      await api(`/admin/capacity-overrides/${id}`, { method: 'DELETE' });
      setSuccess('Override removed');
      await load();
      setTimeout(() => setSuccess(''), 4000);
    } catch (err) {
      setError((err as ApiError).message || 'Failed to remove override');
    }
  }

  // ── Base capacity ───────────────────────────────────────────────────────────

  async function saveBaseCapacity() {
    const val = parseInt(baseCapInput);
    if (isNaN(val) || val < 1) { setError('Capacity must be at least 1'); return; }
    setBaseSaving(true);
    try {
      await api('/admin/base-capacity', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ capacity_per_window: val }),
      });
      setSuccess('Base capacity updated');
      setEditingBase(false);
      await load();
      setTimeout(() => setSuccess(''), 4000);
    } catch (err) {
      setError((err as ApiError).message || 'Failed to update base capacity');
    } finally {
      setBaseSaving(false);
    }
  }

  // ── Window DOW rules ────────────────────────────────────────────────────────

  // DOW_LABELS uses Python weekday order: 0=Mon … 5=Sat, 6=Sun
  const DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  function toggleDow(window: 'A' | 'B', day: number) {
    setDowRules(prev => {
      const current = prev[window].disabled_days;
      const next = current.includes(day) ? current.filter(d => d !== day) : [...current, day];
      return { ...prev, [window]: { disabled_days: next } };
    });
  }

  async function saveDowRules() {
    if (!baseCap?.location_id) return;
    setDowSaving(true);
    try {
      await api(`/locations/${baseCap.location_id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ window_dow_rules: dowRules }),
      });
      setSuccess('Window schedule saved');
      setTimeout(() => setSuccess(''), 4000);
    } catch (err) {
      setError((err as ApiError).message || 'Failed to save window schedule');
    } finally {
      setDowSaving(false);
    }
  }

  // ── Sunday detection ────────────────────────────────────────────────────────

  const blockedSundayCount = blackouts.filter(b => {
    const d = parseLocalDate(b.service_date);
    return d.getDay() === 0 && b.active && b.window_code === null;
  }).length;

  // ── Auth guard ──────────────────────────────────────────────────────────────

  if (!requireRole(['admin'])) return <div className="page"><p>Unauthorized</p></div>;

  const calDays = getCalendarDays();

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <>
      <style>{styles}</style>
      <div className="page av-page">

        {/* Header */}
        <div className="av-top">
          <div>
            <h1>Delivery Availability</h1>
            <p className="av-subtitle">Control which dates are open for delivery and how many orders each window accepts</p>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={load} disabled={loading}>↻ Refresh</button>
        </div>

        {error && (
          <div className="alert alert-error" style={{ marginBottom: 16 }}>
            <span>⚠</span> {error}
            <button className="btn btn-ghost btn-sm" onClick={() => setError('')} style={{ marginLeft: 'auto' }}>✕</button>
          </div>
        )}
        {success && (
          <div className="alert alert-success" style={{ marginBottom: 16 }}>
            <span>✓</span> {success}
            <button className="btn btn-ghost btn-sm" onClick={() => setSuccess('')} style={{ marginLeft: 'auto' }}>✕</button>
          </div>
        )}

        {loading && (
          <div style={{ textAlign: 'center', padding: 60 }}>
            <div className="spinner spinner-lg" style={{ margin: '0 auto' }} />
          </div>
        )}

        {!loading && (
          <div className="av-grid">

            {/* ── LEFT COLUMN ── */}
            <div className="av-left">

              {/* Base Capacity */}
              <div className="card av-section">
                <div className="av-section-head">
                  <div>
                    <div className="av-section-title">Base Capacity</div>
                    <div className="av-section-sub">Default slots per window when no override is active</div>
                  </div>
                </div>
                {baseCap && (
                  <div className="av-base-row">
                    <div className="av-base-windows">
                      <div className="av-window-badge av-window-am">
                        <span className="av-window-label">Morning</span>
                        <span className="av-window-val">{baseCap.capacity_per_window}</span>
                        <span className="av-window-unit">slots</span>
                      </div>
                      <div className="av-window-badge av-window-pm">
                        <span className="av-window-label">Afternoon</span>
                        <span className="av-window-val">{baseCap.capacity_per_window}</span>
                        <span className="av-window-unit">slots</span>
                      </div>
                    </div>
                    {!editingBase ? (
                      <button className="btn btn-ghost btn-sm" onClick={() => { setEditingBase(true); setBaseCapInput(String(baseCap.capacity_per_window)); }}>
                        Edit
                      </button>
                    ) : (
                      <div className="av-base-edit">
                        <div className="av-base-edit-row">
                          <label className="form-label" style={{ margin: 0, whiteSpace: 'nowrap' }}>Slots per window</label>
                          <input
                            className="form-input"
                            type="number"
                            min={1}
                            style={{ width: 80 }}
                            value={baseCapInput}
                            onChange={e => setBaseCapInput(e.target.value)}
                          />
                        </div>
                        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                          <button className="btn btn-primary btn-sm" onClick={saveBaseCapacity} disabled={baseSaving}>
                            {baseSaving ? 'Saving…' : 'Save'}
                          </button>
                          <button className="btn btn-ghost btn-sm" onClick={() => setEditingBase(false)}>Cancel</button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Window Schedule Rules */}
              <div className="card av-section">
                <div className="av-section-head">
                  <div>
                    <div className="av-section-title">Window Schedule</div>
                    <div className="av-section-sub">Disable a delivery window on specific days of the week</div>
                  </div>
                </div>
                <div className="av-dow-grid">
                  {(['A', 'B'] as const).map(win => (
                    <div key={win} className="av-dow-row">
                      <div className={`av-dow-window-label ${win === 'A' ? 'av-dow-am' : 'av-dow-pm'}`}>
                        {win === 'A' ? '🌅 Morning' : '🌆 Afternoon'}
                      </div>
                      <div className="av-dow-toggles">
                        {DOW_LABELS.map((label, idx) => {
                          const disabled = dowRules[win].disabled_days.includes(idx);
                          return (
                            <button
                              key={idx}
                              className={`av-dow-btn${disabled ? ' av-dow-btn--off' : ' av-dow-btn--on'}`}
                              onClick={() => toggleDow(win, idx)}
                              title={disabled ? `${label}: disabled` : `${label}: enabled`}
                            >
                              {label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
                  <button className="btn btn-primary btn-sm" onClick={saveDowRules} disabled={dowSaving}>
                    {dowSaving ? 'Saving…' : 'Save Schedule'}
                  </button>
                  <span style={{ fontSize: 12, color: 'var(--gray-400)' }}>
                    Green = open · Red = closed
                  </span>
                </div>
              </div>

              {/* Capacity Overrides */}
              <div className="card av-section">
                <div className="av-section-head">
                  <div>
                    <div className="av-section-title">Capacity Overrides</div>
                    <div className="av-section-sub">Boost or reduce capacity for a specific date range</div>
                  </div>
                  <button className="btn btn-primary btn-sm" onClick={() => { setOverrideModal(true); setOverrideError(''); }}>
                    + Add Override
                  </button>
                </div>

                {overrides.length === 0 ? (
                  <div className="av-empty">
                    <span>No overrides set — all dates use base capacity</span>
                  </div>
                ) : (
                  <div className="av-override-list">
                    {overrides.map(o => {
                      const isActive = parseLocalDate(o.start_date) <= today && parseLocalDate(o.end_date) >= today;
                      const isUpcoming = parseLocalDate(o.start_date) > today;
                      const isPastOverride = parseLocalDate(o.end_date) < today;
                      return (
                        <div key={o.id} className={`av-override-card${isActive ? ' av-override-active' : ''}${isPastOverride ? ' av-override-past' : ''}`}>
                          <div className="av-override-top">
                            <div className="av-override-dates">
                              {fmtDateShort(o.start_date)} – {fmtDateShort(o.end_date)}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              {isActive && <span className="pill pill-green" style={{ fontSize: 11 }}><span className="pill-dot" />Active</span>}
                              {isUpcoming && <span className="pill pill-gray" style={{ fontSize: 11 }}>Upcoming</span>}
                              {isPastOverride && <span className="pill pill-gray" style={{ fontSize: 11, opacity: 0.5 }}>Expired</span>}
                              {!isPastOverride && (
                                <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red-600)', padding: '2px 6px' }} onClick={() => deleteOverride(o.id)}>✕</button>
                              )}
                            </div>
                          </div>
                          {o.label && <div className="av-override-label">{o.label}</div>}
                          <div className="av-override-caps">
                            <span className="av-cap-badge av-cap-am">🌅 Morning: {o.window_a_capacity} slots</span>
                            <span className="av-cap-badge av-cap-pm">🌆 Afternoon: {o.window_b_capacity} slots</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Sunday controls */}
              <div className="card av-section">
                <div className="av-section-head">
                  <div>
                    <div className="av-section-title">Sunday Deliveries</div>
                    <div className="av-section-sub">
                      {blockedSundayCount > 0
                        ? `${blockedSundayCount} Sunday${blockedSundayCount !== 1 ? 's' : ''} currently blocked`
                        : 'No Sundays are blocked'}
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <button className="btn btn-secondary btn-sm" onClick={blockAllSundays}>
                    🚫 Block all Sundays (90 days)
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={unblockAllSundays} disabled={blockedSundayCount === 0}>
                    ✓ Unblock all Sundays
                  </button>
                </div>
              </div>

            </div>

            {/* ── RIGHT COLUMN — Calendar ── */}
            <div className="av-right">
              <div className="card av-section" style={{ padding: 0, overflow: 'hidden' }}>

                {/* Calendar toolbar */}
                <div className="av-cal-toolbar">
                  <button className="av-cal-nav" onClick={() => {
                    if (calMonth === 0) { setCalMonth(11); setCalYear(y => y - 1); }
                    else setCalMonth(m => m - 1);
                  }}>‹</button>
                  <span className="av-cal-month">{MONTHS[calMonth]} {calYear}</span>
                  <button className="av-cal-nav" onClick={() => {
                    if (calMonth === 11) { setCalMonth(0); setCalYear(y => y + 1); }
                    else setCalMonth(m => m + 1);
                  }}>›</button>
                </div>

                {/* Day headers */}
                <div className="av-cal-grid av-cal-header">
                  {DAYS.map(d => <div key={d} className="av-cal-dh">{d}</div>)}
                </div>

                {/* Calendar cells */}
                <div className="av-cal-grid av-cal-body">
                  {calDays.map((day, i) => {
                    if (!day) return <div key={`empty-${i}`} className="av-cal-cell av-cal-empty" />;
                    const ds = toDateStr(day);
                    const past = isPast(day);
                    const blocked = isBlackedOut(ds);
                    const override = getOverrideForDate(ds);
                    const isToday = ds === toDateStr(today);

                    return (
                      <div
                        key={ds}
                        className={[
                          'av-cal-cell',
                          past ? 'av-cal-past' : '',
                          blocked ? 'av-cal-blocked' : '',
                          isToday ? 'av-cal-today' : '',
                          !past && !blocked ? 'av-cal-open' : '',
                        ].filter(Boolean).join(' ')}
                        onClick={() => !past && openBlackoutModal(ds)}
                      >
                        <span className="av-cal-num">{day.getDate()}</span>
                        {blocked && <span className="av-cal-icon">🚫</span>}
                        {!blocked && override && (
                          <span className="av-cal-override-dot" title={`Override: AM ${override.window_a_capacity} / PM ${override.window_b_capacity}`}>
                            ★
                          </span>
                        )}
                        {!blocked && !override && !past && (
                          <span className="av-cal-slots">{baseCap?.capacity_per_window ?? '–'}</span>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Legend */}
                <div className="av-cal-legend">
                  <span className="av-legend-item"><span className="av-legend-dot av-legend-open" />Open</span>
                  <span className="av-legend-item"><span className="av-legend-dot av-legend-blocked" />Blocked</span>
                  <span className="av-legend-item"><span style={{ fontSize: 11 }}>★</span> Capacity override</span>
                </div>

              </div>
            </div>

          </div>
        )}

        {/* ── Blackout Modal ── */}
        {blackoutModal && (
          <div className="modal-overlay" onClick={() => setBlackoutModal(null)}>
            <div className="modal-card" onClick={e => e.stopPropagation()} style={{ maxWidth: 420 }}>
              <div className="modal-header">
                <h2 className="modal-title">
                  {blackoutModal.existingId ? 'Manage Blocked Date' : 'Block Date'}
                </h2>
                <div className="modal-subtitle">{fmtDateFull(blackoutModal.date)}</div>
              </div>
              <div className="modal-body">
                {blackoutModal.existingId ? (
                  <>
                    <div className="av-blocked-info">
                      <div className="av-blocked-reason">
                        Reason: <strong>{REASON_LABELS[blackoutReason] || blackoutReason}</strong>
                      </div>
                      {blackoutNote && <div className="av-blocked-note">{blackoutNote}</div>}
                    </div>
                    <div className="modal-footer" style={{ paddingTop: 16 }}>
                      <button
                        className="btn btn-primary btn-sm"
                        style={{ background: 'var(--green-600)' }}
                        onClick={() => unblockDate(blackoutModal.existingId!, blackoutModal.date)}
                      >
                        ✓ Unblock this date
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setBlackoutModal(null)}>Close</button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="form-group">
                      <label className="form-label">Reason</label>
                      <select className="form-select" value={blackoutReason} onChange={e => setBlackoutReason(e.target.value)}>
                        <option value="other">Other / General</option>
                        <option value="weather">Weather</option>
                        <option value="staffing">Staffing</option>
                        <option value="equipment">Equipment</option>
                      </select>
                    </div>
                    <div className="form-group">
                      <label className="form-label">Note <span style={{ color: 'var(--gray-400)', fontWeight: 400 }}>(optional)</span></label>
                      <input
                        className="form-input"
                        placeholder="e.g. Holiday closure"
                        value={blackoutNote}
                        onChange={e => setBlackoutNote(e.target.value)}
                      />
                    </div>
                    <div className="modal-footer">
                      <button className="btn btn-danger btn-sm" onClick={saveBlackout} disabled={blackoutSaving}>
                        {blackoutSaving ? 'Saving…' : '🚫 Block this date'}
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setBlackoutModal(null)}>Cancel</button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Override Modal ── */}
        {overrideModal && (
          <div className="modal-overlay" onClick={() => setOverrideModal(false)}>
            <div className="modal-card" onClick={e => e.stopPropagation()} style={{ maxWidth: 460 }}>
              <div className="modal-header">
                <h2 className="modal-title">Add Capacity Override</h2>
                <div className="modal-subtitle">Override slots for a specific date range — affects AM and PM windows independently</div>
              </div>
              <div className="modal-body">
                <div className="form-group">
                  <label className="form-label">Label <span style={{ color: 'var(--gray-400)', fontWeight: 400 }}>(optional)</span></label>
                  <input
                    className="form-input"
                    placeholder="e.g. Spring rush — triple capacity"
                    value={overrideForm.label}
                    onChange={e => setOverrideForm(f => ({ ...f, label: e.target.value }))}
                  />
                </div>
                <div className="av-form-row">
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="form-label">Start date</label>
                    <input
                      className="form-input"
                      type="date"
                      value={overrideForm.start_date}
                      onChange={e => setOverrideForm(f => ({ ...f, start_date: e.target.value }))}
                    />
                  </div>
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="form-label">End date</label>
                    <input
                      className="form-input"
                      type="date"
                      value={overrideForm.end_date}
                      onChange={e => setOverrideForm(f => ({ ...f, end_date: e.target.value }))}
                    />
                  </div>
                </div>
                <div className="av-form-row">
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="form-label">🌅 Morning slots</label>
                    <input
                      className="form-input"
                      type="number"
                      min={0}
                      placeholder={String(baseCap?.capacity_per_window ?? 4)}
                      value={overrideForm.window_a_capacity}
                      onChange={e => setOverrideForm(f => ({ ...f, window_a_capacity: e.target.value }))}
                    />
                  </div>
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="form-label">🌆 Afternoon slots</label>
                    <input
                      className="form-input"
                      type="number"
                      min={0}
                      placeholder={String(baseCap?.capacity_per_window ?? 4)}
                      value={overrideForm.window_b_capacity}
                      onChange={e => setOverrideForm(f => ({ ...f, window_b_capacity: e.target.value }))}
                    />
                  </div>
                </div>
                {overrideError && <div className="alert alert-error" style={{ marginTop: 8 }}><span>⚠</span> {overrideError}</div>}
                <div className="modal-footer">
                  <button className="btn btn-primary btn-sm" onClick={saveOverride} disabled={overrideSaving}>
                    {overrideSaving ? 'Saving…' : 'Save Override'}
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setOverrideModal(false)}>Cancel</button>
                </div>
              </div>
            </div>
          </div>
        )}

      </div>
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = `
  .av-page { max-width: 1200px; }

  .av-top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 24px;
    flex-wrap: wrap;
  }
  .av-top h1 { margin: 0; }
  .av-subtitle { color: var(--gray-500); font-size: 14px; margin-top: 4px; }

  /* Two-column layout */
  .av-grid {
    display: grid;
    grid-template-columns: 380px 1fr;
    gap: 20px;
    align-items: start;
  }
  .av-left { display: flex; flex-direction: column; gap: 16px; }
  .av-right { position: sticky; top: 24px; }

  /* Section cards */
  .av-section { padding: 20px; }
  .av-section-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 16px;
  }
  .av-section-title {
    font-family: var(--font-heading);
    font-size: 15px;
    font-weight: 700;
    color: var(--gray-900);
  }
  .av-section-sub {
    font-size: 12px;
    color: var(--gray-500);
    margin-top: 2px;
  }

  /* Base capacity */
  .av-base-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }
  .av-base-windows { display: flex; gap: 12px; }
  .av-window-badge {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 10px 16px;
    border-radius: var(--radius-lg);
    min-width: 80px;
    gap: 2px;
  }
  .av-window-am { background: rgba(26,158,58,0.08); border: 1px solid rgba(26,158,58,0.2); }
  .av-window-pm { background: rgba(37,99,235,0.07); border: 1px solid rgba(37,99,235,0.18); }
  .av-window-label { font-size: 11px; font-weight: 600; color: var(--gray-500); text-transform: uppercase; letter-spacing: 0.05em; }
  .av-window-val { font-family: var(--font-heading); font-size: 28px; font-weight: 800; color: var(--gray-900); line-height: 1; }
  .av-window-unit { font-size: 11px; color: var(--gray-400); }
  .av-base-edit { display: flex; flex-direction: column; }
  .av-base-edit-row { display: flex; align-items: center; gap: 10px; }

  /* Overrides */
  .av-override-list { display: flex; flex-direction: column; gap: 10px; }
  .av-override-card {
    border: 1px solid var(--border-light);
    border-radius: var(--radius-lg);
    padding: 12px 14px;
    transition: border-color 0.15s;
  }
  .av-override-active { border-color: var(--green-400, #4ade80); background: rgba(26,158,58,0.04); }
  .av-override-past { opacity: 0.5; }
  .av-override-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 6px;
  }
  .av-override-dates {
    font-family: var(--font-heading);
    font-size: 14px;
    font-weight: 700;
    color: var(--gray-900);
  }
  .av-override-label {
    font-size: 12px;
    color: var(--gray-500);
    margin-bottom: 8px;
    font-style: italic;
  }
  .av-override-caps { display: flex; gap: 8px; flex-wrap: wrap; }
  .av-cap-badge {
    font-size: 12px;
    font-weight: 600;
    padding: 3px 8px;
    border-radius: var(--radius-sm);
  }
  .av-cap-am { background: rgba(26,158,58,0.1); color: var(--green-800, #166534); }
  .av-cap-pm { background: rgba(37,99,235,0.08); color: #1e40af; }

  /* Empty states */
  .av-empty {
    padding: 20px;
    text-align: center;
    color: var(--gray-400);
    font-size: 13px;
    background: var(--bg-secondary, var(--gray-50));
    border-radius: var(--radius-md);
  }

  /* Calendar */
  .av-cal-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px 12px;
    border-bottom: 1px solid var(--border-light);
  }
  .av-cal-month {
    font-family: var(--font-heading);
    font-size: 16px;
    font-weight: 700;
    color: var(--gray-900);
  }
  .av-cal-nav {
    width: 32px; height: 32px;
    display: flex; align-items: center; justify-content: center;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    font-size: 18px;
    color: var(--gray-600);
    cursor: pointer;
    transition: all 0.12s;
  }
  .av-cal-nav:hover { background: var(--bg-secondary); color: var(--gray-900); }

  .av-cal-grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
  }
  .av-cal-header { border-bottom: 1px solid var(--border-light); }
  .av-cal-dh {
    padding: 8px 4px;
    text-align: center;
    font-family: var(--font-heading);
    font-size: 11px;
    font-weight: 700;
    color: var(--gray-400);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .av-cal-cell {
    min-height: 68px;
    padding: 6px;
    border-right: 1px solid var(--border-light);
    border-bottom: 1px solid var(--border-light);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    position: relative;
    transition: background 0.12s;
  }
  .av-cal-cell:nth-child(7n) { border-right: none; }
  .av-cal-empty { background: transparent; cursor: default; }
  .av-cal-past { background: var(--bg-secondary, var(--gray-50)); cursor: default; opacity: 0.4; }
  .av-cal-open { cursor: pointer; }
  .av-cal-open:hover { background: rgba(26,158,58,0.06); }
  .av-cal-blocked {
    background: rgba(244,63,94,0.07);
    cursor: pointer;
  }
  .av-cal-blocked:hover { background: rgba(244,63,94,0.12); }
  .av-cal-today .av-cal-num {
    background: var(--green-600, #16a34a);
    color: white;
    border-radius: 50%;
    width: 22px; height: 22px;
    display: flex; align-items: center; justify-content: center;
  }

  .av-cal-num {
    font-family: var(--font-heading);
    font-size: 13px;
    font-weight: 700;
    color: var(--gray-700);
    width: 22px; height: 22px;
    display: flex; align-items: center; justify-content: center;
  }
  .av-cal-past .av-cal-num { color: var(--gray-300); }
  .av-cal-icon { font-size: 14px; line-height: 1; }
  .av-cal-slots {
    font-size: 10px;
    font-weight: 700;
    color: var(--green-700, #15803d);
    background: rgba(26,158,58,0.1);
    border-radius: 4px;
    padding: 1px 5px;
    line-height: 1.4;
  }
  .av-cal-override-dot {
    font-size: 11px;
    color: #d97706;
    font-weight: 800;
  }

  .av-cal-legend {
    display: flex;
    gap: 16px;
    padding: 12px 20px;
    border-top: 1px solid var(--border-light);
    flex-wrap: wrap;
  }
  .av-legend-item {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--gray-500);
  }
  .av-legend-dot {
    width: 10px; height: 10px;
    border-radius: 2px;
    flex-shrink: 0;
  }
  .av-legend-open { background: rgba(26,158,58,0.25); }
  .av-legend-blocked { background: rgba(244,63,94,0.3); }

  /* Modal extras */
  .av-blocked-info { padding: 12px; background: rgba(244,63,94,0.06); border-radius: var(--radius-md); border: 1px solid rgba(244,63,94,0.15); }
  .av-blocked-reason { font-size: 14px; color: var(--gray-700); margin-bottom: 4px; }
  .av-blocked-note { font-size: 13px; color: var(--gray-500); font-style: italic; }
  .av-form-row { display: flex; gap: 12px; }
  .av-form-row .form-group { flex: 1; }

  /* Window DOW rules */
  .av-dow-grid { display: flex; flex-direction: column; gap: 12px; }
  .av-dow-row { display: flex; flex-direction: column; gap: 6px; }
  .av-dow-window-label {
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 3px 0;
  }
  .av-dow-am { color: var(--green-700, #15803d); }
  .av-dow-pm { color: #1e40af; }
  .av-dow-toggles { display: flex; gap: 5px; flex-wrap: wrap; }
  .av-dow-btn {
    width: 40px;
    height: 34px;
    border-radius: var(--radius-md);
    border: 1.5px solid;
    font-size: 11px;
    font-weight: 700;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.15s;
  }
  .av-dow-btn--on {
    background: rgba(26,158,58,0.1);
    border-color: rgba(26,158,58,0.35);
    color: var(--green-700, #15803d);
  }
  .av-dow-btn--on:hover {
    background: rgba(26,158,58,0.18);
  }
  .av-dow-btn--off {
    background: rgba(244,63,94,0.08);
    border-color: rgba(244,63,94,0.3);
    color: #be123c;
  }
  .av-dow-btn--off:hover {
    background: rgba(244,63,94,0.14);
  }

  /* Responsive */
  @media (max-width: 900px) {
    .av-grid { grid-template-columns: 1fr; }
    .av-right { position: static; }
  }
  @media (max-width: 600px) {
    .av-top { flex-direction: column; }
    .av-cal-cell { min-height: 52px; }
    .av-form-row { flex-direction: column; }
    .av-base-row { flex-direction: column; align-items: flex-start; }
  }
`;
