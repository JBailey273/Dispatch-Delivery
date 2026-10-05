"""
Finance reports — admin only.

Monthly income posting sheet (cash basis) for month-end entry into
QuickBooks Desktop. Read-only: pulls paid orders from WooCommerce,
fees/charges/payouts from Stripe, and two memo figures from the local DB.

Paid-date rules (cash basis = the day money was received, Eastern time):
  - Contractor invoice paid by cash/check  -> _emgc_invoice_batch_date meta
  - Contractor invoice charged to card     -> _emgc_invoice_batch_date meta
  - Invoice order not yet paid             -> excluded (not income yet)
  - Payment link                           -> Stripe PaymentIntent created time
                                              (unpaid links excluded)
  - Counter cash/card, website checkout    -> WC date_paid_gmt
We do NOT trust WC date_paid for invoice / payment-link orders: those are
created in 'processing' status, which can stamp date_paid at creation and
ignore set_paid later.
"""
import logging
import time as _time
import urllib.parse
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.api.deps import AuthUser, db_dep, require_roles
from app.api.routes.internal_orders import _stripe, _wc_request
from app.core.config import settings
from app.models.entities import Drop, UserRole

logger = logging.getLogger("dispatch.finance")
router = APIRouter(prefix="/finance", tags=["finance"])

EASTERN = ZoneInfo("America/New_York")

# ── Income rows (one per QuickBooks income item), in print order ─────────────
DELIVERY_ROW = "Delivery Income"
OTHER_FEES_ROW = "Other Fees"
UNCATEGORIZED_ROW = "Uncategorized"

INCOME_ROWS = [
    "Mulch",
    "Wood Chips",
    "Topsoil",
    "Garden Soil",
    "Compost",
    "Fill",
    "Firewood",
    "Brush / Yard Waste Disposal",
    "Hauling",
    DELIVERY_ROW,
    OTHER_FEES_ROW,
    UNCATEGORIZED_ROW,
]

# SKU -> income row. Keys are uppercase; matching ignores case.
# New products: add a line here. Anything unmapped shows as Uncategorized.
SKU_TO_ROW = {
    "BROWNMULCH": "Mulch",
    "NATURALMULCH": "Mulch",
    "BLACKMULCH": "Mulch",
    "HEMLOCKMULCH": "Mulch",
    "REDMULCH": "Mulch",
    "AGEDHEMLOCK": "Mulch",
    "PLAYGROUND": "Mulch",
    "CHIPS": "Wood Chips",
    "TOPSOIL": "Topsoil",
    "GARDENSOIL": "Garden Soil",
    "COMPOST": "Compost",
    "FILL": "Fill",
    "1CORDFIREWOOD": "Firewood",
    "HALFCORDFIREWOOD": "Firewood",
    "DISPOSAL": "Brush / Yard Waste Disposal",
    "DEBRISHAULING": "Hauling",
}

# Fallback by product name, for line items that come back without a SKU.
NAME_TO_ROW = {
    "dark brown mulch": "Mulch",
    "natural double ground mulch": "Mulch",
    "black mulch": "Mulch",
    "hemlock mulch": "Mulch",
    "red mulch": "Mulch",
    "aged hemlock mulch": "Mulch",
    "playground mulch": "Mulch",
    "whole tree wood chips": "Wood Chips",
    "screened topsoil": "Topsoil",
    "premium garden soil": "Garden Soil",
    "screened compost": "Compost",
    "unscreened fill": "Fill",
    "1 cord firewood": "Firewood",
    "1/2 cord firewood": "Firewood",
    "brush disposal": "Brush / Yard Waste Disposal",
    "debris hauling": "Hauling",
}

WC_FIELDS = (
    "id,number,status,date_paid_gmt,date_modified_gmt,total,total_tax,"
    "shipping_total,shipping_tax,line_items,fee_lines,refunds,payment_method,transaction_id,meta_data"
)
WC_PAGE_SIZE = 100
WC_MAX_PAGES = 60
WC_PAUSE_SECONDS = 0.3  # be gentle with Hostinger (429s)

