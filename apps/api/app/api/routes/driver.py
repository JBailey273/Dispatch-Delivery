from datetime import date
from fastapi import APIRouter, Depends, Header, HTTPException, Query, UploadFile, File
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import AuthUser, db_dep, require_roles
from app.api.services import enqueue_sms_job, log_event, now_utc
from app.models.entities import Customer, CustomerAddress, Drop, ExceptionReasonCode, Load, LoadStatus, UserRole

router = APIRouter(prefix="/driver", tags=["driver"])


# ── Driver drops (grouped by drop with nested loads) ──────────────────────────


@router.get("/drops")
def driver_drops(
    day: date = Query(...),
    user: AuthUser = Depends(require_roles(UserRole.DRIVER)),
    db: Session = Depends(db_dep),
):
    """Return drops with nested loads for a given day, grouped by drop/customer.
    Only includes drops that have at least one load assigned to this driver."""

    # Get all loads assigned to this driver for the day
    loads = db.execute(
        select(Load).where(
            Load.tenant_id == user.tenant_id,
            Load.route_date == day,
            Load.driver_user_id == user.user_id,
        )
    ).scalars().all()

    if not loads:
        return {"server_timestamp": now_utc().isoformat(), "drops": []}

    # Group loads by drop_id
    drop_ids = list({l.drop_id for l in loads})
    loads_by_drop: dict[str, list[Load]] = {}
    for l in loads:
        loads_by_drop.setdefault(str(l.drop_id), []).append(l)

    # Fetch drops, customers, and addresses
    drops = db.execute(select(Drop).where(Drop.id.in_(drop_ids), Drop.tenant_id == user.tenant_id)).scalars().all()
    drops_by_id = {str(d.id): d for d in drops}

    customer_ids = list({d.customer_id for d in drops})
    customers = db.execute(select(Customer).where(Customer.id.in_(customer_ids), Customer.tenant_id == user.tenant_id)).scalars().all()
    customers_by_id = {str(c.id): c for c in customers}

    address_ids = list({d.address_id for d in drops})
    addresses = db.execute(select(CustomerAddress).where(CustomerAddress.id.in_(address_ids), CustomerAddress.tenant_id == user.tenant_id)).scalars().all()
    addresses_by_id = {str(a.id): a for a in addresses}

    result = []
    for drop_id_str, drop_loads in loads_by_drop.items():
        drop = drops_by_id.get(drop_id_str)
        if not drop:
            continue
        customer = customers_by_id.get(str(drop.customer_id))
        addr = addresses_by_id.get(str(drop.address_id))

        result.append({
            "drop_id": drop_id_str,
            "customer_name": customer.name if customer else "Unknown",
            "customer_phone": customer.phone_e164 if customer else None,
            "address": {
                "line1": addr.line1 if addr else "",
                "city": addr.city if addr else "",
                "state": addr.state if addr else "",
                "postal_code": addr.postal_code if addr else "",
            } if addr else None,
            "notes": drop.notes,
            "notify_sent": drop.notify_sent_at is not None,
            "scheduled_window": drop.scheduled_window.value if drop.scheduled_window else None,
            "loads": [
                {
                    "id": str(l.id),
                    "status": l.status.value,
                    "material": l.material_name_snapshot,
                    "qty": l.qty,
                    "unit": l.unit,
                    "pod_photo_url": l.pod_photo_url,
                    "exception_photo_url": l.exception_photo_url,
                    "exception_reason_code": l.exception_reason_code.value if l.exception_reason_code else None,
                    "exception_notes": l.exception_notes,
                }
                for l in drop_loads
            ],
        })

    # Sort: active deliveries first, then by window, then completed
    status_priority = {"assigned": 0, "loaded_leaving": 1, "exception": 3, "delivered": 4, "cancelled": 5}

    def drop_sort_key(d: dict) -> tuple:
        statuses = [status_priority.get(l["status"], 2) for l in d["loads"]]
        min_status = min(statuses) if statuses else 99
        return (min_status, d.get("scheduled_window", "Z"))

    result.sort(key=drop_sort_key)

    return {"server_timestamp": now_utc().isoformat(), "drops": result}


# ── Notify customer (per-drop SMS) ───────────────────────────────────────────


