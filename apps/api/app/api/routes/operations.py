from collections import defaultdict
from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel
from sqlalchemy import case, func, or_, select
from sqlalchemy.orm import Session

from app.api.deps import AuthUser, db_dep, require_roles
from app.api.guardrails import CapacityMutationContext, assert_drop_load_invariants, mutate_capacity_or_409
from app.api.services import enqueue_sms_job, log_event, now_utc
from app.billing.service import ensure_billing_account, get_plan
from app.models.entities import (
    BlackoutReason,
    CapacityHold,
    Drop,
    EventLog,
    Load,
    LoadStatus,
    OperationalBlackout,
    User,
    Customer,
    UserRole,
    WindowCapacity,
    WindowCode,
)

router = APIRouter(prefix="/ops", tags=["operations"])
admin_router = APIRouter(prefix="/admin", tags=["admin-ops"])


def is_window_blacked_out(db: Session, tenant_id, day: date, window: WindowCode) -> bool:
    row = db.execute(
        select(OperationalBlackout.id).where(
            OperationalBlackout.tenant_id == tenant_id,
            OperationalBlackout.service_date == day,
            OperationalBlackout.active.is_(True),
            or_(OperationalBlackout.window_code.is_(None), OperationalBlackout.window_code == window),
        )
    ).scalar_one_or_none()
    return row is not None


def _event_times(db: Session, tenant_id, start: date, end: date):
    rows = db.execute(
        select(EventLog.payload_json, EventLog.created_at)
        .where(
            EventLog.tenant_id == tenant_id,
            EventLog.event_type == "LOAD_STATUS_CHANGED",
            EventLog.created_at >= datetime.combine(start, datetime.min.time(), tzinfo=timezone.utc),
            EventLog.created_at < datetime.combine(end, datetime.max.time(), tzinfo=timezone.utc),
        )
    ).all()
    by_load = defaultdict(dict)
    for payload, created in rows:
        load_id = payload.get("load_id")
        status = payload.get("status")
        if load_id and status and status not in by_load[load_id]:
            by_load[load_id][status] = created
    return by_load


