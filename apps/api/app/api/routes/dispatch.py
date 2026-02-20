import logging
from collections import defaultdict
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.api.deps import AuthUser, db_dep, require_roles
from app.api.dispatch_suggestions import (
    build_dispatch_suggestions,
    get_address_history,
    get_driver_performance_signals,
    invalidate_suggestion_cache,
)
from app.api.optimization import apply_proposal, generate_proposals, undo_proposal
from app.api.guardrails import guard_load_editable
from app.api.services import enqueue_sms_job, log_event, now_utc
from app.billing.service import ensure_billing_account, get_plan, scheduling_gate
from app.models.entities import Customer, CustomerAddress, Drop, Load, LoadStatus, OperationalBlackout, OptimizationProposal, Tenant, User, UserRole, WindowCapacity, WindowCode

router = APIRouter(prefix="/dispatch", tags=["dispatch"])
logger = logging.getLogger("dispatch.ops")


@router.get("/schedule")
def dispatch_schedule(day: date, user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)), db: Session = Depends(db_dep)):
    tenant = db.execute(select(Tenant).where(Tenant.id == user.tenant_id)).scalar_one()
    default_cap = tenant.capacity_per_window
    orphaned = db.execute(select(Load.id).where(Load.tenant_id == user.tenant_id, Load.route_date == day, ~Load.drop_id.in_(select(Drop.id)))).scalars().all()
    if orphaned:
        logger.error("orphaned_loads_detected", extra={"tenant_id": str(user.tenant_id), "count": len(orphaned)})
    caps = db.execute(select(WindowCapacity).where(WindowCapacity.tenant_id == user.tenant_id, WindowCapacity.service_date == day)).scalars().all()
    cap_map = {c.window_code.value: {"used": c.capacity_used, "total": c.capacity_total, "remaining_capacity": c.capacity_total - c.capacity_used} for c in caps}
    disabled_windows = set(
        code.value
        for code in db.execute(
            select(OperationalBlackout.window_code).where(
                OperationalBlackout.tenant_id == user.tenant_id,
                OperationalBlackout.service_date == day,
                OperationalBlackout.active.is_(True),
                or_(OperationalBlackout.window_code == WindowCode.A, OperationalBlackout.window_code == WindowCode.B),
            )
        ).scalars().all()
        if code
    )
    loads = db.execute(
        select(Load, Drop, User, Customer, CustomerAddress)
        .join(Drop, Drop.id == Load.drop_id)
        .outerjoin(User, User.id == Load.driver_user_id)
        .join(Customer, Customer.id == Drop.customer_id)
        .join(CustomerAddress, CustomerAddress.id == Drop.address_id)
        .where(Load.tenant_id == user.tenant_id, Load.route_date == day)
    ).all()

    by_window = {"A": defaultdict(list), "B": defaultdict(list)}
    for load, drop, driver, customer, address in loads:
        driver_display = driver.display_name if driver else "Unassigned"
        history = get_address_history(db, str(user.tenant_id), str(drop.address_id))

        # Build order reference
        if drop.external_order_id:
            order_ref = drop.external_order_id
        elif drop.order_number:
            order_ref = f"D-{drop.order_number:05d}"
        else:
            order_ref = str(drop.id)[:8].upper()

        addr_short = f"{address.line1}, {address.city}"

        by_window[load.route_window.value][driver_display].append(
            {
                "id": str(load.id),
                "drop_id": str(drop.id),
                "order_ref": order_ref,
                "status": load.status.value,
                "material": load.material_name_snapshot,
                "qty": load.qty,
                "unit": load.unit,
                "customer_name": customer.name,
                "customer_phone": customer.phone_e164,
                "address_short": addr_short,
                "driver_name": driver_display,
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
            "A": {"capacity": cap_map.get("A", {"used": 0, "total": default_cap, "remaining_capacity": default_cap}), "groups": by_window["A"], "disabled": "A" in disabled_windows},
            "B": {"capacity": cap_map.get("B", {"used": 0, "total": default_cap, "remaining_capacity": default_cap}), "groups": by_window["B"], "disabled": "B" in disabled_windows},
        },
    }


@router.get("/drivers")
def list_drivers(user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)), db: Session = Depends(db_dep)):
    drivers = db.execute(
        select(User).where(User.tenant_id == user.tenant_id, User.role == UserRole.DRIVER, User.is_active == True)  # noqa: E712
    ).scalars().all()
    return {"drivers": [{"id": str(d.id), "email": d.email, "name": d.display_name, "truck": d.default_truck_identifier} for d in drivers]}


