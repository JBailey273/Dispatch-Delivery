import logging
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from secrets import token_urlsafe
from uuid import uuid4

import boto3
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.api.deps import AuthUser, ChannelAuth, db_dep, require_channel, require_roles
from app.api.guardrails import CapacityMutationContext, locked_capacity_row, mutate_capacity_or_409
from app.api.services import enqueue_sms_job, log_event, normalize_us_phone, now_utc
from app.api.email_service import send_delivery_scheduled_email
from app.core.config import settings
from app.models.entities import (
    CapacityHold,
    Customer,
    CustomerAddress,
    DeliveryMode,
    Drop,
    EventLog,
    Load,
    Location,
    OperationalBlackout,
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
    qty: int = Field(ge=1)


class DateRangeIn(BaseModel):
    start_date: date
    end_date: date

    @model_validator(mode="after")
    def validate_range(self):
        if self.end_date < self.start_date:
            raise ValueError("end_date must be greater than or equal to start_date")
        return self


class AvailabilityIn(BaseModel):
    date_range: DateRangeIn
    cart_items: list[CartItemIn]


class HoldCreateIn(BaseModel):
    date: date
    window: WindowCode
    required_loads: int = Field(ge=0)
    cart_hash: str = Field(min_length=1)
    cart_items: list[CartItemIn]
    location_id: str | None = None  # Required for multi-location; defaults to tenant's first active location


class ExternalOrderIn(BaseModel):
    id: str
    placed_at: datetime
    url: str | None = None


class CustomerIn(BaseModel):
    name: str
    phone: str
    email: str | None = None


class AddressIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    line1: str
    city: str
    state: str
    postal_code: str
    line2: str | None = None
    country: str = "US"


class DropIn(BaseModel):
    address: AddressIn
    notes: str | None = None
    photos: list[str] | None = None
    requested_date: date | None = None
    requested_window: WindowCode | None = None


class ConfirmOrderIn(BaseModel):
    external_order: ExternalOrderIn
    customer: CustomerIn
    drop: DropIn
    items: list[CartItemIn]


class IngestOrderIn(ConfirmOrderIn):
    hold_token: str


class EmbedScheduleIn(BaseModel):
    scheduled_date: date
    scheduled_window: WindowCode


def _required_loads(db: Session, tenant_id, location_id, items: list[CartItemIn]) -> tuple[int, dict[str, dict]]:
    if not items:
        raise HTTPException(status_code=400, detail={"code": "invalid_items", "message": "At least one item is required"})
    skus = [i.sku for i in items]
    catalog = db.execute(
        select(ProductCatalogItem).where(
            ProductCatalogItem.tenant_id == tenant_id,
            ProductCatalogItem.location_id == location_id,
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


def _active_holds(db: Session, tenant_id, location_id, day: date, window: WindowCode) -> int:
    return (
        db.execute(
            select(func.coalesce(func.sum(CapacityHold.units_held), 0)).where(
                CapacityHold.tenant_id == tenant_id,
                CapacityHold.location_id == location_id,
                CapacityHold.service_date == day,
                CapacityHold.window_code == window,
                CapacityHold.released_at.is_(None),
                CapacityHold.converted_at.is_(None),
                CapacityHold.expires_at > now_utc(),
            )
        ).scalar_one()
        or 0
    )


def _remaining_slots(db: Session, tenant_id, location_id, location_default: int, day: date, window: WindowCode) -> tuple[int, int, int]:
    cap = db.execute(
        select(WindowCapacity).where(
            WindowCapacity.tenant_id == tenant_id,
            WindowCapacity.location_id == location_id,
            WindowCapacity.service_date == day,
            WindowCapacity.window_code == window,
        )
    ).scalar_one_or_none()
    total = cap.capacity_total if cap else location_default
    used = cap.capacity_used if cap else 0
    holds = _active_holds(db, tenant_id, location_id, day, window)
    return total - used - holds, used, holds


def _fmt_window_range(location, window_code) -> str:
    """Format a window time range string from location settings. e.g. '9am–1pm'"""
    from app.models.entities import WindowCode as WC
    if window_code == WC.A:
        start = location.windowA_start.strftime('%-I:%M%p').lower().replace(':00', '')
        end = location.windowA_end.strftime('%-I:%M%p').lower().replace(':00', '')
    else:
        start = location.windowB_start.strftime('%-I:%M%p').lower().replace(':00', '')
        end = location.windowB_end.strftime('%-I:%M%p').lower().replace(':00', '')
    return f"{start}–{end}"


def _is_blacked_out(db: Session, tenant_id, location_id, day: date, window: WindowCode) -> bool:
    blackout = db.execute(
        select(OperationalBlackout.id).where(
            OperationalBlackout.tenant_id == tenant_id,
            OperationalBlackout.location_id == location_id,
            OperationalBlackout.service_date == day,
            OperationalBlackout.active.is_(True),
            or_(OperationalBlackout.window_code.is_(None), OperationalBlackout.window_code == window),
        )
    ).scalar_one_or_none()
    return blackout is not None


def _upsert_customer_and_address(db: Session, tenant_id, payload: ConfirmOrderIn) -> tuple[Customer, CustomerAddress]:
    try:
        phone = normalize_us_phone(payload.customer.phone)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"code": "invalid_customer", "message": str(exc)}) from exc
    customer = db.execute(select(Customer).where(Customer.tenant_id == tenant_id, Customer.phone_e164 == phone)).scalar_one_or_none()
    if not customer:
        customer = Customer(tenant_id=tenant_id, name=payload.customer.name, phone_e164=phone)
        db.add(customer)
        db.flush()

    addr = payload.drop.address.model_dump()
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


def _next_order_number(db: Session, tenant_id) -> int:
    current_max = db.execute(
        select(func.coalesce(func.max(Drop.order_number), 0)).where(Drop.tenant_id == tenant_id)
    ).scalar_one()
    return current_max + 1


def _create_drop_and_loads(db: Session, tenant_id, location_id, payload: ConfirmOrderIn, grouped: dict[str, dict], customer_id, address_id, *, source: str = "channel"):
    ext_id = payload.external_order.id if payload.external_order else None
    drop = Drop(
        tenant_id=tenant_id,
        location_id=location_id,
        customer_id=customer_id,
        address_id=address_id,
        order_number=_next_order_number(db, tenant_id),
        external_order_id=ext_id,
        source=source,
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


def _is_expired(ts: datetime) -> bool:
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts <= now_utc()


def _confirm_hold_transaction(hold: CapacityHold, payload: ConfirmOrderIn, channel: ChannelAuth, db: Session):
    required_loads, grouped = _required_loads(db, channel.tenant_id, hold.location_id, payload.items)
    if _is_blacked_out(db, channel.tenant_id, hold.location_id, payload.drop.requested_date, payload.drop.requested_window):
        raise HTTPException(status_code=409, detail={"code": "window_blacked_out", "message": f"Could not confirm order: {payload.drop.requested_date} window {payload.drop.requested_window.value} is blocked.", "next_step": "Pick a different available window and retry."})
    if payload.drop.requested_date != hold.service_date or payload.drop.requested_window != hold.window_code:
        raise HTTPException(status_code=409, detail={"code": "hold_window_mismatch", "message": "Could not confirm order because the selected date/window does not match the held slot.", "next_step": "Use the held date/window or create a new hold for the new choice."})
    if required_loads != hold.units_held:
        raise HTTPException(status_code=409, detail={"code": "hold_mismatch", "message": "Could not confirm order because cart load requirements changed since hold creation.", "next_step": "Refresh the cart, request a new hold, then submit again."})

    cap = locked_capacity_row(db, channel.tenant_id, hold.service_date, hold.window_code, location_id=hold.location_id)
    if cap.capacity_total - cap.capacity_used < required_loads:
        remaining = cap.capacity_total - cap.capacity_used
        raise HTTPException(status_code=409, detail={"code": "capacity_conflict", "message": f"Could not confirm order: needed {required_loads} loads but only {remaining} remain in that window.", "next_step": "Choose another available window and retry."})

    customer, address = _upsert_customer_and_address(db, channel.tenant_id, payload)
    drop, load_ids = _create_drop_and_loads(db, channel.tenant_id, hold.location_id, payload, grouped, customer.id, address.id)
    mutate_capacity_or_409(
        db,
        channel.tenant_id,
        hold.service_date,
        hold.window_code,
        required_loads,
        CapacityMutationContext(source="channel", reason="hold_confirm", reference_id=hold.hold_token),
        location_id=hold.location_id,
    )
    hold.converted_at = now_utc()
    hold.converted_drop_id = drop.id
    log_event(db, channel.tenant_id, "HOLD_CONVERTED", "channel", {"hold_token": hold.hold_token, "drop_id": str(drop.id), "load_ids": load_ids})
    log_event(db, channel.tenant_id, "capacity.consumed", "channel", {"date": str(hold.service_date), "window": hold.window_code.value, "units": required_loads})
    return drop, load_ids


@router.get("/availability")
def check_availability(
    required_loads: int = Query(default=1, ge=0),
    start_date: date | None = Query(default=None),
    days: int = Query(default=7, ge=1, le=45),
    location_id: str | None = Query(default=None),
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)),
    db: Session = Depends(db_dep),
) -> dict:
    if location_id:
        location = db.execute(
            select(Location).where(Location.id == location_id, Location.tenant_id == user.tenant_id)
        ).scalar_one_or_none()
        if not location:
            raise HTTPException(status_code=404, detail={"code": "location_not_found", "message": "Location not found"})
    else:
        location = db.execute(
            select(Location).where(Location.tenant_id == user.tenant_id, Location.is_active == True)  # noqa: E712
            .order_by(Location.created_at)
        ).scalars().first()
        if not location:
            raise HTTPException(status_code=400, detail={"code": "no_location", "message": "No active location found"})

    from zoneinfo import ZoneInfo
    start = start_date or datetime.now(ZoneInfo("America/New_York")).date()
    windows = []
    for i in range(days):
        d = start + timedelta(days=i)
        for w in [WindowCode.A, WindowCode.B]:
            if _is_blacked_out(db, user.tenant_id, location.id, d, w):
                continue
            remaining_capacity, used, active_holds = _remaining_slots(db, user.tenant_id, location.id, location.capacity_per_window, d, w)
            windows.append({"date": str(d), "window": w.value, "used": used, "active_holds": active_holds, "total": used + active_holds + remaining_capacity, "required_loads": required_loads, "remaining_capacity": remaining_capacity, "available": remaining_capacity >= required_loads})
    return {"required_loads": required_loads, "windows": windows}


