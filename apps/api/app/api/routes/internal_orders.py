"""
Internal order entry — dispatcher/admin only.
Talks directly to WooCommerce REST API server-side using env-var credentials.
Creates a WC order which then flows through the existing webhook → dispatch queue.
Handles Stripe payment intents, setup intents, payment links, and card-on-file.
"""
import base64
import json
import logging
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

import stripe
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import AuthUser, db_dep, require_roles
from app.api.services import log_event, normalize_us_phone, now_utc
from app.core.config import settings
from app.models.entities import (
    Customer,
    CustomerAddress,
    CustomerType,
    Drop,
    Load,
    LoadStatus,
    Location,
    UserRole,
)

logger = logging.getLogger("dispatch.internal_orders")
router = APIRouter(prefix="/internal-orders", tags=["internal-orders"])

WC_ROLE_CONTRACTOR = "contractor"
WC_ROLE_WHOLESALE = "wholesale"

# ── Stripe init ───────────────────────────────────────────────────────────────

def _stripe():
    if not settings.stripe_api_key:
        raise HTTPException(status_code=503, detail={"code": "stripe_not_configured", "message": "Stripe is not configured"})
    stripe.api_key = settings.stripe_api_key
    return stripe


# ── WooCommerce API helper ─────────────────────────────────────────────────────

def _wc_request(path: str, method: str = "GET", payload: dict | None = None) -> Any:
    if not settings.wc_store_url or not settings.wc_consumer_key:
        raise HTTPException(status_code=503, detail={"code": "wc_not_configured", "message": "WooCommerce credentials not configured"})

    # Use query string auth — Hostinger strips Authorization headers
    separator = "&" if "?" in path else "?"
    url = (
        f"{settings.wc_store_url.rstrip('/')}/wp-json/wc/v3/{path.lstrip('/')}"
        f"{separator}consumer_key={urllib.parse.quote(settings.wc_consumer_key)}"
        f"&consumer_secret={urllib.parse.quote(settings.wc_consumer_secret)}"
    )

    data = json.dumps(payload).encode() if payload else None
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "dispatch-app/1.0",
        },
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        logger.error(f"WC API error {e.code} on {method} {path}: {body}")
        raise HTTPException(status_code=502, detail={"code": "wc_error", "message": f"WooCommerce API error: {e.code}"})
    except Exception as e:
        logger.error(f"WC API request failed: {e}")
        raise HTTPException(status_code=502, detail={"code": "wc_unreachable", "message": "Could not reach WooCommerce"})


def _price_for_role(product: dict, role: str | None) -> str:
    meta = {m["key"]: m["value"] for m in product.get("meta_data", [])}
    if role == WC_ROLE_CONTRACTOR:
        return meta.get("_contractor_price") or product.get("price", "0")
    if role == WC_ROLE_WHOLESALE:
        return meta.get("_wholesale_price") or product.get("price", "0")
    return product.get("price", "0")


def _next_order_number(db: Session, tenant_id) -> int:
    current_max = db.execute(
        select(func.coalesce(func.max(Drop.order_number), 0)).where(Drop.tenant_id == tenant_id)
    ).scalar_one()
    return current_max + 1


# ── 1. Products ───────────────────────────────────────────────────────────────

@router.get("/wc-products")
def get_wc_products(
    role: str | None = None,
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)),
    db: Session = Depends(db_dep),
):
    """Fetch bulk-material products from WooCommerce with role-based pricing."""
    products = _wc_request("products?per_page=100&status=publish")
    result = []
    for p in products:
        meta = {m["key"]: m["value"] for m in p.get("meta_data", [])}
        result.append({
            "id": p["id"],
            "name": p["name"],
            "sku": p.get("sku", ""),
            "price": _price_for_role(p, role),
            "regular_price": p.get("regular_price", "0"),
            "contractor_price": meta.get("_contractor_price"),
            "wholesale_price": meta.get("_wholesale_price"),
            "shipping_class": p.get("shipping_class", ""),
            "sold_by_yard": meta.get("_sold_by_the_yard") == "yes",
        })
    return {"products": result}


# ── 2. Customer lookup ────────────────────────────────────────────────────────