# Closed months are cached in-process; ?refresh=true rebuilds.
_SHEET_CACHE: dict[tuple, dict] = {}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _money(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def _meta(o: dict) -> dict:
    return {m.get("key"): m.get("value") for m in (o.get("meta_data") or [])}


def _gmt_to_local_date(s: str | None) -> date | None:
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", ""))
    except ValueError:
        return None
    return dt.replace(tzinfo=timezone.utc).astimezone(EASTERN).date()


def _row_for_line(li: dict) -> str | None:
    sku = (li.get("sku") or "").strip().upper()
    if sku in SKU_TO_ROW:
        return SKU_TO_ROW[sku]
    return NAME_TO_ROW.get((li.get("name") or "").strip().lower())


def _pi_created_local_date(ref: str, cache: dict) -> date | None:
    """Payment date for a payment-link order, from the Stripe PaymentIntent."""
    if not ref or not ref.startswith("pi_") or not settings.stripe_api_key:
        return None
    if ref in cache:
        return cache[ref]
    result = None
    try:
        pi = _stripe().PaymentIntent.retrieve(ref)
        result = datetime.fromtimestamp(pi.created, tz=timezone.utc).astimezone(EASTERN).date()
    except Exception as e:
        logger.warning(f"income_sheet: could not retrieve PI {ref}: {e}")
    cache[ref] = result
    return result


def _paid_date_and_tender(o: dict, pi_cache: dict) -> tuple[date | None, str]:
    """Return (local paid date, tender). Paid date None = not income yet."""
    if o.get("status") in ("failed", "checkout-draft", "trash"):
        return None, "unpaid"

    m = _meta(o)

    # Contractor invoices settled through the billing page
    if str(m.get("_emgc_invoice_paid_cash")) == "1" or str(m.get("_emgc_invoice_charged")) == "1":
        tender = "cash" if str(m.get("_emgc_invoice_paid_cash")) == "1" else "card"
        raw = m.get("_emgc_invoice_batch_date")
        try:
            paid = date.fromisoformat(str(raw)) if raw else None
        except ValueError:
            paid = None
        return (paid or _gmt_to_local_date(o.get("date_modified_gmt"))), tender

    pm = m.get("_emgc_payment_method")

    # Invoice order not yet settled -> not income under cash basis
    if pm == "invoice" or str(m.get("_emgc_invoice_pending")) == "1":
        return None, "unpaid"

    # Payment link -> paid when Stripe confirmed it
    if pm == "payment_link":
        ref = m.get("_stripe_payment_confirmed")
        if not ref:
            return None, "unpaid"
        paid = _pi_created_local_date(str(ref), pi_cache) or _gmt_to_local_date(o.get("date_modified_gmt"))
        return paid, "card"

    # Counter orders and website checkout
    paid = _gmt_to_local_date(o.get("date_paid_gmt"))
    if paid is None:
        return None, "unpaid"
    if pm == "cash":
        return paid, "cash"
    if pm == "card":
        return paid, "card"
    gateway = (o.get("payment_method") or "").lower()
    if "stripe" in gateway:
        return paid, "card"
    if gateway in ("cod", "cheque", "bacs"):
        return paid, "cash"
    return paid, "other"


def _fetch_orders_modified_since(since_utc: datetime) -> list[dict]:
    """Every WC order modified on/after since_utc. Any order paid in the month
    was modified when it was paid, so this window always contains it."""
    since = urllib.parse.quote(since_utc.strftime("%Y-%m-%dT%H:%M:%S"))
    seen: dict[int, dict] = {}
    page = 1
    while True:
        batch = _wc_request(
            f"orders?per_page={WC_PAGE_SIZE}&page={page}&status=any"
            f"&dates_are_gmt=true&modified_after={since}"
            f"&orderby=id&order=asc&_fields={WC_FIELDS}"
        )
        if not batch:
            break
        for o in batch:
            seen[o["id"]] = o
        if len(batch) < WC_PAGE_SIZE:
            break
        page += 1
        if page > WC_MAX_PAGES:
            logger.warning("income_sheet: hit WC page cap — results may be incomplete")
            break
        _time.sleep(WC_PAUSE_SECONDS)
    return list(seen.values())


def _refunds_in_range(order_id: int, start: date, end: date) -> list[dict]:
    rows = _wc_request(f"orders/{order_id}/refunds?per_page=100&_fields=id,date_created_gmt,amount,reason")
    out = []
    for r in rows or []:
        d = _gmt_to_local_date(r.get("date_created_gmt"))
        if d and start <= d < end:
            out.append(r)
    return out


STRIPE_REF_META_KEYS = ("_stripe_payment_intent_id", "_stripe_payment_confirmed", "_stripe_intent_id")


def _order_stripe_refs(o: dict) -> set[str]:
    """Every Stripe PaymentIntent / charge id this WC order carries."""
    m = _meta(o)
    refs = {str(m[k]) for k in STRIPE_REF_META_KEYS if m.get(k)}
    txn = str(o.get("transaction_id") or "")
    if txn.startswith(("pi_", "ch_")):
        refs.add(txn)
    return refs


def _month_label(d: str | None) -> str:
    if not d:
        return "another month"
    try:
        return date.fromisoformat(d).strftime("%b %Y")
    except ValueError:
        return "another month"


def _stripe_summary(
    start_utc: datetime,
    end_utc: datetime,
    ref_index: dict[str, int],
    by_oid: dict[int, dict],
    counted_oids: set[int],
    wc_refunds_by_oid: dict[int, float],
) -> dict | None:
    """Stripe totals for the month, plus every charge/refund that doesn't
    line up with a counted order or WC refund on this sheet."""
    if not settings.stripe_api_key:
        return None
    try:
        s = _stripe()
        gross = refunds = fees = payouts = 0.0
        charge_count = 0
        unmatched: list[dict] = []
        wc_refund_left = dict(wc_refunds_by_oid)

        def resolve(ref_ids: list[str], metadata: dict) -> int | None:
            for r in ref_ids:
                if r and r in ref_index:
                    return ref_index[r]
            wc_id = (metadata or {}).get("wc_order_id")
            if wc_id and str(wc_id).isdigit() and int(wc_id) in by_oid:
                return int(wc_id)
            return None

        txns = s.BalanceTransaction.list(
            created={"gte": int(start_utc.timestamp()), "lt": int(end_utc.timestamp())},
            limit=100,
            expand=["data.source"],
        )
        for t in txns.auto_paging_iter():
            amount = t.amount / 100
            fees += t.fee / 100
            when = str(datetime.fromtimestamp(t.created, tz=timezone.utc).astimezone(EASTERN).date())
            src = t.source if not isinstance(t.source, str) else None

            if t.type in ("charge", "payment"):
                gross += amount
                charge_count += 1
                pi = getattr(src, "payment_intent", None) if src else None
                ch = getattr(src, "id", None) if src else None
                md = dict(getattr(src, "metadata", {}) or {}) if src else {}
                oid = resolve([pi, ch], md)
                if oid is not None and oid in counted_oids:
                    continue
                info = by_oid.get(oid) if oid is not None else None
                if info and info["status"] in ("cancelled", "refunded"):
                    note = f"Order #{info['number']} is {info['status']} — excluded from income"
                elif info and info["paid"]:
                    note = f"Order #{info['number']} counted in {_month_label(info['paid'])} by its Loadout paid date"
                elif info:
                    note = f"Order #{info['number']} isn't marked paid in Loadout"
                elif md.get("drop_id") or md.get("modified_by"):
                    note = "Order edit charge — not tied to a paid date in WooCommerce"
                else:
                    note = "No matching order — possible duplicate or orphan charge"
                unmatched.append({
                    "date": when, "kind": "charge", "amount": round(amount, 2),
                    "order": info["number"] if info else None,
                    "ref": pi or ch, "note": note,
                    "description": (getattr(src, "description", None) or "") if src else "",
                })

            elif t.type in ("refund", "payment_refund"):
                amt = -amount
                refunds += amt
                pi = getattr(src, "payment_intent", None) if src else None
                ch = getattr(src, "charge", None) if src else None
                if ch is not None and not isinstance(ch, str):
                    ch = getattr(ch, "id", None)
                md = dict(getattr(src, "metadata", {}) or {}) if src else {}
                oid = resolve([pi, ch], md)
                # Covered by a WC refund record on this sheet?
                if oid is not None and wc_refund_left.get(oid, 0) >= amt - 0.01:
                    wc_refund_left[oid] -= amt
                    continue
                info = by_oid.get(oid) if oid is not None else None
                if info and info["status"] in ("cancelled", "refunded") and oid not in counted_oids:
                    note = f"Order #{info['number']} is {info['status']} — refund excluded with it"
                elif md.get("drop_id") or md.get("modified_by"):
                    note = "Order edit refund — WooCommerce total was lowered instead of recording a refund"
                elif info:
                    note = f"Order #{info['number']} has no matching WooCommerce refund this month"
                else:
                    note = "No matching order or WooCommerce refund"
                unmatched.append({
                    "date": when, "kind": "refund", "amount": round(amt, 2),
                    "order": info["number"] if info else None,
                    "ref": getattr(src, "id", None) if src else None, "note": note,
                    "description": md.get("reason", "") if md else "",
                })

            elif t.type == "payout":
                payouts += -amount
            elif t.type == "stripe_fee":
                fees += -amount

        unmatched.sort(key=lambda r: (r["date"], r["kind"]))
        return {
            "gross_charges": round(gross, 2),
            "charge_count": charge_count,
            "refunds": round(refunds, 2),
            "fees": round(fees, 2),
            "net": round(gross - refunds - fees, 2),
            "payouts": round(payouts, 2),
            "unmatched": unmatched,
            "unmatched_charges": round(sum(u["amount"] for u in unmatched if u["kind"] == "charge"), 2),
            "unmatched_refunds": round(sum(u["amount"] for u in unmatched if u["kind"] == "refund"), 2),
        }
    except Exception as e:
        logger.error(f"income_sheet: Stripe summary failed: {e}")
        return {"error": "Couldn't load Stripe data for this month."}


# ── Endpoint ──────────────────────────────────────────────────────────────────

@router.get("/income-sheet")
def income_sheet(
    year: int = Query(..., ge=2020, le=2100),
    month: int = Query(..., ge=1, le=12),
    refresh: bool = Query(default=False),
    user: AuthUser = Depends(require_roles(UserRole.ADMIN)),
    db: Session = Depends(db_dep),
):
    start_local = datetime(year, month, 1, tzinfo=EASTERN)
    end_local = datetime(year + (month == 12), month % 12 + 1, 1, tzinfo=EASTERN)
    start_d, end_d = start_local.date(), end_local.date()
    start_utc = start_local.astimezone(timezone.utc)
    end_utc = end_local.astimezone(timezone.utc)
    now = datetime.now(timezone.utc)

    month_closed = now >= end_utc
    cache_key = (str(user.tenant_id), year, month)
    if month_closed and not refresh and cache_key in _SHEET_CACHE:
        return {**_SHEET_CACHE[cache_key], "cached": True}

    orders = _fetch_orders_modified_since(start_utc - timedelta(days=1))

    rows = defaultdict(float)
    row_orders: dict[str, set] = defaultdict(set)
    unmapped: set[str] = set()
    other_fee_names: set[str] = set()
    tender = {"card": 0.0, "cash": 0.0, "other": 0.0}
    tax_collected = taxable_sales = total_collected = 0.0
    paid_orders: list[dict] = []
    refund_rows: list[dict] = []
    pi_cache: dict = {}
    excluded_cancelled = 0

    # Index every fetched order by its Stripe ids, with its Loadout paid date,
    # so Stripe activity can be matched back to orders.
    ref_index: dict[str, int] = {}
    by_oid: dict[int, dict] = {}
    paid_map: dict[int, tuple] = {}
    for o in orders:
        paid, how = _paid_date_and_tender(o, pi_cache)
        paid_map[o["id"]] = (paid, how)
        by_oid[o["id"]] = {
            "number": str(o.get("number") or o["id"]),
            "status": o.get("status"),
            "paid": str(paid) if paid else None,
        }
        for ref in _order_stripe_refs(o):
            ref_index[ref] = o["id"]
    counted_oids: set[int] = set()
    wc_refunds_by_oid: dict[int, float] = defaultdict(float)

    for o in orders:
        oid = o["id"]
        number = str(o.get("number") or oid)

        # Cancelled orders are not income, and neither are orders marked
        # refunded with no WC refund record (refunded directly in Stripe).
        # Skip them entirely so their refunds aren't subtracted either.
        status = o.get("status")
        if status == "cancelled" or (status == "refunded" and not o.get("refunds")):
            excluded_cancelled += 1
            continue

        # Refunds count in the month they were issued, whenever the order was paid
        if o.get("refunds"):
            try:
                for r in _refunds_in_range(oid, start_d, end_d):
                    wc_refunds_by_oid[oid] += _money(r.get("amount"))
                    refund_rows.append({
                        "order_number": number,
                        "date": str(_gmt_to_local_date(r.get("date_created_gmt"))),
                        "amount": round(_money(r.get("amount")), 2),
                        "reason": r.get("reason") or "",
                    })
                _time.sleep(WC_PAUSE_SECONDS)
            except Exception as e:
                logger.warning(f"income_sheet: refunds fetch failed for order {oid}: {e}")

        paid, how = paid_map[oid]
        if paid is None or not (start_d <= paid < end_d):
            continue
        counted_oids.add(oid)

        for li in o.get("line_items") or []:
            amt = _money(li.get("total"))
            row = _row_for_line(li)
            if row is None:
                row = UNCATEGORIZED_ROW
                unmapped.add(f"{li.get('name') or 'Unnamed'} ({li.get('sku') or 'no SKU'})")
            rows[row] += amt
            row_orders[row].add(oid)
            if _money(li.get("total_tax")) > 0:
                taxable_sales += amt

        ship = _money(o.get("shipping_total"))
        if ship:
            rows[DELIVERY_ROW] += ship
            row_orders[DELIVERY_ROW].add(oid)
            if _money(o.get("shipping_tax")) > 0:
                taxable_sales += ship

        for fl in o.get("fee_lines") or []:
            amt = _money(fl.get("total"))
            if amt:
                rows[OTHER_FEES_ROW] += amt
                row_orders[OTHER_FEES_ROW].add(oid)
                other_fee_names.add(fl.get("name") or "Fee")
                if _money(fl.get("total_tax")) > 0:
                    taxable_sales += amt

        order_total = _money(o.get("total"))
        tax_collected += _money(o.get("total_tax"))
        total_collected += order_total
        tender[how if how in tender else "other"] += order_total
        paid_orders.append({
            "number": number,
            "paid": str(paid),
            "total": round(order_total, 2),
            "tender": how,
        })

    gross_sales = sum(rows.values())
    refunds_total = sum(r["amount"] for r in refund_rows)
    # Self-check: categories + tax should equal what customers paid
    unexplained = round(total_collected - (gross_sales + tax_collected), 2)

    # Memo lines from Loadout
    unpaid_total, unpaid_count = db.execute(
        select(func.coalesce(func.sum(Drop.order_total), 0), func.count(Drop.id)).where(
            Drop.tenant_id == user.tenant_id,
            Drop.payment_method == "invoice",
            or_(Drop.payment_status.is_(None), Drop.payment_status != "paid"),
        )
    ).one()
    quick_drops = db.execute(
        select(func.count(Drop.id)).where(
            Drop.tenant_id == user.tenant_id,
            Drop.qd_number.isnot(None),
            Drop.created_at >= start_utc,
            Drop.created_at < end_utc,
        )
    ).scalar_one()

    stripe_data = _stripe_summary(start_utc, end_utc, ref_index, by_oid, counted_oids, wc_refunds_by_oid)
    if stripe_data and "error" not in stripe_data:
        stripe_data["card_tender_diff"] = round(stripe_data["gross_charges"] - tender["card"], 2)

    sheet = {
        "year": year,
        "month": month,
        "month_closed": month_closed,
        "generated_at": now.isoformat(),
        "rows": [
            {"label": label, "amount": round(rows.get(label, 0.0), 2), "orders": len(row_orders.get(label, ()))}
            for label in INCOME_ROWS
        ],
        "gross_sales": round(gross_sales, 2),
        "refunds": {
            "total": round(refunds_total, 2),
            "count": len(refund_rows),
            "items": sorted(refund_rows, key=lambda r: r["date"]),
        },
        "net_income": round(gross_sales - refunds_total, 2),
        "sales_tax": {
            "collected": round(tax_collected, 2),
            "taxable_sales": round(taxable_sales, 2),
            "nontaxable_sales": round(gross_sales - taxable_sales, 2),
        },
        "total_collected": round(total_collected, 2),
        "unexplained": unexplained,
        "tender": {k: round(v, 2) for k, v in tender.items()},
        "stripe": stripe_data,
        "memo": {
            "unpaid_invoice_total": round(float(unpaid_total or 0), 2),
            "unpaid_invoice_count": int(unpaid_count or 0),
            "quick_drops": int(quick_drops or 0),
            "excluded_cancelled": excluded_cancelled,
        },
        "unmapped": sorted(unmapped),
        "other_fee_names": sorted(other_fee_names),
        "order_count": len(paid_orders),
        "orders": sorted(paid_orders, key=lambda r: (r["paid"], r["number"])),
    }

    if month_closed:
        _SHEET_CACHE[cache_key] = sheet
    return {**sheet, "cached": False}