@router.post("/availability")
def channel_availability(payload: AvailabilityIn, channel: ChannelAuth = Depends(require_channel), db: Session = Depends(db_dep)):
    location = db.execute(
        select(Location).where(Location.tenant_id == channel.tenant_id, Location.is_active == True)  # noqa: E712
        .order_by(Location.created_at)
    ).scalars().first()
    if not location:
        raise HTTPException(status_code=400, detail={"code": "no_location", "message": "No active location found"})
    required_loads, _ = _required_loads(db, channel.tenant_id, location.id, payload.cart_items)
    days = []
    current = payload.date_range.start_date
    while current <= payload.date_range.end_date:
        window_rows = []
        for window in [WindowCode.A, WindowCode.B]:
            if _is_blacked_out(db, channel.tenant_id, location.id, current, window):
                continue
            remaining, _used, _holds = _remaining_slots(db, channel.tenant_id, location.id, location.capacity_per_window, current, window)
            if remaining >= required_loads:
                window_rows.append({"window": window.value, "remaining_slots": remaining})
        if window_rows:
            days.append({"date": str(current), "windows": window_rows})
        current += timedelta(days=1)
    return {"required_loads": required_loads, "dates": days}


@router.post("/holds")
def create_hold(payload: HoldCreateIn, channel: ChannelAuth = Depends(require_channel), db: Session = Depends(db_dep)):
    expected_required_loads, _ = _required_loads(db, channel.tenant_id, payload.cart_items)
    if expected_required_loads != payload.required_loads:
        log_event(db, channel.tenant_id, "AVAILABILITY_CHECK_FAILED", "channel", {"reason": "required_loads_mismatch", "expected": expected_required_loads, "received": payload.required_loads})
        db.commit()
        raise HTTPException(status_code=400, detail={"code": "required_loads_mismatch", "message": "required_loads does not match cart_items"})
    if _is_blacked_out(db, channel.tenant_id, payload.date, payload.window):
        raise HTTPException(status_code=409, detail={"code": "window_blacked_out", "message": f"Could not hold capacity: {payload.date} window {payload.window.value} is blocked.", "next_step": "Choose another window/date and retry checkout."})
    cap = locked_capacity_row(db, channel.tenant_id, payload.date, payload.window)
    active_holds = _active_holds(db, channel.tenant_id, payload.date, payload.window)
    remaining = cap.capacity_total - cap.capacity_used - active_holds
    if remaining < payload.required_loads:
        log_event(db, channel.tenant_id, "AVAILABILITY_CHECK_FAILED", "channel", {"reason": "insufficient_capacity", "date": str(payload.date), "window": payload.window.value})
        db.commit()
        raise HTTPException(status_code=409, detail={"code": "capacity_conflict", "message": f"Could not hold capacity: needed {payload.required_loads} loads but only {remaining} are open.", "next_step": "Choose a less full window or reduce cart load requirements."})

    location = db.execute(
        select(Location).where(Location.tenant_id == channel.tenant_id, Location.is_active == True)  # noqa: E712
        .order_by(Location.created_at)
    ).scalars().first()
    if not location:
        raise HTTPException(status_code=400, detail={"code": "no_location", "message": "No active location found"})

    hold = CapacityHold(
        tenant_id=channel.tenant_id,
        location_id=location.id,
        service_date=payload.date,
        window_code=payload.window,
        units_held=payload.required_loads,
        hold_token=token_urlsafe(24),
        cart_hash=payload.cart_hash,
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=15),
    )
    db.add(hold)
    log_event(db, channel.tenant_id, "HOLD_CREATED", "channel", {"hold_token": hold.hold_token, "date": str(payload.date), "window": payload.window.value, "units": payload.required_loads})
    db.commit()
    return {"hold_token": hold.hold_token, "expires_at": hold.expires_at.isoformat()}


