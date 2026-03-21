import secrets
import uuid
from datetime import date, timedelta
from uuid import uuid4

import boto3
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import AuthUser, db_dep, require_roles
from app.api.routes.availability import _is_blacked_out, _remaining_slots, _schedule_storage_client
from app.api.services import log_event, now_utc
from app.core.config import settings
from app.models.entities import (
    Customer,
    CustomerAddress,
    Drop,
    Load,
    Location,
    SchedulingToken,
    Tenant,
    UserRole,
    WindowCapacity,
    WindowCode,
)

router = APIRouter(prefix="/schedule", tags=["schedule"])


# ── Dispatcher: generate a scheduling token for a drop ───────────────────────

@router.post("/drops/{drop_id}/scheduling-link")
def create_scheduling_link(
    drop_id: str,
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER, UserRole.ADMIN)),
    db: Session = Depends(db_dep),
):
    drop = db.execute(
        select(Drop).where(Drop.id == drop_id, Drop.tenant_id == user.tenant_id)
    ).scalar_one_or_none()
    if not drop:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Drop not found"})

    token_str = secrets.token_urlsafe(32)
    token = SchedulingToken(
        id=uuid.uuid4(),
        tenant_id=user.tenant_id,
        drop_id=drop.id,
        token=token_str,
    )
    db.add(token)
    log_event(db, user.tenant_id, "scheduling_token.created", "api", {"drop_id": drop_id})
    db.commit()

    return {"token": token_str}


# ── Public: token-gated routes (no JWT required) ─────────────────────────────

def _resolve_token(token_str: str, db: Session) -> tuple[SchedulingToken, Drop]:
    token = db.execute(
        select(SchedulingToken).where(SchedulingToken.token == token_str)
    ).scalar_one_or_none()
    if not token:
        raise HTTPException(status_code=404, detail={"code": "invalid_token", "message": "This scheduling link is invalid."})
    if token.used_at is not None:
        raise HTTPException(status_code=410, detail={"code": "token_used", "message": "This scheduling link has already been used."})
    drop = db.execute(
        select(Drop).where(Drop.id == token.drop_id)
    ).scalar_one_or_none()
    if not drop:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Delivery not found."})
    return token, drop


@router.get("/{token}")
def get_schedule_context(token: str, db: Session = Depends(db_dep)):
    """Return drop summary for the customer scheduling page. No auth required."""
    scheduling_token, drop = _resolve_token(token, db)

    customer = db.execute(select(Customer).where(Customer.id == drop.customer_id)).scalar_one_or_none()
    address = db.execute(select(CustomerAddress).where(CustomerAddress.id == drop.address_id)).scalar_one_or_none()
    tenant = db.execute(select(Tenant).where(Tenant.id == drop.tenant_id)).scalar_one_or_none()

    loads = db.execute(select(Load).where(Load.drop_id == drop.id)).scalars().all()
    materials = []
    for load in loads:
        materials.append(f"{load.qty} {load.unit} {load.material_name_snapshot}")

    return {
        "tenant_name": tenant.name if tenant else "Garden Center",
        "customer_name": customer.name if customer else "",
        "address": {
            "line1": address.line1 if address else "",
            "city": address.city if address else "",
            "state": address.state if address else "",
            "postal_code": address.postal_code if address else "",
        } if address else None,
        "materials": materials,
        "already_scheduled": drop.scheduled_date is not None and not drop.needs_reschedule,
        "current_date": str(drop.scheduled_date) if drop.scheduled_date else None,
        "current_window": drop.scheduled_window.value if drop.scheduled_window else None,
    }


@router.get("/{token}/availability")
def get_schedule_availability(token: str, db: Session = Depends(db_dep)):
    """Return available dates/windows for this drop. No auth required."""
    _, drop = _resolve_token(token, db)

    location = db.execute(select(Location).where(Location.id == drop.location_id)).scalar_one_or_none()
    if not location:
        raise HTTPException(status_code=400, detail={"code": "no_location", "message": "No location found for this delivery."})

    load_count = db.execute(select(Load).where(Load.drop_id == drop.id)).scalars().all()
    required_loads = len(load_count) or 1

    start = date.today() + timedelta(days=1)
    end = start + timedelta(days=60)

    days_out = []
    current = start
    while current <= end:
        windows = []
        for window in [WindowCode.A, WindowCode.B]:
            if _is_blacked_out(db, drop.tenant_id, location.id, current, window):
                continue
            remaining, _used, _holds = _remaining_slots(
                db, drop.tenant_id, location.id, location.capacity_per_window, current, window
            )
            if remaining >= required_loads:
                label = "Morning" if window == WindowCode.A else "Afternoon"
                time_range = (
                    f"{location.windowA_start.strftime('%-I:%M %p')}–{location.windowA_end.strftime('%-I:%M %p')}"
                    if window == WindowCode.A
                    else f"{location.windowB_start.strftime('%-I:%M %p')}–{location.windowB_end.strftime('%-I:%M %p')}"
                )
                windows.append({"window": window.value, "label": label, "time_range": time_range})
        if windows:
            days_out.append({"date": str(current), "windows": windows})
        current += timedelta(days=1)

    return {"dates": days_out}


class ConfirmScheduleIn(BaseModel):
    scheduled_date: date
    scheduled_window: str


