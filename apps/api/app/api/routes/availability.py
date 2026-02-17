import logging
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from secrets import token_urlsafe

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import AuthUser, ChannelAuth, db_dep, require_channel, require_roles
from app.api.services import log_event, normalize_us_phone, now_utc
from app.models.entities import (
    CapacityHold,
    Customer,
    CustomerAddress,
    DeliveryMode,
    Drop,
    Load,
    ProductCatalogItem,
    Tenant,
    UserRole,
    WindowCapacity,
    WindowCode,
)

router = APIRouter(tags=["availability"])
logger = logging.getLogger("dispatch.availability")


class CartItemIn(BaseModel):
    sku: str
    qty: int


class DateRangeIn(BaseModel):
    start_date: date
    end_date: date


class AvailabilityIn(BaseModel):
    date_range: DateRangeIn
    cart_items: list[CartItemIn]


class HoldCreateIn(BaseModel):
    date: date
    window: WindowCode
    required_loads: int
    cart_hash: str


class ExternalOrderIn(BaseModel):
    id: str
    placed_at: datetime
    url: str | None = None


class CustomerIn(BaseModel):
    name: str
    phone: str
    email: str | None = None


class DropIn(BaseModel):
    address: dict
    notes: str | None = None
    photos: list[str] | None = None
    requested_date: date
    requested_window: WindowCode


class ConfirmOrderIn(BaseModel):
    external_order: ExternalOrderIn
    customer: CustomerIn
    drop: DropIn
    items: list[CartItemIn]


def _required_loads(db: Session, tenant_id, items: list[CartItemIn]) -> tuple[int, dict[str, dict]]:
    skus = [i.sku for i in items]
    catalog = db.execute(
        select(ProductCatalogItem).where(
            ProductCatalogItem.tenant_id == tenant_id,
            ProductCatalogItem.sku.in_(skus),
            ProductCatalogItem.active == True,  # noqa: E712
        )
    ).scalars().all()
    by_sku = {c.sku: c for c in catalog}
    if len(by_sku) != len(set(skus)):
        raise HTTPException(status_code=400, detail={"code": "invalid_items", "message": "One or more SKUs not found/active"})

    grouped = defaultdict(lambda: {"qty": 0, "name": "", "unit": ""})
    for item in items:
        cat = by_sku[item.sku]
        if cat.delivery_mode != DeliveryMode.BULK_LOAD:
            continue
        grouped[cat.bulk_group]["qty"] += item.qty
        grouped[cat.bulk_group]["name"] = cat.name
        grouped[cat.bulk_group]["unit"] = cat.unit
    return len(grouped.keys()), grouped


def _active_holds(db: Session, tenant_id, day: date, window: WindowCode) -> int:
    return (
        db.execute(
            select(func.coalesce(func.sum(CapacityHold.units_held), 0)).where(
                CapacityHold.tenant_id == tenant_id,
                CapacityHold.service_date == day,
                CapacityHold.window_code == window,
                CapacityHold.released_at.is_(None),
                CapacityHold.converted_at.is_(None),
                CapacityHold.expires_at > now_utc(),
            )
        ).scalar_one()
        or 0
    )


def _capacity_row_locked(db: Session, tenant_id, day: date, window: WindowCode) -> WindowCapacity:
    cap = db.execute(
        select(WindowCapacity)
        .where(WindowCapacity.tenant_id == tenant_id, WindowCapacity.service_date == day, WindowCapacity.window_code == window)
        .with_for_update()
    ).scalar_one_or_none()
    if cap:
        return cap
    tenant = db.execute(select(Tenant).where(Tenant.id == tenant_id)).scalar_one()
    cap = WindowCapacity(tenant_id=tenant_id, service_date=day, window_code=window, capacity_total=tenant.capacity_per_window, capacity_used=0)
    db.add(cap)
    db.flush()
    return cap


def _upsert_customer_and_address(db: Session, tenant_id, payload: ConfirmOrderIn) -> tuple[Customer, CustomerAddress]:
    phone = normalize_us_phone(payload.customer.phone)
    customer = db.execute(select(Customer).where(Customer.tenant_id == tenant_id, Customer.phone_e164 == phone)).scalar_one_or_none()
    if not customer:
        customer = Customer(tenant_id=tenant_id, name=payload.customer.name, phone_e164=phone)
        db.add(customer)
        db.flush()

    addr = payload.drop.address
    address = db.execute(
        select(CustomerAddress).where(
            CustomerAddress.tenant_id == tenant_id,
            CustomerAddress.customer_id == customer.id,
            CustomerAddress.line1.ilike(addr["line1"]),
            CustomerAddress.city.ilike(addr["city"]),
            CustomerAddress.state.ilike(addr["state"]),
            CustomerAddress.postal_code == addr["postal_code"],
        )
    ).scalar_one_or_none()
    if not address:
        address = CustomerAddress(
            tenant_id=tenant_id,
            customer_id=customer.id,
            line1=addr["line1"],
            line2=addr.get("line2"),
            city=addr["city"],
            state=addr["state"],
            postal_code=addr["postal_code"],
            country=addr.get("country", "US"),
            last_used_at=now_utc(),
        )
        db.add(address)
        db.flush()
    else:
        address.last_used_at = now_utc()
    return customer, address


