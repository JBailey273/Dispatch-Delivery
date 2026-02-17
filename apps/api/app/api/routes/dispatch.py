import logging
from collections import defaultdict
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import AuthUser, db_dep, require_roles
from app.api.dispatch_suggestions import (
    build_dispatch_suggestions,
    get_address_history,
    get_driver_performance_signals,
    invalidate_suggestion_cache,
)
from app.api.services import enqueue_sms_job, log_event, now_utc
from app.models.entities import Customer, CustomerAddress, Drop, Load, LoadStatus, User, UserRole, WindowCapacity

router = APIRouter(prefix="/dispatch", tags=["dispatch"])
logger = logging.getLogger("dispatch.ops")


@router.get("/schedule")
def dispatch_schedule(day: date, user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)), db: Session = Depends(db_dep)):
    orphaned = db.execute(select(Load.id).where(Load.tenant_id == user.tenant_id, Load.route_date == day, ~Load.drop_id.in_(select(Drop.id)))).scalars().all()
    if orphaned:
        logger.error("orphaned_loads_detected", extra={"tenant_id": str(user.tenant_id), "count": len(orphaned)})
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
        history = get_address_history(db, str(user.tenant_id), str(drop.address_id))
        by_window[load.route_window.value][key].append(
            {
                "id": str(load.id),
                "drop_id": str(drop.id),
                "status": load.status.value,
                "material": load.material_name_snapshot,
                "qty": load.qty,
                "unit": load.unit,
                "historical_flags": {
                    "exception_count": history.exception_count,
                    "has_exception_history": history.exception_count > 0,
                    "recent_notes": history.recent_notes,
                },
            }
        )

    return {
        "date": str(day),
        "windows": {
            "A": {"capacity": cap_map.get("A", {"used": 0, "total": 0}), "groups": by_window["A"]},
            "B": {"capacity": cap_map.get("B", {"used": 0, "total": 0}), "groups": by_window["B"]},
        },
    }


@router.get("/drops/{drop_id}")
def drop_detail(drop_id: str, user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)), db: Session = Depends(db_dep)):
    row = db.execute(
        select(Drop, Customer).join(Customer, Customer.id == Drop.customer_id).where(Drop.tenant_id == user.tenant_id, Drop.id == drop_id)
    ).one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Drop not found"})
    drop, customer = row
    return {
        "id": str(drop.id),
        "scheduled_date": str(drop.scheduled_date),
        "scheduled_window": drop.scheduled_window.value,
        "notify_sent_at": drop.notify_sent_at.isoformat() if drop.notify_sent_at else None,
        "last_reschedule_sms_at": drop.last_reschedule_sms_at.isoformat() if drop.last_reschedule_sms_at else None,
        "customer_phone": customer.phone_e164,
    }


class RescheduleSmsIn(BaseModel):
    message: str
    admin_override: bool = False


@router.post("/drops/{drop_id}/send-reschedule-sms")
def send_reschedule_sms(drop_id: str, payload: RescheduleSmsIn, user: AuthUser = Depends(require_roles(UserRole.DISPATCHER, UserRole.ADMIN)), db: Session = Depends(db_dep)):
    row = db.execute(
        select(Drop, Customer).join(Customer, Customer.id == Drop.customer_id).where(Drop.tenant_id == user.tenant_id, Drop.id == drop_id).with_for_update()
    ).one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Drop not found"})
    drop, customer = row
    if drop.last_reschedule_sms_at and now_utc() - drop.last_reschedule_sms_at < timedelta(minutes=5) and not payload.admin_override:
        raise HTTPException(status_code=409, detail={"code": "sms_rate_limited", "message": "Reschedule SMS already sent recently"})

    job = {
        "type": "SEND_SMS",
        "tenant_id": str(user.tenant_id),
        "drop_id": str(drop.id),
        "to": customer.phone_e164,
        "template": "custom",
        "message": payload.message,
    }
    dedupe_key = f"reschedule-{drop.id}-{int(now_utc().timestamp() // 300)}"
    if not enqueue_sms_job(job, dedupe_key=dedupe_key):
        raise HTTPException(status_code=409, detail={"code": "duplicate_sms", "message": "Duplicate SMS request"})

    drop.last_reschedule_sms_at = now_utc()
    log_event(db, user.tenant_id, "SMS_SENT", "dispatch", {"drop_id": drop_id, "kind": "reschedule", "preview": payload.message})
    db.commit()
    invalidate_suggestion_cache(str(user.tenant_id))
    return {"status": "queued", "sent_at": drop.last_reschedule_sms_at.isoformat()}


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
        if l.status == LoadStatus.CANCELLED:
            continue
        l.status = LoadStatus.ASSIGNED
    log_event(db, user.tenant_id, "loads.assigned", "api", payload.model_dump())
    db.commit()
    invalidate_suggestion_cache(str(user.tenant_id))
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
    invalidate_suggestion_cache(str(user.tenant_id))
    return {"updated": len(rows)}


@router.post("/drops/{drop_id}/assign")
def assign_entire_drop(drop_id: str, payload: AssignIn, user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)), db: Session = Depends(db_dep)):
    rows = db.execute(select(Load).where(Load.tenant_id == user.tenant_id, Load.drop_id == drop_id)).scalars().all()
    for l in rows:
        l.driver_user_id = payload.driver_user_id
        l.truck_label = payload.truck_label
        if l.status != LoadStatus.CANCELLED:
            l.status = LoadStatus.ASSIGNED
    log_event(db, user.tenant_id, "drop.assigned", "api", {"drop_id": drop_id, "driver_user_id": payload.driver_user_id})
    db.commit()
    invalidate_suggestion_cache(str(user.tenant_id))
    return {"updated": len(rows)}


@router.get("/suggestions")
def get_dispatch_suggestions(day: date, user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)), db: Session = Depends(db_dep)):
    return {"date": str(day), "suggestions": build_dispatch_suggestions(db, str(user.tenant_id), day)}


@router.get("/history/address/{address_id}")
def address_history(address_id: str, day: date, user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)), db: Session = Depends(db_dep)):
    address = db.execute(
        select(CustomerAddress).where(CustomerAddress.id == address_id, CustomerAddress.tenant_id == user.tenant_id)
    ).scalar_one_or_none()
    if not address:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Address not found"})
    history = get_address_history(db, str(user.tenant_id), address_id)
    return {
        "address_id": address_id,
        "exception_count": history.exception_count,
        "delivered_count": history.delivered_count,
        "typical_delivery_hour_utc": history.typical_delivery_hour_utc,
        "recent_notes": history.recent_notes,
        "driver_performance_signals": [signal.__dict__ for signal in get_driver_performance_signals(db, str(user.tenant_id), day)],
    }


class SuggestionEventIn(BaseModel):
    suggestion_type: str
    referenced_entities: dict


@router.post("/suggestions/applied")
def log_suggestion_applied(payload: SuggestionEventIn, user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)), db: Session = Depends(db_dep)):
    log_event(
        db,
        user.tenant_id,
        "SUGGESTION_APPLIED",
        "dispatch",
        {"suggestion_type": payload.suggestion_type, "referenced_entities": payload.referenced_entities},
    )
    db.commit()
    return {"status": "logged"}


@router.post("/suggestions/dismissed")
def log_suggestion_dismissed(payload: SuggestionEventIn, user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)), db: Session = Depends(db_dep)):
    log_event(
        db,
        user.tenant_id,
        "SUGGESTION_DISMISSED",
        "dispatch",
        {"suggestion_type": payload.suggestion_type, "referenced_entities": payload.referenced_entities},
    )
    db.commit()
    return {"status": "logged"}