@router.post("/{token}/confirm")
def confirm_schedule(token: str, payload: ConfirmScheduleIn, db: Session = Depends(db_dep)):
    """Customer confirms their chosen date/window. Marks token used."""
    scheduling_token, drop = _resolve_token(token, db)

    try:
        window = WindowCode(payload.scheduled_window)
    except ValueError:
        raise HTTPException(status_code=422, detail={"code": "invalid_window", "message": "Window must be A or B."})

    location = db.execute(select(Location).where(Location.id == drop.location_id)).scalar_one_or_none()
    if not location:
        raise HTTPException(status_code=400, detail={"code": "no_location", "message": "No location found."})

    loads = db.execute(select(Load).where(Load.drop_id == drop.id)).scalars().all()
    required_loads = len(loads) or 1

    remaining, _used, _holds = _remaining_slots(
        db, drop.tenant_id, location.id, location.capacity_per_window, payload.scheduled_date, window
    )
    if remaining < required_loads:
        raise HTTPException(status_code=409, detail={"code": "capacity_conflict", "message": "That date and window is no longer available. Please choose another."})

    # Release old capacity if drop was already scheduled
    if drop.scheduled_date and drop.scheduled_window and not drop.is_priority:
        old_cap = db.execute(
            select(WindowCapacity).where(
                WindowCapacity.tenant_id == drop.tenant_id,
                WindowCapacity.service_date == drop.scheduled_date,
                WindowCapacity.window_code == drop.scheduled_window,
            ).with_for_update()
        ).scalar_one_or_none()
        if old_cap:
            old_cap.capacity_used = max(0, old_cap.capacity_used - required_loads)

    # Reserve new capacity
    new_cap = db.execute(
        select(WindowCapacity).where(
            WindowCapacity.tenant_id == drop.tenant_id,
            WindowCapacity.service_date == payload.scheduled_date,
            WindowCapacity.window_code == window,
        ).with_for_update()
    ).scalar_one_or_none()
    if new_cap:
        new_cap.capacity_used += required_loads
    else:
        db.add(WindowCapacity(
            tenant_id=drop.tenant_id,
            location_id=drop.location_id,
            service_date=payload.scheduled_date,
            window_code=window,
            capacity_total=location.capacity_per_window,
            capacity_used=required_loads,
        ))

    # Update the drop
    drop.scheduled_date = payload.scheduled_date
    drop.scheduled_window = window
    drop.needs_reschedule = False

    # Update loads
    for load in loads:
        load.route_date = payload.scheduled_date
        load.route_window = window

    # Mark token used
    scheduling_token.used_at = now_utc()

    log_event(db, drop.tenant_id, "drop.customer_scheduled", "schedule", {
        "drop_id": str(drop.id),
        "date": str(payload.scheduled_date),
        "window": window.value,
    })
    db.commit()

    return {
        "status": "confirmed",
        "scheduled_date": str(payload.scheduled_date),
        "scheduled_window": window.value,
        "window_label": "Morning" if window == WindowCode.A else "Afternoon",
    }

def _schedule_storage_client():
    from botocore.client import Config
    return boto3.client(
        "s3",
        endpoint_url=settings.r2_endpoint_url,
        aws_access_key_id=settings.r2_access_key_id,
        aws_secret_access_key=settings.r2_secret_access_key,
        config=Config(signature_version="s3v4"),
    )

def _resolve_drop_for_site_info(token_str: str, db: Session) -> Drop:
    """Like _resolve_token but allows already-used tokens — site info can be added after confirm."""
    token = db.execute(
        select(SchedulingToken).where(SchedulingToken.token == token_str)
    ).scalar_one_or_none()
    if not token:
        raise HTTPException(status_code=404, detail={"code": "invalid_token", "message": "This scheduling link is invalid."})
    drop = db.execute(
        select(Drop).where(Drop.id == token.drop_id)
    ).scalar_one_or_none()
    if not drop:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Delivery not found."})
    return drop


class SiteInfoIn(BaseModel):
    note: str | None = None
    photo_url: str | None = None


@router.post("/{token}/site-info")
def save_site_info(token: str, payload: SiteInfoIn, db: Session = Depends(db_dep)):
    """Customer submits delivery site notes and/or photo after scheduling. No auth required."""
    drop = _resolve_drop_for_site_info(token, db)

    if payload.note and payload.note.strip():
        existing = drop.notes or ""
        separator = "\n\n" if existing else ""
        drop.notes = existing + separator + f"[Customer note] {payload.note.strip()}"

    if payload.photo_url and payload.photo_url.strip():
        photos = list(drop.drop_photos or [])
        photos.append(payload.photo_url.strip())
        drop.drop_photos = photos

    log_event(db, drop.tenant_id, "schedule.site_info.saved", "api", {
        "drop_id": str(drop.id),
        "has_note": bool(payload.note),
        "has_photo": bool(payload.photo_url),
    })
    db.commit()
    return {"status": "ok"}


class PhotoUploadRequestIn(BaseModel):
    content_type: str = "image/jpeg"


@router.post("/{token}/photo-upload-url")
def get_photo_upload_url(token: str, payload: PhotoUploadRequestIn, db: Session = Depends(db_dep)):
    """Return a presigned R2 URL for direct customer photo upload. No auth required."""
    drop = _resolve_drop_for_site_info(token, db)

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
