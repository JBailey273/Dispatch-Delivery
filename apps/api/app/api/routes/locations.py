from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import AuthUser, db_dep, require_roles
from app.api.services import log_event
from app.models.entities import Location, UserRole

router = APIRouter(prefix="/locations", tags=["locations"])


class LocationCreateIn(BaseModel):
    name: str
    slug: str
    timezone: str = "America/New_York"
    address_line1: str | None = None
    address_line2: str | None = None
    city: str | None = None
    state: str | None = None
    postal_code: str | None = None
    phone: str | None = None
    service_days: list[str] = ["mon", "tue", "wed", "thu", "fri"]
    windowA_start: str = "09:00:00"
    windowA_end: str = "13:00:00"
    windowB_start: str = "13:00:00"
    windowB_end: str = "17:00:00"
    capacity_per_window: int = 4


class LocationUpdateIn(BaseModel):
    name: str | None = None
    timezone: str | None = None
    address_line1: str | None = None
    address_line2: str | None = None
    city: str | None = None
    state: str | None = None
    postal_code: str | None = None
    phone: str | None = None
    service_days: list[str] | None = None
    windowA_start: str | None = None
    windowA_end: str | None = None
    windowB_start: str | None = None
    windowB_end: str | None = None
    capacity_per_window: int | None = None
    is_active: bool | None = None


def _location_dict(loc: Location) -> dict:
    return {
        "id": str(loc.id),
        "name": loc.name,
        "slug": loc.slug,
        "is_active": loc.is_active,
        "address_line1": loc.address_line1,
        "address_line2": loc.address_line2,
        "city": loc.city,
        "state": loc.state,
        "postal_code": loc.postal_code,
        "phone": loc.phone,
        "timezone": loc.timezone,
        "service_days": loc.service_days,
        "windowA_start": str(loc.windowA_start),
        "windowA_end": str(loc.windowA_end),
        "windowB_start": str(loc.windowB_start),
        "windowB_end": str(loc.windowB_end),
        "capacity_per_window": loc.capacity_per_window,
    }


@router.get("")
def list_locations(
    include_inactive: bool = Query(default=False),
    user: AuthUser = Depends(require_roles(UserRole.ADMIN, UserRole.DISPATCHER, UserRole.DRIVER)),
    db: Session = Depends(db_dep),
):
    """List locations for the tenant. Used by dispatcher nav switcher and customer-facing location selector."""
    q = select(Location).where(Location.tenant_id == user.tenant_id)
    if not include_inactive:
        q = q.where(Location.is_active == True)  # noqa: E712
    q = q.order_by(Location.name)
    locations = db.execute(q).scalars().all()
    return {"locations": [_location_dict(loc) for loc in locations]}


@router.get("/{location_id}")
def get_location(
    location_id: str,
    user: AuthUser = Depends(require_roles(UserRole.ADMIN, UserRole.DISPATCHER, UserRole.DRIVER)),
    db: Session = Depends(db_dep),
):
    loc = db.execute(
        select(Location).where(Location.id == location_id, Location.tenant_id == user.tenant_id)
    ).scalar_one_or_none()
    if not loc:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Location not found"})
    return _location_dict(loc)


@router.post("")
def create_location(
    payload: LocationCreateIn,
    user: AuthUser = Depends(require_roles(UserRole.ADMIN)),
    db: Session = Depends(db_dep),
):
    existing = db.execute(
        select(Location).where(Location.tenant_id == user.tenant_id, Location.slug == payload.slug)
    ).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail={"code": "slug_conflict", "message": f"A location with slug '{payload.slug}' already exists."})

    from datetime import time
    def parse_time(t: str):
        h, m, s = t.split(":")
        return time(int(h), int(m), int(s))

    loc = Location(
        tenant_id=user.tenant_id,
        name=payload.name,
        slug=payload.slug,
        timezone=payload.timezone,
        address_line1=payload.address_line1,
        address_line2=payload.address_line2,
        city=payload.city,
        state=payload.state,
        postal_code=payload.postal_code,
        phone=payload.phone,
        service_days=payload.service_days,
        windowA_start=parse_time(payload.windowA_start),
        windowA_end=parse_time(payload.windowA_end),
        windowB_start=parse_time(payload.windowB_start),
        windowB_end=parse_time(payload.windowB_end),
        capacity_per_window=payload.capacity_per_window,
    )
    db.add(loc)
    db.commit()
    db.refresh(loc)
    log_event(db, user.tenant_id, "location.created", "api", {"location_id": str(loc.id), "slug": loc.slug})
    db.commit()
    return _location_dict(loc)


@router.put("/{location_id}")
def update_location(
    location_id: str,
    payload: LocationUpdateIn,
    user: AuthUser = Depends(require_roles(UserRole.ADMIN)),
    db: Session = Depends(db_dep),
):
    loc = db.execute(
        select(Location).where(Location.id == location_id, Location.tenant_id == user.tenant_id)
    ).scalar_one_or_none()
    if not loc:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Location not found"})

    from datetime import time
    def parse_time(t: str):
        h, m, s = t.split(":")
        return time(int(h), int(m), int(s))

    simple_fields = ["name", "timezone", "address_line1", "address_line2", "city", "state",
                     "postal_code", "phone", "service_days", "capacity_per_window", "is_active"]
    time_fields = ["windowA_start", "windowA_end", "windowB_start", "windowB_end"]

    for field in simple_fields:
        val = getattr(payload, field)
        if val is not None:
            setattr(loc, field, val)

    for field in time_fields:
        val = getattr(payload, field)
        if val is not None:
            setattr(loc, field, parse_time(val))

    db.commit()
    db.refresh(loc)
    log_event(db, user.tenant_id, "location.updated", "api", {"location_id": str(loc.id)})
    db.commit()
    return _location_dict(loc)
