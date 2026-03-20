'use client';

import { useEffect, useState, useRef, useCallback } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000/api/v1';

type WindowOption = { window: string; label: string; time_range: string };
type DateOption = { date: string; windows: WindowOption[] };
type OrderContext = {
  drop_id: string;
  customer_name: string;
  items: string[];
  already_scheduled: boolean;
  scheduled_date: string | null;
  scheduled_window: string | null;
  available_dates: DateOption[];
};

const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const PAGE_SIZE = 8;

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

  // Find the Sunday that starts this date's week
  const weekStart = new Date(d);
  weekStart.setDate(d.getDate() - d.getDay());
  return `Week of ${MONTHS[weekStart.getMonth()]} ${weekStart.getDate()}`;
}

type WeekGroup = { label: string; dates: DateOption[] };
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

export default function ScheduleEmbedPage() {
  const [orderId, setOrderId] = useState<string | null>(null);
  const [channelKey, setChannelKey] = useState<string | null>(null);
  const [ctx, setCtx] = useState<OrderContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedWindow, setSelectedWindow] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState<{ date: string; window_label: string } | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const loaderRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oid = params.get('order_id');
    const key = params.get('key');
    if (!oid || !key) {
      setError('Invalid scheduling link.');
      setLoading(false);
      return;
    }
    setOrderId(oid);
    setChannelKey(key);
  }, []);

  const MAX_RETRIES = 8;
  const RETRY_DELAY_MS = 3000;
  const retryRef = useRef(0);

  useEffect(() => {
    if (!orderId || !channelKey) return;
    retryRef.current = 0;

    const attempt = () => {
      setLoading(true);
      fetch(`${API_BASE}/embed/order/${orderId}`, {
        headers: { 'X-Channel-Key': channelKey },
      })
        .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject({ status: r.status, ...e })))
        .then(data => {
          setCtx(data);
          setLoading(false);
        })
        .catch(e => {
          // Only retry on 404 (order not ingested yet) — fail immediately on anything else
          if (e?.status === 404 && retryRef.current < MAX_RETRIES) {
            retryRef.current += 1;
            setTimeout(attempt, RETRY_DELAY_MS);
          } else {
            setError(e?.detail?.message || 'Unable to load your order. Please contact us.');
            setLoading(false);
          }
        });
    };

    attempt();
  }, [orderId, channelKey]);

  // Infinite scroll
  useEffect(() => {
    const el = loaderRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) setVisibleCount(v => v + PAGE_SIZE);
    }, { threshold: 0.1 });
    observer.observe(el);
    return () => observer.disconnect();
  }, [loading]);

  const confirm = useCallback(async () => {
    if (!orderId || !channelKey || !selectedDate || !selectedWindow) return;
    setConfirming(true);
    setError('');
    try {
      const r = await fetch(`${API_BASE}/embed/order/${orderId}/schedule`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Channel-Key': channelKey,
        },
        body: JSON.stringify({
          scheduled_date: selectedDate,
          scheduled_window: selectedWindow,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw data;
      setConfirmed({ date: data.scheduled_date, window_label: data.window_label });
    } catch (e: any) {
      setError(e?.detail?.message || 'Something went wrong. Please try again.');
    } finally {
      setConfirming(false);
    }
  }, [orderId, channelKey, selectedDate, selectedWindow]);

  const visibleDates = (ctx?.available_dates ?? []).slice(0, visibleCount);
  const weekGroups = groupByWeek(visibleDates);
  const hasMore = visibleCount < (ctx?.available_dates.length ?? 0);
  const selectedWindowObj = ctx?.available_dates
    .find(d => d.date === selectedDate)
    ?.windows.find(w => w.window === selectedWindow);

  // ── Confirmed ──
  if (confirmed) {
    const d = parseLocalDate(confirmed.date);
    return (
      <>
        <style>{styles}</style>
        <div className="se-shell">
          <div className="se-confirmed-card">
            <div className="se-confirmed-check">✓</div>
            <h2 className="se-confirmed-title">You're all set!</h2>
            <p className="se-confirmed-sub">Your delivery is scheduled for</p>
            <div className="se-confirmed-date">
              {DAYS[d.getDay()]}, {MONTHS[d.getMonth()]} {d.getDate()}
            </div>
            <div className="se-confirmed-window">{confirmed.window_label}</div>
            <p className="se-confirmed-note">
              We'll send you a text message when your driver is on the way. Thank you for choosing East Meadow Garden Center!
            </p>
          </div>
        </div>
      </>
    );
  }

  // ── Loading ──
  if (loading) {
    return (
      <>
        <style>{styles}</style>
        <div className="se-shell" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 300 }}>
          <div style={{ textAlign: 'center' }}>
            <div className="spinner spinner-lg" style={{ margin: '0 auto 16px' }} />
            <div style={{ fontSize: 15, color: 'var(--gray-600)', fontWeight: 500 }}>
              {retryRef.current > 0 ? 'Getting your order ready…' : 'Loading…'}
            </div>
          </div>
        </div>
      </>
    );
  }

  // ── Error ──
  if (error && !ctx) {
    return (
      <>
        <style>{styles}</style>
        <div className="se-shell">
          <div className="se-error-card">
            <div className="se-error-icon">⚠️</div>
            <h2>Unable to load scheduling</h2>
            <p>{error}</p>
            <p className="se-error-contact">Please call us at <a href="tel:+15168265050">(516) 826-5050</a> and we'll get you scheduled.</p>
          </div>
        </div>
      </>
    );
  }

  // ── Already scheduled ──
  if (ctx?.already_scheduled && ctx.scheduled_date) {
    const d = parseLocalDate(ctx.scheduled_date);
    const windowLabel = ctx.scheduled_window === 'A' ? 'Morning (9am–1pm)' : 'Afternoon (1pm–5pm)';
    return (
      <>
        <style>{styles}</style>
        <div className="se-shell">
          <div className="se-already-card">
            <div className="se-already-icon">📅</div>
            <h2 className="se-already-title">Delivery Already Scheduled</h2>
            <p className="se-already-sub">Hi {ctx.customer_name.split(' ')[0]}! Your delivery is scheduled for:</p>
            <div className="se-already-date">{DAYS[d.getDay()]}, {MONTHS[d.getMonth()]} {d.getDate()}</div>
            <div className="se-already-window">{windowLabel}</div>
            <p className="se-already-note">
              Need to change your date? Call us at <a href="tel:+15168265050">(516) 826-5050</a>.
            </p>
          </div>
        </div>
      </>
    );
  }

  // ── Main scheduling UI ──
  return (
    <>
      <style>{styles}</style>
      <div className="se-shell">

        {/* Header */}
        <div className="se-header">
          <h2 className="se-title">Schedule Your Delivery</h2>
          <p className="se-subtitle">
            Hi {ctx?.customer_name.split(' ')[0]}! Pick a date and time that works for you.
          </p>
        </div>

        {/* Order summary */}
        {ctx && ctx.items.length > 0 && (
          <div className="se-order-summary">
            <div className="se-summary-label">Your Order</div>
            {ctx.items.map((item, i) => (
              <div key={i} className="se-summary-item">
                <span className="se-summary-dot" />
                {item}
              </div>
            ))}
          </div>
        )}

        {/* Error inline */}
        {error && (
          <div className="se-inline-error">{error}</div>
        )}

        {/* Date list */}
        <div className="se-dates">
          {weekGroups.length === 0 && (
            <div className="se-no-dates">
              No available delivery dates found. Please call us at <a href="tel:+15168265050">(516) 826-5050</a>.
            </div>
          )}

          {weekGroups.map(group => (
            <div key={group.label} className="se-week-group">
              <div className="se-week-label">{group.label}</div>
              {group.dates.map(dateOpt => {
                const isSelected = selectedDate === dateOpt.date;
                return (
                  <div key={dateOpt.date} className={`se-date-card ${isSelected ? 'se-date-card--selected' : ''}`}>
                    <button
                      className="se-date-btn"
                      onClick={() => {
                        if (isSelected) { setSelectedDate(null); setSelectedWindow(null); }
                        else { setSelectedDate(dateOpt.date); setSelectedWindow(null); }
                      }}
                    >
                      <span className="se-date-name">{fmtDate(dateOpt.date)}</span>
                      <span className="se-date-slots">
                        {dateOpt.windows.length} window{dateOpt.windows.length !== 1 ? 's' : ''} available
                      </span>
                      <span className="se-date-chev">{isSelected ? '▲' : '▼'}</span>
                    </button>

                    {isSelected && (
                      <div className="se-windows">
                        {dateOpt.windows.map(win => {
                          const isWinSelected = selectedWindow === win.window;
                          return (
                            <button
                              key={win.window}
                              className={`se-window-btn ${isWinSelected ? 'se-window-btn--selected' : ''}`}
                              onClick={() => setSelectedWindow(isWinSelected ? null : win.window)}
                            >
                              <span className="se-window-label">{win.label}</span>
                              <span className="se-window-time">{win.time_range}</span>
                              {isWinSelected && <span className="se-window-check">✓</span>}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}

          {hasMore && <div ref={loaderRef} style={{ height: 40 }} />}
        </div>

        {/* Confirm footer */}
        {selectedDate && selectedWindow && (
          <div className="se-confirm-bar">
            <div className="se-confirm-summary">
              <div className="se-confirm-date">{fmtDate(selectedDate)}</div>
              <div className="se-confirm-window">{selectedWindowObj?.label} · {selectedWindowObj?.time_range}</div>
            </div>
            <button
              className="se-confirm-btn"
              onClick={confirm}
              disabled={confirming}
            >
              {confirming ? 'Scheduling…' : 'Confirm Delivery Date'}
            </button>
          </div>
        )}

      </div>
    </>
  );
}

const styles = `
  @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=Inter:wght@400;500;600&display=swap');

  .se-shell {
    font-family: 'Inter', -apple-system, sans-serif;
    color: #2c2c2c;
    background: transparent;
    max-width: 560px;
    margin: 0 auto;
    padding: 0 4px 80px;
    font-size: 15px;
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }

  /* Header */
  .se-header {
    text-align: center;
    padding: 28px 16px 20px;
  }
  .se-title {
    font-family: 'Outfit', sans-serif;
    font-size: 26px;
    font-weight: 800;
    color: #3d5a45;
    letter-spacing: -0.02em;
    margin: 0 0 8px;
    line-height: 1.2;
  }
  .se-subtitle {
    font-size: 15px;
    color: #666;
    margin: 0;
  }

  /* Order summary */
  .se-order-summary {
    background: #f4f8f4;
    border: 1px solid rgba(74,112,82,0.15);
    border-radius: 14px;
    padding: 14px 18px;
    margin: 0 0 20px;
  }
  .se-summary-label {
    font-family: 'Outfit', sans-serif;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #4a7052;
    margin-bottom: 8px;
  }
  .se-summary-item {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    color: #444;
    padding: 3px 0;
  }
  .se-summary-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #4a7052;
    flex-shrink: 0;
  }

  /* Week groups */
  .se-dates { display: flex; flex-direction: column; gap: 0; }
  .se-week-group { margin-bottom: 20px; }
  .se-week-label {
    font-family: 'Outfit', sans-serif;
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #4a7052;
    padding: 0 4px 8px;
  }

  /* Date card */
  .se-date-card {
    border: 1.5px solid rgba(74,112,82,0.15);
    border-radius: 14px;
    margin-bottom: 8px;
    background: #fff;
    overflow: hidden;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .se-date-card:hover {
    border-color: rgba(74,112,82,0.35);
    box-shadow: 0 4px 16px rgba(74,112,82,0.1);
  }
  .se-date-card--selected {
    border-color: #4a7052;
    box-shadow: 0 4px 20px rgba(74,112,82,0.15);
  }
  .se-date-btn {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 18px;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    font-family: inherit;
  }
  .se-date-name {
    font-family: 'Outfit', sans-serif;
    font-size: 16px;
    font-weight: 700;
    color: #2c2c2c;
    flex: 1;
  }
  .se-date-slots {
    font-size: 13px;
    color: #4a7052;
    font-weight: 600;
  }
  .se-date-chev {
    font-size: 11px;
    color: #999;
    flex-shrink: 0;
  }

  /* Windows */
  .se-windows {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 0 14px 14px;
  }
  .se-window-btn {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    border: 1.5px solid rgba(74,112,82,0.2);
    border-radius: 10px;
    background: #f9fcf9;
    cursor: pointer;
    font-family: inherit;
    text-align: left;
    transition: all 0.15s;
  }
  .se-window-btn:hover {
    border-color: #4a7052;
    background: #f0f7f1;
  }
  .se-window-btn--selected {
    border-color: #4a7052;
    background: linear-gradient(135deg, #f0f7f1 0%, #e8f5ea 100%);
  }
  .se-window-label {
    font-family: 'Outfit', sans-serif;
    font-size: 15px;
    font-weight: 700;
    color: #2c2c2c;
    flex: 1;
  }
  .se-window-time {
    font-size: 13px;
    color: #666;
  }
  .se-window-check {
    font-size: 14px;
    color: #4a7052;
    font-weight: 700;
    flex-shrink: 0;
  }

  /* Confirm bar */
  .se-confirm-bar {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    background: #fff;
    border-top: 1.5px solid rgba(74,112,82,0.2);
    padding: 14px 20px;
    display: flex;
    align-items: center;
    gap: 14px;
    box-shadow: 0 -4px 20px rgba(0,0,0,0.08);
    z-index: 100;
  }
  .se-confirm-summary { flex: 1; min-width: 0; }
  .se-confirm-date {
    font-family: 'Outfit', sans-serif;
    font-size: 14px;
    font-weight: 700;
    color: #2c2c2c;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .se-confirm-window {
    font-size: 12px;
    color: #4a7052;
    font-weight: 600;
  }
  .se-confirm-btn {
    background: linear-gradient(135deg, #4a7052 0%, #3d5a45 100%);
    color: #fff;
    border: none;
    border-radius: 999px;
    padding: 12px 24px;
    font-family: 'Outfit', sans-serif;
    font-size: 15px;
    font-weight: 700;
    cursor: pointer;
    white-space: nowrap;
    box-shadow: 0 4px 16px rgba(74,112,82,0.3);
    transition: all 0.2s;
    flex-shrink: 0;
  }
  .se-confirm-btn:hover:not(:disabled) {
    background: linear-gradient(135deg, #3d5a45 0%, #2d4433 100%);
    transform: translateY(-1px);
    box-shadow: 0 6px 20px rgba(74,112,82,0.35);
  }
  .se-confirm-btn:disabled { opacity: 0.6; cursor: not-allowed; }

  /* Confirmed */
  .se-confirmed-card {
    text-align: center;
    padding: 48px 28px 40px;
    background: linear-gradient(135deg, #fff 0%, #f4f8f4 100%);
    border: 1.5px solid rgba(74,112,82,0.2);
    border-radius: 20px;
    margin: 20px 0;
  }
  .se-confirmed-check {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    background: linear-gradient(135deg, #4a7052 0%, #3d5a45 100%);
    color: #fff;
    font-size: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 0 auto 20px;
    box-shadow: 0 8px 24px rgba(74,112,82,0.3);
  }
  .se-confirmed-title {
    font-family: 'Outfit', sans-serif;
    font-size: 26px;
    font-weight: 800;
    color: #3d5a45;
    margin: 0 0 8px;
    letter-spacing: -0.02em;
  }
  .se-confirmed-sub { font-size: 15px; color: #666; margin: 0 0 12px; }
  .se-confirmed-date {
    font-family: 'Outfit', sans-serif;
    font-size: 22px;
    font-weight: 800;
    color: #2c2c2c;
    margin-bottom: 6px;
    letter-spacing: -0.02em;
  }
  .se-confirmed-window {
    font-size: 15px;
    font-weight: 600;
    color: #4a7052;
    margin-bottom: 20px;
  }
  .se-confirmed-note { font-size: 14px; color: #888; line-height: 1.6; margin: 0; }

  /* Already scheduled */
  .se-already-card {
    text-align: center;
    padding: 40px 28px;
    background: #fff;
    border: 1.5px solid rgba(74,112,82,0.15);
    border-radius: 20px;
    margin: 20px 0;
  }
  .se-already-icon { font-size: 36px; margin-bottom: 14px; }
  .se-already-title {
    font-family: 'Outfit', sans-serif;
    font-size: 22px;
    font-weight: 800;
    color: #3d5a45;
    margin: 0 0 8px;
  }
  .se-already-sub { font-size: 15px; color: #666; margin: 0 0 16px; }
  .se-already-date {
    font-family: 'Outfit', sans-serif;
    font-size: 20px;
    font-weight: 800;
    color: #2c2c2c;
    margin-bottom: 6px;
  }
  .se-already-window { font-size: 15px; color: #4a7052; font-weight: 600; margin-bottom: 20px; }
  .se-already-note { font-size: 14px; color: #888; }
  .se-already-note a { color: #4a7052; }

  /* Error */
  .se-error-card {
    text-align: center;
    padding: 40px 24px;
    background: #fff;
    border: 1.5px solid #fecaca;
    border-radius: 20px;
    margin: 20px 0;
  }
  .se-error-icon { font-size: 36px; margin-bottom: 14px; }
  .se-error-card h2 { font-family: 'Outfit', sans-serif; font-size: 20px; color: #2c2c2c; margin: 0 0 10px; }
  .se-error-card p { font-size: 14px; color: #666; margin: 0 0 8px; }
  .se-error-contact a { color: #4a7052; font-weight: 600; }

  /* Inline error */
  .se-inline-error {
    background: #fef2f2;
    border: 1px solid #fecaca;
    border-radius: 10px;
    padding: 10px 14px;
    font-size: 13px;
    color: #dc2626;
    margin-bottom: 16px;
  }

  /* Spinner */
  .se-spinner-wrap {
    text-align: center;
    padding: 60px 20px;
  }
  .se-spinner {
    width: 36px;
    height: 36px;
    border: 3px solid rgba(74,112,82,0.15);
    border-top-color: #4a7052;
    border-radius: 50%;
    animation: se-spin 0.7s linear infinite;
    margin: 0 auto 16px;
  }
  @keyframes se-spin { to { transform: rotate(360deg); } }
  .se-spinner-text { font-size: 14px; color: #888; }

  /* No dates */
  .se-no-dates {
    text-align: center;
    padding: 32px 20px;
    font-size: 14px;
    color: #666;
    background: #f9f9f9;
    border-radius: 14px;
  }
  .se-no-dates a { color: #4a7052; font-weight: 600; }

  @media (max-width: 480px) {
    .se-title { font-size: 22px; }
    .se-confirm-bar { padding: 12px 16px; }
    .se-confirm-btn { padding: 11px 18px; font-size: 14px; }
  }
`;