@router.post("/holds/{hold_token}/confirm")
def confirm_hold(hold_token: str, payload: ConfirmOrderIn, channel: ChannelAuth = Depends(require_channel), db: Session = Depends(db_dep)):
    hold = db.execute(select(CapacityHold).where(CapacityHold.hold_token == hold_token, CapacityHold.tenant_id == channel.tenant_id).with_for_update()).scalar_one_or_none()
    if not hold:
        raise HTTPException(status_code=404, detail={"code": "hold_not_found", "message": "Hold not found"})
    if hold.released_at or hold.converted_at:
        raise HTTPException(status_code=409, detail={"code": "hold_not_available", "message": "Hold already consumed"})
    if _is_expired(hold.expires_at):
        hold.released_at = now_utc()
        log_event(db, channel.tenant_id, "HOLD_EXPIRED", "channel", {"hold_token": hold_token})
        log_event(db, channel.tenant_id, "HOLD_CONFIRMATION_FAILED", "channel", {"hold_token": hold_token, "reason": "expired"})
        db.commit()
        raise HTTPException(status_code=409, detail={"code": "hold_expired", "message": "Could not confirm order because the hold expired.", "next_step": "Refresh availability and reserve a new window before submitting again."})

    try:
        drop, load_ids = _confirm_hold_transaction(hold, payload, channel, db)
        db.commit()
    except HTTPException as exc:
        log_event(db, channel.tenant_id, "HOLD_CONFIRMATION_FAILED", "channel", {"hold_token": hold_token, "reason": exc.detail.get("code") if isinstance(exc.detail, dict) else "unknown"})
        db.commit()
        raise
    except Exception:
        db.rollback()
        logger.exception("hold_confirmation_failed", extra={"tenant_id": str(channel.tenant_id), "hold_token": hold_token})
        raise
    return {"drop_id": str(drop.id), "load_ids": load_ids}


