from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.services import log_event
from app.models.entities import Drop, Load, LoadStatus, Tenant, WindowCapacity, WindowCode


@dataclass
class CapacityMutationContext:
    source: str
    reason: str
    reference_id: str | None = None


def locked_capacity_row(db: Session, tenant_id, day: date, window: WindowCode) -> WindowCapacity:
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


def _raise_capacity_violation(db: Session, tenant_id, cap: WindowCapacity, attempted_used: int, reason: str):
    log_event(
        db,
        tenant_id,
        "CAPACITY_INVARIANT_VIOLATION",
        "api",
        {
            "capacity_id": str(cap.id),
            "service_date": str(cap.service_date),
            "window": cap.window_code.value,
            "capacity_total": cap.capacity_total,
            "capacity_used": cap.capacity_used,
            "attempted_capacity_used": attempted_used,
            "reason": reason,
        },
    )
    raise HTTPException(status_code=409, detail={"code": "capacity_conflict", "message": "Capacity invariant violation"})


def mutate_capacity_or_409(
    db: Session,
    tenant_id,
    day: date,
    window: WindowCode,
    delta: int,
    context: CapacityMutationContext,
) -> WindowCapacity:
    cap = locked_capacity_row(db, tenant_id, day, window)
    attempted_used = int(cap.capacity_used) + int(delta)
    if attempted_used < 0:
        _raise_capacity_violation(db, tenant_id, cap, attempted_used, "below_zero")
    if attempted_used > int(cap.capacity_total):
        _raise_capacity_violation(db, tenant_id, cap, attempted_used, "exceeds_total")

    cap.capacity_used = attempted_used
    log_event(
        db,
        tenant_id,
        "capacity.mutated",
        context.source,
        {
            "service_date": str(day),
            "window": window.value,
            "delta": delta,
            "reason": context.reason,
            "reference_id": context.reference_id,
            "capacity_used": cap.capacity_used,
            "capacity_total": cap.capacity_total,
        },
    )
    return cap


def assert_drop_load_invariants(db: Session, tenant_id, drop_id) -> list[Load]:
    drop = db.execute(select(Drop).where(Drop.tenant_id == tenant_id, Drop.id == drop_id).with_for_update()).scalar_one_or_none()
    if not drop:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Drop not found"})
    loads = db.execute(select(Load).where(Load.tenant_id == tenant_id, Load.drop_id == drop_id).with_for_update()).scalars().all()
    if not loads:
        raise HTTPException(status_code=409, detail={"code": "invalid_drop", "message": "Drops without loads are not allowed"})
    for load in loads:
        if load.drop_id != drop.id:
            raise HTTPException(status_code=409, detail={"code": "invalid_load", "message": "Load must belong to exactly one Drop"})
        if not load.route_date or not load.route_window:
            raise HTTPException(status_code=409, detail={"code": "invalid_load", "message": "Load scheduling metadata is required"})
    return loads


def guard_load_editable(load: Load, operation: str):
    if load.status == LoadStatus.DELIVERED:
        raise HTTPException(status_code=409, detail={"code": "invalid_load_state", "message": f"Delivered loads cannot be {operation}"})
