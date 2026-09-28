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

function fmtCords(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' cord' + (n === 1 ? '' : 's');
}

type CustomerTypeStat = { count: number; revenue: number; yards: number; deliveries: number; pickups: number };

type Summary = {
  order_count: number;
  total_revenue: number;
  cash_total: number;
  total_yards: number;
  total_cords: number;
  delivery_count: number;
  pickup_count: number;
  yards_by_product: Record<string, number>;
  firewood_by_product: Record<string, { units_sold: number; cords: number }>;
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

  const totalRevenue = res.revenue + com.revenue;
  const resRevPct = totalRevenue > 0 ? Math.round(res.revenue / totalRevenue * 100) : 0;
  const comRevPct = 100 - resRevPct;

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
              <span className="rp-ctype-pct">{pct}% of orders</span>
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
            {(() => {
              const dpTotal = stat.deliveries + stat.pickups;
              const dPct = dpTotal > 0 ? Math.round(stat.deliveries / dpTotal * 100) : 0;
              return (
                <div className="rp-ctype-dp">
                  <div className="rp-ctype-dp-bar">
                    <div className="rp-ctype-dp-fill" style={{ width: `${dPct}%` }} />
                  </div>
                  <div className="rp-ctype-dp-legend">
                    <span>🚚 {stat.deliveries}</span>
                    <span>{stat.pickups} 🏪</span>
                  </div>
                </div>
              );
            })()}
          </div>
        ))}
      </div>
      {totalOrders > 0 && (
        <div style={{ padding: '0 20px 16px' }}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--gray-400)', marginBottom: 5 }}>
            Order Split
          </div>
          <div className="rp-split-bar" style={{ height: 10 }}>
            <div className="rp-ctype-bar-res" style={{ width: `${resPct}%` }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 11, color: 'var(--gray-400)', fontWeight: 600 }}>
            <span>🏠 {resPct}% · {res.count} orders</span>
            <span>{com.count} orders · {comPct}% 🏢</span>
          </div>

          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--gray-400)', margin: '16px 0 5px' }}>
            Revenue Split
          </div>
          <div className="rp-split-bar" style={{ height: 10 }}>
            <div className="rp-ctype-bar-res" style={{ width: `${resRevPct}%` }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 11, color: 'var(--gray-400)', fontWeight: 600 }}>
            <span>🏠 {resRevPct}% · {fmt$(res.revenue)}</span>
            <span>{fmt$(com.revenue)} · {comRevPct}% 🏢</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Season view ────────────────────────────────────────────────

type SeasonMetric = 'revenue' | 'yards' | 'orders';
type SeasonWeek = { week_start: string; revenue: number; yards: number; orders: number; deliveries: number; pickups: number; loads: number };
type SeasonDay = { date: string; revenue: number; yards: number; orders: number; deliveries: number; pickups: number };
type Season = {
  totals: { revenue: number; yards: number; orders: number; deliveries: number; pickups: number; open_days: number };
  weeks: SeasonWeek[];
  days: SeasonDay[];
  weekday: { dow: number; label: string; open_days: number; avg_orders: number; avg_yards: number; avg_revenue: number }[];
  months: string[];
  products: { product: string; total_yards: number; by_month: Record<string, number>; peak_week_start: string; peak_week_yards: number }[];
  staffing: {
    delivery_days: number;
    avg_loads_per_delivery_day: number;
    peak_load_day: { date: string; loads: number } | null;
    avg_drivers_per_day: number;
    avg_loads_per_driver_day: number;
    unassigned_loads: number;
    total_delivery_loads: number;
    window_split: { A: number; B: number };
    pickup_days: number;
    avg_pickups_per_pickup_day: number;
    peak_pickup_day: { date: string; pickups: number } | null;
    pickups_by_hour: { hour: number; count: number }[];
  };
};