def _create_drop_and_loads(db: Session, tenant_id, payload: ConfirmOrderIn, grouped: dict[str, dict], customer_id, address_id):
    drop = Drop(
        tenant_id=tenant_id,
        customer_id=customer_id,
        address_id=address_id,
        scheduled_date=payload.drop.requested_date,
        scheduled_window=payload.drop.requested_window,
        notes=payload.drop.notes,
        drop_photos=payload.drop.photos or [],
    )
    db.add(drop)
    db.flush()
    load_ids = []
    for bulk_group, snap in grouped.items():
        load = Load(
            tenant_id=tenant_id,
            drop_id=drop.id,
            route_date=payload.drop.requested_date,
            route_window=payload.drop.requested_window,
            bulk_group_snapshot=bulk_group,
            material_name_snapshot=snap["name"],
            qty=snap["qty"],
            unit=snap["unit"],
        )
        db.add(load)
        db.flush()
        load_ids.append(str(load.id))
    return drop, load_ids


@router.get("/availability")
def check_availability(
    required_loads: int = Query(default=1, ge=0),
    start_date: date | None = Query(default=None),
    days: int = Query(default=7, ge=1, le=21),
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)),
    db: Session = Depends(db_dep),
) -> dict:
    tenant = db.execute(select(Tenant).where(Tenant.id == user.tenant_id)).scalar_one()
    start = start_date or date.today()
    windows = []
    for i in range(days):
        d = start + timedelta(days=i)
        for w in [WindowCode.A, WindowCode.B]:
            cap = db.execute(select(WindowCapacity).where(WindowCapacity.tenant_id == user.tenant_id, WindowCapacity.service_date == d, WindowCapacity.window_code == w)).scalar_one_or_none()
            total = cap.capacity_total if cap else tenant.capacity_per_window
            used = cap.capacity_used if cap else 0
            active_holds = _active_holds(db, user.tenant_id, d, w)
            windows.append({"date": str(d), "window": w.value, "used": used, "active_holds": active_holds, "total": total, "available": (total - used - active_holds) >= required_loads})
    return {"required_loads": required_loads, "windows": windows}


@router.post("/availability")
def channel_availability(payload: AvailabilityIn, channel: ChannelAuth = Depends(require_channel), db: Session = Depends(db_dep)):
    required_loads, _ = _required_loads(db, channel.tenant_id, payload.cart_items)
    tenant = db.execute(select(Tenant).where(Tenant.id == channel.tenant_id)).scalar_one()
    days = []
    current = payload.date_range.start_date
    while current <= payload.date_range.end_date:
        window_rows = []
        for window in [WindowCode.A, WindowCode.B]:
            cap = db.execute(
                select(WindowCapacity).where(WindowCapacity.tenant_id == channel.tenant_id, WindowCapacity.service_date == current, WindowCapacity.window_code == window)
            ).scalar_one_or_none()
            total = cap.capacity_total if cap else tenant.capacity_per_window
            used = cap.capacity_used if cap else 0
            active_holds = _active_holds(db, channel.tenant_id, current, window)
            remaining = total - used - active_holds
            if remaining >= required_loads:
                window_rows.append({"window": window.value, "remaining_slots": remaining})
        if window_rows:
            days.append({"date": str(current), "windows": window_rows})
        current += timedelta(days=1)
    return {"required_loads": required_loads, "dates": days}


@router.post("/holds")
def create_hold(payload: HoldCreateIn, channel: ChannelAuth = Depends(require_channel), db: Session = Depends(db_dep)):
    cap = _capacity_row_locked(db, channel.tenant_id, payload.date, payload.window)
    active_holds = _active_holds(db, channel.tenant_id, payload.date, payload.window)
    remaining = cap.capacity_total - cap.capacity_used - active_holds
    if remaining < payload.required_loads:
        log_event(db, channel.tenant_id, "hold.failed", "channel", {"reason": "insufficient_capacity", "date": str(payload.date), "window": payload.window.value})
        db.commit()
        raise HTTPException(status_code=409, detail={"code": "capacity_conflict", "message": "Insufficient window capacity"})

    expires_at = datetime.now(timezone.utc) + timedelta(minutes=15)
    hold = CapacityHold(
        tenant_id=channel.tenant_id,
        service_date=payload.date,
        window_code=payload.window,
        units_held=payload.required_loads,
        hold_token=token_urlsafe(24),
        cart_hash=payload.cart_hash,
        expires_at=expires_at,
    )
    db.add(hold)
    log_event(db, channel.tenant_id, "hold.created", "channel", {"hold_token": hold.hold_token, "date": str(payload.date), "window": payload.window.value, "units": payload.required_loads})
    db.commit()
    return {"hold_token": hold.hold_token, "expires_at": hold.expires_at.isoformat()}