@router.post("/orders/ingest")
def ingest_order(payload: IngestOrderIn, channel: ChannelAuth = Depends(require_channel), db: Session = Depends(db_dep)):
    hold = db.execute(select(CapacityHold).where(CapacityHold.hold_token == payload.hold_token, CapacityHold.tenant_id == channel.tenant_id).with_for_update()).scalar_one_or_none()
    if not hold:
        log_event(db, channel.tenant_id, "ORDER_INGEST_FAILED", "channel", {"reason": "hold_not_found", "external_order_id": payload.external_order.id})
        db.commit()
        raise HTTPException(status_code=409, detail={"code": "hold_required", "message": "A valid hold_token is required for ingestion"})
    if _is_expired(hold.expires_at) or hold.released_at or hold.converted_at:
        log_event(db, channel.tenant_id, "ORDER_INGEST_FAILED", "channel", {"reason": "hold_not_available", "hold_token": payload.hold_token, "external_order_id": payload.external_order.id})
        db.commit()
        raise HTTPException(status_code=409, detail={"code": "hold_not_available", "message": "Hold expired or already consumed"})

    try:
        drop, load_ids = _confirm_hold_transaction(hold, payload, channel, db)
        log_event(db, channel.tenant_id, "order.ingested", "channel", {"external_order_id": payload.external_order.id, "drop_id": str(drop.id)})
        db.commit()
    except HTTPException as exc:
        log_event(db, channel.tenant_id, "ORDER_INGEST_FAILED", "channel", {"reason": exc.detail.get("code") if isinstance(exc.detail, dict) else "unknown", "hold_token": payload.hold_token, "external_order_id": payload.external_order.id})
        db.commit()
        raise
    except Exception:
        db.rollback()
        logger.exception("order_ingest_failed", extra={"tenant_id": str(channel.tenant_id), "external_order_id": payload.external_order.id})
        raise

    return {"drop_id": str(drop.id), "load_ids": load_ids}