@router.get("/drops/{drop_id}")
def drop_detail(drop_id: str, user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)), db: Session = Depends(db_dep)):
    row = db.execute(
        select(Drop, Customer).join(Customer, Customer.id == Drop.customer_id).where(Drop.tenant_id == user.tenant_id, Drop.id == drop_id)
    ).one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Drop not found"})
    drop, customer = row

    # Delivery address
    address = db.execute(select(CustomerAddress).where(CustomerAddress.id == drop.address_id)).scalar_one_or_none()
    addr_dict = None
    if address:
        addr_dict = {
            "line1": address.line1, "line2": address.line2,
            "city": address.city, "state": address.state, "postal_code": address.postal_code,
        }

    # Loads with driver info
    load_rows = db.execute(
        select(Load, User).outerjoin(User, User.id == Load.driver_user_id)
        .where(Load.tenant_id == user.tenant_id, Load.drop_id == drop.id)
    ).all()
    loads_out = []
    for ld, driver in load_rows:
        loads_out.append({
            "id": str(ld.id),
            "material": ld.material_name_snapshot,
            "qty": ld.qty,
            "unit": ld.unit,
            "status": ld.status.value,
            "driver_name": driver.display_name if driver else None,
            "driver_email": driver.email if driver else None,
        })

    # Build display reference
    if drop.external_order_id:
        display_ref = drop.external_order_id
    elif drop.order_number:
        display_ref = f"D-{drop.order_number:05d}"
    else:
        display_ref = str(drop.id)[:8].upper()

    return {
        "id": str(drop.id),
        "ref": display_ref,
        "order_number": drop.order_number,
        "external_order_id": drop.external_order_id,
        "source": drop.source or "manual",
        "scheduled_date": str(drop.scheduled_date),
        "scheduled_window": drop.scheduled_window.value,
        "notify_sent_at": drop.notify_sent_at.isoformat() if drop.notify_sent_at else None,
        "last_reschedule_sms_at": drop.last_reschedule_sms_at.isoformat() if drop.last_reschedule_sms_at else None,
        "customer_name": customer.name,
        "customer_phone": customer.phone_e164,
        "delivery_address": addr_dict,
        "notes": drop.notes,
        "required_loads": len(loads_out),
        "loads": loads_out,
    }


@router.post("/drops/{drop_id}/send-delivery-notification")
def send_delivery_notification(drop_id: str, user: AuthUser = Depends(require_roles(UserRole.DISPATCHER, UserRole.ADMIN)), db: Session = Depends(db_dep)):
    row = db.execute(
        select(Drop, Customer).join(Customer, Customer.id == Drop.customer_id)
        .where(Drop.tenant_id == user.tenant_id, Drop.id == drop_id)
    ).one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Drop not found"})
    drop, customer = row
    window_label = "9am–1pm" if drop.scheduled_window.value == "A" else "1pm–5pm"
    message = f"Your delivery is scheduled for {drop.scheduled_date.strftime('%A, %B %d')} between {window_label}. Please ensure the delivery area is accessible."
    job = {
        "tenant_id": str(user.tenant_id),
        "to": customer.phone_e164,
        "template": "delivery_notification",
        "message": message,
    }
    dedupe_key = f"notify-{drop.id}-{int(now_utc().timestamp() // 300)}"
    if not enqueue_sms_job(job, dedupe_key=dedupe_key):
        raise HTTPException(status_code=409, detail={"code": "rate_limited", "message": "Notification was already sent recently. Wait a few minutes."})
    drop.notify_sent_at = now_utc()
    log_event(db, user.tenant_id, "delivery_notification.sent", "api", {"drop_id": drop_id})
    db.commit()
    return {"status": "sent", "sent_at": drop.notify_sent_at.isoformat()}


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
        raise HTTPException(
            status_code=409,
            detail={
                "code": "sms_rate_limited",
                "message": "Could not send reschedule text because one was already sent in the last 5 minutes.",
                "next_step": "Wait a few minutes or use admin override if this is urgent.",
            },
        )

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
        raise HTTPException(
            status_code=409,
            detail={
                "code": "duplicate_sms",
                "message": "Could not queue this reschedule text because the same message is already queued.",
                "next_step": "Refresh drop details and retry with updated timing or content.",
            },
        )

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

    schedule_decision = scheduling_gate(db, user.tenant_id)
    if not schedule_decision.allowed:
        raise HTTPException(status_code=402, detail={"code": schedule_decision.code, "message": schedule_decision.message})
    rows = db.execute(select(Load).where(Load.tenant_id == user.tenant_id, Load.id.in_(payload.load_ids)).with_for_update()).scalars().all()
    for l in rows:
        guard_load_editable(l, "reassigned")
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
        ).with_for_update()
    ).scalars().all()
    for l in rows:
        guard_load_editable(l, "reassigned")
        l.driver_user_id = payload.to_driver_user_id
    log_event(db, user.tenant_id, "loads.reassigned_all", "api", payload.model_dump(mode="json"))
    db.commit()
    invalidate_suggestion_cache(str(user.tenant_id))
    return {"updated": len(rows)}