@router.post("/holds/{hold_token}/confirm")
def confirm_hold(hold_token: str, payload: ConfirmOrderIn, channel: ChannelAuth = Depends(require_channel), db: Session = Depends(db_dep)):
    hold = db.execute(
        select(CapacityHold)
        .where(CapacityHold.hold_token == hold_token, CapacityHold.tenant_id == channel.tenant_id)
        .with_for_update()
    ).scalar_one_or_none()
    if not hold or hold.released_at or hold.converted_at:
        raise HTTPException(status_code=404, detail={"code": "hold_not_found", "message": "Hold not found"})
    if hold.expires_at <= now_utc():
        hold.released_at = now_utc()
        log_event(db, channel.tenant_id, "hold.failed", "channel", {"hold_token": hold_token, "reason": "expired"})
        db.commit()
        raise HTTPException(status_code=409, detail={"code": "hold_expired", "message": "Hold expired"})

    required_loads, grouped = _required_loads(db, channel.tenant_id, payload.items)
    if required_loads != hold.units_held:
        log_event(db, channel.tenant_id, "hold.failed", "channel", {"hold_token": hold_token, "reason": "load_mismatch", "expected": hold.units_held, "actual": required_loads})
        db.commit()
        raise HTTPException(status_code=409, detail={"code": "hold_mismatch", "message": "Hold no longer matches cart"})

    if payload.drop.requested_date != hold.service_date or payload.drop.requested_window != hold.window_code:
        raise HTTPException(status_code=409, detail={"code": "hold_window_mismatch", "message": "Hold window mismatch"})

    cap = _capacity_row_locked(db, channel.tenant_id, hold.service_date, hold.window_code)
    if cap.capacity_total - cap.capacity_used < required_loads:
        logger.warning("failed_hold_confirmation", extra={"tenant_id": str(channel.tenant_id), "hold_token": hold_token, "reason": "capacity_conflict"})
        raise HTTPException(status_code=409, detail={"code": "capacity_conflict", "message": "Insufficient window capacity"})

    customer, address = _upsert_customer_and_address(db, channel.tenant_id, payload)
    drop, load_ids = _create_drop_and_loads(db, channel.tenant_id, payload, grouped, customer.id, address.id)
    cap.capacity_used += required_loads
    if cap.capacity_used > cap.capacity_total:
        raise HTTPException(status_code=409, detail={"code": "capacity_conflict", "message": "Insufficient window capacity"})
    hold.converted_at = now_utc()
    hold.converted_drop_id = drop.id

    log_event(db, channel.tenant_id, "hold.converted", "channel", {"hold_token": hold_token, "drop_id": str(drop.id), "load_ids": load_ids})
    log_event(db, channel.tenant_id, "capacity.consumed", "channel", {"date": str(hold.service_date), "window": hold.window_code.value, "units": required_loads})
    db.commit()
    return {"drop_id": str(drop.id), "load_ids": load_ids}


@router.post("/orders/ingest")
def ingest_order(payload: ConfirmOrderIn, channel: ChannelAuth = Depends(require_channel), db: Session = Depends(db_dep)):
    required_loads, grouped = _required_loads(db, channel.tenant_id, payload.items)
    cap = _capacity_row_locked(db, channel.tenant_id, payload.drop.requested_date, payload.drop.requested_window)
    active_holds = _active_holds(db, channel.tenant_id, payload.drop.requested_date, payload.drop.requested_window)
    remaining = cap.capacity_total - cap.capacity_used - active_holds
    if remaining < required_loads:
        log_event(db, channel.tenant_id, "order.ingest_failed", "channel", {"reason": "insufficient_capacity", "required_loads": required_loads})
        db.commit()
        raise HTTPException(status_code=409, detail={"code": "capacity_conflict", "message": "Insufficient window capacity"})

    customer, address = _upsert_customer_and_address(db, channel.tenant_id, payload)
    drop, load_ids = _create_drop_and_loads(db, channel.tenant_id, payload, grouped, customer.id, address.id)
    cap.capacity_used += required_loads
    log_event(db, channel.tenant_id, "order.ingested", "channel", {"external_order_id": payload.external_order.id, "drop_id": str(drop.id)})
    log_event(db, channel.tenant_id, "capacity.consumed", "channel", {"date": str(payload.drop.requested_date), "window": payload.drop.requested_window.value, "units": required_loads})
    db.commit()
    return {"drop_id": str(drop.id), "load_ids": load_ids}