@router.post("/drops/{drop_id}/notify")
def driver_notify_customer(
    drop_id: str,
    user: AuthUser = Depends(require_roles(UserRole.DRIVER)),
    db: Session = Depends(db_dep),
):
    """Send on-the-way SMS to customer. Idempotent — won't send twice."""
    drop = db.execute(
        select(Drop).where(Drop.id == drop_id, Drop.tenant_id == user.tenant_id).with_for_update()
    ).scalar_one_or_none()
    if not drop:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Drop not found"})

    # Verify this driver has loads on this drop
    driver_load = db.execute(
        select(Load).where(Load.drop_id == drop_id, Load.driver_user_id == user.user_id, Load.tenant_id == user.tenant_id)
    ).scalars().first()
    if not driver_load:
        raise HTTPException(status_code=403, detail={"code": "not_assigned", "message": "No loads assigned to you for this drop"})

    if drop.notify_sent_at:
        db.commit()
        return {"already_sent": True, "sent_at": drop.notify_sent_at.isoformat()}

    customer = db.execute(
        select(Customer).where(Customer.id == drop.customer_id, Customer.tenant_id == user.tenant_id)
    ).scalar_one()

    created = enqueue_sms_job(
        {
            "type": "SEND_SMS",
            "tenant_id": str(user.tenant_id),
            "drop_id": str(drop.id),
            "to": customer.phone_e164,
            "template": "on_the_way",
            "context": {"drop_id": str(drop.id)},
        },
        dedupe_key=f"drop-on-the-way-{drop.id}",
    )
    if created:
        drop.notify_sent_at = now_utc()

    log_event(
        db, user.tenant_id, "CUSTOMER_NOTIFIED", "driver",
        {"drop_id": drop_id, "driver_user_id": str(user.user_id)},
    )

    db.commit()
    return {"already_sent": False, "sent_at": drop.notify_sent_at.isoformat() if drop.notify_sent_at else None}


# ── Existing load-level endpoints ────────────────────────────────────────────


@router.get("/loads")
def poll_driver_loads(
    day: date = Query(...),
    server_version: str | None = Query(default=None),
    known_load_ids: list[str] = Query(default=[]),
    user: AuthUser = Depends(require_roles(UserRole.DRIVER)),
    db: Session = Depends(db_dep),
):
    rows = db.execute(
        select(Load).where(Load.tenant_id == user.tenant_id, Load.route_date == day, Load.driver_user_id == user.user_id)
    ).scalars().all()
    current_load_ids = {str(l.id) for l in rows}
    removed_load_ids = [load_id for load_id in known_load_ids if load_id not in current_load_ids]
    max_revision_ts = db.execute(
        select(func.max(Load.updated_at)).where(Load.tenant_id == user.tenant_id, Load.route_date == day)
    ).scalar_one_or_none()
    revision_millis = int(max_revision_ts.timestamp() * 1000) if max_revision_ts else 0
    route_load_count = db.execute(select(func.count()).select_from(Load).where(Load.tenant_id == user.tenant_id, Load.route_date == day)).scalar_one()
    computed_server_version = f"{revision_millis}:{route_load_count}"
    data = [
        {
            "id": str(l.id),
            "drop_id": str(l.drop_id),
            "status": l.status.value,
            "material": l.material_name_snapshot,
            "qty": l.qty,
            "unit": l.unit,
            "server_version": str(int(l.updated_at.timestamp() * 1000)),
        }
        for l in rows
    ]
    return {
        "server_timestamp": now_utc().isoformat(),
        "server_version": computed_server_version,
        "client_server_version": server_version,
        "removed_load_ids": removed_load_ids,
        "loads": data,
    }


@router.get("/loads/{load_id}")
def driver_load_detail(load_id: str, user: AuthUser = Depends(require_roles(UserRole.DRIVER)), db: Session = Depends(db_dep)):
    load = db.execute(select(Load).where(Load.id == load_id, Load.tenant_id == user.tenant_id)).scalar_one_or_none()
    if not load:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Load not found"})
    if load.driver_user_id != user.user_id:
        raise HTTPException(status_code=403, detail={"code": "load_reassigned", "message": "Load not assigned to driver"})
    drop = db.execute(select(Drop).where(Drop.id == load.drop_id, Drop.tenant_id == user.tenant_id)).scalar_one()
    addr = db.execute(select(CustomerAddress).where(CustomerAddress.id == drop.address_id, CustomerAddress.tenant_id == user.tenant_id)).scalar_one()
    return {
        "server_timestamp": now_utc().isoformat(),
        "server_version": str(int(load.updated_at.timestamp() * 1000)),
        "id": str(load.id),
        "drop_id": str(drop.id),
        "status": load.status.value,
        "address": {
            "line1": addr.line1,
            "city": addr.city,
            "state": addr.state,
            "postal_code": addr.postal_code,
        },
        "notes": drop.notes,
        "material": load.material_name_snapshot,
        "qty": load.qty,
        "unit": load.unit,
        "pod_photo_url": load.pod_photo_url,
        "exception_photo_url": load.exception_photo_url,
        "exception_reason_code": load.exception_reason_code.value if load.exception_reason_code else None,
    }


