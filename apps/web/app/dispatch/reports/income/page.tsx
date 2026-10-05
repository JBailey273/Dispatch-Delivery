'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, requireRole } from '../../../lib/auth';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

type Row = { label: string; amount: number; orders: number };
type RefundItem = { order_number: string; date: string; amount: number; reason: string };
type StripeUnmatched = {
  date: string; kind: 'charge' | 'refund'; amount: number;
  order: string | null; ref: string | null; note: string; description: string;
};
type StripeData = {
  error?: string;
  gross_charges: number; charge_count: number; refunds: number;
  fees: number; net: number; payouts: number; card_tender_diff: number;
  unmatched?: StripeUnmatched[]; unmatched_charges?: number; unmatched_refunds?: number;
};
type Sheet = {
  year: number; month: number; month_closed: boolean; generated_at: string; cached: boolean;
  rows: Row[];
  gross_sales: number;
  refunds: { total: number; count: number; items: RefundItem[] };
  net_income: number;
  sales_tax: { collected: number; taxable_sales: number; nontaxable_sales: number };
  total_collected: number;
  unexplained: number;
  tender: { card: number; cash: number; other: number };
  stripe: StripeData | null;
  memo: { unpaid_invoice_total: number; unpaid_invoice_count: number; quick_drops: number };
  unmapped: string[];
  other_fee_names: string[];
  order_count: number;
  orders: { number: string; paid: string; total: number; tender: string }[];
};

function fmt$(n: number) {
  const s = '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? '−' + s : s;
}

function fmtStamp(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }) + ' ET';
}

function fmtShortDate(ds: string) {
  const d = new Date(ds + 'T12:00:00');
  return `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}`;
}

const TENDER_LABELS: Record<string, string> = { card: 'Card', cash: 'Cash / check', other: 'Other' };