@router.post("/drops/{drop_id}/assign")
def assign_entire_drop(drop_id: str, payload: AssignIn, user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)), db: Session = Depends(db_dep)):

    schedule_decision = scheduling_gate(db, user.tenant_id)
    if not schedule_decision.allowed:
        raise HTTPException(status_code=402, detail={"code": schedule_decision.code, "message": schedule_decision.message})
    rows = db.execute(select(Load).where(Load.tenant_id == user.tenant_id, Load.drop_id == drop_id).with_for_update()).scalars().all()
    for l in rows:
        guard_load_editable(l, "reassigned")
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


class OptimizationApplyIn(BaseModel):
    selected_load_ids: list[str] | None = Field(default=None)


@router.get("/optimization/proposals")
def list_optimization_proposals(
    day: date,
    window: WindowCode | None = Query(default=None),
    regenerate: bool = Query(default=False),
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)),
    db: Session = Depends(db_dep),
):
    account = ensure_billing_account(db, user.tenant_id)
    plan = get_plan(db, account.plan_id)
    if not plan.optimization_features_enabled:
        raise HTTPException(status_code=402, detail={"code": "feature_not_in_plan", "message": "Optimization features are not enabled for your plan", "upgrade_required": True})
    if regenerate:
        db.query(OptimizationProposal).filter(OptimizationProposal.tenant_id == user.tenant_id, OptimizationProposal.proposal_date == day).delete()
        proposals = generate_proposals(db, user.tenant_id, day, window)
        for p in proposals:
            db.add(p)
            log_event(db, user.tenant_id, "OPTIMIZATION_PROPOSED", "dispatch", {"proposal_type": p.proposal_type, "affected_load_ids": p.affected_load_ids})
        db.commit()

    q = db.query(OptimizationProposal).filter(OptimizationProposal.tenant_id == user.tenant_id, OptimizationProposal.proposal_date == day)
    if window:
        q = q.filter(OptimizationProposal.window_code == window)
    rows = q.order_by(OptimizationProposal.created_at.desc()).all()
    return {
        "date": str(day),
        "proposals": [
            {
                "proposal_id": str(r.id),
                "proposal_type": r.proposal_type,
                "affected_load_ids": r.affected_load_ids,
                "before_state": r.before_state,
                "after_state": r.after_state,
                "explanation": r.explanation,
                "estimated_benefit": r.estimated_benefit,
                "confidence_level": r.confidence_level,
                "status": r.status,
            }
            for r in rows
        ],
    }


@router.post("/optimization/proposals/{proposal_id}/apply")
def apply_optimization_proposal(
    proposal_id: str,
    payload: OptimizationApplyIn,
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)),
    db: Session = Depends(db_dep),
):
    schedule_decision = scheduling_gate(db, user.tenant_id)
    if not schedule_decision.allowed:
        raise HTTPException(status_code=402, detail={"code": schedule_decision.code, "message": schedule_decision.message})
    proposal = db.execute(select(OptimizationProposal).where(OptimizationProposal.id == proposal_id, OptimizationProposal.tenant_id == user.tenant_id).with_for_update()).scalar_one_or_none()
    if not proposal:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Proposal not found"})
    result = apply_proposal(db, proposal, payload.selected_load_ids)
    log_event(db, user.tenant_id, "OPTIMIZATION_APPLIED", "dispatch", {"proposal_id": proposal_id, "updated": result["updated"], "selected_load_ids": payload.selected_load_ids})
    db.commit()
    invalidate_suggestion_cache(str(user.tenant_id))
    return {"status": proposal.status, **result}


@router.post("/optimization/proposals/{proposal_id}/undo")
def undo_optimization_proposal(
    proposal_id: str,
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)),
    db: Session = Depends(db_dep),
):
    proposal = db.execute(select(OptimizationProposal).where(OptimizationProposal.id == proposal_id, OptimizationProposal.tenant_id == user.tenant_id).with_for_update()).scalar_one_or_none()
    if not proposal:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Proposal not found"})
    result = undo_proposal(db, proposal)
    log_event(db, user.tenant_id, "OPTIMIZATION_REVERTED", "dispatch", {"proposal_id": proposal_id, "updated": result["updated"]})
    db.commit()
    invalidate_suggestion_cache(str(user.tenant_id))
    return {"status": proposal.status, **result}


@router.post("/optimization/proposals/{proposal_id}/dismiss")
def dismiss_optimization_proposal(
    proposal_id: str,
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)),
    db: Session = Depends(db_dep),
):
    proposal = db.execute(select(OptimizationProposal).where(OptimizationProposal.id == proposal_id, OptimizationProposal.tenant_id == user.tenant_id).with_for_update()).scalar_one_or_none()
    if not proposal:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Proposal not found"})
    proposal.status = "dismissed"
    log_event(db, user.tenant_id, "OPTIMIZATION_DISMISSED", "dispatch", {"proposal_id": proposal_id})
    db.commit()
    return {"status": proposal.status}
