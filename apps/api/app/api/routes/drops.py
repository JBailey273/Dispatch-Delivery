import logging
from collections import defaultdict
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.api.deps import AuthUser, db_dep, require_roles
from app.api.guardrails import CapacityMutationContext, assert_drop_load_invariants, guard_load_editable, mutate_capacity_or_409
from app.api.services import find_matching_address, log_event, now_utc
from app.billing.service import evaluate_limit, scheduling_gate
from app.models.entities import CapacityHold, Customer, CustomerAddress, CustomerType, DeliveryMode, Drop, Load, LoadStatus, OperationalBlackout, ProductCatalogItem, UserRole, WindowCapacity, WindowCode

router = APIRouter(prefix="/drops", tags=["drops"])
logger = logging.getLogger("dispatch.capacity")

PRIORITY_SOFT_CAP = 8  # warn after this many priority drops in a day


def next_order_number(db: Session, tenant_id) -> int:
    """Generate the next sequential order number for a tenant."""
    current_max = db.execute(
        select(func.coalesce(func.max(Drop.order_number), 0)).where(Drop.tenant_id == tenant_id)
    ).scalar_one()
    return current_max + 1


def check_priority_warning(db: Session, tenant_id, scheduled_date: date) -> str | None:
    """Returns a warning message if priority load count is high, else None."""
    count = db.execute(
        select(func.count(Drop.id)).where(
            Drop.tenant_id == tenant_id,
            Drop.scheduled_date == scheduled_date,
            Drop.is_priority == True,  # noqa: E712
        )
    ).scalar_one()
    if count >= PRIORITY_SOFT_CAP:
        return f"You have {count} priority deliveries scheduled for this day. Consider spreading across multiple days."
    return None


class ItemIn(BaseModel):
    sku: str
    qty: int


class CustomerRef(BaseModel):
    id: str | None = None
    name: str | None = None
    phone: str | None = None


class AddressRef(BaseModel):
    address_id: str | None = None
    line1: str | None = None
    line2: str | None = None
    city: str | None = None
    state: str | None = None
    postal_code: str | None = None
    country: str = "US"
    create_if_missing: bool = True


class ManualDropIn(BaseModel):
    customer: CustomerRef
    address: AddressRef
    notes: str | None = None
    scheduled_date: date
    scheduled_window: WindowCode | None = None  # None allowed for priority drops
    is_priority: bool | None = None  # None = auto-detect from customer type
    items: list[ItemIn]
    driver_user_id: str | None = None


def _is_blacked_out(db: Session, tenant_id, day: date, window: WindowCode) -> bool:
    return db.execute(
        select(OperationalBlackout.id).where(
            OperationalBlackout.tenant_id == tenant_id,
            OperationalBlackout.service_date == day,
            OperationalBlackout.active.is_(True),
            or_(OperationalBlackout.window_code.is_(None), OperationalBlackout.window_code == window),
        )
    ).scalar_one_or_none() is not None