@router.get("/admin/diagnostics/ingestion-failures")
def ingestion_failures_diagnostics(
    limit: int = Query(default=50, ge=1, le=250),
    user: AuthUser = Depends(require_roles(UserRole.ADMIN, UserRole.DISPATCHER)),
    db: Session = Depends(db_dep),
):
    failure_events = {"AVAILABILITY_CHECK_FAILED", "HOLD_CONFIRMATION_FAILED", "ORDER_INGEST_FAILED"}
    rows = db.execute(
        select(EventLog.event_type, EventLog.payload_json, EventLog.created_at)
        .where(EventLog.tenant_id == user.tenant_id, EventLog.event_type.in_(failure_events))
        .order_by(EventLog.created_at.desc())
        .limit(limit)
    ).all()
    reasons = Counter([(payload or {}).get("reason", "unknown") for _evt, payload, _created in rows])
    return {
        "recent_failures": [{"event_type": evt, "payload": payload, "created_at": created.isoformat()} for evt, payload, created in rows],
        "most_common_reasons": [{"reason": reason, "count": count} for reason, count in reasons.most_common(10)],
    }

@router.get("/embed/order/{order_id}")
def get_embed_order(
    order_id: str,
    channel: ChannelAuth = Depends(require_channel),
    db: Session = Depends(db_dep),
):
    """
    Look up a drop by WooCommerce external_order_id.
    Returns customer name, items, current schedule status, and available dates.
    Used by the scheduling iframe embed on the WC order confirmation page.
    """
    drop = db.execute(
        select(Drop)
        .where(
            Drop.tenant_id == channel.tenant_id,
            Drop.external_order_id == order_id,
            Drop.delivery_method == "delivery",
        )
    ).scalar_one_or_none()
 
    if not drop:
        raise HTTPException(
            status_code=404,
            detail={"code": "order_not_found", "message": "Order not found or not eligible for scheduling."},
        )
 
    customer = db.execute(
        select(Customer).where(Customer.id == drop.customer_id)
    ).scalar_one_or_none()
 
    loads = db.execute(
        select(Load).where(Load.drop_id == drop.id)
    ).scalars().all()
 
    items = [f"{l.qty} {l.unit} {l.material_name_snapshot}" for l in loads]

    location = db.execute(
        select(Location).where(Location.id == drop.location_id)
    ).scalar_one_or_none()

    # Get available dates using existing availability logic
    from zoneinfo import ZoneInfo
    tz = ZoneInfo(location.timezone if location else "America/New_York")
    now_local = datetime.now(tz)
    today_local = now_local.date()

    look_ahead_days = 60
    avail_dates = []

    for i in range(0, look_ahead_days + 1):
        check_date = today_local + timedelta(days=i)
        windows = []
        for window_code in [WindowCode.A, WindowCode.B]:
            if check_date == today_local:
                window_start = location.windowA_start if window_code == WindowCode.A else location.windowB_start
                if location and now_local.time() >= window_start:
                    continue
            if _is_blacked_out(db, channel.tenant_id, drop.location_id, check_date, window_code):
                continue
            cap = db.execute(
                select(WindowCapacity).where(
                    WindowCapacity.tenant_id == channel.tenant_id,
                    WindowCapacity.location_id == drop.location_id,
                    WindowCapacity.service_date == check_date,
                    WindowCapacity.window_code == window_code,
                )
            ).scalar_one_or_none()
            if cap and cap.capacity_used >= cap.capacity_total:
                continue
            label = "Morning" if window_code == WindowCode.A else "Afternoon"
            time_range = _fmt_window_range(location, window_code) if location else ("9am–1pm" if window_code == WindowCode.A else "1pm–5pm")
            windows.append({
                "window": window_code.value,
                "label": label,
                "time_range": time_range,
            })
        if windows:
            avail_dates.append({"date": str(check_date), "windows": windows})
 
    scheduled_time_range = None
    if drop.scheduled_window and location:
        scheduled_time_range = _fmt_window_range(location, drop.scheduled_window)

    return {
        "drop_id": str(drop.id),
        "customer_name": customer.name if customer else "Customer",
        "items": items,
        "already_scheduled": drop.scheduled_date is not None,
        "scheduled_date": str(drop.scheduled_date) if drop.scheduled_date else None,
        "scheduled_window": drop.scheduled_window.value if drop.scheduled_window else None,
        "scheduled_window_time_range": scheduled_time_range,
        "available_dates": avail_dates,
    }
 
 
