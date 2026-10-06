"""
Finance reports — admin only.

Month-end general journal entry (cash basis) for QuickBooks Desktop.
Read-only: pulls paid orders and refunds from WooCommerce, fees and
payouts from Stripe. The entry balances by construction (all math in cents).

Paid-date rules (cash basis = the day money was received, Eastern time):
  - Contractor invoice paid by cash/check  -> _emgc_invoice_batch_date meta
  - Contractor invoice charged to card     -> _emgc_invoice_batch_date meta
  - Invoice order not yet paid             -> excluded (not income yet)
  - Payment link                           -> Stripe PaymentIntent created time
  - Counter cash/card, website checkout    -> WC date_paid_gmt

Refunds = WooCommerce refund records only. Order-edit refunds/charges change
the WC order total instead, so they are already reflected in income and
are deliberately NOT counted again.
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

# ── QuickBooks accounts (names must match the chart of accounts exactly) ─────
ACCT_BANK = "Monson Savings"
ACCT_CLEARING = "POS Clearing"
ACCT_FEES = "Credit Card Processing Fees"
ACCT_REFUNDS = "Sales Refunds"
ACCT_TAX = "Sales Tax Payable"
ACCT_DELIVERY = "Delivery Charge"
ACCT_MISC = "Misc Sales"

# Income accounts in print order
INCOME_ACCOUNTS = [
    "Mulch Sales",
    "Wood Chips / Biomass",
    "Soil Sales:Topsoil",
    "Soil Sales:Garden Soil",
    "Soil Sales:Compost",
    "Soil Sales:Fill",
    "Firewood",
    "Brush / Yard Waste Disposal",
    "Hauling",
    ACCT_DELIVERY,
    ACCT_MISC,
]

# SKU -> income account. Keys are uppercase; matching ignores case.
# New products: add a line here. Anything unmapped goes to Misc Sales.
SKU_TO_ACCOUNT = {
    "BROWNMULCH": "Mulch Sales",
    "NATURALMULCH": "Mulch Sales",
    "BLACKMULCH": "Mulch Sales",
    "HEMLOCKMULCH": "Mulch Sales",
    "REDMULCH": "Mulch Sales",
    "AGEDHEMLOCK": "Mulch Sales",
    "PLAYGROUND": "Mulch Sales",
    "CHIPS": "Wood Chips / Biomass",
    "TOPSOIL": "Soil Sales:Topsoil",
    "GARDENSOIL": "Soil Sales:Garden Soil",
    "COMPOST": "Soil Sales:Compost",
    "FILL": "Soil Sales:Fill",
    "1CORDFIREWOOD": "Firewood",
    "HALFCORDFIREWOOD": "Firewood",
    "DISPOSAL": "Brush / Yard Waste Disposal",
    "DEBRISHAULING": "Hauling",
}

# Fallback by product name, for line items that come back without a SKU.
NAME_TO_ACCOUNT = {
    "dark brown mulch": "Mulch Sales",
    "natural double ground mulch": "Mulch Sales",
    "black mulch": "Mulch Sales",
    "hemlock mulch": "Mulch Sales",
    "red mulch": "Mulch Sales",
    "aged hemlock mulch": "Mulch Sales",
    "playground mulch": "Mulch Sales",
    "whole tree wood chips": "Wood Chips / Biomass",
    "screened topsoil": "Soil Sales:Topsoil",
    "premium garden soil": "Soil Sales:Garden Soil",
    "screened compost": "Soil Sales:Compost",
    "unscreened fill": "Soil Sales:Fill",
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


def _account_for_line(li: dict) -> str | None:
    sku = (li.get("sku") or "").strip().upper()
    if sku in SKU_TO_ACCOUNT:
        return SKU_TO_ACCOUNT[sku]
    return NAME_TO_ACCOUNT.get((li.get("name") or "").strip().lower())


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


def _cents(v) -> int:
    return int(round(_money(v) * 100))


def _d(c: int) -> float:
    return round(c / 100, 2)


STRIPE_REF_META_KEYS = ("_stripe_payment_intent_id", "_stripe_payment_confirmed", "_stripe_intent_id")


def _order_stripe_refs(o: dict) -> set[str]:
    m = _meta(o)
    refs = {str(m[k]) for k in STRIPE_REF_META_KEYS if m.get(k)}
    txn = str(o.get("transaction_id") or "")
    if txn.startswith(("pi_", "ch_")):
        refs.add(txn)
    return refs


def _is_order_edit(md: dict) -> bool:
    return bool(md and (md.get("drop_id") or md.get("modified_by")))


def _local_date(ts: int) -> str:
    return str(datetime.fromtimestamp(ts, tz=timezone.utc).astimezone(EASTERN).date())


# ── Stripe ────────────────────────────────────────────────────────────────────

def _stripe_month(
    start_utc: datetime,
    end_utc: datetime,
    payout_from: int,
    payout_to: int,
    ref_index: dict[str, int],
    by_oid: dict[int, dict],
    wc_refunds_by_oid: dict[int, int],
) -> dict:
    """Fees, bank deposits, what Stripe should be holding, and the short list
    of Stripe activity that has no home in Loadout (needs attention)."""
    s = _stripe()

    def resolve(ref_ids, md) -> int | None:
        for r in ref_ids:
            if r and r in ref_index:
                return ref_index[r]
        wc_id = (md or {}).get("wc_order_id")
        if wc_id and str(wc_id).isdigit() and int(wc_id) in by_oid:
            return int(wc_id)
        return None

    # 1. This month's activity: fees + attention items
    fees_c = 0
    attention: list[dict] = []
    excluded_net: dict[int, int] = defaultdict(int)
    wc_refund_left = dict(wc_refunds_by_oid)

    txns = s.BalanceTransaction.list(
        created={"gte": int(start_utc.timestamp()), "lt": int(end_utc.timestamp())},
        limit=100,
        expand=["data.source"],
    )
    for t in txns.auto_paging_iter():
        fees_c += t.fee
        if t.type == "stripe_fee":
            fees_c += -t.amount
        if t.type in ("payout", "payout_cancel", "payout_failure", "stripe_fee"):
            continue

        when = _local_date(t.created)
        src = t.source if not isinstance(t.source, str) else None
        md = dict(getattr(src, "metadata", {}) or {}) if src else {}

        if t.type in ("charge", "payment"):
            oid = resolve([getattr(src, "payment_intent", None), getattr(src, "id", None)], md) if src else None
            if oid is not None:
                if by_oid[oid]["excluded"]:
                    excluded_net[oid] += t.amount
                continue
            if _is_order_edit(md):
                continue
            attention.append({
                "date": when, "kind": "Charge", "amount": _d(t.amount), "order": None,
                "ref": getattr(src, "payment_intent", None) or getattr(src, "id", None),
                "note": "No matching order — duplicate or orphan charge. Refund it in Stripe or enter the sale.",
            })

        elif t.type in ("refund", "payment_refund"):
            amt = -t.amount
            ch = getattr(src, "charge", None) if src else None
            if ch is not None and not isinstance(ch, str):
                ch = getattr(ch, "id", None)
            oid = resolve([getattr(src, "payment_intent", None), ch], md) if src else None
            if oid is not None and by_oid[oid]["excluded"]:
                excluded_net[oid] -= amt
                continue
            if oid is not None and wc_refund_left.get(oid, 0) >= amt - 1:
                wc_refund_left[oid] -= amt
                continue
            if _is_order_edit(md):
                continue
            info = by_oid.get(oid) if oid is not None else None
            attention.append({
                "date": when, "kind": "Refund", "amount": _d(-amt),
                "order": info["number"] if info else None,
                "ref": getattr(src, "id", None) if src else None,
                "note": "Refunded in Stripe with no refund recorded in WooCommerce. Record the refund on the order.",
            })

        else:
            attention.append({
                "date": when, "kind": t.type.replace("_", " ").capitalize(), "amount": _d(t.net),
                "order": None, "ref": getattr(t, "id", None),
                "note": "Stripe adjustment or dispute — needs a manual entry.",
            })

    for oid, net in excluded_net.items():
        if abs(net) >= 1:
            info = by_oid[oid]
            attention.append({
                "date": "", "kind": "Charge", "amount": _d(net), "order": info["number"],
                "ref": None,
                "note": f"Order is {info['status']} but this money was kept. Refund it or un-cancel the order.",
            })

    # 2. Deposits that landed in the bank this month (by arrival date)
    deposits_c = 0
    deposit_count = 0
    for p in s.Payout.list(arrival_date={"gte": payout_from, "lt": payout_to}, limit=100).auto_paging_iter():
        if p.status == "paid":
            deposits_c += p.amount
            deposit_count += 1

    # 3. What Stripe should be holding after this month's deposits:
    #    all activity through month end, minus every deposit that has arrived.
    activity_c = 0
    for t in s.BalanceTransaction.list(created={"lt": int(end_utc.timestamp())}, limit=100).auto_paging_iter():
        if t.type not in ("payout", "payout_cancel", "payout_failure"):
            activity_c += t.net
    arrived_c = 0
    for p in s.Payout.list(arrival_date={"lt": payout_to}, limit=100).auto_paging_iter():
        if p.status == "paid":
            arrived_c += p.amount

    attention.sort(key=lambda a: (a["date"] or "9999", a["kind"]))
    return {
        "fees_c": fees_c,
        "deposits_c": deposits_c,
        "deposit_count": deposit_count,
        "held_c": activity_c - arrived_c,
        "attention": attention,
    }


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
    # Stripe payout arrival dates are calendar dates stamped at UTC midnight
    payout_from = int(datetime(start_d.year, start_d.month, 1, tzinfo=timezone.utc).timestamp())
    payout_to = int(datetime(end_d.year, end_d.month, 1, tzinfo=timezone.utc).timestamp())
    now = datetime.now(timezone.utc)

    month_closed = now >= end_utc
    cache_key = (str(user.tenant_id), year, month)
    if month_closed and not refresh and cache_key in _SHEET_CACHE:
        return {**_SHEET_CACHE[cache_key], "cached": True}

    orders = _fetch_orders_modified_since(start_utc - timedelta(days=1))

    # Pass 1 — classify every fetched order
    pi_cache: dict = {}
    by_oid: dict[int, dict] = {}
    ref_index: dict[str, int] = {}
    for o in orders:
        status = o.get("status")
        excluded = status == "cancelled" or (status == "refunded" and not o.get("refunds"))
        paid, how = _paid_date_and_tender(o, pi_cache)
        if how == "unpaid":
            how = "card" if _order_stripe_refs(o) else "cash"
        by_oid[o["id"]] = {
            "number": str(o.get("number") or o["id"]),
            "status": status,
            "excluded": excluded,
            "paid": paid,
            "tender": "card" if how == "card" else "cash",
        }
        for ref in _order_stripe_refs(o):
            ref_index[ref] = o["id"]

    # Pass 2 — income, tax, refunds (all in cents)
    income_c: dict[str, int] = defaultdict(int)
    income_orders: dict[str, set] = defaultdict(set)
    misc_items: set[str] = set()
    tax_c = card_c = cash_c = 0
    refund_ex_tax_c = refund_tax_c = card_refunds_c = cash_refunds_c = 0
    wc_refunds_by_oid: dict[int, int] = defaultdict(int)
    paid_orders: list[dict] = []
    refund_rows: list[dict] = []

    for o in orders:
        oid = o["id"]
        info = by_oid[oid]
        if info["excluded"]:
            continue

        total_c = _cents(o.get("total"))
        order_tax_c = _cents(o.get("total_tax"))

        # Refunds count in the month they were issued
        if o.get("refunds"):
            try:
                for r in _refunds_in_range(oid, start_d, end_d):
                    amt = _cents(r.get("amount"))
                    if amt <= 0:
                        continue
                    r_tax = round(amt * order_tax_c / total_c) if total_c > 0 else 0
                    r_tax = min(r_tax, amt)
                    refund_tax_c += r_tax
                    refund_ex_tax_c += amt - r_tax
                    wc_refunds_by_oid[oid] += amt
                    if info["tender"] == "card":
                        card_refunds_c += amt
                    else:
                        cash_refunds_c += amt
                    refund_rows.append({
                        "order_number": info["number"],
                        "date": str(_gmt_to_local_date(r.get("date_created_gmt"))),
                        "amount": _d(amt),
                        "tender": info["tender"],
                        "reason": r.get("reason") or "",
                    })
                _time.sleep(WC_PAUSE_SECONDS)
            except Exception as e:
                logger.warning(f"income_sheet: refunds fetch failed for order {oid}: {e}")

        paid = info["paid"]
        if paid is None or not (start_d <= paid < end_d):
            continue

        allocated = 0
        for li in o.get("line_items") or []:
            amt = _cents(li.get("total"))
            acct = _account_for_line(li)
            if acct is None:
                acct = ACCT_MISC
                misc_items.add(f"{li.get('name') or 'Unnamed'} ({li.get('sku') or 'no SKU'})")
            income_c[acct] += amt
            income_orders[acct].add(oid)
            allocated += amt

        ship = _cents(o.get("shipping_total"))
        if ship:
            income_c[ACCT_DELIVERY] += ship
            income_orders[ACCT_DELIVERY].add(oid)
            allocated += ship

        for fl in o.get("fee_lines") or []:
            amt = _cents(fl.get("total"))
            if amt:
                income_c[ACCT_MISC] += amt
                income_orders[ACCT_MISC].add(oid)
                misc_items.add(f"Fee: {fl.get('name') or 'Fee'}")
                allocated += amt

        # Rounding pennies so income + tax always equals what was collected
        diff = total_c - order_tax_c - allocated
        if diff:
            income_c[ACCT_MISC] += diff
            if abs(diff) > 5:
                misc_items.add(f"Order #{info['number']} adjustment")

        tax_c += order_tax_c
        if info["tender"] == "card":
            card_c += total_c
        else:
            cash_c += total_c
        paid_orders.append({
            "number": info["number"], "paid": str(paid),
            "total": _d(total_c), "tender": info["tender"],
        })

    # Stripe side
    stripe_ok = bool(settings.stripe_api_key)
    stripe_error = None
    st = {"fees_c": 0, "deposits_c": 0, "deposit_count": 0, "held_c": 0, "attention": []}
    if stripe_ok:
        try:
            st = _stripe_month(start_utc, end_utc, payout_from, payout_to, ref_index, by_oid, wc_refunds_by_oid)
        except Exception as e:
            logger.error(f"income_sheet: Stripe failed: {e}")
            stripe_error = "Couldn't load Stripe data. Try again — don't post this month until it loads."

    # ── Build the journal entry ───────────────────────────────────────────────
    lines: list[dict] = []

    def add(account: str, memo: str, amount_c: int):
        """Positive = debit, negative = credit. Zero lines are dropped."""
        if amount_c:
            lines.append({
                "account": account, "memo": memo,
                "debit": _d(amount_c) if amount_c > 0 else 0.0,
                "credit": _d(-amount_c) if amount_c < 0 else 0.0,
            })

    clearing_c = card_c - card_refunds_c - st["fees_c"] - st["deposits_c"]

    add(ACCT_BANK, f"Stripe deposits ({st['deposit_count']})", st["deposits_c"])
    add(ACCT_BANK, "Cash and checks collected", cash_c)
    add(ACCT_BANK, "Cash and check refunds", -cash_refunds_c)
    add(ACCT_FEES, "Stripe processing fees", st["fees_c"])
    add(ACCT_REFUNDS, f"Customer refunds ({len(refund_rows)})", refund_ex_tax_c)
    add(ACCT_CLEARING, "Card sales less refunds, fees, and deposits", clearing_c)
    for acct in INCOME_ACCOUNTS:
        n = len(income_orders.get(acct, ()))
        add(acct, f"{n} order{'s' if n != 1 else ''}" if n else "", -income_c.get(acct, 0))
    add(ACCT_TAX, "Sales tax collected, less tax refunded", -(tax_c - refund_tax_c))

    total_debit_c = sum(_cents(l["debit"]) for l in lines)
    total_credit_c = sum(_cents(l["credit"]) for l in lines)

    unpaid_total, unpaid_count = db.execute(
        select(func.coalesce(func.sum(Drop.order_total), 0), func.count(Drop.id)).where(
            Drop.tenant_id == user.tenant_id,
            Drop.payment_method == "invoice",
            or_(Drop.payment_status.is_(None), Drop.payment_status != "paid"),
        )
    ).one()

    sheet = {
        "year": year,
        "month": month,
        "entry_date": str(end_d - timedelta(days=1)),
        "month_closed": month_closed,
        "generated_at": now.isoformat(),
        "lines": lines,
        "total_debit": _d(total_debit_c),
        "total_credit": _d(total_credit_c),
        "balanced": total_debit_c == total_credit_c,
        "stripe_ok": stripe_ok and stripe_error is None,
        "stripe_error": stripe_error,
        "clearing_check": _d(st["held_c"]) if stripe_ok and not stripe_error else None,
        "attention": st["attention"],
        "summary": {
            "gross_sales": _d(sum(income_c.values())),
            "refunds": _d(refund_ex_tax_c + refund_tax_c),
            "tax_collected": _d(tax_c),
            "tax_refunded": _d(refund_tax_c),
            "card_collected": _d(card_c),
            "cash_collected": _d(cash_c),
        },
        "misc_items": sorted(misc_items),
        "unpaid_invoices": {"total": round(float(unpaid_total or 0), 2), "count": int(unpaid_count or 0)},
        "orders": sorted(paid_orders, key=lambda r: (r["paid"], r["number"])),
        "refund_items": sorted(refund_rows, key=lambda r: r["date"]),
    }

    if month_closed and sheet["stripe_ok"]:
        _SHEET_CACHE[cache_key] = sheet
    return {**sheet, "cached": False}
