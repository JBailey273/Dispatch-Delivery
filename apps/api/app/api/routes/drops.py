import logging
from collections import defaultdict
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import AuthUser, db_dep, require_roles
from app.api.services import find_matching_address, log_event, now_utc
from app.models.entities import CapacityHold, Customer, CustomerAddress, DeliveryMode, Drop, Load, ProductCatalogItem, UserRole, WindowCapacity, WindowCode

router = APIRouter(prefix="/drops", tags=["drops"])
logger = logging.getLogger("dispatch.capacity")


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
    scheduled_window: WindowCode
    items: list[ItemIn]


def reserve_capacity(db: Session, tenant_id, day: date, window: WindowCode, required_loads: int):
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
        raise HTTPException(status_code=409, detail={"code": "capacity_conflict", "message": "Insufficient window capacity"})
    cap.capacity_used += required_loads
    if cap.capacity_used > cap.capacity_total:
        raise HTTPException(status_code=409, detail={"code": "capacity_conflict", "message": "Capacity exceeded"})
    return cap


@router.post("/manual")
def create_manual_drop(payload: ManualDropIn, user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)), db: Session = Depends(db_dep)):
    customer = None
    if payload.customer.id:
        customer = db.execute(select(Customer).where(Customer.id == payload.customer.id, Customer.tenant_id == user.tenant_id)).scalar_one_or_none()
    if not customer:
        raise HTTPException(status_code=400, detail={"code": "invalid_customer", "message": "Existing customer id is required for manual drop"})

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

    try:
        reserve_capacity(db, user.tenant_id, payload.scheduled_date, payload.scheduled_window, required_loads)
        drop = Drop(
            tenant_id=user.tenant_id,
            customer_id=customer.id,
            address_id=address.id,
            scheduled_date=payload.scheduled_date,
            scheduled_window=payload.scheduled_window,
            notes=payload.notes,
        )
        db.add(drop)
        db.flush()

        load_ids = []
        for bulk_group, snap in grouped.items():
            load = Load(
                tenant_id=user.tenant_id,
                drop_id=drop.id,
                route_date=payload.scheduled_date,
                route_window=payload.scheduled_window,
                bulk_group_snapshot=bulk_group,
                material_name_snapshot=snap["name"],
                qty=snap["qty"],
                unit=snap["unit"],
            )
            db.add(load)
            db.flush()
            load_ids.append(str(load.id))
        address.last_used_at = now_utc()
        log_event(db, user.tenant_id, "drop.created", "api", {"drop_id": str(drop.id)})
        log_event(db, user.tenant_id, "loads.created", "api", {"drop_id": str(drop.id), "load_ids": load_ids})
        log_event(db, user.tenant_id, "capacity.consumed", "api", {"date": str(payload.scheduled_date), "window": payload.scheduled_window.value, "units": required_loads})
        db.commit()
    except Exception:
        db.rollback()
        raise

    return {"drop_id": str(drop.id), "load_ids": load_ids, "required_loads": required_loads}


class RescheduleIn(BaseModel):
    scheduled_date: date
    scheduled_window: WindowCode


@router.post("/{drop_id}/reschedule")
def reschedule_drop(drop_id: str, payload: RescheduleIn, user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)), db: Session = Depends(db_dep)):
    drop = db.execute(select(Drop).where(Drop.id == drop_id, Drop.tenant_id == user.tenant_id).with_for_update()).scalar_one_or_none()
    if not drop:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Drop not found"})

    load_count = db.execute(select(func.count(Load.id)).where(Load.drop_id == drop.id, Load.tenant_id == user.tenant_id)).scalar_one()
    if load_count == 0:
        raise HTTPException(status_code=409, detail={"code": "invalid_drop", "message": "Drops without loads are not allowed"})
    old_cap = db.execute(
        select(WindowCapacity)
        .where(WindowCapacity.tenant_id == user.tenant_id, WindowCapacity.service_date == drop.scheduled_date, WindowCapacity.window_code == drop.scheduled_window)
        .with_for_update()
    ).scalar_one()
    new_cap = reserve_capacity(db, user.tenant_id, payload.scheduled_date, payload.scheduled_window, int(load_count))
    old_cap.capacity_used = max(0, old_cap.capacity_used - int(load_count))
    drop.scheduled_date = payload.scheduled_date
    drop.scheduled_window = payload.scheduled_window
    loads = db.execute(select(Load).where(Load.drop_id == drop.id, Load.tenant_id == user.tenant_id)).scalars().all()
    for load in loads:
        load.route_date = payload.scheduled_date
        load.route_window = payload.scheduled_window
    log_event(db, user.tenant_id, "capacity.rebalanced", "api", {"drop_id": drop_id, "from": str(old_cap.service_date), "to": str(new_cap.service_date)})
    db.commit()
    return {"status": "rescheduled"}
