'use client';

import { useEffect, useState, useRef, useCallback } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000/api/v1';

type ScheduleContext = {
  tenant_name: string;
  customer_name: string;
  address: { line1: string; city: string; state: string; postal_code: string } | null;
  materials: string[];
  already_scheduled: boolean;
  current_date: string | null;
  current_window: string | null;
};

type WindowOption = { window: string; label: string; time_range: string };
type DateOption = { date: string; windows: WindowOption[] };
type WeekGroup = { label: string; dates: DateOption[] };

const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function parseLocalDate(ds: string) {
  const [y, m, d] = ds.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function fmtDate(ds: string) {
  const d = parseLocalDate(ds);
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

function weekLabel(ds: string): string {
  const d = parseLocalDate(ds);
  const now = new Date();
  const startOfThisWeek = new Date(now);
  startOfThisWeek.setDate(now.getDate() - now.getDay());
  startOfThisWeek.setHours(0, 0, 0, 0);
  const startOfNextWeek = new Date(startOfThisWeek);
  startOfNextWeek.setDate(startOfThisWeek.getDate() + 7);
  const startOfWeekAfter = new Date(startOfNextWeek);
  startOfWeekAfter.setDate(startOfNextWeek.getDate() + 7);
  if (d < startOfNextWeek) return 'This week';
  if (d < startOfWeekAfter) return 'Next week';
  const weekStart = new Date(d);
  weekStart.setDate(d.getDate() - d.getDay());
  return `Week of ${MONTHS[weekStart.getMonth()]} ${weekStart.getDate()}`;
}

function groupByWeek(dates: DateOption[]): WeekGroup[] {
  const groups: WeekGroup[] = [];
  for (const date of dates) {
    const label = weekLabel(date.date);
    const existing = groups.find(g => g.label === label);
    if (existing) existing.dates.push(date);
    else groups.push({ label, dates: [date] });
  }
  return groups;
}

const PAGE_SIZE = 10;

export default function SchedulePage() {
  const [token, setToken] = useState<string | null>(null);
  const [ctx, setCtx] = useState<ScheduleContext | null>(null);
  const [allDates, setAllDates] = useState<DateOption[]>([]);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [loadingCtx, setLoadingCtx] = useState(true);
  const [loadingDates, setLoadingDates] = useState(true);
  const [error, setError] = useState('');
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedWindow, setSelectedWindow] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState<{ date: string; window_label: string } | null>(null);

  // Site info step
  const [showSiteInfo, setShowSiteInfo] = useState(false);
  const [siteNote, setSiteNote] = useState('');
  const [sitePhoto, setSitePhoto] = useState<File | null>(null);
  const [sitePhotoPreview, setSitePhotoPreview] = useState<string | null>(null);
  const [siteInfoSaving, setSiteInfoSaving] = useState(false);
  const [siteInfoDone, setSiteInfoDone] = useState(false);

  const loaderRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get('token');
    if (!t) { setError('This scheduling link is invalid.'); setLoadingCtx(false); return; }
    setToken(t);
  }, []);

  useEffect(() => {
    if (!token) return;
    setLoadingCtx(true);
    fetch(`${API_BASE}/schedule/${token}`)
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(e)))
      .then(data => { setCtx(data); setLoadingCtx(false); })
      .catch(e => { setError(e?.detail?.message || 'This link is invalid or has expired.'); setLoadingCtx(false); });
  }, [token]);

  useEffect(() => {
    if (!token) return;
    setLoadingDates(true);
    fetch(`${API_BASE}/schedule/${token}/availability`)
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(e)))
      .then(data => { setAllDates(data.dates || []); setLoadingDates(false); })
      .catch(() => { setLoadingDates(false); });
  }, [token]);

  useEffect(() => {
    const el = loaderRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) setVisibleCount(v => v + PAGE_SIZE);
    }, { threshold: 0.1 });
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadingDates]);

  const selectDate = useCallback((date: string) => {
    if (selectedDate === date) { setSelectedDate(null); setSelectedWindow(null); }
    else { setSelectedDate(date); setSelectedWindow(null); }
  }, [selectedDate]);

  const confirm = async () => {
    if (!token || !selectedDate || !selectedWindow) return;
    setConfirming(true);
    try {
      const r = await fetch(`${API_BASE}/schedule/${token}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduled_date: selectedDate, scheduled_window: selectedWindow }),
      });
      const data = await r.json();
      if (!r.ok) throw data;
      setConfirmed({ date: data.scheduled_date, window_label: data.window_label });
      setShowSiteInfo(true); // go to step 2
    } catch (e: any) {
      setError(e?.detail?.message || 'Something went wrong. Please try again.');
      setConfirming(false);
    }
  };

  const handlePhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSitePhoto(file);
    setSitePhotoPreview(URL.createObjectURL(file));
  };

  const submitSiteInfo = async (skip = false) => {
    if (skip) { setSiteInfoDone(true); return; }
    if (!token) return;
    setSiteInfoSaving(true);
    try {
      let photoUrl: string | null = null;

      if (sitePhoto) {
  try {
    const uploadRes = await fetch(`${API_BASE}/embed/order/${orderId}/photo-upload-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Channel-Key': channelKey },
      body: JSON.stringify({ content_type: sitePhoto.type || 'image/jpeg' }),
    });
    const uploadData = await uploadRes.json();
    if (uploadRes.ok) {
      const putRes = await fetch(uploadData.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': sitePhoto.type || 'image/jpeg' },
        body: sitePhoto,
      });
      if (putRes.ok) {
        photoUrl = uploadData.photo_url;
      }
    }
  } catch {
    // Photo upload failed — continue without photo so site-info still saves
  }
}