def reserve_capacity(db: Session, tenant_id, day: date, window: WindowCode, required_loads: int):
    if _is_blacked_out(db, tenant_id, day, window):
        raise HTTPException(
            status_code=409,
            detail={
                "code": "window_blacked_out",
                "message": f"Could not schedule this drop: {day} window {window.value} is blocked for operations.",
                "next_step": "Choose another day/window and retry.",
            },
        )
    cap = db.execute(
        select(WindowCapacity)
        .where(WindowCapacity.tenant_id == tenant_id, WindowCapacity.service_date == day, WindowCapacity.window_code == window)
        .with_for_update()
    ).scalar_one_or_none()
    if not cap:
        from app.models.entities import Tenant

        tenant = db.execute(select(Tenant).where(Tenant.id == tenant_id)).scalar_one()
        cap = WindowCapacity(tenant_id=tenant_id, service_date=day, window_code=window, capacity_total=tenant.capacity_per_window, capacity_used=0)
        db.add(cap)
        db.flush()
    active_holds = (
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
    remaining = cap.capacity_total - cap.capacity_used - active_holds
    if remaining < required_loads:
        logger.warning("capacity_conflict", extra={"tenant_id": str(tenant_id), "service_date": str(day), "window": window.value, "required_loads": required_loads, "remaining": remaining})
        raise HTTPException(
            status_code=409,
            detail={
                "code": "capacity_conflict",
                "message": f"Could not schedule this drop: {day} window {window.value} needs {required_loads} loads but only {remaining} are open.",
                "next_step": "Pick a window with enough remaining capacity or reduce the selected bulk groups.",
            },
        )
    mutate_capacity_or_409(
        db,
        tenant_id,
        day,
        window,
        required_loads,
        CapacityMutationContext(source="api", reason="reserve_capacity"),
    )
    return cap


@router.post("/manual")
def create_manual_drop(payload: ManualDropIn, user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)), db: Session = Depends(db_dep)):
    schedule_decision = scheduling_gate(db, user.tenant_id)
    if not schedule_decision.allowed:
        raise HTTPException(status_code=402, detail={"code": schedule_decision.code, "message": schedule_decision.message})

    # Resolve customer
    customer = None
    if payload.customer.id:
        customer = db.execute(select(Customer).where(Customer.id == payload.customer.id, Customer.tenant_id == user.tenant_id)).scalar_one_or_none()
    if not customer:
        raise HTTPException(status_code=400, detail={"code": "invalid_customer", "message": "Existing customer id is required for manual drop"})

    # Determine priority: explicit override > auto-detect from customer type
    if payload.is_priority is not None:
        is_priority = payload.is_priority
    else:
        is_priority = customer.customer_type == CustomerType.COMMERCIAL

    # Validate window: non-priority drops MUST have a window
    if not is_priority and not payload.scheduled_window:
        raise HTTPException(
            status_code=422,
            detail={"code": "window_required", "message": "Non-priority deliveries require a delivery window (A or B)."},
        )

    # Resolve address
    if payload.address.address_id:
        address = db.execute(
            select(CustomerAddress).where(
                CustomerAddress.id == payload.address.address_id,
                CustomerAddress.customer_id == customer.id,
                CustomerAddress.tenant_id == user.tenant_id,
            )
        ).scalar_one_or_none()
        if not address:
            raise HTTPException(status_code=404, detail={"code": "address_not_found", "message": "Address not found"})
    else:
        addr_payload = payload.address.model_dump(exclude_none=True)
        address = find_matching_address(db, user.tenant_id, customer.id, addr_payload)
        if not address and payload.address.create_if_missing:
            address = CustomerAddress(
                tenant_id=user.tenant_id,
                customer_id=customer.id,
                line1=payload.address.line1,
                line2=payload.address.line2,
                city=payload.address.city,
                state=payload.address.state,
                postal_code=payload.address.postal_code,
                country=payload.address.country,
                last_used_at=now_utc(),
            )
            db.add(address)
            db.flush()
        elif not address:
            raise HTTPException(status_code=404, detail={"code": "address_not_found", "message": "No matching address"})

    # Resolve SKUs to catalog items
    skus = [i.sku for i in payload.items]
    catalog = db.execute(select(ProductCatalogItem).where(ProductCatalogItem.tenant_id == user.tenant_id, ProductCatalogItem.sku.in_(skus), ProductCatalogItem.active == True)).scalars().all()  # noqa: E712
    by_sku = {i.sku: i for i in catalog}
    if len(by_sku) != len(set(skus)):
        raise HTTPException(status_code=400, detail={"code": "invalid_items", "message": "One or more SKUs not found/active"})

    grouped: dict[str, dict] = defaultdict(lambda: {"qty": 0, "name": "", "unit": ""})
    for item in payload.items:
        cat = by_sku[item.sku]
        if cat.delivery_mode == DeliveryMode.BULK_LOAD:
            grouped[cat.bulk_group]["qty"] += item.qty
            grouped[cat.bulk_group]["name"] = cat.name
            grouped[cat.bulk_group]["unit"] = cat.unit

    required_loads = len(grouped.keys())

    # Daily load limit check
    current_today = db.execute(select(func.count(Drop.id)).where(Drop.tenant_id == user.tenant_id, Drop.scheduled_date == payload.scheduled_date)).scalar_one()
    load_limit_decision = evaluate_limit(db, user.tenant_id, "max_daily_loads", int(current_today) + required_loads)
    if not load_limit_decision.allowed:
        raise HTTPException(status_code=402, detail={"code": load_limit_decision.code, "message": load_limit_decision.message, "upgrade_required": load_limit_decision.upgrade_required})

    try:
        # Priority drops bypass capacity reservation entirely
        if not is_priority:
            reserve_capacity(db, user.tenant_id, payload.scheduled_date, payload.scheduled_window, required_loads)

        drop = Drop(
            tenant_id=user.tenant_id,
            customer_id=customer.id,
            address_id=address.id,
            order_number=next_order_number(db, user.tenant_id),
            source="manual",
            is_priority=is_priority,
            scheduled_date=payload.scheduled_date,
            scheduled_window=payload.scheduled_window,  # None for priority drops
            notes=payload.notes,
        )
        db.add(drop)
        db.flush()

        # For priority drops without a window, we still need a route_window on loads.
        # Use window A as default — it doesn't affect capacity or scheduling.
        load_window = payload.scheduled_window or WindowCode.A

        load_ids = []
        for bulk_group, snap in grouped.items():
            load = Load(
                tenant_id=user.tenant_id,
                drop_id=drop.id,
                route_date=payload.scheduled_date,
                route_window=load_window,
                bulk_group_snapshot=bulk_group,
                material_name_snapshot=snap["name"],
                qty=snap["qty"],
                unit=snap["unit"],
                driver_user_id=payload.driver_user_id,
                status=LoadStatus.ASSIGNED if payload.driver_user_id else LoadStatus.ASSIGNED,
            )
            db.add(load)
            db.flush()
            load_ids.append(str(load.id))

        address.last_used_at = now_utc()
        log_event(db, user.tenant_id, "drop.created", "api", {"drop_id": str(drop.id), "is_priority": is_priority})
        log_event(db, user.tenant_id, "loads.created", "api", {"drop_id": str(drop.id), "load_ids": load_ids})
        if not is_priority:
            log_event(db, user.tenant_id, "capacity.consumed", "api", {"date": str(payload.scheduled_date), "window": payload.scheduled_window.value, "units": required_loads})
        db.commit()
    except Exception:
        db.rollback()
        raise

    # Check for priority soft cap warning
    priority_warning = check_priority_warning(db, user.tenant_id, payload.scheduled_date) if is_priority else None

    return {
        "drop_id": str(drop.id),
        "order_number": drop.order_number,
        "load_ids": load_ids,
        "required_loads": required_loads,
        "is_priority": is_priority,
        "priority_warning": priority_warning,
    }


