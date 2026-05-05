import csv
import io
import re
from collections import defaultdict
from zoneinfo import ZoneInfo

EASTERN = ZoneInfo("America/New_York")
from datetime import date, datetime, time, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel
from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.orm import Session

from app.api.deps import AuthUser, db_dep, require_roles
from app.api.guardrails import CapacityMutationContext, assert_drop_load_invariants, mutate_capacity_or_409
from app.api.services import enqueue_sms_job, log_event, now_utc
from app.billing.service import ensure_billing_account, get_plan
from app.models.entities import (
    BlackoutReason,
    CapacityHold,
    CapacityOverride,
    CustomerAddress,
    Drop,
    EventLog,
    Load,
    Location,
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


def is_window_blacked_out(db: Session, tenant_id, location_id, day: date, window: WindowCode) -> bool:
    row = db.execute(
        select(OperationalBlackout.id).where(
            OperationalBlackout.tenant_id == tenant_id,
            OperationalBlackout.location_id == location_id,
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


def _date_range(start_date: date, end_date: date) -> tuple[datetime, datetime]:
    if end_date < start_date:
        raise HTTPException(status_code=400, detail={"code": "invalid_date_range", "message": "end_date must be greater than or equal to start_date"})
    start_dt = datetime.combine(start_date, time.min, tzinfo=timezone.utc)
    end_dt = datetime.combine(end_date, time.max, tzinfo=timezone.utc)
    return start_dt, end_dt


def _normalize_address(line1: str, city: str, state: str, postal_code: str) -> str:
    raw = f"{line1} {city} {state} {postal_code}".strip().lower()
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\s]", "", raw)).strip()


def _csv_response(filename: str, headers: list[str], rows: list[list[str | int | None]]) -> Response:
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(headers)
    writer.writerows(rows)
    return Response(content=out.getvalue(), media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@router.get("/reports/capacity-utilization")
def capacity_utilization_report(start_date: date, end_date: date, user: AuthUser = Depends(require_roles(UserRole.DISPATCHER, UserRole.ADMIN)), db: Session = Depends(db_dep)):
    _date_range(start_date, end_date)
    caps = db.execute(
        select(WindowCapacity.service_date, WindowCapacity.window_code, WindowCapacity.capacity_total, WindowCapacity.capacity_used)
        .where(WindowCapacity.tenant_id == user.tenant_id, WindowCapacity.service_date >= start_date, WindowCapacity.service_date <= end_date)
        .order_by(WindowCapacity.service_date.asc(), WindowCapacity.window_code.asc())
    ).all()
    holds_expired_rows = db.execute(
        select(CapacityHold.service_date, CapacityHold.window_code, func.coalesce(func.sum(CapacityHold.units_held), 0))
        .where(
            CapacityHold.tenant_id == user.tenant_id,
            CapacityHold.service_date >= start_date,
            CapacityHold.service_date <= end_date,
            CapacityHold.expires_at <= now_utc(),
            CapacityHold.converted_at.is_(None),
        )
        .group_by(CapacityHold.service_date, CapacityHold.window_code)
    ).all()
    expired_lookup = {(d, w): int(v or 0) for d, w, v in holds_expired_rows}

    per_day: dict[str, dict] = defaultdict(lambda: {"total_capacity": 0, "capacity_used": 0, "holds_expired_slots": 0})
    per_window = []
    for day, window, total, used in caps:
        exp = expired_lookup.get((day, window), 0)
        day_key = str(day)
        per_day[day_key]["total_capacity"] += int(total)
        per_day[day_key]["capacity_used"] += int(used)
        per_day[day_key]["holds_expired_slots"] += exp
        per_window.append({"date": day_key, "window": window.value, "capacity_total": int(total), "capacity_used": int(used), "holds_expired_slots": exp})

    return {
        "totals": {
            "total_capacity": sum(p["total_capacity"] for p in per_day.values()),
            "capacity_used": sum(p["capacity_used"] for p in per_day.values()),
            "holds_expired_slots": sum(p["holds_expired_slots"] for p in per_day.values()),
        },
        "per_day": [{"date": d, **v} for d, v in sorted(per_day.items())],
        "per_window": per_window,
    }

@router.get("/reports/summary")
def summary_report(
    start_date: date,
    end_date: date,
    location_id: str | None = Query(default=None),
    mode: str = Query(default="booked"),  # "booked" = created_at, "fulfilled" = scheduled_date
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER, UserRole.ADMIN)),
    db: Session = Depends(db_dep),
):
    _date_range(start_date, end_date)

    if mode == "fulfilled":
        start_dt = datetime.combine(start_date, time.min, tzinfo=EASTERN)
        end_dt = datetime.combine(end_date, time.max, tzinfo=EASTERN)
        drop_filters = [
            Drop.tenant_id == user.tenant_id,
            Drop.status != "cancelled",
            or_(
                and_(Drop.delivery_method == "delivery", Drop.scheduled_date >= start_date, Drop.scheduled_date <= end_date),
                and_(Drop.delivery_method == "pickup", Drop.fulfilled_at >= start_dt, Drop.fulfilled_at <= end_dt),
            ),
        ]
    else:
        start_dt = datetime.combine(start_date, time.min, tzinfo=EASTERN)
        end_dt = datetime.combine(end_date, time.max, tzinfo=EASTERN)
        drop_filters = [
            Drop.tenant_id == user.tenant_id,
            Drop.created_at >= start_dt,
            Drop.created_at <= end_dt,
            Drop.status != "cancelled",
        ]
    if location_id:
        drop_filters.append(Drop.location_id == location_id)

    drops = db.execute(
        select(Drop).where(*drop_filters)
    ).scalars().all()

    drop_ids = [d.id for d in drops]

    # Revenue totals
    total_revenue = sum(float(d.order_total) for d in drops if d.order_total is not None)
    cash_total = sum(float(d.order_total) for d in drops if d.order_total is not None and d.payment_method == "cash")

    # Delivery vs pickup
    delivery_count = sum(1 for d in drops if d.delivery_method == "delivery")
    pickup_count = sum(1 for d in drops if d.delivery_method == "pickup")

    # Order count by payment method
    payment_breakdown: dict[str, dict] = {}
    for d in drops:
        pm = d.payment_method or "unknown"
        if pm not in payment_breakdown:
            payment_breakdown[pm] = {"count": 0, "total": 0.0}
        payment_breakdown[pm]["count"] += 1
        if d.order_total is not None:
            payment_breakdown[pm]["total"] += float(d.order_total)

    # Yards by product (from loads)
    yards_by_product: dict[str, float] = {}
    if drop_ids:
        load_rows = db.execute(
            select(Load.material_name_snapshot, func.sum(Load.qty))
            .where(
                Load.tenant_id == user.tenant_id,
                Load.drop_id.in_(drop_ids),
                Load.status != LoadStatus.CANCELLED,
            )
            .group_by(Load.material_name_snapshot)
        ).all()
        yards_by_product = {name: float(qty) for name, qty in load_rows if name}

    total_yards = sum(yards_by_product.values())

    return {
        "start_date": str(start_date),
        "end_date": str(end_date),
        "order_count": len(drops),
        "total_revenue": round(total_revenue, 2),
        "cash_total": round(cash_total, 2),
        "total_yards": round(total_yards, 1),
        "delivery_count": delivery_count,
        "pickup_count": pickup_count,
        "yards_by_product": yards_by_product,
        "payment_breakdown": [
            {"method": k, "count": v["count"], "total": round(v["total"], 2)}
            for k, v in sorted(payment_breakdown.items(), key=lambda x: x[1]["total"], reverse=True)
        ],
    }
    

@router.get("/reports/throughput")
def throughput_report(start_date: date, end_date: date, window: WindowCode | None = Query(default=None), driver_user_id: str | None = Query(default=None), material: str | None = Query(default=None), location_id: str | None = Query(default=None), user: AuthUser = Depends(require_roles(UserRole.DISPATCHER, UserRole.ADMIN)), db: Session = Depends(db_dep)):
    _date_range(start_date, end_date)
    drop_filters = [Drop.tenant_id == user.tenant_id, Drop.scheduled_date >= start_date, Drop.scheduled_date <= end_date]
    if location_id:
        drop_filters.append(Drop.location_id == location_id)
    drop_counts = db.execute(
        select(Drop.scheduled_date, func.count(Drop.id))
        .where(*drop_filters)
        .group_by(Drop.scheduled_date)
    ).all()
    load_filters = [Load.tenant_id == user.tenant_id, Load.route_date >= start_date, Load.route_date <= end_date]
    if location_id:
        load_filters.append(Load.drop_id.in_(select(Drop.id).where(*drop_filters)))
    if window:
        load_filters.append(Load.route_window == window)
    if driver_user_id:
        load_filters.append(Load.driver_user_id == driver_user_id)
    if material:
        load_filters.append(Load.material_name_snapshot == material)

    load_counts = db.execute(
        select(
            Load.route_date,
            func.count(Load.id),
            func.sum(case((Load.status == LoadStatus.DELIVERED, 1), else_=0)),
            func.sum(case((Load.status == LoadStatus.EXCEPTION, 1), else_=0)),
            func.sum(case((Load.status == LoadStatus.CANCELLED, 1), else_=0)),
        )
        .where(*load_filters)
        .group_by(Load.route_date)
    ).all()
    drop_map = {str(d): int(c) for d, c in drop_counts}
    load_map = {str(d): (int(total), int(delivered or 0), int(exceptioned or 0), int(cancelled or 0)) for d, total, delivered, exceptioned, cancelled in load_counts}

    current = start_date
    per_day = []
    while current <= end_date:
        key = str(current)
        created, delivered, exceptioned, cancelled = load_map.get(key, (0, 0, 0, 0))
        per_day.append({
            "date": key,
            "drops_created": drop_map.get(key, 0),
            "loads_created": created,
            "loads_delivered": delivered,
            "loads_exceptioned": exceptioned,
            "loads_cancelled": cancelled,
        })
        current = current.fromordinal(current.toordinal() + 1)
    return {"per_day": per_day}


@router.get("/reports/exceptions")
def exceptions_report(start_date: date, end_date: date, include_recent: bool = Query(default=True), user: AuthUser = Depends(require_roles(UserRole.DISPATCHER, UserRole.ADMIN)), db: Session = Depends(db_dep)):
    _date_range(start_date, end_date)
    exception_filters = [Load.tenant_id == user.tenant_id, Load.route_date >= start_date, Load.route_date <= end_date, Load.status == LoadStatus.EXCEPTION]
    per_day = db.execute(select(Load.route_date, func.count(Load.id)).where(*exception_filters).group_by(Load.route_date)).all()
    by_reason = db.execute(select(Load.exception_reason_code, func.count(Load.id)).where(*exception_filters).group_by(Load.exception_reason_code)).all()
    by_address_rows = db.execute(
        select(CustomerAddress.line1, CustomerAddress.city, CustomerAddress.state, CustomerAddress.postal_code, func.count(Load.id))
        .join(Drop, Drop.id == Load.drop_id)
        .join(CustomerAddress, CustomerAddress.id == Drop.address_id)
        .where(*exception_filters)
        .group_by(CustomerAddress.line1, CustomerAddress.city, CustomerAddress.state, CustomerAddress.postal_code)
    ).all()
    normalized: dict[str, int] = defaultdict(int)
    for line1, city, state, postal, count in by_address_rows:
        normalized[_normalize_address(line1 or "", city or "", state or "", postal or "")] += int(count)

    recent_exceptions = []
    if include_recent:
        events = db.execute(
            select(EventLog.created_at, EventLog.payload_json)
            .where(
                EventLog.tenant_id == user.tenant_id,
                EventLog.event_type == "LOAD_STATUS_CHANGED",
                EventLog.created_at >= datetime.combine(start_date, time.min, tzinfo=timezone.utc),
                EventLog.created_at <= datetime.combine(end_date, time.max, tzinfo=timezone.utc),
            )
            .order_by(EventLog.created_at.desc())
            .limit(200)
        ).all()
        exception_load_ids = [
            (payload or {}).get("load_id")
            for created, payload in events
            if (payload or {}).get("status") == LoadStatus.EXCEPTION.value
        ]
        load_drop_map = {}
        customer_map = {}
        reason_map = {}
        if exception_load_ids:
            load_rows = db.execute(
                select(Load.id, Load.drop_id, Load.exception_reason_code)
                .where(Load.tenant_id == user.tenant_id, Load.id.in_([lid for lid in exception_load_ids if lid]))
            ).all()
            for lid, did, reason in load_rows:
                load_drop_map[str(lid)] = str(did)
                reason_map[str(lid)] = reason.value if reason else None
            drop_ids = list(load_drop_map.values())
            if drop_ids:
                cust_rows = db.execute(
                    select(Drop.id, Customer.name)
                    .join(Customer, Customer.id == Drop.customer_id)
                    .where(Drop.tenant_id == user.tenant_id, Drop.id.in_(drop_ids))
                ).all()
                for did, cname in cust_rows:
                    customer_map[str(did)] = cname

        recent_exceptions = []
        for created, payload in events:
            if (payload or {}).get("status") != LoadStatus.EXCEPTION.value:
                continue
            load_id = (payload or {}).get("load_id")
            drop_id = load_drop_map.get(load_id) if load_id else None
            customer_name = customer_map.get(drop_id) if drop_id else None
            reason = reason_map.get(load_id) if load_id else None
            recent_exceptions.append({
                "timestamp": created.isoformat(),
                "load_id": load_id,
                "drop_id": drop_id,
                "customer_name": customer_name,
                "reason_code": reason,
                "notes": (payload or {}).get("exception_notes"),
            })
            if len(recent_exceptions) >= 20:
                break

    return {
        "exceptions_per_day": [{"date": str(d), "count": int(c)} for d, c in per_day],
        "exceptions_by_reason_code": [{"reason_code": (r.value if r else "unknown"), "count": int(c)} for r, c in by_reason],
        "top_exception_addresses": [{"normalized_address": addr, "count": count} for addr, count in sorted(normalized.items(), key=lambda x: x[1], reverse=True)[:20]],
        "recent_exceptions": recent_exceptions,
    }


@router.get("/reports/timing-signals")
def timing_signals_report(start_date: date, end_date: date, user: AuthUser = Depends(require_roles(UserRole.DISPATCHER, UserRole.ADMIN)), db: Session = Depends(db_dep)):
    _date_range(start_date, end_date)
    events = _event_times(db, user.tenant_id, start_date, end_date)
    loads = db.execute(select(Load.id, Load.route_date, Load.route_window).where(Load.tenant_id == user.tenant_id, Load.route_date >= start_date, Load.route_date <= end_date)).all()
    per_day: dict[str, dict[str, list[float]]] = defaultdict(lambda: {"start_to_leave": [], "leave_to_delivered": []})
    for load_id, route_date, route_window in loads:
        evt = events.get(str(load_id), {})
        leave_time = evt.get("loaded_leaving")
        delivered_time = evt.get("delivered")
        if not leave_time:
            continue
        window_start = datetime.combine(route_date, time(hour=13 if route_window == WindowCode.B else 9), tzinfo=timezone.utc)
        per_day[str(route_date)]["start_to_leave"].append((leave_time - window_start).total_seconds())
        if delivered_time:
            per_day[str(route_date)]["leave_to_delivered"].append((delivered_time - leave_time).total_seconds())

    def stats(values: list[float]) -> dict:
        if not values:
            return {"avg_seconds": None, "min_seconds": None, "median_seconds": None, "max_seconds": None}
        sorted_vals = sorted(values)
        mid = len(sorted_vals) // 2
        median = sorted_vals[mid] if len(sorted_vals) % 2 == 1 else (sorted_vals[mid - 1] + sorted_vals[mid]) / 2
        return {
            "avg_seconds": sum(sorted_vals) / len(sorted_vals),
            "min_seconds": sorted_vals[0],
            "median_seconds": median,
            "max_seconds": sorted_vals[-1],
        }

    return {
        "per_day": [
            {
                "date": day,
                "window_start_to_loaded_leaving": stats(values["start_to_leave"]),
                "loaded_leaving_to_delivered": stats(values["leave_to_delivered"]),
            }
            for day, values in sorted(per_day.items())
        ]
    }


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
    _date_range(start_date, end_date)
    rows = db.execute(select(Load).where(Load.tenant_id == user.tenant_id, Load.route_date >= start_date, Load.route_date <= end_date)).scalars().all()
    return _csv_response(
        "loads.csv",
        ["id", "drop_id", "route_date", "window", "status", "driver_user_id", "material", "qty", "unit", "created_at", "updated_at"],
        [[str(r.id), str(r.drop_id), str(r.route_date), r.route_window.value, r.status.value, str(r.driver_user_id or ""), r.material_name_snapshot, r.qty, r.unit, r.created_at.isoformat() if r.created_at else "", r.updated_at.isoformat() if r.updated_at else ""] for r in rows],
    )


@router.get("/reports/drops.csv")
def export_drops_csv(start_date: date, end_date: date, user: AuthUser = Depends(require_roles(UserRole.DISPATCHER, UserRole.ADMIN)), db: Session = Depends(db_dep)):
    _date_range(start_date, end_date)
    rows = db.execute(
        select(Drop, Customer, CustomerAddress)
        .join(Customer, Customer.id == Drop.customer_id)
        .join(CustomerAddress, CustomerAddress.id == Drop.address_id)
        .where(Drop.tenant_id == user.tenant_id, Drop.scheduled_date >= start_date, Drop.scheduled_date <= end_date)
    ).all()
    return _csv_response(
        "drops.csv",
        ["id", "customer", "address", "city", "state", "postal_code", "scheduled_date", "window", "required_loads", "notes"],
        [
            [str(drop.id), customer.name, address.line1, address.city, address.state, address.postal_code, str(drop.scheduled_date), drop.scheduled_window.value, db.execute(select(func.count(Load.id)).where(Load.tenant_id == user.tenant_id, Load.drop_id == drop.id)).scalar_one(), drop.notes or ""]
            for drop, customer, address in rows
        ],
    )


@router.get("/reports/exceptions.csv")
def export_exceptions_csv(start_date: date, end_date: date, user: AuthUser = Depends(require_roles(UserRole.DISPATCHER, UserRole.ADMIN)), db: Session = Depends(db_dep)):
    _date_range(start_date, end_date)
    rows = db.execute(select(Load).where(Load.tenant_id == user.tenant_id, Load.route_date >= start_date, Load.route_date <= end_date, Load.status == LoadStatus.EXCEPTION)).scalars().all()
    return _csv_response(
        "exceptions.csv",
        ["id", "drop_id", "route_date", "window", "reason", "notes", "photos_present"],
        [[str(r.id), str(r.drop_id), str(r.route_date), r.route_window.value, (r.exception_reason_code.value if r.exception_reason_code else ""), (r.exception_notes or ""), bool(r.exception_photo_url)] for r in rows],
    )
class BlackoutIn(BaseModel):
    service_date: date
    window_code: WindowCode | None = None
    reason_code: BlackoutReason
    reason_note: str | None = None
    location_id: str | None = None  # Required for multi-location; defaults to tenant's first active location


@admin_router.get("/blackouts")
def list_blackouts(
    start_date: date | None = Query(default=None),
    end_date: date | None = Query(default=None),
    location_id: str | None = Query(default=None),
    user: AuthUser = Depends(require_roles(UserRole.ADMIN)),
    db: Session = Depends(db_dep),
):
    q = select(OperationalBlackout).where(OperationalBlackout.tenant_id == user.tenant_id)
    if start_date:
        q = q.where(OperationalBlackout.service_date >= start_date)
    if end_date:
        q = q.where(OperationalBlackout.service_date <= end_date)
    if location_id:
        q = q.where(OperationalBlackout.location_id == location_id)
    rows = db.execute(q.order_by(OperationalBlackout.service_date.asc())).scalars().all()
    return {"blackouts": [{"id": str(r.id), "service_date": str(r.service_date), "window_code": r.window_code.value if r.window_code else None, "reason_code": r.reason_code.value, "reason_note": r.reason_note, "active": r.active, "location_id": str(r.location_id)} for r in rows]}


@admin_router.post("/blackouts")
def create_blackout(payload: BlackoutIn, user: AuthUser = Depends(require_roles(UserRole.ADMIN)), db: Session = Depends(db_dep)):
    # Resolve location
    if payload.location_id:
        location = db.execute(
            select(Location).where(Location.id == payload.location_id, Location.tenant_id == user.tenant_id)
        ).scalar_one_or_none()
        if not location:
            raise HTTPException(status_code=404, detail={"code": "location_not_found", "message": "Location not found"})
    else:
        location = db.execute(
            select(Location).where(Location.tenant_id == user.tenant_id, Location.is_active == True)  # noqa: E712
            .order_by(Location.created_at)
        ).scalars().first()
        if not location:
            raise HTTPException(status_code=400, detail={"code": "no_location", "message": "No active location found"})

    existing = db.execute(
        select(OperationalBlackout).where(
            OperationalBlackout.tenant_id == user.tenant_id,
            OperationalBlackout.location_id == location.id,
            OperationalBlackout.service_date == payload.service_date,
            OperationalBlackout.window_code == payload.window_code,
        )
    ).scalar_one_or_none()
    if existing:
        existing.active = True
        existing.reason_code = payload.reason_code
        existing.reason_note = payload.reason_note
        event_type = "WINDOW_ENABLED" if payload.window_code else "BLACKOUT_CREATED"
    else:
        data = payload.model_dump(exclude={"location_id"})
        db.add(OperationalBlackout(tenant_id=user.tenant_id, location_id=location.id, **data))
        event_type = "WINDOW_DISABLED" if payload.window_code else "BLACKOUT_CREATED"
    log_event(db, user.tenant_id, event_type, "api", {**payload.model_dump(mode="json"), "location_id": str(location.id)})
    db.commit()
    return {"status": "ok"}


@admin_router.delete("/blackouts/{blackout_id}")
@admin_router.delete("/blackouts/{blackout_id}")
def remove_blackout(blackout_id: str, user: AuthUser = Depends(require_roles(UserRole.ADMIN)), db: Session = Depends(db_dep)):
    blackout = db.execute(select(OperationalBlackout).where(OperationalBlackout.tenant_id == user.tenant_id, OperationalBlackout.id == blackout_id)).scalar_one_or_none()
    if not blackout:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Blackout not found"})
    blackout.active = False
    log_event(db, user.tenant_id, "WINDOW_ENABLED" if blackout.window_code else "BLACKOUT_REMOVED", "api", {"blackout_id": blackout_id, "service_date": str(blackout.service_date), "window_code": blackout.window_code.value if blackout.window_code else None})
    db.commit()
    return {"status": "ok"}


# ── Capacity override endpoints ──────────────────────────────────────────────

class CapacityOverrideIn(BaseModel):
    start_date: date
    end_date: date
    window_a_capacity: int
    window_b_capacity: int
    label: str | None = None
    location_id: str | None = None


@admin_router.get("/capacity-overrides")
def list_capacity_overrides(
    location_id: str | None = Query(default=None),
    user: AuthUser = Depends(require_roles(UserRole.ADMIN)),
    db: Session = Depends(db_dep),
):
    q = select(CapacityOverride).where(CapacityOverride.tenant_id == user.tenant_id)
    if location_id:
        q = q.where(CapacityOverride.location_id == location_id)
    rows = db.execute(q.order_by(CapacityOverride.start_date.asc(), CapacityOverride.created_at.desc())).scalars().all()
    return {
        "overrides": [
            {
                "id": str(r.id),
                "location_id": str(r.location_id),
                "start_date": str(r.start_date),
                "end_date": str(r.end_date),
                "window_a_capacity": r.window_a_capacity,
                "window_b_capacity": r.window_b_capacity,
                "label": r.label,
                "created_at": r.created_at.isoformat(),
            }
            for r in rows
        ]
    }


@admin_router.post("/capacity-overrides")
def create_capacity_override(
    payload: CapacityOverrideIn,
    user: AuthUser = Depends(require_roles(UserRole.ADMIN)),
    db: Session = Depends(db_dep),
):
    if payload.end_date < payload.start_date:
        raise HTTPException(status_code=400, detail={"code": "invalid_range", "message": "end_date must be on or after start_date"})

    if payload.location_id:
        location = db.execute(
            select(Location).where(Location.id == payload.location_id, Location.tenant_id == user.tenant_id)
        ).scalar_one_or_none()
        if not location:
            raise HTTPException(status_code=404, detail={"code": "location_not_found", "message": "Location not found"})
    else:
        location = db.execute(
            select(Location)
            .where(Location.tenant_id == user.tenant_id, Location.is_active == True)  # noqa: E712
            .order_by(Location.created_at)
        ).scalars().first()
        if not location:
            raise HTTPException(status_code=400, detail={"code": "no_location", "message": "No active location found"})

    override = CapacityOverride(
        tenant_id=user.tenant_id,
        location_id=location.id,
        start_date=payload.start_date,
        end_date=payload.end_date,
        window_a_capacity=payload.window_a_capacity,
        window_b_capacity=payload.window_b_capacity,
        label=payload.label,
    )
    db.add(override)

    # Apply override as source of truth: upsert WindowCapacity rows for every date in range
    current = payload.start_date
    while current <= payload.end_date:
        for window_code, cap_val in [(WindowCode.A, payload.window_a_capacity), (WindowCode.B, payload.window_b_capacity)]:
            existing = db.execute(
                select(WindowCapacity).where(
                    WindowCapacity.tenant_id == user.tenant_id,
                    WindowCapacity.location_id == location.id,
                    WindowCapacity.service_date == current,
                    WindowCapacity.window_code == window_code,
                )
            ).scalar_one_or_none()
            if existing:
                existing.capacity_total = cap_val
            else:
                db.add(WindowCapacity(
                    tenant_id=user.tenant_id,
                    location_id=location.id,
                    service_date=current,
                    window_code=window_code,
                    capacity_total=cap_val,
                    capacity_used=0,
                ))
        current = current + timedelta(days=1)

    log_event(db, user.tenant_id, "CAPACITY_OVERRIDE_CREATED", "api", {
        "location_id": str(location.id),
        "start_date": str(payload.start_date),
        "end_date": str(payload.end_date),
        "window_a_capacity": payload.window_a_capacity,
        "window_b_capacity": payload.window_b_capacity,
    })
    db.commit()
    return {"status": "ok"}


@admin_router.delete("/capacity-overrides/{override_id}")
def delete_capacity_override(
    override_id: str,
    user: AuthUser = Depends(require_roles(UserRole.ADMIN)),
    db: Session = Depends(db_dep),
):
    override = db.execute(
        select(CapacityOverride).where(
            CapacityOverride.id == override_id,
            CapacityOverride.tenant_id == user.tenant_id,
        )
    ).scalar_one_or_none()
    if not override:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Override not found"})

    location = db.execute(select(Location).where(Location.id == override.location_id)).scalar_one_or_none()
    default_cap = location.capacity_per_window if location else 4

    current = override.start_date
    while current <= override.end_date:
        for window_code in [WindowCode.A, WindowCode.B]:
            existing = db.execute(
                select(WindowCapacity).where(
                    WindowCapacity.tenant_id == user.tenant_id,
                    WindowCapacity.location_id == override.location_id,
                    WindowCapacity.service_date == current,
                    WindowCapacity.window_code == window_code,
                )
            ).scalar_one_or_none()
            if existing and existing.capacity_used == 0:
                db.delete(existing)
            elif existing:
                existing.capacity_total = max(existing.capacity_used, default_cap)
        current = current + timedelta(days=1)

    db.delete(override)
    log_event(db, user.tenant_id, "CAPACITY_OVERRIDE_DELETED", "api", {
        "override_id": override_id,
        "location_id": str(override.location_id),
        "start_date": str(override.start_date),
        "end_date": str(override.end_date),
    })
    db.commit()
    return {"status": "ok"}


@admin_router.get("/base-capacity")
def get_base_capacity(
    location_id: str | None = Query(default=None),
    user: AuthUser = Depends(require_roles(UserRole.ADMIN)),
    db: Session = Depends(db_dep),
):
    if location_id:
        location = db.execute(
            select(Location).where(Location.id == location_id, Location.tenant_id == user.tenant_id)
        ).scalar_one_or_none()
    else:
        location = db.execute(
            select(Location)
            .where(Location.tenant_id == user.tenant_id, Location.is_active == True)  # noqa: E712
            .order_by(Location.created_at)
        ).scalars().first()

    if not location:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Location not found"})

    return {
        "location_id": str(location.id),
        "location_name": location.name,
        "capacity_per_window": location.capacity_per_window,
    }


class BaseCapacityIn(BaseModel):
    capacity_per_window: int
    location_id: str | None = None


@admin_router.put("/base-capacity")
def update_base_capacity(
    payload: BaseCapacityIn,
    user: AuthUser = Depends(require_roles(UserRole.ADMIN)),
    db: Session = Depends(db_dep),
):
    if payload.capacity_per_window < 1:
        raise HTTPException(status_code=400, detail={"code": "invalid_value", "message": "Capacity must be at least 1"})

    if payload.location_id:
        location = db.execute(
            select(Location).where(Location.id == payload.location_id, Location.tenant_id == user.tenant_id)
        ).scalar_one_or_none()
    else:
        location = db.execute(
            select(Location)
            .where(Location.tenant_id == user.tenant_id, Location.is_active == True)  # noqa: E712
            .order_by(Location.created_at)
        ).scalars().first()

    if not location:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Location not found"})

    location.capacity_per_window = payload.capacity_per_window

    from datetime import timedelta
    from zoneinfo import ZoneInfo
    from app.models.entities import CapacityOverride
    today = datetime.now(ZoneInfo("America/New_York")).date()

    overrides = db.execute(
        select(CapacityOverride).where(
            CapacityOverride.tenant_id == user.tenant_id,
            CapacityOverride.location_id == location.id,
            CapacityOverride.end_date >= today,
        )
    ).scalars().all()

    overridden_dates: set[tuple] = set()
    for ov in overrides:
        cur = max(ov.start_date, today)
        while cur <= ov.end_date:
            overridden_dates.add((cur, "A"))
            overridden_dates.add((cur, "B"))
            cur = cur + timedelta(days=1)

    future_caps = db.execute(
        select(WindowCapacity).where(
            WindowCapacity.tenant_id == user.tenant_id,
            WindowCapacity.location_id == location.id,
            WindowCapacity.service_date >= today,
        )
    ).scalars().all()

    updated = 0
    for cap in future_caps:
        if (cap.service_date, cap.window_code.value) not in overridden_dates:
            cap.capacity_total = max(cap.capacity_used, payload.capacity_per_window)
            updated += 1

    log_event(db, user.tenant_id, "BASE_CAPACITY_UPDATED", "api", {
        "location_id": str(location.id),
        "capacity_per_window": payload.capacity_per_window,
        "window_capacity_rows_updated": updated,
    })
    db.commit()
    return {"status": "ok", "capacity_per_window": payload.capacity_per_window}


@admin_router.get("/diagnostics/anomalies")
def anomalies(auto_fix: bool = Query(default=True), location_id: str | None = Query(default=None), user: AuthUser = Depends(require_roles(UserRole.ADMIN, UserRole.DISPATCHER)), db: Session = Depends(db_dep)):
    anomalies_out = []

    # Resolve location filter
    loc_id = None
    if location_id:
        loc = db.execute(
            select(Location).where(Location.id == location_id, Location.tenant_id == user.tenant_id)
        ).scalar_one_or_none()
        if loc:
            loc_id = loc.id

    cap_q = select(WindowCapacity).where(WindowCapacity.tenant_id == user.tenant_id, WindowCapacity.capacity_used > WindowCapacity.capacity_total)
    if loc_id:
        cap_q = cap_q.where(WindowCapacity.location_id == loc_id)
    cap_violations = db.execute(cap_q).scalars().all()
    for cap in cap_violations:
        anomalies_out.append({"type": "capacity_overrun", "service_date": str(cap.service_date), "window": cap.window_code.value, "capacity_used": cap.capacity_used, "capacity_total": cap.capacity_total})

    drop_q = (
        select(Drop.id, Drop.scheduled_date, Drop.scheduled_window)
        .where(Drop.tenant_id == user.tenant_id)
        .where(Drop.delivery_method == "delivery")
        .where(Drop.scheduled_date.isnot(None))
        .where(~Drop.id.in_(select(Load.drop_id).where(Load.tenant_id == user.tenant_id)))
    )
    if loc_id:
        drop_q = drop_q.where(Drop.location_id == loc_id)
    drops_with_zero_loads = db.execute(drop_q).all()
    for drop_id, scheduled_date, scheduled_window in drops_with_zero_loads:
        anomalies_out.append({"type": "drop_without_loads", "drop_id": str(drop_id), "scheduled_date": str(scheduled_date), "scheduled_window": scheduled_window.value if scheduled_window else None})

    now = now_utc()
    try:
        tenant = db.execute(select(Tenant).where(Tenant.id == user.tenant_id)).scalar_one()
        tz = ZoneInfo(tenant.timezone)
        window_ends = {
            WindowCode.A: datetime.combine(datetime.today(), tenant.windowA_end, tzinfo=tz),
            WindowCode.B: datetime.combine(datetime.today(), tenant.windowB_end, tzinfo=tz),
        }
    except Exception:
        tz = timezone.utc
        window_ends = {
            WindowCode.A: datetime.combine(datetime.today(), time(13, 0), tzinfo=tz),
            WindowCode.B: datetime.combine(datetime.today(), time(17, 0), tzinfo=tz),
        }
    assigned_q = (
        select(Load).join(Drop, Drop.id == Load.drop_id)
        .where(Load.tenant_id == user.tenant_id, Load.status == LoadStatus.ASSIGNED, Drop.is_priority == False)
    )
    if loc_id:
        assigned_q = assigned_q.where(Drop.location_id == loc_id)
    assigned = db.execute(assigned_q).scalars().all()
    for load in assigned:
        if not load.route_date or not load.route_window:
            continue
        window_end = datetime.combine(load.route_date, window_ends[load.route_window].timetz(), tzinfo=tz)
        if window_end < now:
            anomalies_out.append({"type": "load_stuck_assigned", "load_id": str(load.id), "drop_id": str(load.drop_id), "route_date": str(load.route_date), "route_window": load.route_window.value, "status": load.status.value})

    holds_q = select(CapacityHold).where(
        CapacityHold.tenant_id == user.tenant_id,
        CapacityHold.expires_at <= now,
        CapacityHold.converted_at.is_(None),
        CapacityHold.released_at.is_(None),
    )
    if loc_id:
        holds_q = holds_q.where(CapacityHold.location_id == loc_id)
    expired_holds = db.execute(holds_q).scalars().all()
    fixed = 0
    for hold in expired_holds:
        if auto_fix:
            hold.released_at = now
            fixed += 1
            log_event(db, user.tenant_id, "AUTO_FIX_APPLIED", "api", {"type": "expired_hold_released", "hold_token": hold.hold_token})
    for hold in expired_holds:
        anomalies_out.append({"type": "expired_hold_not_released", "hold_token": hold.hold_token, "service_date": str(hold.service_date), "window": hold.window_code.value, "auto_fixed": auto_fix})
    db.commit()
    return {"anomalies": anomalies_out, "auto_fix_applied": fixed}



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
    confirm: bool = False


@admin_router.post("/bulk/reschedule")
def bulk_reschedule(payload: BulkRescheduleIn, user: AuthUser = Depends(require_roles(UserRole.ADMIN, UserRole.DISPATCHER)), db: Session = Depends(db_dep)):
    if not payload.confirm:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "confirmation_required",
                "message": "Bulk reschedule was not started because confirmation is required.",
                "next_step": "Retry with confirm=true after reviewing the selected drops.",
            },
        )
    if not payload.drop_ids:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "empty_selection",
                "message": "Bulk reschedule was not started because no drops were selected.",
                "next_step": "Select at least one drop and retry.",
            },
        )
    if len(set(payload.drop_ids)) != len(payload.drop_ids):
        raise HTTPException(
            status_code=409,
            detail={
                "code": "ambiguous_selection",
                "message": "Bulk reschedule was not started because the request included duplicate drop ids.",
                "next_step": "Remove duplicates from selection and retry.",
            },
        )
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
                location_id=str(drop.location_id),
            )
            mutate_capacity_or_409(
                db,
                user.tenant_id,
                drop.scheduled_date,
                drop.scheduled_window,
                -load_count,
                CapacityMutationContext(source="api", reason="bulk_reschedule_release", reference_id=drop_id),
                location_id=str(drop.location_id),
            )
            drop.scheduled_date = payload.scheduled_date
            drop.scheduled_window = payload.scheduled_window
            for l in loads:
                l.route_date = payload.scheduled_date
                l.route_window = payload.scheduled_window
            results.append({"drop_id": drop_id, "status": "ok"})
        except HTTPException as exc:
            db.rollback()
            results.append({"drop_id": drop_id, "status": "failed", "reason": exc.detail.get("code", "error"), "message": exc.detail.get("message")})
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
    confirm: bool = False


@admin_router.post("/bulk/unassign")
def bulk_unassign(payload: BulkUnassignIn, user: AuthUser = Depends(require_roles(UserRole.ADMIN, UserRole.DISPATCHER)), db: Session = Depends(db_dep)):
    if not payload.confirm:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "confirmation_required",
                "message": "Bulk unassign was not started because confirmation is required.",
                "next_step": "Retry with confirm=true after reviewing affected drivers and loads.",
            },
        )
    loads = db.execute(select(Load).where(Load.tenant_id == user.tenant_id, Load.route_date == payload.day, Load.status != LoadStatus.DELIVERED)).scalars().all()
    for load in loads:
        load.driver_user_id = None
    log_event(db, user.tenant_id, "ops.bulk_unassign", "api", payload.model_dump(mode="json"))
    db.commit()
    return {"updated": len(loads)}
