'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, requireRole } from '../../../lib/auth';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

type Line = { account: string; memo: string; debit: number; credit: number };
type Attention = { date: string; kind: string; amount: number; order: string | null; ref: string | null; note: string };
type Sheet = {
  year: number; month: number; entry_date: string; month_closed: boolean;
  generated_at: string; cached: boolean;
  lines: Line[]; total_debit: number; total_credit: number; balanced: boolean;
  stripe_ok: boolean; stripe_error: string | null;
  clearing_check: number | null;
  attention: Attention[];
  summary: {
    gross_sales: number; refunds: number; tax_collected: number; tax_refunded: number;
    card_collected: number; cash_collected: number;
  };
  misc_items: string[];
  unpaid_invoices: { total: number; count: number };
  orders: { number: string; paid: string; total: number; tender: string }[];
  refund_items: { order_number: string; date: string; amount: number; tender: string; reason: string }[];
};

function fmt$(n: number) {
  const s = '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? '−' + s : s;
}
function fmtAmt(n: number) {
  return n ? Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function fmtStamp(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }) + ' ET';
}
function fmtDate(ds: string) {
  if (!ds) return '';
  const d = new Date(ds + 'T12:00:00');
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

export default function IncomeSheetPage() {
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
      setError("Couldn't build the journal entry. Try again in a minute.");
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

  const isCurrentOrFuture = year > now.getFullYear() || (year === now.getFullYear() && month >= now.getMonth() + 1);

  if (!requireRole(['admin'])) return <div className="page"><p>Unauthorized</p></div>;

  const readyToPost = !!sheet && sheet.balanced && sheet.stripe_ok && sheet.month_closed;

  return (
    <>
      <style>{styles}</style>
      <div className="page je-page">

        {/* ── Controls ── */}
        <div className="no-print">
          <div className="je-top">
            <div>
              <h1>Month-end journal entry</h1>
              <p className="je-sub">Type each line into QuickBooks as a General Journal Entry</p>
            </div>
            <Link href="/dispatch/reports" className="btn btn-ghost btn-sm" style={{ textDecoration: 'none' }}>← Reports</Link>
          </div>

          <div className="card je-bar">
            <div className="je-month">
              <button className="btn btn-ghost btn-sm" onClick={() => shiftMonth(-1)} disabled={loading} aria-label="Previous month">‹</button>
              <span className="je-month-label">{MONTHS[month - 1]} {year}</span>
              <button className="btn btn-ghost btn-sm" onClick={() => shiftMonth(1)} disabled={loading || isCurrentOrFuture} aria-label="Next month">›</button>
            </div>
            <div className="je-actions">
              <button className="btn btn-ghost btn-sm" onClick={() => load(true)} disabled={loading}>
                {loading ? 'Building…' : 'Refresh'}
              </button>
              <button className="btn btn-primary btn-sm" onClick={() => window.print()} disabled={!sheet || loading}>Print</button>
            </div>
          </div>

          {sheet?.cached && (
            <div className="je-hint">Saved copy from {fmtStamp(sheet.generated_at)}. Refresh to rebuild from live data.</div>
          )}
        </div>

        {error && <div className="alert alert-error no-print" style={{ marginBottom: 16 }}>{error}</div>}

        {loading && !sheet && (
          <div className="no-print" style={{ textAlign: 'center', padding: 60 }}>
            <div className="spinner spinner-lg" style={{ margin: '0 auto' }} />
            <p className="je-hint" style={{ marginTop: 12 }}>Pulling the month from WooCommerce and Stripe…</p>
          </div>
        )}

        {sheet && (
          <div className="card je-sheet je-print">

            <div className="je-head">
              <div>
                <div className="je-title">General journal entry</div>
                <div className="je-meta">East Meadow Garden Center · cash basis</div>
              </div>
              <div className="je-head-right">
                <div className="je-title">{MONTHS[sheet.month - 1]} {sheet.year}</div>
                <div className="je-meta">Entry date {fmtDate(sheet.entry_date)}</div>
              </div>
            </div>

            {/* ── Status ── */}
            {!sheet.month_closed && <div className="je-banner je-warn">This month isn't over yet. Don't post until it closes.</div>}
            {sheet.stripe_error && <div className="je-banner je-bad">{sheet.stripe_error}</div>}
            {readyToPost && <div className="je-banner je-ok">✓ Balanced and ready to post</div>}

            {/* ── The entry ── */}
            <table className="je-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th className="je-r">Debit</th>
                  <th className="je-r">Credit</th>
                </tr>
              </thead>
              <tbody>
                {sheet.lines.map((l, i) => (
                  <tr key={i}>
                    <td>
                      <div className="je-acct">{l.account}</div>
                      {l.memo && <div className="je-memo">{l.memo}</div>}
                    </td>
                    <td className="je-r je-num">{fmtAmt(l.debit)}</td>
                    <td className="je-r je-num">{fmtAmt(l.credit)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Totals {sheet.balanced ? <span className="je-tick">✓ balanced</span> : <span className="je-x">out of balance</span>}</td>
                  <td className="je-r je-num">{fmtAmt(sheet.total_debit)}</td>
                  <td className="je-r je-num">{fmtAmt(sheet.total_credit)}</td>
                </tr>
              </tfoot>
            </table>

            {/* ── One check after posting ── */}
            {sheet.clearing_check !== null && (
              <div className="je-check">
                <div className="je-check-label">After posting, POS Clearing in QuickBooks should read</div>
                <div className="je-check-val">{fmt$(sheet.clearing_check)}</div>
                <div className="je-check-note">This is what Stripe is holding that hasn't reached Monson Savings yet. If QuickBooks shows a different number, the items below explain the gap.</div>
              </div>
            )}

            {/* ── Needs attention ── */}
            {sheet.attention.length > 0 && (
              <div className="je-attn">
                <div className="je-sec">Needs attention in Stripe</div>
                {sheet.attention.map((a, i) => (
                  <div key={i} className="je-attn-row">
                    <div>
                      <div className="je-acct">
                        {a.date ? fmtDate(a.date) + ' · ' : ''}{a.kind}{a.order ? ` · #${a.order}` : ''}
                      </div>
                      <div className="je-memo">{a.note}</div>
                    </div>
                    <div className="je-num">{fmt$(a.amount)}</div>
                  </div>
                ))}
              </div>
            )}

            {sheet.misc_items.length > 0 && (
              <div className="je-foot">Misc Sales includes: {sheet.misc_items.join(', ')}</div>
            )}
            <div className="je-foot">
              Not in this entry: {fmt$(sheet.unpaid_invoices.total)} in unpaid contractor invoices ({sheet.unpaid_invoices.count}). They post in the month they're paid.
            </div>

            {/* ── Supporting detail ── */}
            <div className="no-print" style={{ marginTop: 14 }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowDetail(v => !v)}>
                {showDetail ? 'Hide supporting detail' : 'Show supporting detail'}
              </button>
            </div>
            {showDetail && (
              <div className="je-detail">
                <div className="je-sec">Month at a glance</div>
                <div className="je-kv">
                  <span>Sales before tax</span><span>{fmt$(sheet.summary.gross_sales)}</span>
                  <span>Sales tax collected</span><span>{fmt$(sheet.summary.tax_collected)}</span>
                  <span>Customer refunds (incl. tax)</span><span>{fmt$(-sheet.summary.refunds)}</span>
                  <span>Collected by card</span><span>{fmt$(sheet.summary.card_collected)}</span>
                  <span>Collected cash / check</span><span>{fmt$(sheet.summary.cash_collected)}</span>
                </div>

                {sheet.refund_items.length > 0 && (
                  <>
                    <div className="je-sec">Refunds</div>
                    {sheet.refund_items.map((r, i) => (
                      <div key={i} className="je-attn-row">
                        <div>
                          <div className="je-acct">#{r.order_number} · {fmtDate(r.date)} · {r.tender === 'card' ? 'Card' : 'Cash / check'}</div>
                          {r.reason && <div className="je-memo">{r.reason}</div>}
                        </div>
                        <div className="je-num">{fmt$(-r.amount)}</div>
                      </div>
                    ))}
                  </>
                )}

                <div className="je-sec">Paid orders ({sheet.orders.length})</div>
                {sheet.orders.map(o => (
                  <div key={o.number + o.paid} className="je-attn-row">
                    <div className="je-acct">#{o.number} · {fmtDate(o.paid)} · {o.tender === 'card' ? 'Card' : 'Cash / check'}</div>
                    <div className="je-num">{fmt$(o.total)}</div>
                  </div>
                ))}
              </div>
            )}

            <div className="je-stamp">Generated {fmtStamp(sheet.generated_at)}</div>
          </div>
        )}
      </div>
    </>
  );
}

const styles = `
  .je-page { max-width: 760px; margin: 0 auto; }
  .je-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 16px; }
  .je-sub { color: var(--gray-500); margin-top: 2px; font-size: 14px; }
  .je-bar { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; padding: 12px 16px; margin-bottom: 12px; }
  .je-month { display: flex; align-items: center; gap: 8px; }
  .je-month-label { font-weight: 700; font-size: 17px; min-width: 150px; text-align: center; }
  .je-actions { display: flex; gap: 8px; }
  .je-hint { font-size: 13px; color: var(--gray-500); margin-bottom: 12px; }

  .je-sheet { padding: 20px; font-variant-numeric: tabular-nums; }
  .je-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; padding-bottom: 12px; border-bottom: 2px solid #222; }
  .je-head-right { text-align: right; }
  .je-title { font-size: 18px; font-weight: 800; }
  .je-meta { font-size: 12px; color: var(--gray-500); margin-top: 2px; }

  .je-banner { margin-top: 14px; padding: 10px 12px; border-radius: 8px; font-size: 14px; font-weight: 600; }
  .je-ok { background: #f0fdf4; border: 1px solid #bbf7d0; color: #15803d; }
  .je-warn { background: #fffbeb; border: 1px solid #fde68a; color: #92400e; }
  .je-bad { background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; }

  .je-table { width: 100%; border-collapse: collapse; margin-top: 14px; font-size: 15px; }
  .je-table th { text-align: left; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--gray-500); padding: 0 0 6px; border-bottom: 1px solid #ccc; }
  .je-table td { padding: 9px 0; border-bottom: 1px solid var(--gray-100, #eee); vertical-align: top; }
  .je-table tfoot td { font-weight: 800; border-bottom: none; border-top: 2px solid #222; }
  .je-r { text-align: right; width: 110px; padding-left: 10px !important; }
  .je-num { white-space: nowrap; font-weight: 600; }
  .je-acct { font-weight: 600; }
  .je-memo { font-size: 12px; color: var(--gray-500); margin-top: 1px; }
  .je-tick { font-size: 12px; color: #15803d; margin-left: 6px; }
  .je-x { font-size: 12px; color: #b91c1c; margin-left: 6px; }

  .je-check { margin-top: 18px; padding: 14px; border: 1px solid #ccc; border-radius: 10px; }
  .je-check-label { font-size: 13px; color: var(--gray-500); }
  .je-check-val { font-size: 22px; font-weight: 800; margin: 2px 0 4px; }
  .je-check-note { font-size: 12px; color: var(--gray-500); }

  .je-sec { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--gray-500); margin: 18px 0 4px; }
  .je-attn-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; padding: 7px 0; border-bottom: 1px solid var(--gray-100, #eee); font-size: 14px; }
  .je-attn .je-acct { color: #92400e; }
  .je-foot { margin-top: 12px; font-size: 12px; color: var(--gray-500); }
  .je-kv { display: grid; grid-template-columns: 1fr auto; gap: 6px 12px; font-size: 14px; }
  .je-kv span:nth-child(even) { text-align: right; font-weight: 600; }
  .je-stamp { margin-top: 14px; font-size: 11px; color: var(--gray-400); }

  @media (max-width: 480px) {
    .je-sheet { padding: 14px; }
    .je-head-right { text-align: left; }
    .je-table { font-size: 14px; }
    .je-r { width: 84px; }
    .je-month-label { min-width: 0; }
  }

  @media print {
    @page { size: letter portrait; margin: 0.5in; }
    body * { visibility: hidden; }
    .je-print, .je-print * { visibility: visible; }
    .je-print { position: absolute; left: 0; top: 0; width: 100%; border: none !important; box-shadow: none !important; padding: 0 !important; }
    .no-print { display: none !important; }
    .je-table { font-size: 12px; }
    .je-table td { padding: 6px 0; }
    .je-head-right { text-align: right !important; }
    .je-banner { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
`;
