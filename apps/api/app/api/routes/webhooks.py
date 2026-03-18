import hashlib
import hmac
import logging

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import db_dep
from app.api.services import log_event, now_utc
from app.api.email_service import send_pickup_ready_email
from app.models.entities import (
    Channel, ChannelType, Customer, CustomerAddress,
    Drop, Load, Location, ProductCatalogItem, Tenant,
)

logger = logging.getLogger("dispatch.webhooks")

router = APIRouter(prefix="/webhooks", tags=["webhooks"])


def _normalize_phone(raw: str) -> str | None:
    if not raw:
        return None
    digits = "".join(ch for ch in raw if ch.isdigit())
    if len(digits) == 10:
        digits = f"1{digits}"
    if len(digits) == 11 and digits.startswith("1"):
        return f"+{digits}"
    return None


def _next_order_number(db: Session, tenant_id) -> int:
    from sqlalchemy import func
    current_max = db.execute(
        select(func.coalesce(func.max(Drop.order_number), 0)).where(Drop.tenant_id == tenant_id)
    ).scalar_one()
    return current_max + 1


@router.post("/woocommerce")
async def woocommerce_webhook(
    request: Request,
    x_wc_webhook_topic: str | None = Header(default=None),
    x_wc_webhook_source: str | None = Header(default=None),
    db: Session = Depends(db_dep),
):
    body = await request.body()
    import json
    try:
        payload = json.loads(body)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    # Only handle order.updated and order.created
    topic = x_wc_webhook_topic or ""
    if not topic.startswith("order."):
        return {"status": "ignored", "topic": topic}

    # Find the WooCommerce channel
    channel = db.execute(
        select(Channel).where(
            Channel.channel_type == ChannelType.WOOCOMMERCE,
            Channel.is_active == True,
        )
    ).scalar_one_or_none()
    if not channel:
        logger.warning("woocommerce_webhook: no active WooCommerce channel found")
        raise HTTPException(status_code=400, detail="No active WooCommerce channel")

    tenant_id = channel.tenant_id

    # Skip if already ingested
    external_order_id = str(payload.get("id", ""))
    if not external_order_id:
        return {"status": "ignored", "reason": "no order id"}

    existing = db.execute(
        select(Drop).where(
            Drop.tenant_id == tenant_id,
            Drop.external_order_id == external_order_id,
        )
    ).scalar_one_or_none()
    if existing:
        return {"status": "already_ingested", "drop_id": str(existing.id)}

    # Only process paid statuses
    wc_status = payload.get("status", "")
    if wc_status not in ("processing", "completed"):
        return {"status": "ignored", "reason": f"order status is {wc_status}"}

    # Resolve location
    location = db.execute(
        select(Location).where(
            Location.tenant_id == tenant_id,
            Location.is_active == True,
        ).order_by(Location.created_at)
    ).scalars().first()
    if not location:
        raise HTTPException(status_code=400, detail="No active location found")

    # Determine delivery method from shipping lines
    delivery_method = "delivery"
    for line in payload.get("shipping_lines", []):
        method_id = line.get("method_id", "")
        if "pickup" in method_id.lower() or method_id == "local_pickup":
            delivery_method = "pickup"
            break

    # Get address
    billing  = payload.get("billing", {})
    shipping = payload.get("shipping", {})
    addr     = billing if delivery_method == "pickup" else shipping

    # Upsert customer
    phone = _normalize_phone(billing.get("phone", ""))
    email = billing.get("email", "")

    customer = None
    if phone:
        customer = db.execute(
            select(Customer).where(
                Customer.tenant_id == tenant_id,
                Customer.phone_e164 == phone,
            )
        ).scalar_one_or_none()
    if not customer and email:
        customer = db.execute(
            select(Customer).where(
                Customer.tenant_id == tenant_id,
                Customer.email == email,
            )
        ).scalar_one_or_none()
    if not customer:
        customer = Customer(
            tenant_id=tenant_id,
            name=f"{billing.get('first_name', '')} {billing.get('last_name', '')}".strip(),
            phone_e164=phone,
            email=email or None,
            first_name=billing.get("first_name", ""),
            last_name=billing.get("last_name", ""),
        )
        db.add(customer)
        db.flush()

    # Upsert address
    line1       = addr.get("address_1", "")
    city        = addr.get("city", "")
    state       = addr.get("state", "")
    postal_code = addr.get("postcode", "")

    address = db.execute(
        select(CustomerAddress).where(
            CustomerAddress.tenant_id == tenant_id,
            CustomerAddress.customer_id == customer.id,
            CustomerAddress.line1.ilike(line1),
            CustomerAddress.city.ilike(city),
            CustomerAddress.state.ilike(state),
            CustomerAddress.postal_code == postal_code,
        )
    ).scalar_one_or_none()
    if not address:
        address = CustomerAddress(
            tenant_id=tenant_id,
            customer_id=customer.id,
            line1=line1,
            line2=addr.get("address_2") or None,
            city=city,
            state=state,
            postal_code=postal_code,
            country="US",
            last_used_at=now_utc(),
        )
        db.add(address)
        db.flush()

    # Resolve SKUs to catalog items and build loads
    line_items = payload.get("line_items", [])
    loads_to_create = []
    skipped_skus = []

    for item in line_items:
        sku = (item.get("sku") or "").strip()
        qty = int(item.get("quantity", 1))
        if not sku:
            continue
        catalog_item = db.execute(
            select(ProductCatalogItem).where(
                ProductCatalogItem.tenant_id == tenant_id,
                ProductCatalogItem.location_id == location.id,
                ProductCatalogItem.sku == sku,
                ProductCatalogItem.active == True,
            )
        ).scalar_one_or_none()
        if catalog_item:
            loads_to_create.append((catalog_item, qty))
        else:
            skipped_skus.append(sku)
            logger.warning(f"woocommerce_webhook: SKU '{sku}' not found in catalog — skipping")

    if not loads_to_create:
        logger.warning(f"woocommerce_webhook: order {external_order_id} has no matching SKUs — not creating drop")
        log_event(db, tenant_id, "webhook.woocommerce.no_skus", "webhook", {
            "external_order_id": external_order_id,
            "skipped_skus": skipped_skus,
        })
        db.commit()
        return {"status": "ignored", "reason": "no matching SKUs", "skipped_skus": skipped_skus}

    # Create drop
    drop = Drop(
        tenant_id=tenant_id,
        location_id=location.id,
        customer_id=customer.id,
        address_id=address.id,
        order_number=_next_order_number(db, tenant_id),
        external_order_id=external_order_id,
        source="woocommerce",
        delivery_method=delivery_method,
        is_priority=False,
        scheduled_date=None,
        scheduled_window=None,
        notes=payload.get("customer_note", "") or "",
        drop_photos=[],
    )
    db.add(drop)
    db.flush()

    # Create loads
    for catalog_item, qty in loads_to_create:
        load = Load(
            tenant_id=tenant_id,
            drop_id=drop.id,
            bulk_group_snapshot=catalog_item.bulk_group,
            material_name_snapshot=catalog_item.name,
            qty=qty,
            unit=catalog_item.unit,
            route_date=now_utc().date(),
            route_window=None,
        )
        db.add(load)

    log_event(db, tenant_id, "webhook.woocommerce.ingested", "webhook", {
        "external_order_id": external_order_id,
        "drop_id": str(drop.id),
        "delivery_method": delivery_method,
        "skipped_skus": skipped_skus,
    })
    db.commit()

    logger.info(f"woocommerce_webhook: order {external_order_id} → drop {drop.id} ({delivery_method})")
    return {"status": "ok", "drop_id": str(drop.id), "delivery_method": delivery_method}
