from collections import defaultdict
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import and_, select
from sqlalchemy.orm import Session

from app.api.deps import AuthUser, db_dep, require_roles
from app.api.services import log_event
from app.models.entities import Drop, Load, LoadStatus, User, UserRole, WindowCapacity, WindowCode

router = APIRouter(prefix="/dispatch", tags=["dispatch"])


@router.get("/schedule")
def dispatch_schedule(day: date = Query(...), user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)), db: Session = Depends(db_dep)):
    caps = db.execute(select(WindowCapacity).where(WindowCapacity.tenant_id == user.tenant_id, WindowCapacity.service_date == day)).scalars().all()
    cap_map = {c.window_code.value: {"used": c.capacity_used, "total": c.capacity_total} for c in caps}
    loads = db.execute(
        select(Load, Drop, User)
        .join(Drop, Drop.id == Load.drop_id)
        .outerjoin(User, User.id == Load.driver_user_id)
        .where(Load.tenant_id == user.tenant_id, Load.route_date == day)
    ).all()

    by_window = {"A": defaultdict(list), "B": defaultdict(list)}
    for load, drop, driver in loads:
        key = driver.email if driver else "Unassigned"
        by_window[load.route_window.value][key].append(
            {
                "id": str(load.id),
                "drop_id": str(drop.id),
                "status": load.status.value,
                "material": load.material_name_snapshot,
                "qty": load.qty,
                "unit": load.unit,
            }
        )

    return {
        "date": str(day),
        "windows": {
            "A": {"capacity": cap_map.get("A", {"used": 0, "total": 0}), "groups": by_window["A"]},
            "B": {"capacity": cap_map.get("B", {"used": 0, "total": 0}), "groups": by_window["B"]},
        },
    }


class AssignIn(BaseModel):
    load_ids: list[str]
    driver_user_id: str
    truck_label: str | None = None


@router.post("/loads/assign")
def assign_loads(payload: AssignIn, user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)), db: Session = Depends(db_dep)):
    rows = db.execute(select(Load).where(Load.tenant_id == user.tenant_id, Load.id.in_(payload.load_ids))).scalars().all()
    for l in rows:
        l.driver_user_id = payload.driver_user_id
        l.truck_label = payload.truck_label
    log_event(db, user.tenant_id, "loads.assigned", "api", payload.model_dump())
    db.commit()
    return {"updated": len(rows)}


class ReassignAllIn(BaseModel):
    day: date
    from_driver_user_id: str
    to_driver_user_id: str


@router.post("/loads/reassign-all")
def reassign_all(payload: ReassignAllIn, user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)), db: Session = Depends(db_dep)):
    rows = db.execute(
        select(Load).where(
            Load.tenant_id == user.tenant_id,
            Load.route_date == payload.day,
            Load.driver_user_id == payload.from_driver_user_id,
            Load.status.notin_([LoadStatus.DELIVERED, LoadStatus.CANCELLED]),
        )
    ).scalars().all()
    for l in rows:
        l.driver_user_id = payload.to_driver_user_id
    log_event(db, user.tenant_id, "loads.reassigned_all", "api", payload.model_dump(mode="json"))
    db.commit()
    return {"updated": len(rows)}


@router.post("/drops/{drop_id}/assign")
def assign_entire_drop(drop_id: str, payload: AssignIn, user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)), db: Session = Depends(db_dep)):
    rows = db.execute(select(Load).where(Load.tenant_id == user.tenant_id, Load.drop_id == drop_id)).scalars().all()
    for l in rows:
        l.driver_user_id = payload.driver_user_id
        l.truck_label = payload.truck_label
    log_event(db, user.tenant_id, "drop.assigned", "api", {"drop_id": drop_id, "driver_user_id": payload.driver_user_id})
    db.commit()
    return {"updated": len(rows)}