@router.get("/wc-customer")
def lookup_wc_customer(
    search: str,
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)),
    db: Session = Depends(db_dep),
):
    """
    Look up a customer by searching WC orders billing data.
    Works for both guest and registered customers.
    """
    # Search orders by billing email or phone
    orders = _wc_request(f"orders?per_page=10&search={urllib.parse.quote(search.strip())}&orderby=date&order=desc")

    if not orders:
        return {"found": False}

    # Use the most recent order's billing info
    o = orders[0]
    billing = o.get("billing", {})
    wc_customer_id = o.get("customer_id") or None  # 0 = guest, treat as None

    # Check WC registered customer for role if customer_id exists
    wc_role = None
    if wc_customer_id:
        try:
            wc_user = _wc_request(f"customers/{wc_customer_id}")
            role = wc_user.get("role", "customer")
            if role in (WC_ROLE_CONTRACTOR, WC_ROLE_WHOLESALE):
                wc_role = role
        except Exception:
            pass

    # Check local dispatch customer record
    local = None
    phone = billing.get("phone", "")
    email = billing.get("email", "")

    if phone:
        try:
            normalized = normalize_us_phone(phone)
            local = db.execute(
                select(Customer).where(
                    Customer.tenant_id == user.tenant_id,
                    Customer.phone_e164 == normalized,
                )
            ).scalar_one_or_none()
        except Exception:
            pass

    if not local and email:
        local = db.execute(
            select(Customer).where(
                Customer.tenant_id == user.tenant_id,
                Customer.email == email.strip().lower(),
            )
        ).scalar_one_or_none()

    # Fetch saved Stripe card if we have a local record
    stripe_customer_id = local.stripe_customer_id if local else None
    saved_card = None
    if stripe_customer_id and settings.stripe_api_key:
        try:
            _stripe()
            methods = stripe.PaymentMethod.list(customer=stripe_customer_id, type="card")
            if methods.data:
                pm = methods.data[0]
                saved_card = {
                    "payment_method_id": pm.id,
                    "brand": pm.card.brand,
                    "last4": pm.card.last4,
                    "exp_month": pm.card.exp_month,
                    "exp_year": pm.card.exp_year,
                }
        except Exception as e:
            logger.warning(f"Could not fetch Stripe methods: {e}")

    # Build order history from all matching orders
    order_history = []
    for ord in orders[:5]:
        items = [f"{li.get('quantity')} yd {li.get('name', '')}" for li in ord.get("line_items", [])]
        order_history.append({
            "wc_order_id": ord["id"],
            "order_number": ord.get("number"),
            "date": ord.get("date_created", "")[:10],
            "status": ord.get("status"),
            "total": ord.get("total"),
            "items": items,
            "line_items_raw": [
                {
                    "product_id": li.get("product_id"),
                    "name": li.get("name"),
                    "quantity": li.get("quantity"),
                }
                for li in ord.get("line_items", [])
            ],
        })

    return {
        "found": True,
        "wc_id": wc_customer_id,
        "email": email,
        "first_name": billing.get("first_name", ""),
        "last_name": billing.get("last_name", ""),
        "phone": phone,
        "role": wc_role,
        "billing": billing,
        "stripe_customer_id": stripe_customer_id,
        "saved_card": saved_card,
        "order_history": order_history,
        "local_customer_id": str(local.id) if local else None,
        "sms_opt_in": local.sms_opt_in if local else False,
        "email_opt_in": local.email_opt_in if local else False,
    }


# ── 3. Shipping fee lookup ────────────────────────────────────────────────────

@router.get("/shipping-fee")
def get_shipping_fee(
    postal_code: str,
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)),
    db: Session = Depends(db_dep),
):
    """Find the flat-rate delivery fee for a given postal code via WC shipping zones."""
    zones = _wc_request("shipping/zones")
    for zone in zones:
        zone_id = zone["id"]
        if zone_id == 0:
            continue  # skip "Rest of World" catch-all
        locations = _wc_request(f"shipping/zones/{zone_id}/locations")
        postcode_matches = [
            loc for loc in locations
            if loc.get("type") == "postcode"
            and loc.get("code", "").replace(" ", "") == postal_code.strip()
        ]
        if postcode_matches:
            methods = _wc_request(f"shipping/zones/{zone_id}/methods")
            for method in methods:
                if method.get("method_id") == "flat_rate" and method.get("enabled"):
                    settings_data = method.get("settings", {})
                    # Find any shipping class cost (class_cost_{id} keys)
                    class_cost = next(
                        (v.get("value") for k, v in settings_data.items() 
                         if k.startswith("class_cost_") and v.get("value")),
                        None
                    )
                    cost = class_cost or settings_data.get("cost", {}).get("value") or "0"
                    return {
                        "found": True,
                        "zone_id": zone_id,
                        "zone_title": zone["name"],
                        "fee": cost,
                    }
            # Zone matched but no flat rate — delivery allowed, $0 fee
            return {"found": True, "zone_id": zone_id, "zone_title": zone["name"], "fee": "0"}

    return {"found": False, "fee": None}


