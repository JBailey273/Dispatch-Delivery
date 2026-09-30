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

function fmtWhole$(n: number) {
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

// Month label under the first week of each month; drops a label that would collide with the next one
function monthTicks(weekStarts: string[]) {
  const labels = weekStarts.map((k, i) => {
    const m = parseKey(k).getMonth();
    return i === 0 || parseKey(weekStarts[i - 1]).getMonth() !== m ? MONTH_SHORT[m] : '';
  });
  return labels.map((l, i) => (l && (labels[i + 1] || labels[i + 2]) ? '' : l));
}

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

      <div className="rp-print-note">Weekly chart, heatmap and weekday averages show {metric}.</div>

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
                        {monthTicks(data.weeks.map(w => w.week_start)).map((label, i) => (
              <span key={data.weeks[i].week_start}>{label}</span>
            ))}
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
        {data.products.length > 6 && !showAllProducts && (
          <div className="rp-print-note rp-print-note--list">Top 6 of {data.products.length} products shown</div>
        )}
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

// ── Contractors view ───────────────────────────────────────────

type Breakdown = { materials: number; delivery: number; tax: number; other: number; covered_orders: number; covered_revenue: number; pending_orders: number };
type SegStat = { orders: number; yards: number; revenue: number; deliveries: number; pickups: number; avg_order_yards: number; avg_order_value: number; breakdown: Breakdown };
type FillState = { run: () => void; running: boolean; message: string };
type ContractorAccount = {
  customer_id: string;
  name: string;
  contact: string;
  phone: string;
  orders: number;
  yards: number;
  revenue: number;
  avg_order_yards: number;
  avg_order_value: number;
  share_of_contractor_yards: number;
  deliveries: number;
  pickups: number;
  delivery_fees: number;
  fee_orders: number;
  materials: { product: string; yards: number; share: number }[];
  first_order_date: string | null;
  last_order_date: string | null;
  days_since_last_order: number | null;
  is_new: boolean;
};
type ContractorReport = {
  contractor: SegStat;
  residential: SegStat;
  share: { yards: number; revenue: number; orders: number };
  accounts_active: number;
  accounts_new: number;
  top5_share_of_contractor_yards: number;
  avg_spend_per_account: number;
  accounts: ContractorAccount[];
  products: { product: string; contractor_yards: number; residential_yards: number; contractor_share: number }[];
  weeks: { week_start: string; contractor_yards: number; residential_yards: number; contractor_revenue: number }[];
  weekday: { label: string; orders: number; yards: number }[];
  window_split: { A: number; B: number };
};

type AccountSort = 'yards' | 'spend' | 'orders' | 'recent';

function fmtPhone(e164: string) {
  const m = e164.replace(/\D/g, '').match(/^1?(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

function RevenueSplit({ b, fill }: { b: Breakdown; fill: FillState }) {
  const parts = [
    { key: 'materials', label: 'Materials', val: b.materials },
    { key: 'delivery', label: 'Delivery', val: b.delivery },
    { key: 'tax', label: 'Tax', val: b.tax },
    ...(b.other ? [{ key: 'other', label: 'Other', val: b.other }] : []),
  ];
  const total = parts.reduce((t, p) => t + Math.max(p.val, 0), 0);
  return (
    <div className="card rp-section">
      <div className="rp-section-head">Revenue Breakdown</div>
      {b.covered_orders === 0 ? (
        <p className="rp-empty">No fee breakdown yet for orders in this range.</p>
      ) : (
        <div className="rp-sn-body">
          <div className="rp-rv-bar">
            {parts.map(p => p.val > 0 && (
              <div key={p.key} className={`rp-rv-seg rp-rv-seg--${p.key}`} style={{ flexGrow: p.val }} title={`${p.label}: ${fmt$(p.val)}`} />
            ))}
          </div>
          <div className="rp-rv-grid">
            {parts.map(p => (
              <div key={p.key} className="rp-rv-item">
                <div className="rp-rv-label"><i className={`rp-cn-dot rp-rv-dot--${p.key}`} />{p.label}</div>
                <div className="rp-rv-val" title={fmt$(p.val)}>{fmtWhole$(p.val)}</div>
                <div className="rp-rv-pct">{total > 0 ? Math.round(p.val / total * 100) : 0}%</div>
              </div>
            ))}
          </div>
        </div>
      )}
      {b.pending_orders > 0 && (
        <div className="rp-rv-pending">
          <span>
            Based on {b.covered_orders.toLocaleString('en-US')} of {(b.covered_orders + b.pending_orders).toLocaleString('en-US')} orders.
            {' '}{b.pending_orders.toLocaleString('en-US')} still need their fee breakdown from WooCommerce.
          </span>
          <button className="btn btn-secondary btn-sm rp-rv-fill" onClick={fill.run} disabled={fill.running}>
            {fill.running ? 'Filling in…' : 'Fill in missing'}
          </button>
        </div>
      )}
      {fill.message && <div className="rp-rv-msg">{fill.message}</div>}
    </div>
  );
}

function ContractorSection({ data, fill }: { data: ContractorReport; fill: FillState }) {
  const [sort, setSort] = useState<AccountSort>('yards');
  const [open, setOpen] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  if (data.accounts.length === 0) {
    return <div className="card rp-section"><p className="rp-empty">No contractor orders in this range.</p></div>;
  }

  const c = data.contractor;
  const r = data.residential;
  const sorted = [...data.accounts].sort((a, b) => {
    if (sort === 'spend') return b.revenue - a.revenue;
    if (sort === 'orders') return b.orders - a.orders;
    if (sort === 'recent') return (a.days_since_last_order ?? 9999) - (b.days_since_last_order ?? 9999);
    return b.yards - a.yards;
  });
  const shown = showAll ? sorted : sorted.slice(0, 10);
  const showNewBadge = data.accounts_new < data.accounts_active;
  const maxAcctYards = Math.max(...data.accounts.map(a => a.yards), 1);
  const maxWeek = Math.max(...data.weeks.map(w => w.contractor_yards + w.residential_yards), 1);
  const maxDow = Math.max(...data.weekday.map(w => w.yards), 1);
  const winTotal = data.window_split.A + data.window_split.B;
  const amPct = winTotal > 0 ? Math.round(data.window_split.A / winTotal * 100) : 0;
  const delivPct = c.orders > 0 ? Math.round(c.deliveries / c.orders * 100) : 0;

  return (
    <>
      {/* ── Contractor KPIs ── */}
      <div className="rp-kpi-grid">
        <div className="card rp-kpi">
          <div className="rp-kpi-val">{fmtCompact$(c.revenue)}</div>
          <div className="rp-kpi-label">Contractor Spend</div>
          <div className="rp-kpi-sub">{data.share.revenue}% of revenue</div>
        </div>
        <div className="card rp-kpi">
          <div className="rp-kpi-val">{fmtYards(Math.round(c.yards))}</div>
          <div className="rp-kpi-label">Yards</div>
          <div className="rp-kpi-sub">{data.share.yards}% of all yards</div>
        </div>
        <div className="card rp-kpi">
          <div className="rp-kpi-val">{c.orders.toLocaleString('en-US')}</div>
          <div className="rp-kpi-label">Orders</div>
          <div className="rp-kpi-sub">{data.share.orders}% of all orders</div>
        </div>
        <div className="card rp-kpi">
          <div className="rp-kpi-val">{data.accounts_active}</div>
          <div className="rp-kpi-label">Accounts</div>
          <div className="rp-kpi-sub">{data.accounts_new} new · avg {fmtCompact$(data.avg_spend_per_account)}</div>
        </div>
      </div>

      <RevenueSplit b={c.breakdown} fill={fill} />

      {/* ── Contractor vs residential ── */}
      <div className="card rp-section">
        <div className="rp-section-head">Contractor Share of Business</div>
        <div className="rp-sn-body">
          {([['Orders', data.share.orders], ['Yards', data.share.yards], ['Revenue', data.share.revenue]] as const).map(([label, pct]) => (
            <div key={label} className="rp-cn-share">
              <div className="rp-cn-share-top"><span>{label}</span><span>{pct}% contractor</span></div>
              <div className="rp-cn-split"><div style={{ width: `${pct}%` }} /></div>
            </div>
          ))}
          <div className="rp-cn-legend"><span><i className="rp-cn-dot rp-cn-dot--con" />Contractor</span><span><i className="rp-cn-dot rp-cn-dot--res" />Residential</span></div>
        </div>
        <div className="rp-sn-tiles" style={{ paddingBottom: 16 }}>
          <div className="rp-sn-tile">
            <div className="rp-sn-tile-val">{fmtYards(c.avg_order_yards)} · {fmtCompact$(c.avg_order_value)}</div>
            <div className="rp-sn-tile-label">Avg contractor order</div>
          </div>
          <div className="rp-sn-tile">
            <div className="rp-sn-tile-val">{fmtYards(r.avg_order_yards)} · {fmtCompact$(r.avg_order_value)}</div>
            <div className="rp-sn-tile-label">Avg residential order</div>
          </div>
        </div>
      </div>

      {/* ── Accounts ── */}
      <div className="card rp-section">
        <div className="rp-section-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <span>Accounts</span>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--gray-500)' }}>Top 5 = {data.top5_share_of_contractor_yards}% of contractor yards</span>
        </div>
        <div className="rp-cn-sort">
          {(['yards', 'spend', 'orders', 'recent'] as const).map(s => (
            <button key={s} className={`rp-preset-btn${sort === s ? ' active' : ''}`} onClick={() => setSort(s)}>
              {s === 'yards' ? 'Yards' : s === 'spend' ? 'Spend' : s === 'orders' ? 'Orders' : 'Recent'}
            </button>
          ))}
        </div>
        {shown.map(a => {
          const isOpen = open === a.customer_id;
          const quiet = (a.days_since_last_order ?? 0) > 30;
          return (
            <div key={a.customer_id} className="rp-cn-acct">
              <button className="rp-cn-acct-row" onClick={() => setOpen(isOpen ? null : a.customer_id)} aria-expanded={isOpen}>
                <div className="rp-cn-acct-main">
                  <div className="rp-cn-acct-name">
                    <span className="rp-cn-acct-name-text">{a.name}</span>
                    {a.is_new && showNewBadge && <span className="rp-cn-badge">New</span>}
                  </div>
                  <div className="rp-cn-acct-meta">
                    {a.orders} order{a.orders !== 1 ? 's' : ''} · avg {fmtYards(a.avg_order_yards)} ·{' '}
                    <span style={quiet ? { color: 'var(--amber-600, #d97706)' } : undefined}>
                      {a.days_since_last_order === null ? '—' : a.days_since_last_order === 0 ? 'today' : `${a.days_since_last_order}d ago`}
                    </span>
                  </div>
                  <div className="rp-cn-acct-bar"><div style={{ width: `${Math.round(a.yards / maxAcctYards * 100)}%` }} /></div>
                  {!isOpen && (
                    <div className="rp-cn-print-mats">{a.materials.map(m => `${m.product} ${fmtYards(m.yards)}`).join(' · ')}</div>
                  )}
                </div>
                <div className="rp-cn-acct-right">
                  <div className="rp-cn-acct-yards">{fmtYards(a.yards)}</div>
                  <div className="rp-cn-acct-spend">{fmtCompact$(a.revenue)}</div>
                </div>
              </button>
              {isOpen && (
                <div className="rp-cn-acct-open">
                  <div className="rp-cn-mat-head">Materials ordered</div>
                  {a.materials.map(m => (
                    <div key={m.product} className="rp-cn-mat">
                      <div className="rp-cn-mat-name">{m.product}</div>
                      <div className="rp-cn-mat-track"><div style={{ width: `${Math.round(m.yards / (a.materials[0]?.yards || 1) * 100)}%` }} /></div>
                      <div className="rp-cn-mat-val">{fmtYards(m.yards)} <span>{Math.round(m.share)}%</span></div>
                    </div>
                  ))}
                  <div className="rp-cn-acct-detail">
                    <div><span>Total spend</span><b>{fmt$(a.revenue)}</b></div>
                    <div><span>Avg order</span><b>{fmtYards(a.avg_order_yards)} · {fmt$(a.avg_order_value)}</b></div>
                    <div><span>Share of contractor yards</span><b>{a.share_of_contractor_yards}%</b></div>
                    <div><span>Delivery / pickup</span><b>🚚 {a.deliveries} · 🏪 {a.pickups}</b></div>
                    <div><span>Delivery fees</span><b>{a.fee_orders ? fmt$(a.delivery_fees) : '—'}</b></div>
                    <div><span>First order</span><b>{a.first_order_date ? parseKey(a.first_order_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</b></div>
                    <div><span>Contact</span><b>{a.contact !== a.name ? `${a.contact} · ` : ''}<a href={`tel:${a.phone}`}>{fmtPhone(a.phone)}</a></b></div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {data.accounts.length > 10 && !showAll && (
          <div className="rp-print-note rp-print-note--list">Top 10 of {data.accounts.length} accounts shown · sorted by {sort === 'recent' ? 'most recent order' : sort}</div>
        )}
        {data.accounts.length > 10 && (
          <button className="rp-sn-more" onClick={() => setShowAll(s => !s)}>
            {showAll ? 'Show top 10' : `Show all ${data.accounts.length} accounts`}
          </button>
        )}
      </div>

      {/* ── Weekly volume ── */}
      <div className="card rp-section">
        <div className="rp-section-head">Weekly Yards</div>
        <div className="rp-sn-body">
          <div className="rp-sn-bars">
            {data.weeks.map(w => {
              const total = w.contractor_yards + w.residential_yards;
              return (
                <div
                  key={w.week_start}
                  className="rp-cn-stack"
                  title={`Week of ${fmtShortDate(w.week_start)}: ${fmtYards(w.contractor_yards)} contractor · ${fmtYards(w.residential_yards)} residential`}
                  style={{ height: `${Math.max(total / maxWeek * 100, total > 0 ? 3 : 0)}%` }}
                >
                  <div className="rp-cn-stack-res" style={{ flexGrow: w.residential_yards }} />
                  <div className="rp-cn-stack-con" style={{ flexGrow: w.contractor_yards }} />
                </div>
              );
            })}
          </div>
          <div className="rp-sn-ticks">
            {monthTicks(data.weeks.map(w => w.week_start)).map((label, i) => (
              <span key={data.weeks[i].week_start}>{label}</span>
            ))}
          </div>
          <div className="rp-cn-legend" style={{ marginTop: 10 }}><span><i className="rp-cn-dot rp-cn-dot--con" />Contractor</span><span><i className="rp-cn-dot rp-cn-dot--res" />Residential</span></div>
        </div>
      </div>

      {/* ── Products ── */}
      <div className="card rp-section">
        <div className="rp-section-head">Contractor Products</div>
        {data.products.filter(p => p.contractor_yards > 0).map(p => (
          <div key={p.product} className="rp-cn-prod">
            <div className="rp-cn-share-top">
              <span className="rp-cn-prod-name">{p.product}</span>
              <span>{fmtYards(p.contractor_yards)} · {p.contractor_share}% of product</span>
            </div>
            <div className="rp-cn-split"><div style={{ width: `${p.contractor_share}%` }} /></div>
          </div>
        ))}
      </div>

      {/* ── When contractors order ── */}
      <div className="card rp-section">
        <div className="rp-section-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>When Contractors Order</span>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--gray-500)' }}>yards · orders</span>
        </div>
        {data.weekday.map(w => (
          <div key={w.label} className="rp-bar-row" style={{ gridTemplateColumns: '48px 1fr 110px' }}>
            <div className="rp-bar-label">{w.label}</div>
            <div className="rp-bar-track"><div className="rp-bar-fill" style={{ width: `${Math.round(w.yards / maxDow * 100)}%` }} /></div>
            <div className="rp-bar-val">{fmtYards(w.yards)} · {w.orders}</div>
          </div>
        ))}
        {winTotal > 0 && (
          <div className="rp-split-bar-wrap" style={{ paddingTop: 14 }}>
            <div className="rp-split-bar"><div className="rp-split-bar-delivery" style={{ width: `${amPct}%` }} /></div>
            <span className="rp-split-pct">{amPct}% AM · {100 - amPct}% PM loads</span>
          </div>
        )}
        <div className="rp-sn-note" style={{ paddingBottom: 16 }}>{delivPct}% of contractor orders are deliveries.</div>
      </div>
    </>
  );
}

// ── Residential view ───────────────────────────────────────────

type ResidentialReport = {
  totals: { orders: number; yards: number; revenue: number; deliveries: number; pickups: number; customers: number; avg_order_yards: number; avg_order_value: number };
  share: { orders: number; yards: number; revenue: number };
  breakdown: Breakdown;
  products: { product: string; yards: number }[];
  top_customers: { name: string; town: string; orders: number; yards: number; revenue: number; delivery_fees: number }[];
  towns: { town: string; state: string; deliveries: number; yards: number; revenue: number; delivery_fees: number; fee_orders: number; avg_fee: number | null; share_of_deliveries: number }[];
};

type TownSort = 'deliveries' | 'fees' | 'yards';

function ResidentialSection({ data, fill }: { data: ResidentialReport; fill: FillState }) {
  const [townSort, setTownSort] = useState<TownSort>('deliveries');
  const [showAllTowns, setShowAllTowns] = useState(false);

  if (data.totals.orders === 0) {
    return <div className="card rp-section"><p className="rp-empty">No residential orders in this range.</p></div>;
  }

  const t = data.totals;
  const maxProd = Math.max(...data.products.map(p => p.yards), 1);
  const towns = [...data.towns].sort((a, b) =>
    townSort === 'fees' ? b.delivery_fees - a.delivery_fees : townSort === 'yards' ? b.yards - a.yards : b.deliveries - a.deliveries,
  );
  const shownTowns = showAllTowns ? towns : towns.slice(0, 12);
  const townMetric = (x: ResidentialReport['towns'][number]) => (townSort === 'fees' ? x.delivery_fees : townSort === 'yards' ? x.yards : x.deliveries);
  const maxTown = Math.max(...towns.map(townMetric), 1);
  const feeTotal = data.towns.reduce((s, x) => s + x.delivery_fees, 0);
  const townLabel = (x: { town: string; state: string }) => (x.state && x.state !== 'MA' ? `${x.town}, ${x.state}` : x.town);

  return (
    <>
      {/* ── Residential KPIs ── */}
      <div className="rp-kpi-grid">
        <div className="card rp-kpi">
          <div className="rp-kpi-val">{fmtCompact$(t.revenue)}</div>
          <div className="rp-kpi-label">Residential Spend</div>
          <div className="rp-kpi-sub">{data.share.revenue}% of revenue</div>
        </div>
        <div className="card rp-kpi">
          <div className="rp-kpi-val">{fmtYards(Math.round(t.yards))}</div>
          <div className="rp-kpi-label">Yards</div>
          <div className="rp-kpi-sub">{data.share.yards}% of all yards</div>
        </div>
        <div className="card rp-kpi">
          <div className="rp-kpi-val">{t.orders.toLocaleString('en-US')}</div>
          <div className="rp-kpi-label">Orders</div>
          <div className="rp-kpi-sub">🚚 {t.deliveries} · 🏪 {t.pickups}</div>
        </div>
        <div className="card rp-kpi">
          <div className="rp-kpi-val">{t.customers.toLocaleString('en-US')}</div>
          <div className="rp-kpi-label">Customers</div>
          <div className="rp-kpi-sub">avg order {fmtYards(t.avg_order_yards)} · {fmtCompact$(t.avg_order_value)}</div>
        </div>
      </div>

      <RevenueSplit b={data.breakdown} fill={fill} />

      {/* ── Deliveries by town ── */}
      <div className="card rp-section">
        <div className="rp-section-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <span>Deliveries by Town</span>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--gray-500)' }}>
            {t.deliveries} to {data.towns.length} town{data.towns.length !== 1 ? 's' : ''} · {fmtWhole$(feeTotal)} fees
          </span>
        </div>
        <div className="rp-cn-sort">
          {(['deliveries', 'fees', 'yards'] as const).map(s => (
            <button key={s} className={`rp-preset-btn${townSort === s ? ' active' : ''}`} onClick={() => setTownSort(s)}>
              {s === 'deliveries' ? 'Deliveries' : s === 'fees' ? 'Fees' : 'Yards'}
            </button>
          ))}
        </div>
        {data.towns.length === 0 && <p className="rp-empty">No residential deliveries in this range.</p>}
        {shownTowns.map(x => (
          <div key={`${x.town}|${x.state}`} className="rp-rs-town">
            <div className="rp-rs-town-top">
              <span className="rp-rs-town-name">{townLabel(x)}</span>
              <span className="rp-rs-town-count">
                {townSort === 'fees' ? fmtWhole$(x.delivery_fees) : townSort === 'yards' ? fmtYards(x.yards) : `${x.deliveries} deliver${x.deliveries !== 1 ? 'ies' : 'y'}`}
              </span>
            </div>
            <div className="rp-cn-acct-bar"><div style={{ width: `${Math.round(townMetric(x) / maxTown * 100)}%` }} /></div>
            <div className="rp-rs-town-meta">
              {x.share_of_deliveries}% of deliveries · {x.fee_orders ? `${fmtWhole$(x.delivery_fees)} fees · avg ${fmtWhole$(x.avg_fee ?? 0)}` : 'fees pending'} · {fmtYards(x.yards)} · {fmtCompact$(x.revenue)} spend
            </div>
          </div>
        ))}
        {towns.length > 12 && !showAllTowns && (
          <div className="rp-print-note rp-print-note--list">Top 12 of {towns.length} towns shown</div>
        )}
        {towns.length > 12 && (
          <button className="rp-sn-more" onClick={() => setShowAllTowns(v => !v)}>
            {showAllTowns ? 'Show top 12' : `Show all ${towns.length} towns`}
          </button>
        )}
      </div>

      {/* ── Materials ── */}
      <div className="card rp-section">
        <div className="rp-section-head">Residential Materials</div>
        {data.products.length === 0 && <p className="rp-empty">No material volume in this range.</p>}
        {data.products.map(p => (
          <div key={p.product} className="rp-bar-row">
            <div className="rp-bar-label">{p.product}</div>
            <div className="rp-bar-track"><div className="rp-bar-fill" style={{ width: `${Math.round(p.yards / maxProd * 100)}%` }} /></div>
            <div className="rp-bar-val">{fmtYards(p.yards)}</div>
          </div>
        ))}
      </div>

      {/* ── Top customers ── */}
      <div className="card rp-section">
        <div className="rp-section-head">Top 10 Residential Customers</div>
        {data.top_customers.map((cu, i) => (
          <div key={`${cu.name}-${i}`} className="rp-rs-cust">
            <div className="rp-rs-rank">{i + 1}</div>
            <div className="rp-cn-acct-main">
              <div className="rp-cn-acct-name"><span className="rp-cn-acct-name-text">{cu.name}</span></div>
              <div className="rp-cn-acct-meta">
                {cu.town ? `${cu.town} · ` : ''}{cu.orders} order{cu.orders !== 1 ? 's' : ''} · {fmtYards(cu.yards)}
              </div>
            </div>
            <div className="rp-cn-acct-right">
              <div className="rp-cn-acct-yards">{fmtWhole$(cu.revenue)}</div>
              {cu.delivery_fees > 0 && <div className="rp-cn-acct-spend">{fmtWhole$(cu.delivery_fees)} fees</div>}
            </div>
          </div>
        ))}
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
  const [contractors, setContractors] = useState<ContractorReport | null>(null);
  const [residential, setResidential] = useState<ResidentialReport | null>(null);
  const [view, setView] = useState<'overview' | 'contractors' | 'residential'>('overview');
  const [filling, setFilling] = useState(false);
  const [fillMessage, setFillMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { activeLocation } = useLocation();
  // Printing always uses the light theme, then restores whatever was on screen
  useEffect(() => {
    let prevTheme: string | null = null;
    let active = false;
    const before = () => {
      if (active) return;
      active = true;
      const root = document.documentElement;
      prevTheme = root.getAttribute('data-theme');
      root.setAttribute('data-theme', 'light');
    };
    const after = () => {
      if (!active) return;
      active = false;
      if (prevTheme !== null) document.documentElement.setAttribute('data-theme', prevTheme);
    };
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', after);
    return () => {
      window.removeEventListener('beforeprint', before);
      window.removeEventListener('afterprint', after);
    };
  }, []);
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
      if (view === 'contractors') {
        const data = await api(`/ops/reports/contractors?start_date=${startDate}&end_date=${endDate}&mode=${mode}${loc}`);
        setContractors(data);
      } else if (view === 'residential') {
        const data = await api(`/ops/reports/residential?start_date=${startDate}&end_date=${endDate}&mode=${mode}${loc}`);
        setResidential(data);
      } else if (isSeason) {
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
  }, [startDate, endDate, mode, activeLocation?.id, isSeason, view]);

  useEffect(() => { fetchSummary(); }, [fetchSummary]);

  // Pull materials / delivery / tax for past orders from WooCommerce, 50 orders per request
  const fillBreakdown = useCallback(async () => {
    const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
    setFilling(true);
    setFillMessage('Starting…');
    let before: string | null = null;
    let filled = 0;
    let skipped = 0;
    let waits = 0;
    let result = '';
    try {
      for (let i = 0; i < 500; i++) {
        const r = await api(
          `/ops/reports/backfill-breakdown?limit=50${before ? `&before=${encodeURIComponent(before)}` : ''}`,
          { method: 'POST' },
        );
        if (r.blocked) {
          waits += 1;
          if (waits > 4) {
            result = `Paused after ${filled.toLocaleString('en-US')} orders. WooCommerce is limiting requests; press again in a few minutes to continue.`;
            break;
          }
          setFillMessage(`WooCommerce asked us to slow down. Waiting ${waits * 20}s…`);
          await pause(waits * 20000);
          continue;
        }
        waits = 0;
        filled += r.updated;
        skipped += Object.values(r.skipped as Record<string, number>).reduce((a, b) => a + b, 0);
        before = r.next_before;
        if (!r.left_to_try || !before) {
          result = `Done. Filled in ${filled.toLocaleString('en-US')} orders.`
            + (skipped ? ` ${skipped.toLocaleString('en-US')} couldn't be matched to a WooCommerce order and were skipped.` : '');
          break;
        }
        setFillMessage(`Filled in ${filled.toLocaleString('en-US')} orders · ${Number(r.left_to_try).toLocaleString('en-US')} to go…`);
        await pause(1000);
      }
      setFillMessage(result || `Filled in ${filled.toLocaleString('en-US')} orders.`);
    } catch {
      setFillMessage(`Stopped after ${filled.toLocaleString('en-US')} orders. Couldn't reach Loadout's server. Press again to continue.`);
    } finally {
      setFilling(false);
      fetchSummary();
    }
  }, [fetchSummary]);
  const fill: FillState = { run: fillBreakdown, running: filling, message: fillMessage };

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
          <div className="rp-header-actions">
            <button className="btn btn-ghost btn-sm" onClick={() => window.print()} disabled={loading}>Print</button>
            <Link href="/ops-dashboard" className="btn btn-ghost btn-sm" style={{ textDecoration: 'none' }}>← Dashboard</Link>
          </div>
        </div>

        {/* ── Print-only header ── */}
        <div className="rp-print-head">
          <div className="rp-print-title">
            {view === 'contractors' ? 'Contractor Report' : view === 'residential' ? 'Residential Report' : isSeason ? 'Season Report' : 'Summary Report'}
          </div>
          <div className="rp-print-meta">
            {parseKey(startDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            {startDate !== endDate && ` – ${parseKey(endDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`}
            {' · '}{mode === 'booked' ? 'By booked date' : 'By fulfilled date'}
            {' · '}{activeLocation?.name ?? 'All locations'}
          </div>
          <div className="rp-print-meta">Printed {new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>
        </div>

        {/* ── View Tabs ── */}
        <div className="rp-view-tabs" role="tablist">
          {(['overview', 'contractors', 'residential'] as const).map(v => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              className={`rp-view-tab${view === v ? ' active' : ''}`}
              onClick={() => setView(v)}
            >
              {v === 'overview' ? 'Overview' : v === 'contractors' ? 'Contractors' : 'Residential'}
            </button>
          ))}
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

        {loading && !(view === 'contractors' ? contractors : view === 'residential' ? residential : isSeason ? season : summary) && (
          <div style={{ textAlign: 'center', padding: 60 }}>
            <div className="spinner spinner-lg" style={{ margin: '0 auto' }} />
          </div>
        )}

        {view === 'contractors' && contractors && <ContractorSection data={contractors} fill={fill} />}

        {view === 'residential' && residential && <ResidentialSection data={residential} fill={fill} />}

        {view === 'overview' && isSeason && season && <SeasonSection data={season} />}

        {view === 'overview' && !isSeason && summary && (
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
.rp-header-actions { display: flex; gap: 8px; flex-shrink: 0; }
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

/* ── View tabs + Contractors view ── */
.rp-view-tabs { display: flex; gap: 4px; padding: 4px; margin-bottom: 12px; border-radius: 100px; background: var(--gray-100); }
.rp-view-tab { flex: 1; padding: 8px 12px; border: none; border-radius: 100px; background: none; font-family: inherit; font-size: 14px; font-weight: 700; color: var(--gray-500); cursor: pointer; }
.rp-view-tab.active { background: var(--surface); color: var(--gray-900); box-shadow: 0 1px 2px rgba(0,0,0,0.08); }
.rp-kpi-sub { margin-top: 4px; font-size: 11px; font-weight: 600; color: var(--gray-500); }
.rp-cn-share { margin-bottom: 12px; }
.rp-cn-share-top { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 5px; font-size: 12px; font-weight: 600; color: var(--gray-500); }
.rp-cn-share-top span:first-child { font-weight: 700; color: var(--gray-800); }
.rp-cn-split { height: 10px; border-radius: 5px; background: var(--brand-green, #4a7052); overflow: hidden; }
.rp-cn-split > div { height: 100%; background: var(--brand); }
.rp-cn-legend { display: flex; gap: 16px; font-size: 11px; font-weight: 700; color: var(--gray-500); }
.rp-cn-dot { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; }
.rp-cn-dot--con { background: var(--brand); }
.rp-cn-dot--res { background: var(--brand-green, #4a7052); }
.rp-cn-sort { display: flex; gap: 6px; flex-wrap: wrap; padding: 12px 20px; border-bottom: 1px solid var(--border-light); }
.rp-cn-acct { border-bottom: 1px solid var(--border-light); }
.rp-cn-acct-row { display: flex; align-items: flex-start; gap: 12px; width: 100%; padding: 12px 20px; border: none; background: none; text-align: left; font-family: inherit; cursor: pointer; }
.rp-cn-acct-main { flex: 1; min-width: 0; }
.rp-cn-acct-name { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 14px; font-weight: 700; color: var(--gray-900); }
.rp-cn-acct-name-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rp-cn-badge { flex-shrink: 0; padding: 1px 7px; border-radius: 100px; background: var(--blue-25, #eff6ff); color: var(--brand); font-size: 10px; font-weight: 800; text-transform: uppercase; }
.rp-cn-acct-meta { margin-top: 2px; font-size: 12px; font-weight: 600; color: var(--gray-500); }
.rp-cn-acct-bar { height: 4px; margin-top: 8px; border-radius: 2px; background: var(--gray-100); overflow: hidden; }
.rp-cn-acct-bar > div { height: 100%; border-radius: 2px; background: var(--brand); }
.rp-cn-acct-right { flex-shrink: 0; text-align: right; }
.rp-cn-acct-yards { font-size: 15px; font-weight: 800; color: var(--gray-900); font-family: var(--font-heading); }
.rp-cn-acct-spend { margin-top: 2px; font-size: 12px; font-weight: 700; color: var(--gray-600); }
.rp-cn-acct-open { padding: 0 20px 14px; }
.rp-cn-mat-head { margin-bottom: 6px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--gray-400); }
.rp-cn-mat { display: grid; grid-template-columns: minmax(0, 1fr) 64px 88px; align-items: center; gap: 10px; padding: 4px 0; }
.rp-cn-mat-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 600; color: var(--gray-800); }
.rp-cn-mat-track { height: 6px; border-radius: 3px; background: var(--gray-100); overflow: hidden; }
.rp-cn-mat-track > div { height: 100%; border-radius: 3px; background: var(--brand); }
.rp-cn-mat-val { text-align: right; font-size: 12px; font-weight: 700; color: var(--gray-700); white-space: nowrap; }
.rp-cn-mat-val span { font-weight: 600; color: var(--gray-400); }
.rp-cn-acct-detail { display: grid; gap: 8px; margin-top: 12px; padding-top: 12px; border-top: 1px dashed var(--border-light); }
.rp-cn-acct-detail > div { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; }
.rp-cn-acct-detail span { flex-shrink: 0; color: var(--gray-500); font-weight: 600; }
.rp-cn-acct-detail b { text-align: right; color: var(--gray-800); font-weight: 700; }
.rp-cn-acct-detail a { color: var(--brand); text-decoration: none; }
.rp-cn-stack { flex: 1; min-width: 0; display: flex; flex-direction: column; border-radius: 3px 3px 0 0; overflow: hidden; }
.rp-cn-stack-con { background: var(--brand); }
.rp-cn-stack-res { background: var(--brand-green, #4a7052); opacity: 0.55; }
.rp-cn-prod { padding: 10px 20px; border-bottom: 1px solid var(--border-light); }
.rp-cn-prod:last-child { border-bottom: none; }
.rp-cn-prod-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ── Revenue breakdown + Residential ── */
.rp-rv-bar { display: flex; height: 12px; border-radius: 6px; overflow: hidden; background: var(--gray-100); }
.rp-rv-seg { min-width: 3px; }
.rp-rv-seg--materials, .rp-rv-dot--materials { background: var(--brand); }
.rp-rv-seg--delivery, .rp-rv-dot--delivery { background: var(--brand-green, #4a7052); }
.rp-rv-seg--tax, .rp-rv-dot--tax { background: var(--gray-400, #9ca3af); }
.rp-rv-seg--other, .rp-rv-dot--other { background: var(--gray-300, #d1d5db); }
.rp-rv-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(88px, 1fr)); gap: 8px; margin-top: 14px; }
.rp-rv-item { padding: 10px 12px; border-radius: var(--radius-md); background: var(--gray-50, #f9fafb); }
.rp-rv-label { display: flex; align-items: center; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--gray-500); }
.rp-rv-label .rp-cn-dot { flex-shrink: 0; }
.rp-rv-val { margin-top: 4px; font-size: 16px; font-weight: 800; color: var(--gray-900); font-family: var(--font-heading); white-space: nowrap; }
.rp-rv-pct { font-size: 12px; font-weight: 700; color: var(--gray-500); }
.rp-rv-pending { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 20px; border-top: 1px solid var(--border-light); font-size: 12px; font-weight: 600; color: var(--gray-500); }
.rp-rv-fill { flex-shrink: 0; }
.rp-rv-msg { padding: 0 20px 12px; font-size: 12px; font-weight: 700; color: var(--brand); }
.rp-rs-town { padding: 10px 20px; border-bottom: 1px solid var(--border-light); }
.rp-rs-town-top { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
.rp-rs-town-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 700; color: var(--gray-900); }
.rp-rs-town-count { flex-shrink: 0; font-size: 14px; font-weight: 800; color: var(--gray-900); font-family: var(--font-heading); }
.rp-rs-town-meta { margin-top: 5px; font-size: 11px; font-weight: 600; color: var(--gray-500); line-height: 1.4; }
.rp-rs-cust { display: flex; align-items: flex-start; gap: 12px; padding: 10px 20px; border-bottom: 1px solid var(--border-light); }
.rp-rs-cust:last-child { border-bottom: none; }
.rp-rs-rank { flex-shrink: 0; width: 22px; height: 22px; border-radius: 50%; background: var(--gray-100); color: var(--gray-600); font-size: 11px; font-weight: 800; display: flex; align-items: center; justify-content: center; }
@media (max-width: 480px) { .rp-rv-pending { flex-direction: column; align-items: flex-start; } }
/* ── Print ── */
.rp-print-head, .rp-print-note, .rp-cn-print-mats { display: none; }
@media print {
  @page { size: letter; margin: 0.5in; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { background: #fff !important; }
  .app-shell, .app-content { display: block !important; height: auto !important; overflow: visible !important; background: #fff !important; }
  .app-sidebar, .mobile-tab-bar, .mobile-drawer, .mobile-drawer-backdrop, .notif-toast-stack, .notif-panel, .notif-panel-backdrop { display: none !important; }
  .page.rp-page { max-width: none; margin: 0; padding: 0; }
  .rp-header, .rp-view-tabs, .rp-controls, .rp-sn-metric, .rp-cn-sort, .rp-sn-more, .rp-sn-detail, .alert { display: none !important; }
  .rp-print-head { display: block; margin-bottom: 14px; padding-bottom: 10px; border-bottom: 2px solid #111; }
  .rp-print-title { font-size: 20px; font-weight: 800; color: #111; }
  .rp-print-meta { margin-top: 2px; font-size: 11px; font-weight: 600; color: #555; }
  .rp-print-note { display: block; margin: 0 0 10px; font-size: 11px; font-weight: 600; color: #555; }
  .rp-print-note--list { margin: 0; padding: 8px 16px; }
  .rp-cn-print-mats { display: block; margin-top: 5px; font-size: 10px; font-weight: 600; color: #555; line-height: 1.4; }
  .card { box-shadow: none !important; }
  .rp-kpi-grid { grid-template-columns: repeat(4, 1fr) !important; gap: 8px; margin-bottom: 10px; }
  .rp-kpi { padding: 12px 8px; }
  .rp-kpi-val { font-size: 20px; }
  .rp-kpi-val--sm { font-size: 15px; }
  .rp-two-col { grid-template-columns: 1fr 1fr !important; }
  .rp-section { margin-bottom: 10px; break-inside: avoid; }
  .rp-section:has(.rp-cn-acct), .rp-section:has(.rp-sn-heat), .rp-section:has(.rp-sn-prod) { break-inside: auto; }
  .rp-section-head { break-after: avoid; }
  .rp-cn-acct, .rp-sn-prod, .rp-bar-row, .rp-rs-town, .rp-rs-cust { break-inside: avoid; }
  .rp-rv-fill, .rp-rv-msg { display: none !important; }
  .rp-section:has(.rp-rs-town) { break-inside: auto; }
  .rp-cn-acct-row { padding: 8px 16px; }
  .rp-cn-acct-open { padding-bottom: 8px; }
  .rp-sn-bar.sel, .rp-sn-cell.sel { outline: none; }
}
`;
