from datetime import date

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import AuthUser, db_dep, require_roles
from app.api.services import enqueue_sms_job, log_event, now_utc
from app.models.entities import Customer, CustomerAddress, Drop, ExceptionReasonCode, Load, LoadStatus, UserRole

router = APIRouter(prefix="/driver", tags=["driver"])


@router.get("/loads")
def poll_driver_loads(
    day: date = Query(...),
    server_version: int | None = Query(default=None),
    user: AuthUser = Depends(require_roles(UserRole.DRIVER)),
    db: Session = Depends(db_dep),
):
    rows = db.execute(
        select(Load).where(Load.tenant_id == user.tenant_id, Load.route_date == day, Load.driver_user_id == user.user_id)
    ).scalars().all()
    data = [{"id": str(l.id), "drop_id": str(l.drop_id), "status": l.status.value, "material": l.material_name_snapshot, "qty": l.qty, "unit": l.unit} for l in rows]
    return {"server_version": int(day.strftime("%Y%m%d")), "removed_load_ids": [], "loads": data, "server_time": now_utc().isoformat(), "client_server_version": server_version}


@router.get("/loads/{load_id}")
def driver_load_detail(load_id: str, user: AuthUser = Depends(require_roles(UserRole.DRIVER)), db: Session = Depends(db_dep)):
    load = db.execute(select(Load).where(Load.id == load_id, Load.tenant_id == user.tenant_id)).scalar_one_or_none()
    if not load:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Load not found"})
    if load.driver_user_id != user.user_id:
        raise HTTPException(status_code=403, detail={"code": "forbidden", "message": "Load not assigned to driver"})
    drop = db.execute(select(Drop).where(Drop.id == load.drop_id, Drop.tenant_id == user.tenant_id)).scalar_one()
    addr = db.execute(select(CustomerAddress).where(CustomerAddress.id == drop.address_id, CustomerAddress.tenant_id == user.tenant_id)).scalar_one()
    return {
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
    reason_code: ExceptionReasonCode | None = None
    notes: str | None = None


def _ensure_transition(load: Load, requested: LoadStatus) -> None:
    allowed = {
        LoadStatus.ASSIGNED: {LoadStatus.LOADED_LEAVING, LoadStatus.EXCEPTION},
        LoadStatus.LOADED_LEAVING: {LoadStatus.DELIVERED, LoadStatus.EXCEPTION},
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
        raise HTTPException(status_code=403, detail={"code": "forbidden", "message": "Load not assigned to driver"})
    if idempotency_key and load.idempotency_key_last == idempotency_key:
        return {"status": load.status.value, "idempotent": True}

    _ensure_transition(load, requested)
    if requested == LoadStatus.DELIVERED and not load.pod_photo_url:
        raise HTTPException(status_code=409, detail={"code": "missing_pod", "message": "POD photo required before delivered"})

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

    if requested == LoadStatus.LOADED_LEAVING:
        drop = db.execute(select(Drop).where(Drop.id == load.drop_id, Drop.tenant_id == user.tenant_id).with_for_update()).scalar_one()
        if not drop.notify_sent_at:
            customer = db.execute(select(Customer).where(Customer.id == drop.customer_id, Customer.tenant_id == user.tenant_id)).scalar_one()
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

    db.commit()
    return {"status": load.status.value, "idempotent": False}