class StatusIn(BaseModel):
    status: str
    client_server_version: str | None = None
    reason_code: ExceptionReasonCode | None = None
    notes: str | None = None


def _ensure_transition(load: Load, requested: LoadStatus) -> None:
    allowed = {
        LoadStatus.ASSIGNED: {LoadStatus.DELIVERED, LoadStatus.EXCEPTION},
        LoadStatus.LOADED_LEAVING: {LoadStatus.DELIVERED, LoadStatus.EXCEPTION},  # legacy support
        LoadStatus.EXCEPTION: set(),
        LoadStatus.DELIVERED: set(),
        LoadStatus.CANCELLED: set(),
    }
    if requested not in allowed.get(load.status, set()):
        raise HTTPException(status_code=409, detail={"code": "invalid_transition", "message": "Invalid status transition"})


@router.post("/loads/{load_id}/status")
def update_load_status(
    load_id: str,
    payload: StatusIn,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    user: AuthUser = Depends(require_roles(UserRole.DRIVER)),
    db: Session = Depends(db_dep),
):
    try:
        requested = LoadStatus(payload.status)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail={"code": "invalid_transition", "message": "Invalid status transition"}) from exc
    load = db.execute(select(Load).where(Load.id == load_id, Load.tenant_id == user.tenant_id).with_for_update()).scalar_one_or_none()
    if not load:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Load not found"})
    if load.driver_user_id != user.user_id:
        raise HTTPException(status_code=403, detail={"code": "load_reassigned", "message": "Load not assigned to driver"})
    current_server_version = str(int(load.updated_at.timestamp() * 1000))
    if payload.client_server_version and payload.client_server_version != current_server_version:
        raise HTTPException(
            status_code=409,
            detail={"code": "stale_state", "message": "Load state changed. Please refresh before retrying."},
        )
    if idempotency_key and load.idempotency_key_last == idempotency_key:
        if load.status != requested:
            raise HTTPException(
                status_code=409,
                detail={"code": "idempotency_conflict", "message": "Idempotency key already used for a different status"},
            )
        return {
            "status": load.status.value,
            "idempotent": True,
            "server_timestamp": now_utc().isoformat(),
            "server_version": current_server_version,
        }

    _ensure_transition(load, requested)

    if requested == LoadStatus.EXCEPTION and not payload.reason_code:
        raise HTTPException(status_code=400, detail={"code": "reason_required", "message": "Exception reason_code is required"})

    load.status = requested
    load.idempotency_key_last = idempotency_key
    if requested == LoadStatus.EXCEPTION:
        load.exception_reason_code = payload.reason_code
        load.exception_notes = payload.notes

    log_event(
        db,
        user.tenant_id,
        "LOAD_STATUS_CHANGED",
        "driver",
        {"load_id": load_id, "status": requested.value, "reason_code": payload.reason_code.value if payload.reason_code else None, "notes": payload.notes},
    )

    # NOTE: SMS no longer auto-triggers on LOADED_LEAVING — driver uses the explicit notify button
    db.commit()
    return {
        "status": load.status.value,
        "idempotent": False,
        "server_timestamp": now_utc().isoformat(),
        "server_version": str(int(load.updated_at.timestamp() * 1000)),
    }


# ── Photo upload for POD / exception ─────────────────────────────────────────


class PhotoLinkIn(BaseModel):
    photo_url: str
    photo_type: str  # "pod" or "exception"


@router.post("/loads/{load_id}/photo")
def attach_load_photo(
    load_id: str,
    payload: PhotoLinkIn,
    user: AuthUser = Depends(require_roles(UserRole.DRIVER)),
    db: Session = Depends(db_dep),
):
    """Attach a photo URL to a load (POD or exception photo).
    The frontend handles the actual upload to the upload service / S3
    and passes the resulting URL here."""
    load = db.execute(
        select(Load).where(Load.id == load_id, Load.tenant_id == user.tenant_id).with_for_update()
    ).scalar_one_or_none()
    if not load:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Load not found"})
    if load.driver_user_id != user.user_id:
        raise HTTPException(status_code=403, detail={"code": "load_reassigned", "message": "Load not assigned to driver"})

    if payload.photo_type == "pod":
        load.pod_photo_url = payload.photo_url
    elif payload.photo_type == "exception":
        load.exception_photo_url = payload.photo_url
    else:
        raise HTTPException(status_code=400, detail={"code": "invalid_type", "message": "photo_type must be 'pod' or 'exception'"})

    log_event(
        db, user.tenant_id, "LOAD_PHOTO_ATTACHED", "driver",
        {"load_id": load_id, "photo_type": payload.photo_type},
    )

    db.commit()
    return {
        "pod_photo_url": load.pod_photo_url,
        "exception_photo_url": load.exception_photo_url,
    }