# ── 4. Stripe: Setup Intent (save card) ──────────────────────────────────────

class SetupIntentIn(BaseModel):
    stripe_customer_id: str | None = None  # existing, if known
    customer_name: str
    customer_email: str | None = None


@router.post("/create-setup-intent")
def create_setup_intent(
    payload: SetupIntentIn,
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)),
    db: Session = Depends(db_dep),
):
    """
    Create a Stripe SetupIntent for saving a card on file.
    Creates a Stripe Customer if one doesn't exist yet.
    Returns client_secret for the frontend Stripe Elements.
    """
    s = _stripe()

    stripe_customer_id = payload.stripe_customer_id

    # Create Stripe Customer if needed
    if not stripe_customer_id:
        sc = s.Customer.create(
            name=payload.customer_name,
            email=payload.customer_email or "",
            metadata={"source": "dispatch-internal"},
        )
        stripe_customer_id = sc.id

    intent = s.SetupIntent.create(
        customer=stripe_customer_id,
        payment_method_types=["card"],
        usage="off_session",
    )

    return {
        "client_secret": intent.client_secret,
        "stripe_customer_id": stripe_customer_id,
    }


# ── 5. Stripe: Payment Intent (charge now) ───────────────────────────────────

class PaymentIntentIn(BaseModel):
    amount_cents: int
    stripe_customer_id: str | None = None
    payment_method_id: str | None = None  # if charging saved card
    customer_name: str
    customer_email: str | None = None
    save_card: bool = False
    description: str = "East Meadow Garden Center order"


@router.post("/create-payment-intent")
def create_payment_intent(
    payload: PaymentIntentIn,
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)),
    db: Session = Depends(db_dep),
):
    """
    Create a Stripe PaymentIntent for immediate card charge.
    If save_card=True, sets up for future off-session use.
    Returns client_secret for frontend to confirm the payment.
    """
    s = _stripe()

    stripe_customer_id = payload.stripe_customer_id

    # Create Stripe Customer if needed
    if not stripe_customer_id:
        sc = s.Customer.create(
            name=payload.customer_name,
            email=payload.customer_email or "",
            metadata={"source": "dispatch-internal"},
        )
        stripe_customer_id = sc.id

    intent_params: dict = {
        "amount": payload.amount_cents,
        "currency": "usd",
        "customer": stripe_customer_id,
        "description": payload.description,
        "metadata": {"source": "dispatch-internal"},
    }

    if payload.save_card:
        intent_params["setup_future_usage"] = "off_session"

    if payload.payment_method_id:
        # Charging saved card — confirm immediately server-side
        intent_params["payment_method"] = payload.payment_method_id
        intent_params["confirm"] = True
        intent_params["off_session"] = True
        intent = s.PaymentIntent.create(**intent_params)
        return {
            "payment_intent_id": intent.id,
            "status": intent.status,
            "stripe_customer_id": stripe_customer_id,
            "confirmed": True,
        }
    else:
        # New card — return client_secret for frontend Elements to confirm
        intent = s.PaymentIntent.create(**intent_params)
        return {
            "client_secret": intent.client_secret,
            "payment_intent_id": intent.id,
            "stripe_customer_id": stripe_customer_id,
            "confirmed": False,
        }


# ── 6. Create Order ───────────────────────────────────────────────────────────

class OrderLineItem(BaseModel):
    product_id: int
    quantity: int
    price: str  # unit price at time of order (role-based)
    name: str = ""