@router.post("/embed/order/{order_id}/schedule")
def schedule_embed_order(
    order_id: str,
    payload: EmbedScheduleIn,
    channel: ChannelAuth = Depends(require_channel),
    db: Session = Depends(db_dep),
):
    """
    Schedule a delivery order from the iframe embed.
    Sets scheduled_date and scheduled_window on the drop and its loads.
    """
    drop = db.execute(
        select(Drop)
        .where(
            Drop.tenant_id == channel.tenant_id,
            Drop.external_order_id == order_id,
            Drop.delivery_method == "delivery",
        )
        .with_for_update()
    ).scalar_one_or_none()
 
    if not drop:
        raise HTTPException(
            status_code=404,
            detail={"code": "order_not_found", "message": "Order not found or not eligible for scheduling."},
        )
 
    if _is_blacked_out(db, channel.tenant_id, drop.location_id, payload.scheduled_date, payload.scheduled_window):
        raise HTTPException(
            status_code=409,
            detail={"code": "window_blacked_out", "message": "That date and window is not available. Please choose another."},
        )
 
    # Check capacity
    cap = db.execute(
        select(WindowCapacity).where(
            WindowCapacity.tenant_id == channel.tenant_id,
            WindowCapacity.location_id == drop.location_id,
            WindowCapacity.service_date == payload.scheduled_date,
            WindowCapacity.window_code == payload.scheduled_window,
        ).with_for_update()
    ).scalar_one_or_none()
 
    loads = db.execute(
        select(Load).where(Load.drop_id == drop.id)
    ).scalars().all()
 
    required = len(loads)
 
    if cap and (cap.capacity_used + required) > cap.capacity_total:
        raise HTTPException(
            status_code=409,
            detail={"code": "no_capacity", "message": "That window is now full. Please choose another date or time."},
        )
 
    # Update capacity
    if cap:
        cap.capacity_used += required
    else:
        # Auto-create capacity row using tenant default
        tenant = db.execute(select(Tenant).where(Tenant.id == channel.tenant_id)).scalar_one_or_none()
        default_cap = tenant.capacity_per_window if tenant else 10
        new_cap = WindowCapacity(
            tenant_id=channel.tenant_id,
            location_id=drop.location_id,
            service_date=payload.scheduled_date,
            window_code=payload.scheduled_window,
            capacity_total=default_cap,
            capacity_used=required,
        )
        db.add(new_cap)
 
    # Schedule the drop
    drop.scheduled_date = payload.scheduled_date
    drop.scheduled_window = payload.scheduled_window
 
    # Update all loads
    for load in loads:
        load.route_date = payload.scheduled_date
        load.route_window = payload.scheduled_window
 
    embed_location = db.execute(
        select(Location).where(Location.id == drop.location_id)
    ).scalar_one_or_none()
    _time_range = _fmt_window_range(embed_location, payload.scheduled_window) if embed_location else ("9am–1pm" if payload.scheduled_window == WindowCode.A else "1pm–5pm")
    window_label = f"{'Morning' if payload.scheduled_window == WindowCode.A else 'Afternoon'} ({_time_range})"
 
    log_event(db, channel.tenant_id, "embed.order_scheduled", "channel", {
        "external_order_id": order_id,
        "drop_id": str(drop.id),
        "scheduled_date": str(payload.scheduled_date),
        "scheduled_window": payload.scheduled_window.value,
    })
    db.commit()

    # ── Notify customer ───────────────────────────────────────────────────────
    try:
        customer = db.execute(select(Customer).where(Customer.id == drop.customer_id)).scalar_one_or_none()
        address = db.execute(select(CustomerAddress).where(CustomerAddress.id == drop.address_id)).scalar_one_or_none()
        if customer:
            date_str = payload.scheduled_date.strftime("%A, %B %d")
            win_label = "Morning" if payload.scheduled_window == WindowCode.A else "Afternoon"
            time_range = _time_range
            def _unit_label(qty, unit):
                if qty == 1:
                    return unit.rstrip('s') if unit.lower().endswith('s') else unit
                return unit if unit.lower().endswith('s') else unit + 's'
            materials = [f"{l.qty} {_unit_label(l.qty, l.unit)} {l.material_name_snapshot}" for l in loads]
            address_line = f"{address.line1}, {address.city}, {address.state}" if address else None

            if customer.email and customer.email_opt_in:
                send_delivery_scheduled_email(
                    customer.email,
                    customer.name,
                    date_str,
                    win_label,
                    time_range,
                    materials,
                    address_line,
                )

            if customer.sms_opt_in and customer.phone_e164:
                first = customer.name.split()[0] if customer.name else "there"
                enqueue_sms_job(
                    {
                        "type": "SEND_SMS",
                        "tenant_id": str(channel.tenant_id),
                        "drop_id": str(drop.id),
                        "to": customer.phone_e164,
                        "template": "custom",
                        "message": (
                            f"Hi {first}! Your East Meadow Garden Center delivery is confirmed for "
                            f"{date_str}, {win_label} ({time_range}). "
                            f"We'll text you when your driver is on the way."
                        ),
                    },
                    dedupe_key=f"scheduled-confirm-{drop.id}",
                )
    except Exception:
        logger.exception(f"Embed delivery scheduled notification failed for drop {drop.id}")

    return {
        "drop_id": str(drop.id),
        "scheduled_date": str(drop.scheduled_date),
        "scheduled_window": drop.scheduled_window.value,
        "window_label": window_label,
    }