// Parse YYYY-MM-DD as a local calendar date (avoids UTC day-shift)
function parseKey(k: string) {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDaysKey(k: string, n: number) {
  const d = parseKey(k);
  d.setDate(d.getDate() + n);
  return toKey(d);
}

function fmtShortDate(k: string) {
  return parseKey(k).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtCompact$(n: number) {
  if (n >= 1000) return '$' + (n / 1000).toLocaleString('en-US', { maximumFractionDigits: n >= 100000 ? 0 : 1 }) + 'k';
  return '$' + Math.round(n).toLocaleString('en-US');
}

function fmtMetric(m: SeasonMetric, n: number) {
  if (m === 'revenue') return fmt$(n);
  if (m === 'yards') return fmtYards(n);
  return `${n.toLocaleString('en-US', { maximumFractionDigits: 1 })} orders`;
}

function fmtHour(h: number) {
  return `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'a' : 'p'}`;
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function SeasonSection({ data }: { data: Season }) {
  const [metric, setMetric] = useState<SeasonMetric>('yards');
  const [detail, setDetail] = useState<{ key: string; text: string } | null>(null);
  const [showAllProducts, setShowAllProducts] = useState(false);

  if (data.weeks.length === 0) {
    return <div className="card rp-section"><p className="rp-empty">No orders in this range.</p></div>;
  }

  const avgKey = metric === 'revenue' ? 'avg_revenue' : metric === 'yards' ? 'avg_yards' : 'avg_orders';
  const maxWeek = Math.max(...data.weeks.map(w => w[metric]), 1);
  const rankedWeeks = [...data.weeks].sort((a, b) => b[metric] - a[metric]);
  const topWeeks = new Set(rankedWeeks.slice(0, 3).filter(w => w[metric] > 0).map(w => w.week_start));
  const peakWeek = rankedWeeks[0];
  const busiestDay = [...data.weekday].sort((a, b) => b[avgKey] - a[avgKey])[0];
  const maxAvg = Math.max(...data.weekday.map(w => w[avgKey]), 1);

  const dayMap = new Map(data.days.map(d => [d.date, d]));
  const maxDay = Math.max(...data.days.map(d => d[metric]), 1);

  const products = showAllProducts ? data.products : data.products.slice(0, 6);
  const st = data.staffing;
  const windowTotal = st.window_split.A + st.window_split.B;
  const amPct = windowTotal > 0 ? Math.round(st.window_split.A / windowTotal * 100) : 0;

  const hourMap = new Map(st.pickups_by_hour.map(h => [h.hour, h.count]));
  const hours = st.pickups_by_hour.length
    ? Array.from(
        { length: st.pickups_by_hour[st.pickups_by_hour.length - 1].hour - st.pickups_by_hour[0].hour + 1 },
        (_, i) => st.pickups_by_hour[0].hour + i,
      )
    : [];
  const maxHour = Math.max(...st.pickups_by_hour.map(h => h.count), 1);

  const pickWeek = (w: SeasonWeek) =>
    setDetail({
      key: w.week_start,
      text: `Week of ${fmtShortDate(w.week_start)} · ${fmt$(w.revenue)} · ${fmtYards(w.yards)} · ${w.orders} orders · ${w.loads} loads`,
    });

  const pickDay = (k: string) => {
    const d = dayMap.get(k);
    const label = parseKey(k).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    setDetail({
      key: k,
      text: d
        ? `${label} · ${fmt$(d.revenue)} · ${fmtYards(d.yards)} · ${d.orders} orders (🚚 ${d.deliveries} / 🏪 ${d.pickups})`
        : `${label} · no orders`,
    });
  };

  return (
    <>
      {/* ── Season KPIs ── */}
      <div className="rp-kpi-grid">
        <div className="card rp-kpi">
          <div className="rp-kpi-val">{fmtCompact$(data.totals.revenue)}</div>
          <div className="rp-kpi-label">Revenue</div>
        </div>
        <div className="card rp-kpi">
          <div className="rp-kpi-val">{fmtYards(Math.round(data.totals.yards))}</div>
          <div className="rp-kpi-label">Yards</div>
        </div>
        <div className="card rp-kpi">
          <div className="rp-kpi-val rp-kpi-val--sm">Wk of {fmtShortDate(peakWeek.week_start)}</div>
          <div className="rp-kpi-label">Peak Week</div>
        </div>
        <div className="card rp-kpi">
          <div className="rp-kpi-val rp-kpi-val--sm">{busiestDay.label}</div>
          <div className="rp-kpi-label">Busiest Day</div>
        </div>
      </div>

      <div className="rp-sn-metric">
        {(['revenue', 'yards', 'orders'] as const).map(m => (
          <button key={m} className={`rp-preset-btn${metric === m ? ' active' : ''}`} onClick={() => setMetric(m)}>
            {m === 'revenue' ? 'Revenue' : m === 'yards' ? 'Yards' : 'Orders'}
          </button>
        ))}
      </div>

      {/* ── Weekly trend ── */}
      <div className="card rp-section">
        <div className="rp-section-head">By Week</div>
        <div className="rp-sn-body">
          <div className="rp-sn-bars">
            {data.weeks.map(w => (
              <button
                key={w.week_start}
                aria-label={`Week of ${fmtShortDate(w.week_start)}: ${fmtMetric(metric, w[metric])}`}
                className={`rp-sn-bar${topWeeks.has(w.week_start) ? ' top' : ''}${detail?.key === w.week_start ? ' sel' : ''}`}
                style={{ height: `${Math.max(w[metric] / maxWeek * 100, w[metric] > 0 ? 3 : 0)}%` }}
                onClick={() => pickWeek(w)}
              />
            ))}
          </div>
          <div className="rp-sn-ticks">
            {data.weeks.map((w, i) => {
              const m = parseKey(w.week_start).getMonth();
              const showLabel = i === 0 || parseKey(data.weeks[i - 1].week_start).getMonth() !== m;
              return <span key={w.week_start}>{showLabel ? MONTH_SHORT[m] : ''}</span>;
            })}
          </div>
          <div className="rp-sn-detail">
            {detail && data.weeks.some(w => w.week_start === detail.key)
              ? detail.text
              : `Top weeks: ${rankedWeeks.slice(0, 3).filter(w => w[metric] > 0).map(w => fmtShortDate(w.week_start)).join(', ')} · tap a bar for details`}
          </div>
        </div>
      </div>

      {/* ── Day-of-week heatmap ── */}
      <div className="card rp-section">
        <div className="rp-section-head">Busy Days</div>
        <div className="rp-sn-body">
          <div className="rp-sn-heat">
            <div />
            {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <div key={i} className="rp-sn-heat-h">{d}</div>)}
            {data.weeks.map(w => (
              <div key={w.week_start} style={{ display: 'contents' }}>
                <div className="rp-sn-heat-wk">{fmtShortDate(w.week_start)}</div>
                {Array.from({ length: 7 }, (_, i) => {
                  const k = addDaysKey(w.week_start, i);
                  const v = dayMap.get(k)?.[metric] ?? 0;
                  return (
                    <button
                      key={k}
                      aria-label={`${k}: ${fmtMetric(metric, v)}`}
                      className={`rp-sn-cell${detail?.key === k ? ' sel' : ''}`}
                      onClick={() => pickDay(k)}
                    >
                      {v > 0 && <span className="rp-sn-cell-fill" style={{ opacity: 0.15 + 0.85 * (v / maxDay) }} />}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="rp-sn-detail">
            {detail && !data.weeks.some(w => w.week_start === detail.key) ? detail.text : 'Tap a day for details'}
          </div>
        </div>
        <div className="rp-sn-sub">Average per open day</div>
        {data.weekday.map(w => (
          <div key={w.dow} className="rp-bar-row" style={{ gridTemplateColumns: '72px 1fr 96px' }}>
            <div className="rp-bar-label">{w.label} <span style={{ color: 'var(--gray-400)', fontWeight: 600 }}>×{w.open_days}</span></div>
            <div className="rp-bar-track">
              <div className="rp-bar-fill" style={{ width: `${Math.round(w[avgKey] / maxAvg * 100)}%` }} />
            </div>
            <div className="rp-bar-val">{w.open_days ? fmtMetric(metric, w[avgKey]) : '—'}</div>
          </div>
        ))}
      </div>

      {/* ── Inventory by month ── */}
      <div className="card rp-section">
        <div className="rp-section-head">Product Volume by Month</div>
        {products.map(p => {
          const maxMonth = Math.max(...Object.values(p.by_month), 1);
          return (
            <div key={p.product} className="rp-sn-prod">
              <div className="rp-sn-prod-head">
                <span className="rp-sn-prod-name">{p.product}</span>
                <span className="rp-sn-prod-meta">
                  {fmtYards(p.total_yards)} · peak wk {fmtShortDate(p.peak_week_start)}: {fmtYards(p.peak_week_yards)}
                </span>
              </div>
              <div className="rp-sn-months">
                {data.months.map(m => (
                  <div
                    key={m}
                    className="rp-sn-month"
                    title={`${m}: ${fmtYards(p.by_month[m] ?? 0)}`}
                    style={{ height: `${Math.max((p.by_month[m] ?? 0) / maxMonth * 100, (p.by_month[m] ?? 0) > 0 ? 6 : 0)}%` }}
                  />
                ))}
              </div>
            </div>
          );
        })}
        <div className="rp-sn-month-axis">
          {data.months.map(m => <span key={m}>{MONTH_SHORT[Number(m.split('-')[1]) - 1]}</span>)}
        </div>
        {data.products.length > 6 && (
          <button className="rp-sn-more" onClick={() => setShowAllProducts(s => !s)}>
            {showAllProducts ? 'Show top 6' : `Show all ${data.products.length} products`}
          </button>
        )}
      </div>

      {/* ── Staffing signals ── */}
      <div className="card rp-section">
        <div className="rp-section-head">Staffing Signals</div>
        <div className="rp-sn-sub">🚚 Delivery</div>
        <div className="rp-sn-tiles">
          <div className="rp-sn-tile">
            <div className="rp-sn-tile-val">{st.avg_loads_per_delivery_day}</div>
            <div className="rp-sn-tile-label">Avg loads / day</div>
          </div>
          <div className="rp-sn-tile">
            <div className="rp-sn-tile-val">{st.peak_load_day ? st.peak_load_day.loads : '—'}</div>
            <div className="rp-sn-tile-label">Peak day{st.peak_load_day ? ` · ${fmtShortDate(st.peak_load_day.date)}` : ''}</div>
          </div>
          <div className="rp-sn-tile">
            <div className="rp-sn-tile-val">{st.avg_drivers_per_day}</div>
            <div className="rp-sn-tile-label">Avg drivers / day</div>
          </div>
          <div className="rp-sn-tile">
            <div className="rp-sn-tile-val">{st.avg_loads_per_driver_day}</div>
            <div className="rp-sn-tile-label">Loads per driver</div>
          </div>
        </div>
        {windowTotal > 0 && (
          <div className="rp-split-bar-wrap" style={{ paddingTop: 12 }}>
            <div className="rp-split-bar">
              <div className="rp-split-bar-delivery" style={{ width: `${amPct}%` }} />
            </div>
            <span className="rp-split-pct">{amPct}% AM · {100 - amPct}% PM</span>
          </div>
        )}
        {st.unassigned_loads > 0 && (
          <div className="rp-sn-note">
            {st.unassigned_loads} of {st.total_delivery_loads} loads had no driver assigned; driver averages exclude them.
          </div>
        )}

        <div className="rp-sn-sub">🏪 Pickup</div>
        <div className="rp-sn-tiles">
          <div className="rp-sn-tile">
            <div className="rp-sn-tile-val">{st.avg_pickups_per_pickup_day}</div>
            <div className="rp-sn-tile-label">Avg pickups / day</div>
          </div>
          <div className="rp-sn-tile">
            <div className="rp-sn-tile-val">{st.peak_pickup_day ? st.peak_pickup_day.pickups : '—'}</div>
            <div className="rp-sn-tile-label">Peak day{st.peak_pickup_day ? ` · ${fmtShortDate(st.peak_pickup_day.date)}` : ''}</div>
          </div>
        </div>
        {hours.length > 0 && (
          <>
            <div className="rp-sn-sub">Pickups by hour</div>
            <div className="rp-sn-hours">
              {hours.map(h => (
                <div
                  key={h}
                  className="rp-sn-hour"
                  title={`${fmtHour(h)}: ${hourMap.get(h) ?? 0}`}
                  style={{ height: `${Math.max((hourMap.get(h) ?? 0) / maxHour * 100, (hourMap.get(h) ?? 0) > 0 ? 4 : 0)}%` }}
                />
              ))}
            </div>
            <div className="rp-sn-hour-axis">
              {hours.map(h => <span key={h}>{fmtHour(h)}</span>)}
            </div>
          </>
        )}
      </div>
    </>
  );
}

export default function ReportsPage() {
  const today = new Date();
    const [preset, setPreset] = useState<'today' | 'week' | 'season' | 'custom'>('today');
  const [startDate, setStartDate] = useState(toKey(today));
  const [endDate, setEndDate] = useState(toKey(today));
  const [mode, setMode] = useState<'booked' | 'fulfilled'>('booked');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [season, setSeason] = useState<Season | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { activeLocation } = useLocation();
  const isSeason = preset === 'season';

  const applyPreset = useCallback((p: 'today' | 'week' | 'season' | 'custom') => {
    setPreset(p);
    if (p === 'today') {
      setStartDate(toKey(today));
      setEndDate(toKey(today));
    } else if (p === 'week') {
      setStartDate(toKey(getMonday(today)));
      setEndDate(toKey(getSunday(today)));
    } else if (p === 'season') {
      setStartDate(`${today.getFullYear()}-01-01`);
      setEndDate(toKey(today));
      setMode('fulfilled');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchSummary = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const loc = activeLocation?.id ? `&location_id=${activeLocation.id}` : '';
      if (isSeason) {
        const data = await api(`/ops/reports/seasonal?start_date=${startDate}&end_date=${endDate}&mode=${mode}${loc}`);
        setSeason(data);
      } else {
        const data = await api(`/ops/reports/summary?start_date=${startDate}&end_date=${endDate}&mode=${mode}${loc}`);
        setSummary(data);
      }
    } catch {
      setError('Failed to load report.');
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate, mode, activeLocation?.id, isSeason]);

  useEffect(() => { fetchSummary(); }, [fetchSummary]);

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
              {(['today', 'week', 'season', 'custom'] as const).map(p => (
                <button
                  key={p}
                  className={`rp-preset-btn${preset === p ? ' active' : ''}`}
                  onClick={() => applyPreset(p)}
                >
                  {p === 'today' ? 'Today' : p === 'week' ? 'This Week' : p === 'season' ? 'Season' : 'Custom'}
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
                onChange={e => { setStartDate(e.target.value); setPreset(p => (p === 'season' ? 'season' : 'custom')); }}
              />
            </div>
            <div className="rp-date-group">
              <label className="rp-label">To</label>
              <input
                type="date"
                className="rp-date-input"
                value={endDate}
                onChange={e => { setEndDate(e.target.value); setPreset(p => (p === 'season' ? 'season' : 'custom')); }}
              />
            </div>
            <button className="btn btn-primary btn-sm" onClick={fetchSummary} disabled={loading}>
              {loading ? '…' : 'Run'}
            </button>
          </div>
        </div>

        {error && <div className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}

        {loading && !(isSeason ? season : summary) && (
          <div style={{ textAlign: 'center', padding: 60 }}>
            <div className="spinner spinner-lg" style={{ margin: '0 auto' }} />
          </div>
        )}

        {isSeason && season && <SeasonSection data={season} />}

        {!isSeason && summary && (
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

            {/* ── Firewood ── */}
            {Object.keys(summary.firewood_by_product).length > 0 && (
              <div className="card rp-section">
                <div className="rp-section-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>Firewood</span>
                  <span style={{ fontWeight: 800, color: 'var(--gray-900)' }}>{fmtCords(summary.total_cords)} total</span>
                </div>
                {Object.entries(summary.firewood_by_product)
                  .sort(([, a], [, b]) => b.cords - a.cords)
                  .map(([name, data]) => (
                    <div key={name} className="rp-bar-row" style={{ gridTemplateColumns: '1fr auto' }}>
                      <div className="rp-bar-label">{name}</div>
                      <div className="rp-bar-val" style={{ textAlign: 'right' }}>
                        {data.units_sold} sold · {fmtCords(data.cords)}
                      </div>
                    </div>
                  ))}
              </div>
            )}

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

.rp-ctype-dp { padding: 0 16px 14px; }
.rp-ctype-dp-bar { height: 6px; border-radius: 3px; background: var(--gray-200, #e5e7eb); overflow: hidden; }
.rp-ctype-dp-fill { height: 100%; border-radius: 3px; background: var(--brand); transition: width 0.4s; }
.rp-ctype-dp-legend { display: flex; justify-content: space-between; margin-top: 4px; font-size: 10px; font-weight: 700; color: var(--gray-400); }

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

/* ── Season view ── */
.rp-presets { flex-wrap: wrap; }
.rp-kpi-val--sm { font-size: 18px; }
.rp-sn-metric { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 16px; }
.rp-sn-body { padding: 14px 20px 16px; }
.rp-sn-detail { font-size: 12px; font-weight: 600; color: var(--gray-600); min-height: 18px; margin-top: 10px; line-height: 1.4; }
.rp-sn-bars { display: flex; align-items: flex-end; gap: 2px; height: 120px; }
.rp-sn-bar { flex: 1; min-width: 0; padding: 0; border: none; border-radius: 3px 3px 0 0; background: var(--brand); opacity: 0.35; cursor: pointer; }
.rp-sn-bar.top { opacity: 1; }
.rp-sn-bar.sel { outline: 2px solid var(--gray-900); outline-offset: 1px; }
.rp-sn-ticks { display: flex; gap: 2px; margin-top: 4px; }
.rp-sn-ticks span { flex: 1; min-width: 0; font-size: 10px; font-weight: 700; color: var(--gray-400); white-space: nowrap; overflow: visible; }
.rp-sn-heat { display: grid; grid-template-columns: 44px repeat(7, minmax(0, 1fr)); gap: 3px; }
.rp-sn-heat-h { font-size: 10px; font-weight: 700; color: var(--gray-400); text-align: center; }
.rp-sn-heat-wk { font-size: 10px; font-weight: 700; color: var(--gray-500); align-self: center; white-space: nowrap; }
.rp-sn-cell { position: relative; height: 18px; padding: 0; border: none; border-radius: 3px; background: var(--gray-100); overflow: hidden; cursor: pointer; }
.rp-sn-cell.sel { outline: 2px solid var(--gray-900); outline-offset: 1px; overflow: visible; }
.rp-sn-cell-fill { position: absolute; inset: 0; border-radius: 3px; background: var(--brand); }
.rp-sn-sub { padding: 14px 20px 6px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--gray-400); }
.rp-sn-note { padding: 6px 20px 0; font-size: 12px; color: var(--gray-500); }
.rp-sn-prod { padding: 12px 20px; border-bottom: 1px solid var(--border-light); }
.rp-sn-prod-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 2px 8px; margin-bottom: 6px; }
.rp-sn-prod-name { font-size: 13px; font-weight: 700; color: var(--gray-800); }
.rp-sn-prod-meta { font-size: 11px; font-weight: 600; color: var(--gray-500); }
.rp-sn-months { display: flex; align-items: flex-end; gap: 3px; height: 32px; }
.rp-sn-month { flex: 1; min-width: 0; border-radius: 2px 2px 0 0; background: var(--brand); opacity: 0.6; }
.rp-sn-month-axis, .rp-sn-hour-axis { display: flex; gap: 3px; padding: 6px 20px 14px; }
.rp-sn-month-axis span, .rp-sn-hour-axis span { flex: 1; min-width: 0; text-align: center; font-size: 10px; font-weight: 700; color: var(--gray-400); }
.rp-sn-more { display: block; width: 100%; padding: 12px; border: none; border-top: 1px solid var(--border-light); background: none; font-family: inherit; font-size: 13px; font-weight: 700; color: var(--brand); cursor: pointer; }
.rp-sn-tiles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; padding: 0 20px; }
.rp-sn-tile { padding: 12px; border-radius: var(--radius-md); background: var(--gray-50, #f9fafb); }
.rp-sn-tile-val { font-size: 20px; font-weight: 800; line-height: 1.1; color: var(--gray-900); font-family: var(--font-heading); }
.rp-sn-tile-label { margin-top: 4px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--gray-400); }
.rp-sn-hours { display: flex; align-items: flex-end; gap: 3px; height: 60px; padding: 0 20px; }
.rp-sn-hour { flex: 1; min-width: 0; border-radius: 2px 2px 0 0; background: var(--brand); opacity: 0.6; }
`;