class InternalOrderIn(BaseModel):
    # Customer
    first_name: str
    last_name: str
    email: str | None = None
    phone: str
    sms_opt_in: bool = False
    email_opt_in: bool = False
    company_name: str | None = None
    wc_customer_id: int | None = None
    wc_role: str | None = None
    is_contractor: bool = False

    # Order
    line_items: list[OrderLineItem]
    delivery_method: str  # "delivery" or "pickup"

    # Delivery address
    address_line1: str = ""
    address_line2: str = ""
    address_city: str = ""
    address_state: str = ""
    address_postal_code: str = ""

    # Pricing
    delivery_fee: str = "0"

    # Payment
    payment_method: str = "cash"  # "cash" | "card" | "payment_link" | "invoice"
    payment_note: str = ""
    stripe_payment_intent_id: str | None = None
    stripe_customer_id: str | None = None
    payment_status: str = "unpaid"  # "paid" | "unpaid" | "pending_link"

    # Location
    location_id: str | None = None


@router.post("/create")
def create_internal_order(
    payload: InternalOrderIn,
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)),
    db: Session = Depends(db_dep),
):
    """
    Full internal order creation flow:
    1. Upsert WooCommerce customer (create if new, update role if needed)
    2. Create WooCommerce order via REST API
    3. Upsert local Customer record with wc_customer_id + stripe_customer_id
    4. Upsert local CustomerAddress
    5. WC webhook will fire automatically and create the Drop + Loads
    6. If payment_link: create Stripe Payment Link and send via SMS/email
    7. Return WC order details + payment link if applicable
    """

    # ── Step 1: Resolve/create WC customer ────────────────────────────────────
    wc_customer_id = payload.wc_customer_id

    if not wc_customer_id:
        # Check if customer exists in WC by email
        if payload.email:
            try:
                existing = _wc_request(f"customers?search={urllib.parse.quote(payload.email)}&per_page=1")
                if existing:
                    wc_customer_id = existing[0]["id"]
            except Exception:
                pass

        # Still not found — create in WC
        if not wc_customer_id:
            wc_role_to_set = "contractor" if payload.is_contractor else (payload.wc_role or "customer")
            try:
                new_wc_customer = _wc_request("customers", method="POST", payload={
                    "first_name": payload.first_name,
                    "last_name": payload.last_name,
                    "email": payload.email or "",
                    "username": (payload.email or f"{payload.first_name.lower()}{payload.last_name.lower()}").replace(" ", ""),
                    "billing": {
                        "first_name": payload.first_name,
                        "last_name": payload.last_name,
                        "email": payload.email or "",
                        "phone": payload.phone,
                        "address_1": payload.address_line1,
                        "address_2": payload.address_line2,
                        "city": payload.address_city,
                        "state": payload.address_state,
                        "postcode": payload.address_postal_code,
                        "country": "US",
                    },
                    "role": wc_role_to_set,
                    "meta_data": [
                        {"key": "_emgc_sms_optin", "value": "1" if payload.sms_opt_in else "0"},
                    ],
                })
                wc_customer_id = new_wc_customer["id"]
                logger.info(f"Created WC customer {wc_customer_id} for {payload.first_name} {payload.last_name}")
            except HTTPException:
                # WC customer creation failed (e.g. duplicate email) — proceed without
                logger.warning(f"Could not create WC customer — proceeding as guest order")
                logger.info(f"create_internal_order: step 1 complete, wc_customer_id={wc_customer_id}")

    # ── Step 2: Create WooCommerce order ─────────────────────────────────────

    wc_line_items = [
        {"product_id": item.product_id, "quantity": item.quantity}
        for item in payload.line_items
    ]

    fee_lines = []
    if payload.delivery_method == "delivery" and float(payload.delivery_fee or 0) > 0:
        fee_lines.append({
            "name": "Delivery Fee",
            "total": payload.delivery_fee,
        })

    shipping_lines = [{
        "method_id": "flat_rate" if payload.delivery_method == "delivery" else "local_pickup",
        "method_title": "Delivery" if payload.delivery_method == "delivery" else "Pickup",
    }]

    billing = {
        "first_name": payload.first_name,
        "last_name": payload.last_name,
        "email": payload.email or "",
        "phone": payload.phone,
        "address_1": payload.address_line1,
        "address_2": payload.address_line2,
        "city": payload.address_city,
        "state": payload.address_state,
        "postcode": payload.address_postal_code,
        "country": "US",
    }

    set_paid = payload.payment_method in ("cash", "card") and payload.payment_status == "paid"

    meta_data = [
        {"key": "_emgc_sms_optin", "value": "1" if payload.sms_opt_in else "0"},
        {"key": "_emgc_source", "value": "internal"},
        {"key": "_emgc_payment_method", "value": payload.payment_method},
        {"key": "_emgc_payment_note", "value": payload.payment_note},
    ]
    if payload.wc_role:
        meta_data.append({"key": "_emgc_customer_role", "value": payload.wc_role})
    if payload.stripe_payment_intent_id:
        meta_data.append({"key": "_stripe_payment_intent_id", "value": payload.stripe_payment_intent_id})
    if payload.payment_method == "invoice":
        meta_data.append({"key": "_emgc_invoice_pending", "value": "1"})

    wc_payload: dict = {
        "status": "processing",
        "billing": billing,
        "shipping": {
            "first_name": payload.first_name,
            "last_name": payload.last_name,
            "address_1": payload.address_line1,
            "address_2": payload.address_line2,
            "city": payload.address_city,
            "state": payload.address_state,
            "postcode": payload.address_postal_code,
            "country": "US",
        },
        "line_items": wc_line_items,
        "fee_lines": fee_lines,
        "shipping_lines": shipping_lines,
        "meta_data": meta_data,
        "set_paid": set_paid,
    }

    if wc_customer_id:
        wc_payload["customer_id"] = wc_customer_id

    try:
        wc_order = _wc_request("orders", method="POST", payload=wc_payload)
        logger.info(f"create_internal_order: step 2 complete, wc_order_id={wc_order.get('id')}")
    except HTTPException as e:
        logger.error(f"WC order creation failed: {e.detail}")
        raise
    except Exception as e:
        logger.exception(f"WC order creation unexpected error: {e}")
        raise HTTPException(status_code=500, detail={"code": "order_creation_failed", "message": str(e)})
    wc_order_id = wc_order.get("id")
    order_number = wc_order.get("number", str(wc_order_id))

    logger.info(f"internal_order: created WC order #{order_number} (id={wc_order_id})")

    # ── Step 3: Upsert local Customer record ──────────────────────────────────

    try:
        normalized_phone = normalize_us_phone(payload.phone)
    except ValueError:
        normalized_phone = payload.phone

    local_customer = None
    if normalized_phone:
        local_customer = db.execute(
            select(Customer).where(
                Customer.tenant_id == user.tenant_id,
                Customer.phone_e164 == normalized_phone,
            )
        ).scalar_one_or_none()()

    if not local_customer and payload.email:
        local_customer = db.execute(
            select(Customer).where(
                Customer.tenant_id == user.tenant_id,
                Customer.email == payload.email.strip().lower(),
            )
        ).scalar_one_or_none()()

    if local_customer:
        # Update existing
        local_customer.first_name = payload.first_name
        local_customer.last_name = payload.last_name
        local_customer.name = f"{payload.first_name} {payload.last_name}".strip()
        if payload.email:
            local_customer.email = payload.email.strip().lower()
        if payload.company_name:
            local_customer.company_name = payload.company_name
        if wc_customer_id:
            local_customer.wc_customer_id = wc_customer_id
        if payload.stripe_customer_id:
            local_customer.stripe_customer_id = payload.stripe_customer_id
        local_customer.is_contractor = payload.is_contractor
        local_customer.sms_opt_in = payload.sms_opt_in
        local_customer.email_opt_in = payload.email_opt_in
        if payload.is_contractor or payload.wc_role == "commercial":
            local_customer.customer_type = CustomerType.COMMERCIAL
    else:
        # Create new
        local_customer = Customer(
            tenant_id=user.tenant_id,
            first_name=payload.first_name,
            last_name=payload.last_name,
            name=f"{payload.first_name} {payload.last_name}".strip(),
            company_name=payload.company_name,
            phone_e164=normalized_phone,
            email=payload.email.strip().lower() if payload.email else None,
            wc_customer_id=wc_customer_id,
            stripe_customer_id=payload.stripe_customer_id,
            is_contractor=payload.is_contractor,
            sms_opt_in=payload.sms_opt_in,
            email_opt_in=payload.email_opt_in,
            customer_type=CustomerType.COMMERCIAL if (payload.is_contractor or payload.wc_role in ("contractor", "wholesale")) else CustomerType.RESIDENTIAL,
        )
        db.add(local_customer)

    db.flush()

    # ── Step 4: Upsert local CustomerAddress (delivery only) ──────────────────

    if payload.delivery_method == "delivery" and payload.address_line1.strip():
        # Find default location
        location = db.execute(
            select(Location).where(
                Location.tenant_id == user.tenant_id,
                Location.is_active == True,  # noqa: E712
            ).order_by(Location.name)
        ).first()

        existing_addr = db.execute(
            select(CustomerAddress).where(
                CustomerAddress.tenant_id == user.tenant_id,
                CustomerAddress.customer_id == local_customer.id,
                CustomerAddress.line1.ilike(payload.address_line1.strip()),
                CustomerAddress.postal_code == payload.address_postal_code.strip(),
            )
        ).first()

        if not existing_addr:
            db.add(CustomerAddress(
                tenant_id=user.tenant_id,
                customer_id=local_customer.id,
                line1=payload.address_line1.strip(),
                line2=payload.address_line2.strip() or None,
                city=payload.address_city.strip(),
                state=payload.address_state.strip().upper(),
                postal_code=payload.address_postal_code.strip(),
                country="US",
                is_default=True,
                last_used_at=now_utc(),
            ))
        else:
            existing_addr.last_used_at = now_utc()

    log_event(db, user.tenant_id, "internal_order.created", "api", {
        "wc_order_id": wc_order_id,
        "order_number": order_number,
        "delivery_method": payload.delivery_method,
        "payment_method": payload.payment_method,
        "wc_customer_id": wc_customer_id,
    })
    db.commit()

    # ── Step 5: Stripe Payment Link (if requested) ───────────────────────────

    payment_link_url = None
    payment_link_id = None

    if payload.payment_method == "payment_link":
        try:
            s = _stripe()
            # Build line items for Stripe Payment Link
            stripe_line_items = []
            for item in payload.line_items:
                price_cents = int(float(item.price) * 100)
                stripe_line_items.append({
                    "price_data": {
                        "currency": "usd",
                        "unit_amount": price_cents,
                        "product_data": {
                            "name": item.name or f"Product #{item.product_id}",
                        },
                    },
                    "quantity": item.quantity,
                })

            # Add delivery fee as separate line item if applicable
            delivery_fee_cents = int(float(payload.delivery_fee or 0) * 100)
            if delivery_fee_cents > 0:
                stripe_line_items.append({
                    "price_data": {
                        "currency": "usd",
                        "unit_amount": delivery_fee_cents,
                        "product_data": {"name": "Delivery Fee"},
                    },
                    "quantity": 1,
                })

            pl = s.PaymentLink.create(
                line_items=stripe_line_items,
                metadata={
                    "wc_order_id": str(wc_order_id),
                    "order_number": str(order_number),
                    "source": "dispatch-internal",
                },
            )
            payment_link_url = pl.url
            payment_link_id = pl.id

            # Update WC order with payment link meta
            try:
                _wc_request(f"orders/{wc_order_id}", method="PUT", payload={
                    "meta_data": [
                        {"key": "_stripe_payment_link_id", "value": payment_link_id},
                        {"key": "_stripe_payment_link_url", "value": payment_link_url},
                    ]
                })
            except Exception:
                pass  # non-fatal

            # Send payment link notification based on opt-ins
            _send_payment_link_notifications(
                payment_link_url=payment_link_url,
                order_number=order_number,
                customer_name=f"{payload.first_name} {payload.last_name}".strip(),
                phone=normalized_phone,
                email=payload.email,
                sms_opt_in=payload.sms_opt_in,
                email_opt_in=payload.email_opt_in,
                tenant_id=str(user.tenant_id),
            )

        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Stripe payment link creation failed: {e}")
            # Non-fatal — return order without link, frontend shows manual URL

    return {
        "wc_order_id": wc_order_id,
        "order_number": order_number,
        "wc_order_key": wc_order.get("order_key", ""),
        "status": wc_order.get("status"),
        "payment_link_url": payment_link_url,
        "payment_link_id": payment_link_id,
        "local_customer_id": str(local_customer.id) if local_customer else None,
        "stripe_customer_id": payload.stripe_customer_id,
    }