@router.get("/analytics/overview")
def analytics_overview(
    start_date: date = Query(...),
    end_date: date = Query(...),
    material: str | None = Query(default=None),
    driver_user_id: str | None = Query(default=None),
    window: WindowCode | None = Query(default=None),
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER, UserRole.ADMIN)),
    db: Session = Depends(db_dep),
):
    account = ensure_billing_account(db, user.tenant_id)
    plan = get_plan(db, account.plan_id)
    if not plan.analytics_enabled:
        raise HTTPException(status_code=402, detail={"code": "feature_not_in_plan", "message": "Analytics is not enabled for current plan", "upgrade_required": True})
    load_filter = [Load.tenant_id == user.tenant_id, Load.route_date >= start_date, Load.route_date <= end_date]
    if material:
        load_filter.append(Load.material_name_snapshot == material)
    if driver_user_id:
        load_filter.append(Load.driver_user_id == driver_user_id)
    if window:
        load_filter.append(Load.route_window == window)

    deliveries_per_day = db.execute(
        select(Load.route_date, func.count(Load.id)).where(*load_filter, Load.status == LoadStatus.DELIVERED).group_by(Load.route_date)
    ).all()
    deliveries_per_window = db.execute(
        select(Load.route_date, Load.route_window, func.count(Load.id)).where(*load_filter, Load.status == LoadStatus.DELIVERED).group_by(Load.route_date, Load.route_window)
    ).all()
    loads_per_material = db.execute(
        select(Load.route_date, Load.material_name_snapshot, func.count(Load.id)).where(*load_filter).group_by(Load.route_date, Load.material_name_snapshot)
    ).all()

    total_count, exception_count = db.execute(
        select(func.count(Load.id), func.sum(case((Load.status == LoadStatus.EXCEPTION, 1), else_=0))).where(*load_filter)
    ).one()
    exceptions_by_reason = db.execute(
        select(Load.exception_reason_code, func.count(Load.id)).where(*load_filter, Load.status == LoadStatus.EXCEPTION).group_by(Load.exception_reason_code)
    ).all()

    events = _event_times(db, user.tenant_id, start_date, end_date)
    loads = db.execute(select(Load.id, Load.route_date, Load.route_window, Load.status).where(*load_filter)).all()
    on_time_proxy = defaultdict(lambda: {"delivered_in_window": 0, "delivered_late_or_missing": 0})
    sched_to_leave = []
    leave_to_delivered = []
    for load_id, route_date, route_window, status in loads:
        key = f"{route_date}:{route_window.value}"
        evt = events.get(str(load_id), {})
        leave_time = evt.get("loaded_leaving")
        delivered_time = evt.get("delivered")
        window_start = datetime.combine(route_date, datetime.min.time(), tzinfo=timezone.utc)
        if route_window == WindowCode.B:
            window_start = window_start.replace(hour=13)
        else:
            window_start = window_start.replace(hour=9)
        if status == LoadStatus.DELIVERED and delivered_time:
            if delivered_time.date() == route_date:
                on_time_proxy[key]["delivered_in_window"] += 1
            else:
                on_time_proxy[key]["delivered_late_or_missing"] += 1
        else:
            on_time_proxy[key]["delivered_late_or_missing"] += 1
        if leave_time:
            sched_to_leave.append((leave_time - window_start).total_seconds())
        if leave_time and delivered_time:
            leave_to_delivered.append((delivered_time - leave_time).total_seconds())

    driver_signals = db.execute(
        select(Load.driver_user_id, User.email, Load.route_date, func.count(Load.id), func.sum(case((Load.status == LoadStatus.EXCEPTION, 1), else_=0)))
        .join(User, User.id == Load.driver_user_id, isouter=True)
        .where(*load_filter, Load.driver_user_id.is_not(None))
        .group_by(Load.driver_user_id, User.email, Load.route_date)
    ).all()

    return {
        "deliveries_per_day": [{"date": str(d), "count": c} for d, c in deliveries_per_day],
        "deliveries_per_window": [{"date": str(d), "window": w.value, "count": c} for d, w, c in deliveries_per_window],
        "loads_per_material": [{"date": str(d), "material": m, "count": c} for d, m, c in loads_per_material],
        "on_time_proxy": [{"slot": k, **v} for k, v in on_time_proxy.items()],
        "average_seconds": {
            "scheduled_to_loaded_leaving": (sum(sched_to_leave) / len(sched_to_leave)) if sched_to_leave else None,
            "loaded_leaving_to_delivered": (sum(leave_to_delivered) / len(leave_to_delivered)) if leave_to_delivered else None,
        },
        "exception_rates": {
            "total_loads": total_count,
            "exception_loads": int(exception_count or 0),
            "exception_percent": round((float(exception_count or 0) / float(total_count) * 100.0), 2) if total_count else 0,
            "by_reason": [{"reason": (r.value if r else "unknown"), "count": c} for r, c in exceptions_by_reason],
        },
        "driver_operational_signals": [
            {"driver_user_id": str(driver_id), "driver": email, "date": str(day), "loads_completed": int(count), "exceptions": int(ex_count or 0)}
            for driver_id, email, day, count, ex_count in driver_signals
        ],
    }


@router.get("/capacity/utilization")
def capacity_utilization(start_date: date, end_date: date, user: AuthUser = Depends(require_roles(UserRole.DISPATCHER, UserRole.ADMIN)), db: Session = Depends(db_dep)):
    caps = db.execute(
        select(WindowCapacity.service_date, WindowCapacity.window_code, WindowCapacity.capacity_total, WindowCapacity.capacity_used).where(
            WindowCapacity.tenant_id == user.tenant_id, WindowCapacity.service_date >= start_date, WindowCapacity.service_date <= end_date
        )
    ).all()
    lost = db.execute(
        select(func.coalesce(func.sum(CapacityHold.units_held), 0))
        .where(
            CapacityHold.tenant_id == user.tenant_id,
            CapacityHold.service_date >= start_date,
            CapacityHold.service_date <= end_date,
            CapacityHold.expires_at <= now_utc(),
            CapacityHold.converted_at.is_(None),
        )
    ).scalar_one()
    under_utilized = [
        {"date": str(d), "window": w.value, "used": used, "total": total, "utilization_percent": round((used / total) * 100.0, 2) if total else 0}
        for d, w, total, used in caps
        if total and (used / total) < 0.5
    ]
    return {
        "total_capacity_available": int(sum(c[2] for c in caps)),
        "capacity_used": int(sum(c[3] for c in caps)),
        "capacity_lost_to_expired_holds": int(lost or 0),
        "under_utilized_windows": under_utilized,
    }