class EmbedSiteInfoIn(BaseModel):
    note: str | None = None
    photo_url: str | None = None


@router.post("/embed/order/{order_id}/site-info")
def embed_save_site_info(
    order_id: str,
    payload: EmbedSiteInfoIn,
    channel: ChannelAuth = Depends(require_channel),
    db: Session = Depends(db_dep),
):
    """Customer submits site info after scheduling via embed. Uses channel key auth."""
    drop = db.execute(
        select(Drop).where(
            Drop.tenant_id == channel.tenant_id,
            Drop.external_order_id == order_id,
            Drop.delivery_method == "delivery",
        )
    ).scalar_one_or_none()
    if not drop:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Order not found."})

    if payload.note and payload.note.strip():
        existing = drop.notes or ""
        separator = "\n\n" if existing else ""
        drop.notes = existing + separator + f"[Customer note] {payload.note.strip()}"

    if payload.photo_url and payload.photo_url.strip():
        photos = list(drop.drop_photos or [])
        photos.append(payload.photo_url.strip())
        drop.drop_photos = photos

    log_event(db, drop.tenant_id, "embed.site_info.saved", "api", {
        "drop_id": str(drop.id),
        "has_note": bool(payload.note),
        "has_photo": bool(payload.photo_url),
    })
    db.commit()
    return {"status": "ok"}