# ── Payment link notification helper ─────────────────────────────────────────

def _send_payment_link_notifications(
    payment_link_url: str,
    order_number: str,
    customer_name: str,
    phone: str | None,
    email: str | None,
    sms_opt_in: bool,
    email_opt_in: bool,
    tenant_id: str,
) -> None:
    """Send payment link via SMS and/or email based on customer opt-ins."""

    # SMS — only if opted in (Twilio A2P compliance)
    if sms_opt_in and phone:
        try:
            from app.api.routes.sms import enqueue_sms_job
            message = (
                f"Hi {customer_name.split()[0]}! Your East Meadow Garden Center order #{order_number} "
                f"is ready for payment. Pay securely here: {payment_link_url}"
            )
            enqueue_sms_job(
                {
                    "type": "SEND_SMS",
                    "tenant_id": tenant_id,
                    "to": phone,
                    "template": "custom",
                    "message": message,
                },
                dedupe_key=f"payment-link-{order_number}",
            )
            logger.info(f"Payment link SMS queued for order #{order_number}")
        except Exception as e:
            logger.error(f"Payment link SMS failed: {e}")

    # Email — only if opted in
    if email_opt_in and email:
        try:
            from app.api.routes.email_service import send_payment_link_email
            send_payment_link_email(email, customer_name, order_number, payment_link_url)
            logger.info(f"Payment link email sent for order #{order_number}")
        except Exception as e:
            logger.error(f"Payment link email failed: {e}")