@router.get("/reports/loads.csv")
def export_loads_csv(start_date: date, end_date: date, user: AuthUser = Depends(require_roles(UserRole.DISPATCHER, UserRole.ADMIN)), db: Session = Depends(db_dep)):
    rows = db.execute(select(Load).where(Load.tenant_id == user.tenant_id, Load.route_date >= start_date, Load.route_date <= end_date)).scalars().all()
    body = "id,drop_id,route_date,window,status,driver,material,qty,unit\n" + "\n".join([f"{r.id},{r.drop_id},{r.route_date},{r.route_window.value},{r.status.value},{r.driver_user_id or ''},{r.material_name_snapshot},{r.qty},{r.unit}" for r in rows])
    return Response(content=body, media_type="text/csv")


@router.get("/reports/drops.csv")
def export_drops_csv(start_date: date, end_date: date, user: AuthUser = Depends(require_roles(UserRole.DISPATCHER, UserRole.ADMIN)), db: Session = Depends(db_dep)):
    rows = db.execute(select(Drop).where(Drop.tenant_id == user.tenant_id, Drop.scheduled_date >= start_date, Drop.scheduled_date <= end_date)).scalars().all()
    body = "id,scheduled_date,window,status,notify_sent_at,last_reschedule_sms_at\n" + "\n".join([f"{r.id},{r.scheduled_date},{r.scheduled_window.value},{r.status},{r.notify_sent_at or ''},{r.last_reschedule_sms_at or ''}" for r in rows])
    return Response(content=body, media_type="text/csv")


@router.get("/reports/exceptions.csv")
def export_exceptions_csv(start_date: date, end_date: date, user: AuthUser = Depends(require_roles(UserRole.DISPATCHER, UserRole.ADMIN)), db: Session = Depends(db_dep)):
    rows = db.execute(select(Load).where(Load.tenant_id == user.tenant_id, Load.route_date >= start_date, Load.route_date <= end_date, Load.status == LoadStatus.EXCEPTION)).scalars().all()
    body = "id,drop_id,route_date,window,reason,notes\n" + "\n".join([f"{r.id},{r.drop_id},{r.route_date},{r.route_window.value},{(r.exception_reason_code.value if r.exception_reason_code else '')},{(r.exception_notes or '').replace(',', ';')}" for r in rows])
    return Response(content=body, media_type="text/csv")
class BlackoutIn(BaseModel):
    service_date: date
    window_code: WindowCode | None = None
    reason_code: BlackoutReason
    reason_note: str | None = None


@admin_router.post("/blackouts")
def create_blackout(payload: BlackoutIn, user: AuthUser = Depends(require_roles(UserRole.ADMIN, UserRole.DISPATCHER)), db: Session = Depends(db_dep)):
    existing = db.execute(
        select(OperationalBlackout).where(
            OperationalBlackout.tenant_id == user.tenant_id,
            OperationalBlackout.service_date == payload.service_date,
            OperationalBlackout.window_code == payload.window_code,
        )
    ).scalar_one_or_none()
    if existing:
        existing.active = True
        existing.reason_code = payload.reason_code
        existing.reason_note = payload.reason_note
    else:
        db.add(OperationalBlackout(tenant_id=user.tenant_id, **payload.model_dump()))
    log_event(db, user.tenant_id, "ops.blackout.updated", "api", payload.model_dump(mode="json"))
    db.commit()
    return {"status": "ok"}


@admin_router.get("/diagnostics/anomalies")
def anomalies(user: AuthUser = Depends(require_roles(UserRole.ADMIN, UserRole.DISPATCHER)), db: Session = Depends(db_dep)):
    rows = db.execute(
        select(EventLog.event_type, EventLog.payload_json, EventLog.created_at)
        .where(EventLog.tenant_id == user.tenant_id, EventLog.event_type.like("anomaly.%"))
        .order_by(EventLog.created_at.desc())
        .limit(250)
    ).all()
    return {"anomalies": [{"event_type": e, "payload": p, "created_at": c.isoformat()} for e, p, c in rows]}




@admin_router.get("/diagnostics/invariants")
def invariants(user: AuthUser = Depends(require_roles(UserRole.ADMIN, UserRole.DISPATCHER)), db: Session = Depends(db_dep)):
    drops_count = db.execute(select(func.count(Drop.id)).where(Drop.tenant_id == user.tenant_id)).scalar_one()
    loads_count = db.execute(select(func.count(Load.id)).where(Load.tenant_id == user.tenant_id)).scalar_one()
    capacity_totals = db.execute(
        select(func.coalesce(func.sum(WindowCapacity.capacity_total), 0), func.coalesce(func.sum(WindowCapacity.capacity_used), 0)).where(WindowCapacity.tenant_id == user.tenant_id)
    ).one()
    orphaned_loads = db.execute(
        select(func.count(Load.id)).where(Load.tenant_id == user.tenant_id, ~Load.drop_id.in_(select(Drop.id).where(Drop.tenant_id == user.tenant_id)))
    ).scalar_one()
    drops_without_loads = db.execute(
        select(func.count(Drop.id)).where(
            Drop.tenant_id == user.tenant_id,
            ~Drop.id.in_(select(Load.drop_id).where(Load.tenant_id == user.tenant_id)),
        )
    ).scalar_one()
    return {
        "drops_count": int(drops_count or 0),
        "loads_count": int(loads_count or 0),
        "capacity_total": int(capacity_totals[0] or 0),
        "capacity_used": int(capacity_totals[1] or 0),
        "orphaned_loads": int(orphaned_loads or 0),
        "drops_without_loads": int(drops_without_loads or 0),
    }