def _schedule_storage_client():
    import boto3
    from botocore.client import Config
    return boto3.client(
        "s3",
        endpoint_url=settings.r2_endpoint_url,
        aws_access_key_id=settings.r2_access_key_id,
        aws_secret_access_key=settings.r2_secret_access_key,
        config=Config(signature_version="s3v4"),
    )

class EmbedPhotoUploadRequestIn(BaseModel):
    content_type: str = "image/jpeg"


@router.post("/embed/order/{order_id}/photo-upload-url")
def embed_get_photo_upload_url(
    order_id: str,
    payload: EmbedPhotoUploadRequestIn,
    channel: ChannelAuth = Depends(require_channel),
    db: Session = Depends(db_dep),
):
    """Return presigned R2 URL for customer photo upload via embed."""
    drop = db.execute(
        select(Drop).where(
            Drop.tenant_id == channel.tenant_id,
            Drop.external_order_id == order_id,
            Drop.delivery_method == "delivery",
        )
    ).scalar_one_or_none()
    if not drop:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Order not found."})

    object_key = f"{drop.tenant_id}/customer-site/{drop.id}/{uuid4()}.jpg"
    url = _schedule_storage_client().generate_presigned_url(
        "put_object",
        Params={
            "Bucket": settings.r2_bucket,
            "Key": object_key,
            "ContentType": payload.content_type,
        },
        ExpiresIn=600,
        HttpMethod="PUT",
    )
    photo_url = f"{settings.r2_public_url.rstrip('/')}/{object_key}"
    return {"upload_url": url, "photo_url": photo_url}