# ── 7. Stripe Webhook ─────────────────────────────────────────────────────────

@router.post("/stripe-webhook")
async def stripe_webhook(request: Request, db: Session = Depends(db_dep)):
    """
    Handle Stripe webhook events.
    On payment_intent.succeeded → mark WC order as paid.
    On payment_link completed → mark WC order as paid.
    """
    if not settings.stripe_webhook_secret:
        raise HTTPException(status_code=503, detail="Stripe webhook not configured")

    payload = await request.body()
    sig_header = request.headers.get("stripe-signature", "")

    try:
        event = stripe.Webhook.construct_event(
            payload, sig_header, settings.stripe_webhook_secret
        )
    except stripe.error.SignatureVerificationError:
        raise HTTPException(status_code=400, detail="Invalid Stripe signature")

    if event["type"] == "payment_intent.succeeded":
        pi = event["data"]["object"]
        wc_order_id = pi.get("metadata", {}).get("wc_order_id")
        if wc_order_id:
            _mark_wc_order_paid(wc_order_id, pi["id"])

    elif event["type"] == "checkout.session.completed":
        session = event["data"]["object"]
        wc_order_id = session.get("metadata", {}).get("wc_order_id")
        if wc_order_id:
            _mark_wc_order_paid(wc_order_id, session.get("payment_intent", ""))

    return {"status": "ok"}