class RescheduleIn(BaseModel):
    scheduled_date: date
    scheduled_window: WindowCode | None = None  # None allowed for priority drops
    is_priority: bool | None = None  # Can toggle priority during reschedule
    allow_split: bool = False


@router.post("/{drop_id}/reschedule")
def reschedule_drop(drop_id: str, payload: RescheduleIn, user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)), db: Session = Depends(db_dep)):
    schedule_decision = scheduling_gate(db, user.tenant_id)
    if not schedule_decision.allowed:
        raise HTTPException(status_code=402, detail={"code": schedule_decision.code, "message": schedule_decision.message})
    drop = db.execute(select(Drop).where(Drop.id == drop_id, Drop.tenant_id == user.tenant_id).with_for_update()).scalar_one_or_none()
    if not drop:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Drop not found"})
    if payload.allow_split:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "split_not_supported",
                "message": "Could not reschedule this drop with split loads: dispatcher reschedule defaults to no split.",
                "next_step": "Retry with allow_split=false (or omit it) so all loads move together.",
            },
        )

    # Determine new priority state
    new_is_priority = payload.is_priority if payload.is_priority is not None else drop.is_priority
    new_window = payload.scheduled_window

    # Validate: non-priority must have a window
    if not new_is_priority and not new_window:
        raise HTTPException(
            status_code=422,
            detail={"code": "window_required", "message": "Non-priority deliveries require a delivery window (A or B)."},
        )

    if payload.scheduled_date == drop.scheduled_date and new_window == drop.scheduled_window and new_is_priority == drop.is_priority:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "already_scheduled",
                "message": "Drop is already on that date/window, so nothing changed.",
                "next_step": "Choose a different date/window before rescheduling.",
            },
        )

    loads = assert_drop_load_invariants(db, user.tenant_id, drop.id)
    for load in loads:
        guard_load_editable(load, "rescheduled")

    load_count = len(loads)

    # Release old capacity (only if the drop was NOT priority before)
    if not drop.is_priority and drop.scheduled_window:
        mutate_capacity_or_409(
            db,
            user.tenant_id,
            drop.scheduled_date,
            drop.scheduled_window,
            -int(load_count),
            CapacityMutationContext(source="api", reason="drop_reschedule_release", reference_id=drop_id),
        )

    # Reserve new capacity (only if the drop is NOT priority after)
    if not new_is_priority and new_window:
        reserve_capacity(db, user.tenant_id, payload.scheduled_date, new_window, int(load_count))

    drop.scheduled_date = payload.scheduled_date
    drop.scheduled_window = new_window
    drop.is_priority = new_is_priority
    drop.needs_reschedule = False

    load_window = new_window or WindowCode.A
    for load in loads:
        load.route_date = payload.scheduled_date
        load.route_window = load_window
        if load.status == LoadStatus.EXCEPTION:
            load.status = LoadStatus.ASSIGNED
            load.exception_reason_code = None
            load.exception_notes = None

    log_event(db, user.tenant_id, "drop.rescheduled", "api", {
        "drop_id": drop_id,
        "is_priority": new_is_priority,
        "new_date": str(payload.scheduled_date),
        "new_window": new_window.value if new_window else None,
    })
    db.commit()
    return {"status": "rescheduled", "is_priority": new_is_priority}
