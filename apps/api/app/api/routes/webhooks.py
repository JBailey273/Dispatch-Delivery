import json
import logging
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel
from app.api.deps import db_dep, require_channel, ChannelAuth
from app.api.services import log_event, normalize_us_phone, now_utc
from app.core.config import settings
from app.models.entities import (
    Channel, ChannelType, Customer, CustomerAddress, CustomerType,
    Drop, Load, LoadStatus, Location, ProductCatalogItem, Tenant,
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
    current_max = db.execute(
        select(func.coalesce(func.max(Drop.order_number), 0)).where(Drop.tenant_id == tenant_id)
    ).scalar_one()
    return current_max + 1


@router.post("/woocommerce")
async def woocommerce_webhook(
    request: Request,
    x_wc_webhook_topic: str | None = Header(default=None),
    db: Session = Depends(db_dep),
):
    body = await request.body()
    if not body:
        return {"status": "ok", "ping": True}
    try:
        payload = json.loads(body)
    except Exception:
        return {"status": "ok", "ping": True}

    topic = x_wc_webhook_topic or ""
    if not topic.startswith("order."):
        return {"status": "ignored", "topic": topic}

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

    wc_status = payload.get("status", "")
    if wc_status not in ("processing", "completed"):
        return {"status": "ignored", "reason": f"order status is '{wc_status}'"}

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

    location = db.execute(
        select(Location).where(
            Location.tenant_id == tenant_id,
            Location.is_active == True,
        ).order_by(Location.created_at)
    ).scalars().first()
    if not location:
        raise HTTPException(status_code=400, detail="No active location found")

    delivery_method = "delivery"
    for line in payload.get("shipping_lines", []):
        method_id = line.get("method_id", "").lower()
        method_title = line.get("method_title", "").lower()
        if "pickup" in method_id or "pickup" in method_title:
            delivery_method = "pickup"
            break

    billing  = payload.get("billing", {})
    shipping = payload.get("shipping", {})
    addr     = billing if delivery_method == "pickup" else shipping

    phone = _normalize_phone(billing.get("phone", ""))
    email = billing.get("email", "").strip().lower() or None

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
        first = billing.get("first_name", "").strip()
        last  = billing.get("last_name", "").strip()
        customer = Customer(
            tenant_id=tenant_id,
            name=f"{first} {last}".strip(),
            first_name=first,
            last_name=last,
            phone_e164=phone,
            email=email,
        )
        db.add(customer)
        db.flush()

    line1       = addr.get("address_1", "").strip()
    line2       = addr.get("address_2", "").strip() or None
    city        = addr.get("city", "").strip()
    state       = addr.get("state", "").strip()
    postal_code = addr.get("postcode", "").strip()

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
            line2=line2,
            city=city,
            state=state,
            postal_code=postal_code,
            country="US",
            last_used_at=now_utc(),
        )
        db.add(address)
        db.flush()
    else:
        address.last_used_at = now_utc()

    line_items    = payload.get("line_items", [])
    matched_items = []
    skipped_skus  = []

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
            matched_items.append((catalog_item, qty))
        else:
            skipped_skus.append(sku)
            logger.warning(f"woocommerce_webhook: SKU '{sku}' not in catalog — skipping")

    if not matched_items:
        logger.warning(f"woocommerce_webhook: order {external_order_id} has no matching SKUs — not creating drop")
        log_event(db, tenant_id, "webhook.woocommerce.no_skus", "webhook", {
            "external_order_id": external_order_id,
            "skipped_skus": skipped_skus,
        })
        db.commit()
        return {"status": "ignored", "reason": "no matching SKUs", "skipped_skus": skipped_skus}

    customer_note = payload.get("customer_note", "") or ""
    notes = customer_note.strip() or None

    logger.info(f"woocommerce_webhook: number={payload.get('number')!r} id={payload.get('id')!r}")
    wc_order_number = int(payload.get("number") or payload.get("id") or 0) or None
    drop = Drop(
        tenant_id=tenant_id,
        location_id=location.id,
        customer_id=customer.id,
        address_id=address.id,
        order_number=wc_order_number,
        qd_number=None,
        external_order_id=external_order_id,
        source="woocommerce",
        delivery_method=delivery_method,
        is_priority=False,
        scheduled_date=None,
        scheduled_window=None,
        notes=notes,
        drop_photos=[],
    )
    db.add(drop)
    db.flush()

    for catalog_item, qty in matched_items:
        load = Load(
            tenant_id=tenant_id,
            drop_id=drop.id,
            status=LoadStatus.ASSIGNED,
            bulk_group_snapshot=catalog_item.bulk_group or catalog_item.sku,
            material_name_snapshot=catalog_item.name,
            qty=qty,
            unit=catalog_item.unit or "unit",
            driver_user_id=None,
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


class JsIngestCustomer(BaseModel):
    name: str
    phone: str | None = None
    email: str | None = None


class JsIngestAddress(BaseModel):
    line1: str
    line2: str = ''
    city: str
    state: str
    postal_code: str
    country: str = 'US'


class JsIngestDrop(BaseModel):
    address: JsIngestAddress
    notes: str = ''


class JsIngestItem(BaseModel):
    sku: str
    qty: int


class JsIngestExternalOrder(BaseModel):
    id: str
    number: int | None = None
    placed_at: str | None = None
    url: str | None = None


class JsIngestIn(BaseModel):
    external_order: JsIngestExternalOrder
    customer: JsIngestCustomer
    drop: JsIngestDrop
    items: list[JsIngestItem]
    delivery_method: str = 'delivery'


@router.post("/ingest")
def js_ingest_order(
    payload: JsIngestIn,
    channel: ChannelAuth = Depends(require_channel),
    db: Session = Depends(db_dep),
):
    """
    JS-initiated order ingest from WooCommerce thank-you page.
    Same logic as woocommerce_webhook but uses channel key auth
    and accepts our canonical payload format.
    """
    tenant_id = channel.tenant_id
    external_order_id = payload.external_order.id

    existing = db.execute(
        select(Drop).where(
            Drop.tenant_id == tenant_id,
            Drop.external_order_id == external_order_id,
        )
    ).scalar_one_or_none()
    if existing:
        return {"status": "already_ingested", "drop_id": str(existing.id)}

    location = db.execute(
        select(Location).where(
            Location.tenant_id == tenant_id,
            Location.is_active == True,
        ).order_by(Location.created_at)
    ).scalars().first()
    if not location:
        raise HTTPException(status_code=400, detail="No active location found")

    raw_phone = payload.customer.phone or ''
    phone_e164 = _normalize_phone(raw_phone)
    email = (payload.customer.email or '').strip().lower() or None

    customer = None
    if email:
        customer = db.execute(
            select(Customer).where(Customer.tenant_id == tenant_id, Customer.email == email)
        ).scalars().first()
    if not customer and phone_e164:
        customer = db.execute(
            select(Customer).where(Customer.tenant_id == tenant_id, Customer.phone_e164 == phone_e164)
        ).scalars().first()
    if not customer:
        name_parts = payload.customer.name.strip().split(' ', 1)
        customer = Customer(
            tenant_id=tenant_id,
            name=payload.customer.name.strip(),
            first_name=name_parts[0],
            last_name=name_parts[1] if len(name_parts) > 1 else '',
            phone_e164=phone_e164,
            email=email,
            customer_type=CustomerType.RESIDENTIAL,
            sms_opt_in=bool(phone_e164),
            email_opt_in=bool(email),
        )
        db.add(customer)
        db.flush()

    addr = payload.drop.address
    line1 = addr.line1.strip().title()
    city  = addr.city.strip().title()
    state = addr.state.strip().upper()
    postal_code = addr.postal_code.strip()

    address = db.execute(
        select(CustomerAddress).where(
            CustomerAddress.tenant_id == tenant_id,
            CustomerAddress.customer_id == customer.id,
            CustomerAddress.line1 == line1,
            CustomerAddress.postal_code == postal_code,
        )
    ).scalars().first()
    if not address:
        address = CustomerAddress(
            tenant_id=tenant_id,
            customer_id=customer.id,
            line1=line1,
            line2=addr.line2.strip() or None,
            city=city,
            state=state,
            postal_code=postal_code,
            country='US',
            last_used_at=now_utc(),
        )
        db.add(address)
        db.flush()
    else:
        address.last_used_at = now_utc()

    matched_items = []
    skipped_skus = []
    for item in payload.items:
        sku = item.sku.strip()
        catalog_item = db.execute(
            select(ProductCatalogItem).where(
                ProductCatalogItem.tenant_id == tenant_id,
                ProductCatalogItem.location_id == location.id,
                ProductCatalogItem.sku == sku,
                ProductCatalogItem.active == True,
            )
        ).scalars().first()
        if catalog_item:
            matched_items.append((catalog_item, item.qty))
        else:
            skipped_skus.append(sku)
            logger.warning(f"js_ingest: SKU '{sku}' not in catalog — skipping")

    if not matched_items:
        logger.warning(f"js_ingest: order {external_order_id} has no matching SKUs")
        log_event(db, tenant_id, "webhook.js_ingest.no_skus", "webhook", {
            "external_order_id": external_order_id,
            "skipped_skus": skipped_skus,
        })
        db.commit()
        return {"status": "ignored", "reason": "no matching SKUs", "skipped_skus": skipped_skus}

    drop = Drop(
        tenant_id=tenant_id,
        location_id=location.id,
        customer_id=customer.id,
        address_id=address.id,
        order_number=payload.external_order.number or None,
        qd_number=None,
        external_order_id=external_order_id,
        source="woocommerce",
        delivery_method=payload.delivery_method,
        is_priority=False,
        scheduled_date=None,
        scheduled_window=None,
        notes=payload.drop.notes or None,
        drop_photos=[],
    )
    db.add(drop)
    db.flush()

    for catalog_item, qty in matched_items:
        db.add(Load(
            tenant_id=tenant_id,
            drop_id=drop.id,
            status=LoadStatus.ASSIGNED,
            bulk_group_snapshot=catalog_item.bulk_group or catalog_item.sku,
            material_name_snapshot=catalog_item.name,
            qty=qty,
            unit=catalog_item.unit or "unit",
            driver_user_id=None,
        ))

    log_event(db, tenant_id, "webhook.js_ingest.ingested", "webhook", {
        "external_order_id": external_order_id,
        "drop_id": str(drop.id),
    })
    db.commit()

    return {"status": "ok", "drop_id": str(drop.id)}

# ── WordPress Contractor Sync ─────────────────────────────────────────────────

class WpContractorSyncIn(BaseModel):
    wp_user_id: int
    email: str
    company_name: str
    contact_person: str
    phone: str
    address_1: str
    address_2: str = ""
    city: str
    state: str
    postcode: str
    tenant_slug: str


@router.post("/wp-contractor-sync")
def wp_contractor_sync(
    payload: WpContractorSyncIn,
    request: Request,
    db: Session = Depends(db_dep),
):
    # Verify shared secret
    secret = request.headers.get("X-WP-Sync-Secret", "")
    if not secret or secret != settings.wp_sync_secret:
        raise HTTPException(status_code=401, detail={"code": "unauthorized", "message": "Invalid sync secret"})

    # Resolve tenant by slug
    tenant = db.execute(
        select(Tenant).where(Tenant.slug == payload.tenant_slug)
    ).scalar_one_or_none()
    if not tenant:
        raise HTTPException(status_code=404, detail={"code": "tenant_not_found", "message": "Tenant not found"})

    # Normalize phone
    try:
        phone_e164 = normalize_us_phone(payload.phone)
    except ValueError:
        phone_e164 = payload.phone.strip()

    # Split contact person into first/last
    name_parts = payload.contact_person.strip().split(" ", 1)
    first_name = name_parts[0]
    last_name = name_parts[1] if len(name_parts) > 1 else ""

    # Upsert local Customer — check phone, email, wc_customer_id in that order
    customer = None
    if phone_e164:
        customer = db.execute(
            select(Customer).where(
                Customer.tenant_id == tenant.id,
                Customer.phone_e164 == phone_e164,
            )
        ).scalars().first()
    if not customer and payload.email:
        customer = db.execute(
            select(Customer).where(
                Customer.tenant_id == tenant.id,
                Customer.email == payload.email.strip().lower(),
            )
        ).scalars().first()
    if not customer:
        customer = db.execute(
            select(Customer).where(
                Customer.tenant_id == tenant.id,
                Customer.wc_customer_id == payload.wp_user_id,
            )
        ).scalars().first()

    if customer:
        customer.first_name = first_name
        customer.last_name = last_name
        customer.name = payload.contact_person.strip()
        customer.company_name = payload.company_name
        customer.email = payload.email.strip().lower()
        customer.phone_e164 = phone_e164
        customer.wc_customer_id = payload.wp_user_id
        customer.is_contractor = True
        customer.customer_type = CustomerType.COMMERCIAL
    else:
        customer = Customer(
            tenant_id=tenant.id,
            first_name=first_name,
            last_name=last_name,
            name=payload.contact_person.strip(),
            company_name=payload.company_name,
            email=payload.email.strip().lower(),
            phone_e164=phone_e164,
            wc_customer_id=payload.wp_user_id,
            is_contractor=True,
            customer_type=CustomerType.COMMERCIAL,
            sms_opt_in=False,
            email_opt_in=False,
        )
        db.add(customer)

    db.flush()

    # Upsert address
    if payload.address_1.strip():
        address = db.execute(
            select(CustomerAddress).where(
                CustomerAddress.tenant_id == tenant.id,
                CustomerAddress.customer_id == customer.id,
                CustomerAddress.line1.ilike(payload.address_1.strip()),
                CustomerAddress.postal_code == payload.postcode.strip(),
            )
        ).scalar_one_or_none()

        if not address:
            db.add(CustomerAddress(
                tenant_id=tenant.id,
                customer_id=customer.id,
                line1=payload.address_1.strip(),
                line2=payload.address_2.strip() or None,
                city=payload.city.strip(),
                state=payload.state.strip().upper(),
                postal_code=payload.postcode.strip(),
                country="US",
                is_default=True,
                last_used_at=now_utc(),
            ))
        else:
            address.last_used_at = now_utc()

    log_event(db, tenant.id, "wp_contractor_sync", "webhook", {
        "wp_user_id": payload.wp_user_id,
        "company_name": payload.company_name,
        "email": payload.email,
    })
    db.commit()

    return {"status": "ok", "customer_id": str(customer.id)}