def _mark_wc_order_paid(wc_order_id: str, payment_ref: str) -> None:
    """Update WC order status to processing with payment confirmation."""
    try:
        _wc_request(f"orders/{wc_order_id}", method="PUT", payload={
            "set_paid": True,
            "meta_data": [
                {"key": "_stripe_payment_confirmed", "value": payment_ref},
            ],
        })
        logger.info(f"WC order {wc_order_id} marked paid via Stripe ({payment_ref})")
    except Exception as e:
        logger.error(f"Failed to mark WC order {wc_order_id} as paid: {e}")


# ── 8. Invoice queue (for ops dashboard) ─────────────────────────────────────

@router.get("/invoiced-orders")
def get_invoiced_orders(
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)),
    db: Session = Depends(db_dep),
):
    """Return all drops with payment_method=invoice for the ops/accounting queue."""
    drops = db.execute(
        select(Drop, Customer)
        .join(Customer, Customer.id == Drop.customer_id)
        .where(
            Drop.tenant_id == user.tenant_id,
            Drop.payment_method == "invoice",
        )
        .order_by(Drop.created_at.desc())
    ).all()

    return {
        "invoiced": [
            {
                "drop_id": str(d.id),
                "order_number": d.order_number,
                "customer_name": f"{c.first_name} {c.last_name}".strip(),
                "company_name": c.company_name,
                "phone": c.phone_e164,
                "email": c.email,
                "payment_note": d.payment_note,
                "payment_status": d.payment_status,
                "delivery_method": d.delivery_method,
                "scheduled_date": str(d.scheduled_date) if d.scheduled_date else None,
                "created_at": d.created_at.isoformat() if d.created_at else None,
                "wc_order_id": d.external_order_id,
            }
            for d, c in drops
        ]
    }