await fetch(`${API_BASE}/embed/order/${orderId}/site-info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          note: siteNote.trim() || null,
          photo_url: photoUrl,
        }),
      });
    } catch {
      // Non-fatal — don't block the customer
    } finally {
      setSiteInfoSaving(false);
      setSiteInfoDone(true);
    }
  };

  const visibleDates = allDates.slice(0, visibleCount);
  const weekGroups = groupByWeek(visibleDates);
  const hasMore = visibleCount < allDates.length;

  // ── Final confirmed screen ────────────────────────────────────────────────
  if (confirmed && siteInfoDone) {
    const d = parseLocalDate(confirmed.date);
    return (
      <>
        <style>{styles}</style>
        <div className="sc-shell">
          <div className="sc-card sc-confirmed">
            <div className="sc-check">✓</div>
            <h1 className="sc-confirmed-title">You're all set!</h1>
            <p className="sc-confirmed-sub">Your delivery is scheduled for</p>
            <div className="sc-confirmed-date">
              {DAYS[d.getDay()]}, {MONTHS[d.getMonth()]} {d.getDate()}
            </div>
            <div className="sc-confirmed-window">{confirmed.window_label} window</div>
            {ctx && <p className="sc-confirmed-addr">{ctx.address?.line1}, {ctx.address?.city}</p>}
            <p className="sc-confirmed-note">You'll receive a text when your driver is on the way.</p>
          </div>
        </div>
      </>
    );
  }

  // ── Site info step ────────────────────────────────────────────────────────
  if (confirmed && showSiteInfo) {
    const d = parseLocalDate(confirmed.date);
    return (
      <>
        <style>{styles}</style>
        <div className="sc-shell">

          {/* Booked confirmation banner */}
          <div className="sc-booked-banner">
            <span className="sc-booked-check">✓</span>
            <div>
              <div className="sc-booked-title">Delivery booked!</div>
              <div className="sc-booked-date">{DAYS[d.getDay()]}, {MONTHS[d.getMonth()]} {d.getDate()} · {confirmed.window_label}</div>
            </div>
          </div>

          {/* Site info card */}
          <div className="sc-card" style={{ marginTop: 16 }}>
            <div className="sc-site-heading">📍 Help your driver find the spot</div>
            <p className="sc-site-sub">Anything useful? Gate codes, driveway notes, where to drop — totally optional.</p>

            <textarea
              className="sc-site-textarea"
              placeholder="e.g. Gate code is 1234, drop near the side gate on the left…"
              value={siteNote}
              onChange={e => setSiteNote(e.target.value)}
              rows={4}
            />

            {/* Photo picker */}
            <div className="sc-photo-section">
              {sitePhotoPreview ? (
                <div className="sc-photo-preview-wrap">
                  <img src={sitePhotoPreview} alt="Site preview" className="sc-photo-preview" />
                  <button
                    className="sc-photo-remove"
                    onClick={() => { setSitePhoto(null); setSitePhotoPreview(null); }}
                  >
                    ✕ Remove photo
                  </button>
                </div>
              ) : (
                <button
                  className="sc-photo-btn"
                  onClick={() => fileInputRef.current?.click()}
                >
                  📷 Add a photo of the drop location
                </button>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                style={{ display: 'none' }}
                onChange={handlePhotoChange}
              />
            </div>
          </div>

          {/* Actions */}
          <div className="sc-cta-wrap sc-site-actions">
            <button
              className="sc-cta"
              disabled={siteInfoSaving}
              onClick={() => submitSiteInfo(false)}
            >
              {siteInfoSaving ? 'Saving…' : 'Submit & finish'}
            </button>
            <button
              className="sc-skip-btn"
              disabled={siteInfoSaving}
              onClick={() => submitSiteInfo(true)}
            >
              Skip for now
            </button>
          </div>

        </div>
      </>
    );
  }

  // ── Error state ───────────────────────────────────────────────────────────
  if (!loadingCtx && error) {
    return (
      <>
        <style>{styles}</style>
        <div className="sc-shell">
          <div className="sc-card" style={{ textAlign: 'center', padding: '40px 24px' }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>⚠️</div>
            <h2 style={{ marginBottom: 8 }}>Link unavailable</h2>
            <p style={{ color: '#6b7280', fontSize: 15 }}>{error}</p>
            <p style={{ color: '#6b7280', fontSize: 14, marginTop: 12 }}>Please contact us to get a new scheduling link.</p>
          </div>
        </div>
      </>
    );
  }

  // ── Loading state ─────────────────────────────────────────────────────────
  if (loadingCtx) {
    return (
      <>
        <style>{styles}</style>
        <div className="sc-shell">
          <div className="sc-spinner-wrap"><div className="sc-spinner" /></div>
        </div>
      </>
    );
  }

  // ── Main scheduling UI ────────────────────────────────────────────────────
  return (
    <>
      <style>{styles}</style>
      <div className="sc-shell">

        <div className="sc-header">
          <div className="sc-logo-mark" />
          <div className="sc-header-name">{ctx?.tenant_name}</div>
        </div>

        <div className="sc-card sc-summary">
          <div className="sc-summary-name">{ctx?.customer_name}</div>
          {ctx?.address && (
            <div className="sc-summary-addr">
              {ctx.address.line1}, {ctx.address.city}, {ctx.address.state} {ctx.address.postal_code}
            </div>
          )}
          {ctx?.materials && ctx.materials.length > 0 && (
            <div className="sc-summary-materials">
              {ctx.materials.map((m, i) => <span key={i} className="sc-material-pill">{m}</span>)}
            </div>
          )}
        </div>

        <div className="sc-section-label">Choose a delivery date</div>

        {ctx?.already_scheduled && ctx.current_date && (
          <div className="sc-notice">
            Currently scheduled for {fmtDate(ctx.current_date)} · {ctx.current_window === 'A' ? 'Morning' : 'Afternoon'}. Select a new date below to change it.
          </div>
        )}

        {loadingDates && <div className="sc-spinner-wrap"><div className="sc-spinner" /></div>}

        {!loadingDates && allDates.length === 0 && (
          <div className="sc-card" style={{ textAlign: 'center', padding: '32px 20px', color: '#6b7280' }}>
            No available dates in the next 60 days. Please contact us directly.
          </div>
        )}

        {!loadingDates && weekGroups.map(group => (
          <div key={group.label}>
            <div className="sc-week-label">{group.label}</div>
            {group.dates.map(d => {
              const isSelected = selectedDate === d.date;
              return (
                <div
                  key={d.date}
                  className={`sc-date-card ${isSelected ? 'sc-date-selected' : ''}`}
                  onClick={() => selectDate(d.date)}
                >
                  <div className="sc-date-row">
                    <div>
                      <div className="sc-date-label">{fmtDate(d.date)}</div>
                      {!isSelected && (
                        <div className="sc-date-sub">
                          {d.windows.map(w => w.label).join(' · ')}
                        </div>
                      )}
                    </div>
                    <div className={`sc-radio ${isSelected ? 'sc-radio-selected' : ''}`}>
                      {isSelected && <div className="sc-radio-dot" />}
                    </div>
                  </div>
                  {isSelected && (
                    <div className="sc-windows">
                      {d.windows.map(w => (
                        <div
                          key={w.window}
                          className={`sc-window-pill ${selectedWindow === w.window ? 'sc-window-selected' : ''}`}
                          onClick={e => { e.stopPropagation(); setSelectedWindow(w.window); }}
                        >
                          <div className="sc-window-label">{w.label}</div>
                          <div className="sc-window-time">{w.time_range}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}

        {hasMore && <div ref={loaderRef} className="sc-load-more">Load more dates ↓</div>}

        {error && confirmed === null && (
          <div className="sc-error">{error}</div>
        )}

        <div className="sc-cta-wrap">
          <button
            className="sc-cta"
            disabled={!selectedDate || !selectedWindow || confirming}
            onClick={confirm}
          >
            {confirming ? 'Confirming…' : 'Confirm delivery date'}
          </button>
        </div>

      </div>
    </>
  );
}

const styles = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body { background: #f3f4f0; }

  .sc-shell {
    min-height: 100vh;
    max-width: 480px;
    margin: 0 auto;
    padding: 0 0 120px;
    font-family: 'DM Sans', -apple-system, sans-serif;
    color: #1a1a1a;
  }

  .sc-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 18px 20px 14px;
    background: #fff;
    border-bottom: 1px solid #e5e7e0;
    position: sticky;
    top: 0;
    z-index: 10;
  }
  .sc-logo-mark {
    width: 28px; height: 28px;
    border-radius: 8px;
    background: #2d6a1f;
    flex-shrink: 0;
  }
  .sc-header-name { font-size: 15px; font-weight: 600; color: #1a1a1a; }

  .sc-card {
    background: #fff;
    border-radius: 14px;
    border: 1px solid #e5e7e0;
    margin: 14px 16px 0;
    padding: 16px;
  }

  .sc-summary-name { font-size: 16px; font-weight: 600; color: #1a1a1a; margin-bottom: 4px; }
  .sc-summary-addr { font-size: 13px; color: #6b7280; margin-bottom: 10px; }
  .sc-summary-materials { display: flex; flex-wrap: wrap; gap: 6px; }
  .sc-material-pill {
    font-size: 12px; font-weight: 500;
    background: #eef6e8; color: #2d6a1f;
    border-radius: 20px; padding: 3px 10px;
  }

  .sc-section-label {
    font-size: 11px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.07em;
    color: #9ca3af; padding: 18px 20px 6px;
  }

  .sc-week-label {
    font-size: 12px; font-weight: 600; color: #6b7280;
    padding: 10px 20px 4px;
    text-transform: uppercase; letter-spacing: 0.05em;
  }

  .sc-notice {
    margin: 0 16px 4px;
    background: #fffbeb; border: 1px solid #fde68a;
    border-radius: 10px; padding: 10px 14px;
    font-size: 13px; color: #92400e;
  }

  .sc-date-card {
    margin: 6px 16px 0;
    background: #fff; border-radius: 12px;
    border: 1px solid #e5e7e0; padding: 14px 16px;
    cursor: pointer; transition: border-color 0.15s;
  }
  .sc-date-card:active { opacity: 0.85; }
  .sc-date-selected { border-color: #2d6a1f; border-width: 2px; }
  .sc-date-row { display: flex; justify-content: space-between; align-items: center; }
  .sc-date-label { font-size: 15px; font-weight: 600; color: #1a1a1a; }
  .sc-date-sub { font-size: 12px; color: #6b7280; margin-top: 3px; }

  .sc-radio {
    width: 20px; height: 20px; border-radius: 50%;
    border: 2px solid #d1d5db;
    display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  }
  .sc-radio-selected { border-color: #2d6a1f; background: #2d6a1f; }
  .sc-radio-dot { width: 7px; height: 7px; border-radius: 50%; background: #fff; }

  .sc-windows { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; }
  .sc-window-pill {
    border: 1.5px solid #e5e7e0; border-radius: 10px;
    padding: 10px 12px; text-align: center; cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
  }
  .sc-window-pill:active { opacity: 0.8; }
  .sc-window-selected { border-color: #2d6a1f; background: #eef6e8; }
  .sc-window-label { font-size: 13px; font-weight: 600; color: #1a1a1a; }
  .sc-window-time { font-size: 11px; color: #6b7280; margin-top: 2px; }

  .sc-load-more {
    text-align: center; padding: 18px 0 4px;
    font-size: 13px; font-weight: 500; color: #2d6a1f;
  }

  .sc-error {
    margin: 12px 16px 0;
    background: #fef2f2; border: 1px solid #fecaca;
    border-radius: 10px; padding: 10px 14px;
    font-size: 13px; color: #991b1b;
  }

  .sc-cta-wrap {
    position: fixed;
    bottom: 0; left: 0; right: 0;
    padding: 14px 16px 28px;
    background: #fff; border-top: 1px solid #e5e7e0;
  }
  .sc-cta {
    width: 100%; background: #2d6a1f; color: #fff;
    border: none; border-radius: 12px; padding: 16px;
    font-size: 16px; font-weight: 600; cursor: pointer;
    font-family: inherit; transition: opacity 0.15s;
  }
  .sc-cta:disabled { opacity: 0.4; cursor: default; }
  .sc-cta:not(:disabled):active { opacity: 0.85; }

  /* Site info step */
  .sc-booked-banner {
    display: flex; align-items: center; gap: 12px;
    background: #eef6e8; border-bottom: 1px solid #c6e0b8;
    padding: 14px 20px;
  }
  .sc-booked-check {
    width: 32px; height: 32px; border-radius: 50%;
    background: #2d6a1f; color: #fff;
    display: flex; align-items: center; justify-content: center;
    font-size: 16px; font-weight: 700; flex-shrink: 0;
  }
  .sc-booked-title { font-size: 14px; font-weight: 700; color: #1a4d10; }
  .sc-booked-date { font-size: 13px; color: #2d6a1f; margin-top: 2px; }

  .sc-site-heading { font-size: 16px; font-weight: 700; color: #1a1a1a; margin-bottom: 6px; }
  .sc-site-sub { font-size: 13px; color: #6b7280; margin-bottom: 14px; line-height: 1.5; }

  .sc-site-textarea {
    width: 100%; border: 1.5px solid #e5e7e0; border-radius: 10px;
    padding: 12px 14px; font-size: 14px; font-family: inherit;
    color: #1a1a1a; resize: none; outline: none;
    transition: border-color 0.15s;
  }
  .sc-site-textarea:focus { border-color: #2d6a1f; }

  .sc-photo-section { margin-top: 12px; }
  .sc-photo-btn {
    width: 100%; padding: 12px;
    border: 1.5px dashed #d1d5db; border-radius: 10px;
    background: #fafafa; color: #4b5563;
    font-size: 14px; font-weight: 500; cursor: pointer;
    font-family: inherit; transition: border-color 0.15s;
  }
  .sc-photo-btn:active { opacity: 0.8; }

  .sc-photo-preview-wrap { position: relative; }
  .sc-photo-preview {
    width: 100%; max-height: 200px; object-fit: cover;
    border-radius: 10px; display: block;
  }
  .sc-photo-remove {
    margin-top: 8px; background: none; border: none;
    color: #dc2626; font-size: 13px; font-weight: 500;
    cursor: pointer; padding: 0; font-family: inherit;
  }

  .sc-site-actions { display: flex; flex-direction: column; gap: 10px; }
  .sc-skip-btn {
    width: 100%; background: none; border: none;
    color: #6b7280; font-size: 14px; font-weight: 500;
    cursor: pointer; padding: 8px; font-family: inherit;
  }
  .sc-skip-btn:disabled { opacity: 0.4; }

  /* Confirmed final screen */
  .sc-confirmed { margin-top: 60px; text-align: center; padding: 36px 24px; }
  .sc-check {
    width: 56px; height: 56px; border-radius: 50%;
    background: #eef6e8; color: #2d6a1f;
    font-size: 24px; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
    margin: 0 auto 16px;
  }
  .sc-confirmed-title { font-size: 24px; font-weight: 700; margin-bottom: 8px; }
  .sc-confirmed-sub { font-size: 14px; color: #6b7280; margin-bottom: 12px; }
  .sc-confirmed-date { font-size: 20px; font-weight: 700; color: #2d6a1f; }
  .sc-confirmed-window { font-size: 14px; color: #6b7280; margin-top: 4px; }
  .sc-confirmed-addr { font-size: 13px; color: #9ca3af; margin-top: 12px; }
  .sc-confirmed-note { font-size: 13px; color: #6b7280; margin-top: 16px; line-height: 1.5; }

  .sc-spinner-wrap { display: flex; justify-content: center; padding: 40px 0; }
  .sc-spinner {
    width: 28px; height: 28px;
    border: 3px solid #e5e7e0; border-top-color: #2d6a1f;
    border-radius: 50%; animation: sc-spin 0.7s linear infinite;
  }
  @keyframes sc-spin { to { transform: rotate(360deg); } }
`;
