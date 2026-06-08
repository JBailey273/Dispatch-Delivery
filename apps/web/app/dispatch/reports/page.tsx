'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { api } from '../../lib/auth';
import { requireRole } from '../../lib/auth';
import { useLocation } from '../../lib/location-context';

function toKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getMonday(d: Date) {
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const m = new Date(d);
  m.setDate(d.getDate() + diff);
  return m;
}

function getSunday(d: Date) {
  const m = getMonday(d);
  m.setDate(m.getDate() + 6);
  return m;
}

function fmt$(n: number) {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtYards(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 1 }) + ' yd';
}

type CustomerTypeStat = { count: number; revenue: number; yards: number };

type Summary = {
  order_count: number;
  total_revenue: number;
  cash_total: number;
  total_yards: number;
  delivery_count: number;
  pickup_count: number;
  yards_by_product: Record<string, number>;
  payment_breakdown: { method: string; count: number; total: number }[];
  customer_breakdown?: { residential: CustomerTypeStat; commercial: CustomerTypeStat };
};

const METHOD_LABELS: Record<string, string> = {
  cash: 'Cash',
  card: 'Card',
  invoice: 'Invoice',
  payment_link: 'Payment Link',
  unknown: 'Unknown',
};

function CustomerBreakdownSection({
  breakdown,
  totalOrders,
}: {
  breakdown: { residential: CustomerTypeStat; commercial: CustomerTypeStat };
  totalOrders: number;
}) {
  const res = breakdown.residential;
  const com = breakdown.commercial;
  const resPct = totalOrders > 0 ? Math.round(res.count / totalOrders * 100) : 0;
  const comPct = 100 - resPct;

  const rows = [
    { key: 'residential', label: 'Residential', icon: '🏠', stat: res, pct: resPct },
    { key: 'commercial', label: 'Contractor', icon: '🏢', stat: com, pct: comPct },
  ] as const;

  return (
    <div className="card rp-section" style={{ marginBottom: 16 }}>
      <div className="rp-section-head">Residential vs. Contractor</div>
      <div className="rp-ctype-grid">
        {rows.map(({ key, label, icon, stat, pct }) => (
          <div key={key} className={`rp-ctype-card rp-ctype-card--${key}`}>
            <div className="rp-ctype-header">
              <span className="rp-ctype-icon">{icon}</span>
              <span className="rp-ctype-label">{label}</span>
              <span className="rp-ctype-pct">{pct}%</span>
            </div>
            <div className="rp-ctype-stats">
              <div className="rp-ctype-stat">
                <div className="rp-ctype-stat-val">{stat.count}</div>
                <div className="rp-ctype-stat-label">Orders</div>
              </div>
              <div className="rp-ctype-stat">
                <div className="rp-ctype-stat-val">{fmt$(stat.revenue)}</div>
                <div className="rp-ctype-stat-label">Revenue</div>
              </div>
              <div className="rp-ctype-stat">
                <div className="rp-ctype-stat-val">{fmtYards(stat.yards)}</div>
                <div className="rp-ctype-stat-label">Yards</div>
              </div>
            </div>
          </div>
        ))}
      </div>
      {totalOrders > 0 && (
        <div style={{ padding: '0 20px 16px' }}>
          <div className="rp-split-bar" style={{ height: 10 }}>
            <div className="rp-ctype-bar-res" style={{ width: `${resPct}%` }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 11, color: 'var(--gray-400)', fontWeight: 600 }}>
            <span>🏠 {resPct}% · {fmt$(res.revenue)}</span>
            <span>{fmt$(com.revenue)} · {comPct}% 🏢</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ReportsPage() {
  const today = new Date();
  const [preset, setPreset] = useState<'today' | 'week' | 'custom'>('today');
  const [startDate, setStartDate] = useState(toKey(today));
  const [endDate, setEndDate] = useState(toKey(today));
  const [mode, setMode] = useState<'booked' | 'fulfilled'>('booked');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { activeLocation } = useLocation();

  const applyPreset = useCallback((p: 'today' | 'week' | 'custom') => {
    setPreset(p);
    if (p === 'today') {
      setStartDate(toKey(today));
      setEndDate(toKey(today));
    } else if (p === 'week') {
      setStartDate(toKey(getMonday(today)));
      setEndDate(toKey(getSunday(today)));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchSummary = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const loc = activeLocation?.id ? `&location_id=${activeLocation.id}` : '';
      const data = await api(`/ops/reports/summary?start_date=${startDate}&end_date=${endDate}&mode=${mode}${loc}`);
      setSummary(data);
    } catch {
      setError('Failed to load report.');
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate, mode, activeLocation?.id]);

  useEffect(() => { fetchSummary(); }, [fetchSummary]);
  useEffect(() => { fetchSummary(); }, [mode]);;

  if (!requireRole(['admin'])) return <div className="page"><p>Unauthorized</p></div>;

  const maxYards = summary ? Math.max(...Object.values(summary.yards_by_product), 1) : 1;

  return (
    <>
      <style>{styles}</style>
      <div className="page rp-page">

        <div className="rp-header">
          <div>
            <h1>Reports</h1>
            <p className="rp-sub">Order totals and material volume</p>
          </div>
          <Link href="/ops-dashboard" className="btn btn-ghost btn-sm" style={{ textDecoration: 'none' }}>← Dashboard</Link>
        </div>

        {/* ── Date Controls ── */}
        <div className="card rp-controls">
          <div className="rp-controls-top">
            <div className="rp-presets">
              {(['today', 'week', 'custom'] as const).map(p => (
                <button
                  key={p}
                  className={`rp-preset-btn${preset === p ? ' active' : ''}`}
                  onClick={() => applyPreset(p)}
                >
                  {p === 'today' ? 'Today' : p === 'week' ? 'This Week' : 'Custom'}
                </button>
              ))}
            </div>
            <div className="rp-mode-toggle">
              <button
                className={`rp-preset-btn${mode === 'booked' ? ' active' : ''}`}
                onClick={() => setMode('booked')}
              >
                Booked
              </button>
              <button
                className={`rp-preset-btn${mode === 'fulfilled' ? ' active' : ''}`}
                onClick={() => setMode('fulfilled')}
              >
                Fulfilled
              </button>
            </div>
          </div>
          <div className="rp-date-row">
            <div className="rp-date-group">
              <label className="rp-label">From</label>
              <input
                type="date"
                className="rp-date-input"
                value={startDate}
                onChange={e => { setStartDate(e.target.value); setPreset('custom'); }}
              />
            </div>
            <div className="rp-date-group">
              <label className="rp-label">To</label>
              <input
                type="date"
                className="rp-date-input"
                value={endDate}
                onChange={e => { setEndDate(e.target.value); setPreset('custom'); }}
              />
            </div>
            <button className="btn btn-primary btn-sm" onClick={fetchSummary} disabled={loading}>
              {loading ? '…' : 'Run'}
            </button>
          </div>
        </div>

        {error && <div className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}

        {loading && !summary && (
          <div style={{ textAlign: 'center', padding: 60 }}>
            <div className="spinner spinner-lg" style={{ margin: '0 auto' }} />
          </div>
        )}

        {summary && (
          <>
            {/* ── Top KPIs ── */}
            <div className="rp-kpi-grid">
              <div className="card rp-kpi">
                <div className="rp-kpi-val">{fmtYards(summary.total_yards)}</div>
                <div className="rp-kpi-label">Total Yards</div>
              </div>
              <div className="card rp-kpi">
                <div className="rp-kpi-val">{fmt$(summary.total_revenue)}</div>
                <div className="rp-kpi-label">Revenue</div>
              </div>
              <div className="card rp-kpi rp-kpi--cash">
                <div className="rp-kpi-val">{fmt$(summary.cash_total)}</div>
                <div className="rp-kpi-label">Cash Collected</div>
              </div>
              <div className="card rp-kpi">
                <div className="rp-kpi-val">{summary.order_count}</div>
                <div className="rp-kpi-label">Orders</div>
              </div>
            </div>

            {/* ── Yards by Product ── */}
            <div className="card rp-section">
              <div className="rp-section-head">Yards by Product</div>
              {Object.keys(summary.yards_by_product).length === 0
                ? <p className="rp-empty">No data for this period.</p>
                : Object.entries(summary.yards_by_product)
                    .sort(([, a], [, b]) => b - a)
                    .map(([name, qty]) => (
                      <div key={name} className="rp-bar-row">
                        <div className="rp-bar-label">{name}</div>
                        <div className="rp-bar-track">
                          <div
                            className="rp-bar-fill"
                            style={{ width: `${Math.round(qty / maxYards * 100)}%` }}
                          />
                        </div>
                        <div className="rp-bar-val">{fmtYards(qty)}</div>
                      </div>
                    ))
              }
            </div>

            {/* ── Residential vs Contractor ── */}
            {summary.customer_breakdown && (
              <CustomerBreakdownSection breakdown={summary.customer_breakdown} totalOrders={summary.order_count} />
            )}

            {/* ── Delivery vs Pickup + Payment Methods ── */}
            <div className="rp-two-col">
              <div className="card rp-section">
                <div className="rp-section-head">Delivery vs Pickup</div>
                <div className="rp-split-row">
                  <div className="rp-split-item">
                    <div className="rp-split-val">{summary.delivery_count}</div>
                    <div className="rp-split-label">🚚 Deliveries</div>
                  </div>
                  <div className="rp-split-divider" />
                  <div className="rp-split-item">
                    <div className="rp-split-val">{summary.pickup_count}</div>
                    <div className="rp-split-label">🏪 Pickups</div>
                  </div>
                </div>
                {summary.order_count > 0 && (
                  <div className="rp-split-bar-wrap">
                    <div className="rp-split-bar">
                      <div
                        className="rp-split-bar-delivery"
                        style={{ width: `${Math.round(summary.delivery_count / summary.order_count * 100)}%` }}
                      />
                    </div>
                    <span className="rp-split-pct">
                      {Math.round(summary.delivery_count / summary.order_count * 100)}% delivery
                    </span>
                  </div>
                )}
              </div>

              <div className="card rp-section">
                <div className="rp-section-head">Payment Methods</div>
                {summary.payment_breakdown.map(({ method, count, total }) => (
                  <div key={method} className="rp-pm-row">
                    <div className="rp-pm-method">{METHOD_LABELS[method] ?? method}</div>
                    <div className="rp-pm-count">{count} order{count !== 1 ? 's' : ''}</div>
                    <div className="rp-pm-total">{fmt$(total)}</div>
                  </div>
                ))}
                {summary.payment_breakdown.length === 0 && <p className="rp-empty">No data.</p>}
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}

const styles = `
.rp-page { max-width: 900px; margin: 0 auto; padding: 20px 16px 80px; }
.rp-header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 24px; gap: 16px; }
.rp-header h1 { margin: 0; font-size: 28px; font-weight: 800; letter-spacing: -0.03em; }
.rp-sub { font-size: 13px; color: var(--gray-500); margin-top: 3px; }

.rp-controls { padding: 16px 20px; margin-bottom: 20px; }
.rp-controls-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
.rp-presets { display: flex; gap: 6px; }
.rp-mode-toggle { display: flex; gap: 6px; }
.rp-preset-btn { padding: 6px 14px; border-radius: 100px; border: 1.5px solid var(--border); background: var(--surface); font-size: 13px; font-weight: 600; color: var(--gray-600); cursor: pointer; font-family: inherit; transition: all 0.12s; }
.rp-preset-btn.active { background: var(--brand); color: white; border-color: var(--brand); }
.rp-date-row { display: flex; align-items: flex-end; gap: 12px; flex-wrap: wrap; }
.rp-date-group { display: flex; flex-direction: column; gap: 4px; }
.rp-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em; color: var(--gray-500); }
.rp-date-input { border: 1.5px solid var(--border); border-radius: var(--radius-md); padding: 7px 10px; font-size: 14px; font-family: inherit; color: var(--gray-900); background: var(--surface); }

.rp-kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px; }
@media (max-width: 700px) { .rp-kpi-grid { grid-template-columns: repeat(2, 1fr); } }
.rp-kpi { padding: 20px 16px; text-align: center; margin-bottom: 0; }
.rp-kpi--cash { border-color: var(--green-200, #bbf7d0); background: var(--green-25, #f0fdf4); }
.rp-kpi-val { font-size: 26px; font-weight: 800; letter-spacing: -0.03em; color: var(--gray-900); line-height: 1; font-family: var(--font-heading); }
.rp-kpi-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--gray-400); margin-top: 6px; }

.rp-section { padding: 0; margin-bottom: 16px; overflow: hidden; }
.rp-section-head { padding: 14px 20px; font-size: 14px; font-weight: 700; color: var(--gray-700); border-bottom: 1px solid var(--border-light); }
.rp-empty { padding: 20px; color: var(--gray-400); font-size: 13px; text-align: center; margin: 0; }

.rp-bar-row { display: grid; grid-template-columns: 140px 1fr 80px; align-items: center; gap: 12px; padding: 10px 20px; border-bottom: 1px solid var(--border-light); }
.rp-bar-row:last-child { border-bottom: none; }
.rp-bar-label { font-size: 13px; font-weight: 600; color: var(--gray-800); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rp-bar-track { height: 8px; border-radius: 4px; background: var(--gray-100); overflow: hidden; }
.rp-bar-fill { height: 100%; border-radius: 4px; background: var(--brand); transition: width 0.4s; }
.rp-bar-val { font-size: 13px; font-weight: 700; color: var(--gray-700); text-align: right; }

.rp-ctype-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 16px 20px 12px; }
@media (max-width: 600px) { .rp-ctype-grid { grid-template-columns: 1fr; } }
.rp-ctype-card { border-radius: var(--radius-md); padding: 14px 16px; border: 1px solid var(--border-light); }
.rp-ctype-card--residential { background: var(--green-25, #f0fdf4); border-color: var(--green-200, #bbf7d0); }
.rp-ctype-card--commercial { background: #eff6ff; border-color: #bfdbfe; }
.rp-ctype-header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.rp-ctype-icon { font-size: 18px; }
.rp-ctype-label { font-size: 13px; font-weight: 700; color: var(--gray-700); flex: 1; }
.rp-ctype-pct { font-size: 13px; font-weight: 800; color: var(--gray-500); }
.rp-ctype-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.rp-ctype-stat { text-align: center; }
.rp-ctype-stat-val { font-size: 15px; font-weight: 800; color: var(--gray-900); font-family: var(--font-heading); line-height: 1.2; }
.rp-ctype-stat-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--gray-400); margin-top: 3px; }
.rp-ctype-bar-res { height: 100%; border-radius: 4px; background: var(--brand-green, #4a7052); }

.rp-two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
@media (max-width: 640px) { .rp-two-col { grid-template-columns: 1fr; } }

.rp-split-row { display: flex; align-items: stretch; padding: 20px; gap: 0; }
.rp-split-item { flex: 1; text-align: center; }
.rp-split-val { font-size: 32px; font-weight: 800; letter-spacing: -0.03em; color: var(--gray-900); font-family: var(--font-heading); line-height: 1; }
.rp-split-label { font-size: 12px; font-weight: 600; color: var(--gray-400); margin-top: 6px; }
.rp-split-divider { width: 1px; background: var(--border-light); flex-shrink: 0; margin: 4px 0; }
.rp-split-bar-wrap { display: flex; align-items: center; gap: 10px; padding: 0 20px 16px; }
.rp-split-bar { flex: 1; height: 8px; border-radius: 4px; background: var(--gray-100); overflow: hidden; }
.rp-split-bar-delivery { height: 100%; background: var(--brand); border-radius: 4px; transition: width 0.4s; }
.rp-split-pct { font-size: 12px; font-weight: 600; color: var(--gray-500); white-space: nowrap; }

.rp-pm-row { display: flex; align-items: center; gap: 12px; padding: 11px 20px; border-bottom: 1px solid var(--border-light); }
.rp-pm-row:last-child { border-bottom: none; }
.rp-pm-method { flex: 1; font-size: 14px; font-weight: 600; color: var(--gray-800); }
.rp-pm-count { font-size: 12px; color: var(--gray-400); font-weight: 600; white-space: nowrap; }
.rp-pm-total { font-size: 14px; font-weight: 700; color: var(--gray-800); min-width: 80px; text-align: right; }
`;