class BulkRescheduleIn(BaseModel):
    drop_ids: list[str]
    scheduled_date: date
    scheduled_window: WindowCode


@admin_router.post("/bulk/reschedule")
def bulk_reschedule(payload: BulkRescheduleIn, user: AuthUser = Depends(require_roles(UserRole.ADMIN, UserRole.DISPATCHER)), db: Session = Depends(db_dep)):
    results = []
    for drop_id in payload.drop_ids:
        try:
            drop = db.execute(select(Drop).where(Drop.id == drop_id, Drop.tenant_id == user.tenant_id).with_for_update()).scalar_one_or_none()
            if not drop:
                results.append({"drop_id": drop_id, "status": "failed", "reason": "not_found"})
                continue
            loads = assert_drop_load_invariants(db, user.tenant_id, drop.id)
            load_count = len(loads)
            mutate_capacity_or_409(
                db,
                user.tenant_id,
                payload.scheduled_date,
                payload.scheduled_window,
                load_count,
                CapacityMutationContext(source="api", reason="bulk_reschedule_consume", reference_id=drop_id),
            )
            mutate_capacity_or_409(
                db,
                user.tenant_id,
                drop.scheduled_date,
                drop.scheduled_window,
                -load_count,
                CapacityMutationContext(source="api", reason="bulk_reschedule_release", reference_id=drop_id),
            )
            drop.scheduled_date = payload.scheduled_date
            drop.scheduled_window = payload.scheduled_window
            for l in loads:
                l.route_date = payload.scheduled_date
                l.route_window = payload.scheduled_window
            results.append({"drop_id": drop_id, "status": "ok"})
        except Exception:
            db.rollback()
            results.append({"drop_id": drop_id, "status": "failed", "reason": "error"})
    log_event(db, user.tenant_id, "ops.bulk_reschedule", "api", {"requested": len(payload.drop_ids), "results": results})
    db.commit()
    return {"results": results}


class BulkNotifyIn(BaseModel):
    drop_ids: list[str]
    message: str


@admin_router.post("/bulk/notify-reschedule")
def bulk_notify(payload: BulkNotifyIn, user: AuthUser = Depends(require_roles(UserRole.ADMIN, UserRole.DISPATCHER)), db: Session = Depends(db_dep)):
    results = []
    rows = db.execute(
        select(Drop.id, Customer.phone_e164)
        .join(Customer, Customer.id == Drop.customer_id)
        .where(Drop.tenant_id == user.tenant_id, Drop.id.in_(payload.drop_ids))
    ).all()
    for drop_id, phone in rows:
        ok = enqueue_sms_job(
            {"type": "SEND_SMS", "tenant_id": str(user.tenant_id), "drop_id": str(drop_id), "to": phone, "template": "custom", "message": payload.message},
            dedupe_key=f"bulk-reschedule-{drop_id}-{int(now_utc().timestamp() // 300)}",
        )
        results.append({"drop_id": str(drop_id), "status": "queued" if ok else "skipped_rate_limited"})
    log_event(db, user.tenant_id, "ops.bulk_notify", "api", {"results": results})
    db.commit()
    return {"results": results}


class BulkUnassignIn(BaseModel):
    day: date


@admin_router.post("/bulk/unassign")
def bulk_unassign(payload: BulkUnassignIn, user: AuthUser = Depends(require_roles(UserRole.ADMIN, UserRole.DISPATCHER)), db: Session = Depends(db_dep)):
    loads = db.execute(select(Load).where(Load.tenant_id == user.tenant_id, Load.route_date == payload.day, Load.status != LoadStatus.DELIVERED)).scalars().all()
    for load in loads:
        load.driver_user_id = None
    log_event(db, user.tenant_id, "ops.bulk_unassign", "api", payload.model_dump(mode="json"))
    db.commit()
    return {"updated": len(loads)}
