from datetime import date

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import AuthUser, db_dep, require_roles
from app.api.services import log_event
from app.models.entities import CustomerAddress, Drop, Load, LoadStatus, UserRole

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
    return {"server_version": int(day.strftime("%Y%m%d")), "removed_load_ids": [], "loads": data}


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
        "photos": [],
    }


class StatusIn(BaseModel):
    status: str
    reason: str | None = None


@router.post("/loads/{load_id}/status")
def update_load_status(
    load_id: str,
    payload: StatusIn,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    user: AuthUser = Depends(require_roles(UserRole.DRIVER)),
    db: Session = Depends(db_dep),
):
    if payload.status not in {LoadStatus.LOADED_LEAVING.value, LoadStatus.EXCEPTION.value, LoadStatus.DELIVERED.value}:
        raise HTTPException(status_code=400, detail={"code": "invalid_status", "message": "Unsupported status"})
    load = db.execute(select(Load).where(Load.id == load_id, Load.tenant_id == user.tenant_id).with_for_update()).scalar_one_or_none()
    if not load:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Load not found"})
    if load.driver_user_id != user.user_id:
        raise HTTPException(status_code=403, detail={"code": "forbidden", "message": "Load not assigned to driver"})
    if idempotency_key and load.idempotency_key_last == idempotency_key:
        return {"status": load.status.value, "idempotent": True}
    if payload.status == LoadStatus.DELIVERED.value:
        return {"status": load.status.value, "stubbed": True}
    load.status = LoadStatus(payload.status)
    load.idempotency_key_last = idempotency_key
    log_event(db, user.tenant_id, "load.status_changed", "driver", {"load_id": load_id, "status": payload.status, "reason": payload.reason})
    db.commit()
    return {"status": load.status.value, "idempotent": False}