export default function IncomeSheetPage() {
  // Default to last month — the one you're closing out
  const now = new Date();
  const [year, setYear] = useState(now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() === 0 ? 12 : now.getMonth());
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showDetail, setShowDetail] = useState(false);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError('');
    try {
      const data = await api(`/finance/income-sheet?year=${year}&month=${month}${refresh ? '&refresh=true' : ''}`);
      setSheet(data);
    } catch {
      setError("Couldn't build the income sheet. Try again in a minute.");
    } finally {
      setLoading(false);
    }
  }, [year, month]);

  useEffect(() => { load(); }, [load]);

  const shiftMonth = (delta: number) => {
    let m = month + delta;
    let y = year;
    if (m < 1) { m = 12; y -= 1; }
    if (m > 12) { m = 1; y += 1; }
    setSheet(null);
    setYear(y);
    setMonth(m);
  };

  const isFutureMonth = year > now.getFullYear() || (year === now.getFullYear() && month >= now.getMonth() + 1);

  if (!requireRole(['admin'])) return <div className="page"><p>Unauthorized</p></div>;

  const visibleRows = sheet?.rows.filter(r =>
    !((r.label === 'Other Fees' || r.label === 'Uncategorized') && r.amount === 0)
  ) ?? [];
  const tenderTotal = sheet ? sheet.tender.card + sheet.tender.cash + sheet.tender.other : 0;
  const tenderMatches = sheet ? Math.abs(tenderTotal - sheet.total_collected) < 0.01 : false;

  return (
    <>
      <style>{styles}</style>
      <div className="page is-page">

        {/* ── Controls (hidden in print) ── */}
        <div className="is-controls no-print">
          <div className="is-top">
            <div>
              <h1>Income sheet</h1>
              <p className="is-sub">Monthly income by QuickBooks item · cash basis</p>
            </div>
            <Link href="/dispatch/reports" className="btn btn-ghost btn-sm" style={{ textDecoration: 'none' }}>← Reports</Link>
          </div>

          <div className="card is-bar">
            <div className="is-month">
              <button className="btn btn-ghost btn-sm" onClick={() => shiftMonth(-1)} disabled={loading} aria-label="Previous month">‹</button>
              <span className="is-month-label">{MONTHS[month - 1]} {year}</span>
              <button className="btn btn-ghost btn-sm" onClick={() => shiftMonth(1)} disabled={loading || isFutureMonth} aria-label="Next month">›</button>
            </div>
            <div className="is-actions">
              <button className="btn btn-ghost btn-sm" onClick={() => load(true)} disabled={loading}>
                {loading ? 'Building…' : 'Refresh'}
              </button>
              <button className="btn btn-primary btn-sm" onClick={() => window.print()} disabled={!sheet || loading}>Print</button>
            </div>
          </div>

          {sheet && !sheet.month_closed && (
            <div className="alert is-note">This month isn't over yet — figures will change.</div>
          )}
          {sheet?.cached && (
            <div className="is-hint">Saved copy from {fmtStamp(sheet.generated_at)}. Refresh to rebuild from live data.</div>
          )}
        </div>

        {error && <div className="alert alert-error no-print" style={{ marginBottom: 16 }}>{error}</div>}

        {loading && !sheet && (
          <div className="no-print" style={{ textAlign: 'center', padding: 60 }}>
            <div className="spinner spinner-lg" style={{ margin: '0 auto' }} />
            <p className="is-hint" style={{ marginTop: 12 }}>Pulling the month from WooCommerce and Stripe…</p>
          </div>
        )}

        {sheet && (
          <div className="card is-sheet is-print">

            <div className="is-head">
              <div>
                <div className="is-title">Income posting sheet</div>
                <div className="is-meta">East Meadow Garden Center · cash basis</div>
              </div>
              <div className="is-head-right">
                <div className="is-title">{MONTHS[sheet.month - 1]} {sheet.year}</div>
                <div className="is-meta">Generated {fmtStamp(sheet.generated_at)}</div>
              </div>
            </div>

            {/* Warnings that must be resolved before posting */}
            {(sheet.unmapped.length > 0 || Math.abs(sheet.unexplained) >= 0.01) && (
              <div className="is-warn">
                {sheet.unmapped.length > 0 && (
                  <div><strong>Uncategorized products:</strong> {sheet.unmapped.join(', ')}. Add their SKUs to the report map.</div>
                )}
                {Math.abs(sheet.unexplained) >= 0.01 && (
                  <div><strong>Doesn't tie out by {fmt$(sheet.unexplained)}:</strong> order totals differ from items + tax. Check order detail before posting.</div>
                )}
              </div>
            )}

            {/* ── Income ── */}
            <div className="is-sec">Income by QuickBooks item</div>
            <table className="is-table">
              <tbody>
                {visibleRows.map(r => (
                  <tr key={r.label} className={r.amount === 0 ? 'is-zero' : ''}>
                    <td>
                      {r.label}
                      {r.orders > 0 && <span className="is-q">{r.orders} order{r.orders === 1 ? '' : 's'}</span>}
                      {r.label === 'Other Fees' && sheet.other_fee_names.length > 0 && (
                        <span className="is-q">{sheet.other_fee_names.join(', ')}</span>
                      )}
                    </td>
                    <td className="is-r">{fmt$(r.amount)}</td>
                  </tr>
                ))}
                <tr className="is-sub-row"><td>Gross sales</td><td className="is-r">{fmt$(sheet.gross_sales)}</td></tr>
                <tr>
                  <td>Refunds{sheet.refunds.count > 0 && <span className="is-q">{sheet.refunds.count}</span>}</td>
                  <td className="is-r is-neg">{fmt$(-sheet.refunds.total)}</td>
                </tr>
                <tr className="is-total"><td>Net income</td><td className="is-r">{fmt$(sheet.net_income)}</td></tr>
              </tbody>
            </table>

            {/* ── Sales tax ── */}
            <div className="is-sec">Sales tax — liability, not income</div>
            <table className="is-table">
              <tbody>
                <tr><td>Taxable sales</td><td className="is-r">{fmt$(sheet.sales_tax.taxable_sales)}</td></tr>
                <tr><td>Non-taxable sales</td><td className="is-r">{fmt$(sheet.sales_tax.nontaxable_sales)}</td></tr>
                <tr><td>Sales tax collected</td><td className="is-r">{fmt$(sheet.sales_tax.collected)}</td></tr>
                <tr className="is-total"><td>Total collected from customers</td><td className="is-r">{fmt$(sheet.total_collected)}</td></tr>
              </tbody>
            </table>

            {/* ── Reconciliation ── */}
            <div className="is-grid">
              <div>
                <div className="is-sec">Tender</div>
                <table className="is-table">
                  <tbody>
                    <tr><td>Card / Stripe</td><td className="is-r">{fmt$(sheet.tender.card)}</td></tr>
                    <tr><td>Cash / check</td><td className="is-r">{fmt$(sheet.tender.cash)}</td></tr>
                    {sheet.tender.other !== 0 && <tr><td>Other</td><td className="is-r">{fmt$(sheet.tender.other)}</td></tr>}
                    <tr className="is-total">
                      <td>{tenderMatches ? 'Matches total' : 'Does not match'}</td>
                      <td className={`is-r ${tenderMatches ? 'is-ok' : 'is-neg'}`}>{tenderMatches ? '✓ ' : ''}{fmt$(tenderTotal)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div>
                <div className="is-sec">Stripe</div>
                {!sheet.stripe && <p className="is-hint">Stripe isn't configured.</p>}
                {sheet.stripe?.error && <p className="is-hint">{sheet.stripe.error}</p>}
                {sheet.stripe && !sheet.stripe.error && (
                  <table className="is-table">
                    <tbody>
                      <tr><td>Charges<span className="is-q">{sheet.stripe.charge_count}</span></td><td className="is-r">{fmt$(sheet.stripe.gross_charges)}</td></tr>
                      <tr><td>Refunds</td><td className="is-r is-neg">{fmt$(-sheet.stripe.refunds)}</td></tr>
                      <tr><td>Fees — post as expense</td><td className="is-r is-neg">{fmt$(-sheet.stripe.fees)}</td></tr>
                      <tr className="is-total"><td>Net to bank</td><td className="is-r">{fmt$(sheet.stripe.net)}</td></tr>
                      <tr><td className="is-muted">Payouts sent this month</td><td className="is-r is-muted">{fmt$(sheet.stripe.payouts)}</td></tr>
                      {Math.abs(sheet.stripe.card_tender_diff) >= 0.01 && (
                        <tr><td colSpan={2} className="is-flag">
                          Stripe charges differ from card tender by {fmt$(sheet.stripe.card_tender_diff)} — likely duplicate charges, order edits, or payments recorded outside Loadout.
                        </td></tr>
                      )}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            {/* ── Stripe items that don't line up ── */}
            {sheet.stripe && !sheet.stripe.error && (sheet.stripe.unmatched?.length ?? 0) > 0 && (
              <>
                <div className="is-sec">Stripe activity not matched to this sheet</div>
                <table className="is-table is-small">
                  <tbody>
                    {sheet.stripe.unmatched!.map((u, i) => (
                      <tr key={(u.ref || '') + i}>
                        <td>
                          {fmtShortDate(u.date)} · {u.kind === 'charge' ? 'Charge' : 'Refund'}{u.order ? ` · #${u.order}` : ''}
                          <span className="is-q is-why">{u.note}</span>
                        </td>
                        <td className={`is-r ${u.kind === 'refund' ? 'is-neg' : ''}`}>{fmt$(u.kind === 'refund' ? -u.amount : u.amount)}</td>
                      </tr>
                    ))}
                    <tr className="is-total">
                      <td>Unmatched charges / refunds</td>
                      <td className="is-r">{fmt$(sheet.stripe.unmatched_charges ?? 0)} / {fmt$(-(sheet.stripe.unmatched_refunds ?? 0))}</td>
                    </tr>
                  </tbody>
                </table>
              </>
            )}

            {/* ── Memo ── */}
            <div className="is-memo">
              <span>Unpaid contractor invoices today: {fmt$(sheet.memo.unpaid_invoice_total)} ({sheet.memo.unpaid_invoice_count}) — not income until paid</span>
              <span>{sheet.memo.quick_drops} Quick Drops excluded (no revenue)</span>
              <span>{sheet.order_count} paid orders</span>
            </div>

            {/* ── Detail appendix ── */}
            <div className="no-print" style={{ marginTop: 12 }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowDetail(v => !v)}>
                {showDetail ? 'Hide order detail' : 'Show order detail'}
              </button>
            </div>
            {showDetail && (
              <div className="is-detail">
                <div className="is-sec">Paid orders</div>
                <table className="is-table is-small">
                  <tbody>
                    {sheet.orders.map(o => (
                      <tr key={o.number + o.paid}>
                        <td>#{o.number}<span className="is-q">{fmtShortDate(o.paid)} · {TENDER_LABELS[o.tender] || o.tender}</span></td>
                        <td className="is-r">{fmt$(o.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {sheet.refunds.items.length > 0 && (
                  <>
                    <div className="is-sec">Refunds</div>
                    <table className="is-table is-small">
                      <tbody>
                        {sheet.refunds.items.map((r, i) => (
                          <tr key={r.order_number + i}>
                            <td>#{r.order_number}<span className="is-q">{fmtShortDate(r.date)}{r.reason ? ` · ${r.reason}` : ''}</span></td>
                            <td className="is-r is-neg">{fmt$(-r.amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

const styles = `
  .is-page { max-width: 760px; margin: 0 auto; }
  .is-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 16px; }
  .is-sub { color: var(--gray-500); margin-top: 2px; font-size: 14px; }
  .is-bar { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; padding: 12px 16px; margin-bottom: 12px; }
  .is-month { display: flex; align-items: center; gap: 8px; }
  .is-month-label { font-weight: 700; font-size: 17px; min-width: 150px; text-align: center; }
  .is-actions { display: flex; gap: 8px; }
  .is-note { background: #fffbeb; border: 1px solid #fde68a; color: #92400e; margin-bottom: 12px; font-size: 14px; }
  .is-hint { font-size: 13px; color: var(--gray-500); margin-bottom: 12px; }

  .is-sheet { padding: 20px; font-variant-numeric: tabular-nums; }
  .is-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; padding-bottom: 12px; border-bottom: 2px solid var(--gray-900, #222); }
  .is-head-right { text-align: right; }
  .is-title { font-size: 18px; font-weight: 800; }
  .is-meta { font-size: 12px; color: var(--gray-500); margin-top: 2px; }

  .is-warn { margin-top: 14px; padding: 10px 12px; border: 1px solid #fecaca; background: #fef2f2; color: #991b1b; border-radius: 8px; font-size: 13px; display: grid; gap: 6px; }
  .is-sec { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--gray-500); margin: 20px 0 4px; }

  .is-table { width: 100%; border-collapse: collapse; font-size: 15px; }
  .is-table td { padding: 8px 0; border-bottom: 1px solid var(--gray-100, #eee); vertical-align: baseline; }
  .is-table.is-small { font-size: 13px; }
  .is-table.is-small td { padding: 5px 0; }
  .is-r { text-align: right; white-space: nowrap; padding-left: 12px !important; }
  .is-q { display: inline-block; margin-left: 8px; font-size: 12px; color: var(--gray-400); }
  .is-zero td { color: var(--gray-400); }
  .is-sub-row td { font-weight: 700; border-top: 1px solid var(--gray-300, #ccc); }
  .is-total td { font-weight: 800; border-bottom: none; border-top: 2px solid var(--gray-900, #222); }
  .is-neg { color: #b91c1c; }
  .is-ok { color: var(--green-700, #15803d); }
  .is-muted { color: var(--gray-500); font-size: 13px; }
  .is-flag { font-size: 12px; color: #92400e; background: #fffbeb; padding: 8px !important; border-radius: 6px; }

  .is-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 0 28px; }
  .is-memo { margin-top: 18px; padding-top: 10px; border-top: 1px solid var(--gray-100, #eee); font-size: 12px; color: var(--gray-500); display: flex; flex-wrap: wrap; gap: 6px 18px; }
  .is-detail { margin-top: 8px; }
  .is-why { display: block; margin-left: 0; margin-top: 2px; }

  @media (max-width: 480px) {
    .is-sheet { padding: 14px; }
    .is-head-right { text-align: left; }
    .is-table { font-size: 14px; }
    .is-q { display: block; margin-left: 0; }
    .is-month-label { min-width: 0; }
  }

  @media print {
    @page { size: letter portrait; margin: 0.5in; }
    body * { visibility: hidden; }
    .is-print, .is-print * { visibility: visible; }
    .is-print { position: absolute; left: 0; top: 0; width: 100%; border: none !important; box-shadow: none !important; padding: 0 !important; }
    .no-print { display: none !important; }
    .is-table { font-size: 12px; }
    .is-table td { padding: 5px 0; }
    .is-q { display: inline-block !important; margin-left: 8px !important; }
    .is-head-right { text-align: right !important; }
    .is-warn, .is-flag { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
`;
