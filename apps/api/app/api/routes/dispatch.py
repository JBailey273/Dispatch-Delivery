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
from app.models.entities import Customer, CustomerAddress, Drop, ExceptionReasonCode, Load, LoadStatus, Location, OperationalBlackout, OptimizationProposal, Tenant, User, UserRole, WindowCapacity, WindowCode
from app.api.email_service import send_on_the_way_email, send_reschedule_notification_email, send_delivery_confirmation_email

router = APIRouter(prefix="/dispatch", tags=["dispatch"])
logger = logging.getLogger("dispatch.ops")


# ── Helpers ───────────────────────────────────────────────────────────────────


def _build_order_ref(drop: Drop) -> str:
    if drop.order_number:
        return str(drop.order_number)
    if drop.qd_number:
        return f"QD-{drop.qd_number}"
    return str(drop.id)[:8].upper()


def _build_load_dict(load: Load, drop: Drop, driver: User | None, customer: Customer, address: CustomerAddress, history=None) -> dict:
    driver_display = driver.display_name if driver else "Unassigned"
    result = {
        "id": str(load.id),
        "drop_id": str(drop.id),
        "order_ref": _build_order_ref(drop),
        "status": load.status.value,
        "material": load.material_name_snapshot,
        "bulk_group": load.bulk_group_snapshot,
        "qty": load.qty,
        "unit": load.unit,
        "customer_name": customer.name,
        "customer_phone": customer.phone_e164,
        "customer_email": customer.email,
        "customer_sms_opt_in": customer.sms_opt_in,
        "customer_email_opt_in": customer.email_opt_in,
        "address_short": f"{address.line1}, {address.city}" if address else "Pickup",
        "driver_name": driver_display,
        "driver_user_id": str(driver.id) if driver else None,
        "is_priority": drop.is_priority,
    }
    if history:
        result["historical_flags"] = {
            "exception_count": history.exception_count,
            "has_exception_history": history.exception_count > 0,
            "recent_notes": history.recent_notes,
        }
    return result


# ── Schedule endpoint ─────────────────────────────────────────────────────────


@router.get("/schedule")
def dispatch_schedule(
    day: date,
    location_id: str | None = Query(default=None),
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)),
    db: Session = Depends(db_dep),
):
    # Resolve location for capacity defaults
    if location_id:
        location = db.execute(
            select(Location).where(Location.id == location_id, Location.tenant_id == user.tenant_id)
        ).scalar_one_or_none()
        if not location:
            raise HTTPException(status_code=404, detail={"code": "location_not_found", "message": "Location not found"})
        default_cap = location.capacity_per_window
    else:
        tenant = db.execute(select(Tenant).where(Tenant.id == user.tenant_id)).scalar_one()
        default_cap = tenant.capacity_per_window

    # Check for orphaned loads
    orphaned = db.execute(select(Load.id).where(Load.tenant_id == user.tenant_id, Load.route_date == day, ~Load.drop_id.in_(select(Drop.id)))).scalars().all()
    if orphaned:
        logger.error("orphaned_loads_detected", extra={"tenant_id": str(user.tenant_id), "count": len(orphaned)})

    # Capacity and blackouts
    cap_query = select(WindowCapacity).where(WindowCapacity.tenant_id == user.tenant_id, WindowCapacity.service_date == day)
    if location_id:
        cap_query = cap_query.where(WindowCapacity.location_id == location_id)
    caps = db.execute(cap_query).scalars().all()
    cap_map = {c.window_code.value: {"used": c.capacity_used, "total": c.capacity_total, "remaining_capacity": c.capacity_total - c.capacity_used} for c in caps}

    blackout_query = select(OperationalBlackout.window_code).where(
        OperationalBlackout.tenant_id == user.tenant_id,
        OperationalBlackout.service_date == day,
        OperationalBlackout.active.is_(True),
        or_(OperationalBlackout.window_code == WindowCode.A, OperationalBlackout.window_code == WindowCode.B),
    )
    if location_id:
        blackout_query = blackout_query.where(OperationalBlackout.location_id == location_id)
    disabled_windows = set(code.value for code in db.execute(blackout_query).scalars().all() if code)

    # Fetch all loads for the day with joins
    loads_query = (
        select(Load, Drop, User, Customer, CustomerAddress)
        .join(Drop, Drop.id == Load.drop_id)
        .outerjoin(User, User.id == Load.driver_user_id)
        .join(Customer, Customer.id == Drop.customer_id)
        .outerjoin(CustomerAddress, CustomerAddress.id == Drop.address_id)
        .where(Load.tenant_id == user.tenant_id, Load.route_date == day)
    )
    if location_id:
        loads_query = loads_query.where(Drop.location_id == location_id)
    rows = db.execute(loads_query).all()

    # Split into priority and windowed
    priority_groups: dict[str, list] = defaultdict(list)
    by_window: dict[str, dict[str, list]] = {"A": defaultdict(list), "B": defaultdict(list)}

    for load, drop, driver, customer, address in rows:
        driver_display = driver.display_name if driver else "Unassigned"
        history = get_address_history(db, str(user.tenant_id), str(drop.address_id))
        load_dict = _build_load_dict(load, drop, driver, customer, address, history)

        if drop.is_priority:
            priority_groups[driver_display].append(load_dict)
        else:
            by_window[load.route_window.value][driver_display].append(load_dict)

    # Sort loads within each window group by material_category for material grouping
    for window_groups in by_window.values():
        for driver_loads in window_groups.values():
            driver_loads.sort(key=lambda l: (l.get("material_category") or ""))

    # Count priority loads for the warning
    priority_load_count = sum(len(v) for v in priority_groups.values())
    priority_warning = None
    if priority_load_count >= 8:
        priority_warning = f"You have {priority_load_count} priority deliveries scheduled for this day."

    return {
        "date": str(day),
        "priority": {
            "groups": dict(priority_groups),
            "load_count": priority_load_count,
            "warning": priority_warning,
        },
        "windows": {
            "A": {"capacity": cap_map.get("A", {"used": 0, "total": default_cap, "remaining_capacity": default_cap}), "groups": dict(by_window["A"]), "disabled": "A" in disabled_windows},
            "B": {"capacity": cap_map.get("B", {"used": 0, "total": default_cap, "remaining_capacity": default_cap}), "groups": dict(by_window["B"]), "disabled": "B" in disabled_windows},
        },
    }

@router.get("/needs-attention")
@router.get("/needs-attention")
def needs_attention(
    location_id: str | None = Query(default=None),
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)),
    db: Session = Depends(db_dep),
):
    needs_attn_query = (
        select(Drop, Customer)
        .join(Customer, Customer.id == Drop.customer_id)
        .where(
            Drop.tenant_id == user.tenant_id,
            Drop.needs_reschedule == True,  # noqa: E712
        )
        .order_by(Drop.scheduled_date.asc())
    )
    if location_id:
        needs_attn_query = needs_attn_query.where(Drop.location_id == location_id)
    rows = db.execute(needs_attn_query).all()
    out = []
    for drop, customer in rows:
        out.append({
            "drop_id": str(drop.id),
            "ref": _build_order_ref(drop),
            "customer_name": customer.name,
            "scheduled_date": str(drop.scheduled_date) if drop.scheduled_date else None,
            "scheduled_window": drop.scheduled_window.value if drop.scheduled_window else None,
            "is_priority": drop.is_priority,
            "created_at": drop.created_at.isoformat() if drop.created_at else None,
        })
    return {"drops": out}

@router.get("/drivers")
def list_drivers(user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)), db: Session = Depends(db_dep)):
    drivers = db.execute(
        select(User).where(User.tenant_id == user.tenant_id, User.role == UserRole.DRIVER, User.is_active == True)  # noqa: E712
    ).scalars().all()
    return {"drivers": [{"id": str(d.id), "email": d.email, "name": d.display_name, "truck": d.default_truck_identifier} for d in drivers]}


@router.get("/month-summary")
def month_summary(
    start_date: date = Query(...),
    end_date: date = Query(...),
    location_id: str | None = Query(default=None),
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)),
    db: Session = Depends(db_dep),
):
    """Lightweight summary of deliveries per day for calendar month cells."""
    drops_query = (
        select(Drop, Customer)
        .join(Customer, Customer.id == Drop.customer_id)
        .where(
            Drop.tenant_id == user.tenant_id,
            Drop.scheduled_date >= start_date,
            Drop.scheduled_date <= end_date,
        )
        .order_by(Drop.scheduled_date, Drop.scheduled_window)
    )
    if location_id:
        drops_query = drops_query.where(Drop.location_id == location_id)
    drops = db.execute(drops_query).all()

    # Collect materials per drop
    drop_ids = [str(d.id) for d, _ in drops]
    materials_map: dict[str, list[str]] = defaultdict(list)
    if drop_ids:
        loads = db.execute(
            select(Load.drop_id, Load.material_name_snapshot)
            .where(Load.drop_id.in_([d.id for d, _ in drops]))
        ).all()
        for load_drop_id, mat in loads:
            materials_map[str(load_drop_id)].append(mat)

    days: dict[str, list] = defaultdict(list)
    for drop, customer in drops:
        mats = materials_map.get(str(drop.id), [])
        days[str(drop.scheduled_date)].append({
            "drop_id": str(drop.id),
            "order_ref": _build_order_ref(drop),
            "customer_name": customer.name,
            "materials": ", ".join(mats) if mats else "",
            "window": drop.scheduled_window.value if drop.scheduled_window else "P",
            "status": drop.status,
            "is_priority": drop.is_priority,
        })

    return {"days": dict(days)}


@router.get("/orders")
def list_orders(
    start_date: date | None = Query(default=None),
    end_date: date | None = Query(default=None),
    status: str | None = Query(default=None),
    driver_name: str | None = Query(default=None),
    location_id: str | None = Query(default=None),
    search: str | None = Query(default=None),
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)),
    db: Session = Depends(db_dep),
):
    """Full order/load list for the All Orders page with optional filters."""
    from datetime import timedelta
    if not end_date:
        end_date = date.today() + timedelta(days=60)
    if not start_date:
        start_date = end_date - timedelta(days=150)
    stmt = (
        select(Load, Drop, Customer, CustomerAddress, User)
        .join(Drop, Drop.id == Load.drop_id)
        .join(Customer, Customer.id == Drop.customer_id)
        .outerjoin(CustomerAddress, CustomerAddress.id == Drop.address_id)
        .outerjoin(User, User.id == Load.driver_user_id)
        .where(
            Load.tenant_id == user.tenant_id,
        )
        .where(
            (Load.route_date.is_(None)) |
            ((Load.route_date >= start_date) & (Load.route_date <= end_date))
        )
    )
    if location_id:
        stmt = stmt.where(Drop.location_id == location_id)

    if status:
        try:
            status_enum = LoadStatus(status)
            stmt = stmt.where(Load.status == status_enum)
        except ValueError:
            pass

    stmt = stmt.order_by(Drop.created_at.desc(), Customer.name)
    rows = db.execute(stmt).all()

    orders = []
    for load, drop, customer, address, driver in rows:
        driver_display = driver.display_name if driver else None

        if driver_name:
            if driver_name == "Unassigned" and driver_display is not None:
                continue
            elif driver_name != "Unassigned" and driver_display != driver_name:
                continue

        if search:
            q = search.lower()
            ref = str(drop.external_order_id or drop.order_number or '').lower()
            if not any([
                q in (customer.name or '').lower(),
                q in (customer.company_name or '').lower(),
                q in (customer.phone_e164 or ''),
                q in (f"{address.line1} {address.city}".lower() if address else ''),
                q in ref,
            ]):
                continue

        orders.append({
            "drop_id": str(drop.id),
            "load_id": str(load.id),
            "order_ref": _build_order_ref(drop),
            "external_order_id": drop.external_order_id,
            "scheduled_date": str(load.route_date) if load.route_date else None,
            "window": load.route_window.value if load.route_window else None,
            "delivery_method": drop.delivery_method,
            "customer_name": customer.name,
            "customer_company": customer.company_name,
            "customer_phone": customer.phone_e164,
            "address_short": f"{address.line1}, {address.city}" if address else "Pickup",
            "material": load.material_name_snapshot,
            "bulk_group": load.bulk_group_snapshot,
            "material_category": load.material_category_snapshot,
            "qty": load.qty,
            "status": "fulfilled" if drop.fulfilled_at else load.status.value,
            "driver_name": driver_display,
            "is_priority": drop.is_priority,
            "created_at": drop.created_at.isoformat() if drop.created_at else None,
        })

    return {"orders": orders}


@router.get("/drops/{drop_id}")
def drop_detail(drop_id: str, user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)), db: Session = Depends(db_dep)):
    row = db.execute(
        select(Drop, Customer).join(Customer, Customer.id == Drop.customer_id).where(Drop.tenant_id == user.tenant_id, Drop.id == drop_id)
    ).one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Drop not found"})
    drop, customer = row

    address = db.execute(select(CustomerAddress).where(CustomerAddress.id == drop.address_id)).scalar_one_or_none()
    addr_dict = None
    if address:
        addr_dict = {
            "line1": address.line1, "line2": address.line2,
            "city": address.city, "state": address.state, "postal_code": address.postal_code,
        }

    load_rows = db.execute(
        select(Load, User).outerjoin(User, User.id == Load.driver_user_id)
        .where(Load.tenant_id == user.tenant_id, Load.drop_id == drop.id)
    ).all()
    loads_out = []
    for ld, driver in load_rows:
        loads_out.append({
            "id": str(ld.id),
            "material": ld.material_name_snapshot,
            "bulk_group": ld.bulk_group_snapshot,
            "qty": ld.qty,
            "unit": ld.unit,
            "status": ld.status.value,
            "driver_user_id": str(driver.id) if driver else None,
            "driver_name": driver.display_name if driver else None,
            "driver_email": driver.email if driver else None,
            "pod_photo_url": ld.pod_photo_url,
            "exception_photo_url": ld.exception_photo_url,
            "exception_reason_code": ld.exception_reason_code.value if ld.exception_reason_code else None,
            "exception_notes": ld.exception_notes,
            "condition_photo_url": ld.condition_photo_url,
            "condition_notes": ld.condition_notes,
        })

    return {
        "id": str(drop.id),
        "ref": _build_order_ref(drop),
        "order_number": drop.order_number,
        "external_order_id": drop.external_order_id,
        "source": drop.source or "manual",
        "is_priority": drop.is_priority,
        "customer_type": customer.customer_type.value,
        "scheduled_date": str(drop.scheduled_date) if drop.scheduled_date else None,
        "scheduled_window": drop.scheduled_window.value if drop.scheduled_window else None,
        "notify_sent_at": drop.notify_sent_at.isoformat() if drop.notify_sent_at else None,
        "last_reschedule_sms_at": drop.last_reschedule_sms_at.isoformat() if drop.last_reschedule_sms_at else None,
        "customer_id": str(customer.id),
        "customer_name": customer.name,
        "customer_phone": customer.phone_e164,
        "customer_email": customer.email,
        "customer_sms_opt_in": customer.sms_opt_in,
        "customer_email_opt_in": customer.email_opt_in,
        "delivery_address": addr_dict,
        "notes": drop.notes,
        "required_loads": len(loads_out),
        "loads": loads_out,
        "drop_photos": drop.drop_photos if drop.drop_photos else [],
        "payment_method": drop.payment_method,
        "payment_status": drop.payment_status,
        "payment_note": drop.payment_note,
        "order_total": float(drop.order_total) if drop.order_total else None,
        "stripe_payment_intent_id": drop.stripe_payment_intent_id,
        "delivery_method": drop.delivery_method,
        "wc_customer_id": drop.wc_customer_id,
    }
@router.get("/drops/{drop_id}/invoice")
def drop_invoice(drop_id: str, user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)), db: Session = Depends(db_dep)):
    """
    Returns line item pricing for the invoice view.
    Fetches from WooCommerce if external_order_id exists; falls back to loads snapshot.
    """
    row = db.execute(
        select(Drop, Customer).join(Customer, Customer.id == Drop.customer_id)
        .where(Drop.tenant_id == user.tenant_id, Drop.id == drop_id)
    ).one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Drop not found"})
    drop, customer = row

    address = db.execute(select(CustomerAddress).where(CustomerAddress.id == drop.address_id)).scalar_one_or_none()

    line_items = []
    shipping_total = 0.0
    tax_total = 0.0
    wc_source = False

    if drop.external_order_id:
        try:
            from app.api.routes.internal_orders import _wc_request
            wc_order = _wc_request(f"orders/{drop.external_order_id}")
            for item in wc_order.get("line_items", []):
                qty = int(item.get("quantity", 1))
                subtotal = float(item.get("subtotal") or item.get("total") or 0)
                unit_price = round(subtotal / qty, 2) if qty else 0
                line_items.append({
                    "name": item.get("name", ""),
                    "sku": item.get("sku", ""),
                    "quantity": qty,
                    "unit_price": unit_price,
                    "subtotal": subtotal,
                })
            shipping_total = float(wc_order.get("shipping_total") or 0)
            tax_total = float(wc_order.get("total_tax") or 0)
            wc_source = True
        except Exception:
            logger.warning(f"drop_invoice: WC fetch failed for drop {drop_id}, falling back to loads")

    if not wc_source:
        # Fallback: build from loads snapshot, no pricing available
        loads = db.execute(select(Load).where(Load.drop_id == drop.id)).scalars().all()
        for l in loads:
            line_items.append({
                "name": l.material_name_snapshot,
                "sku": l.bulk_group_snapshot or "",
                "quantity": l.qty,
                "unit_price": None,
                "subtotal": None,
            })

    return {
        "drop_id": drop_id,
        "ref": f"#{drop.order_number}" if drop.order_number else (f"QD-{drop.qd_number}" if drop.qd_number else drop_id[:8]),
        "order_number": drop.order_number,
        "created_at": drop.created_at.isoformat() if drop.created_at else None,
        "scheduled_date": str(drop.scheduled_date) if drop.scheduled_date else None,
        "delivery_method": drop.delivery_method,
        "customer_name": customer.name,
        "customer_phone": customer.phone_e164,
        "customer_email": customer.email,
        "customer_company": customer.company_name,
        "delivery_address": {
            "line1": address.line1, "line2": address.line2,
            "city": address.city, "state": address.state, "postal_code": address.postal_code,
        } if address else None,
        "line_items": line_items,
        "shipping_total": shipping_total,
        "tax_total": tax_total,
        "order_total": float(drop.order_total) if drop.order_total else None,
        "payment_method": drop.payment_method,
        "payment_status": drop.payment_status,
        "payment_note": drop.payment_note,
        "wc_source": wc_source,
    }


@router.get("/unscheduled")
def get_unscheduled_drops(
    location_id: str | None = Query(default=None),
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER, UserRole.ADMIN)),
    db: Session = Depends(db_dep),
):
    """Return all drops with no scheduled_date, ordered by creation time."""
    stmt = (
        select(Drop, Customer, CustomerAddress)
        .join(Customer, Customer.id == Drop.customer_id)
        .join(CustomerAddress, CustomerAddress.id == Drop.address_id)
        .where(
            Drop.tenant_id == user.tenant_id,
            Drop.scheduled_date.is_(None),
            Drop.delivery_method == "delivery",
        )
        .order_by(Drop.created_at.asc())
    )
    if location_id:
        stmt = stmt.where(Drop.location_id == location_id)

    rows = db.execute(stmt).all()

    drop_ids = [drop.id for drop, _, _ in rows]
    materials_map: dict[str, list[str]] = defaultdict(list)
    if drop_ids:
        loads = db.execute(
            select(Load.drop_id, Load.material_name_snapshot)
            .where(Load.drop_id.in_(drop_ids))
        ).all()
        for load_drop_id, mat in loads:
            materials_map[str(load_drop_id)].append(mat)

    return {
        "drops": [
            {
                "drop_id": str(drop.id),
                "order_number": drop.order_number,
                "customer_name": customer.name,
                "customer_phone": customer.phone_e164,
                "address_short": f"{addr.line1}, {addr.city}",
                "materials": ", ".join(materials_map.get(str(drop.id), [])) or "—",
                "created_at": drop.created_at.isoformat(),
                "is_priority": drop.is_priority,
                "source": drop.source,
            }
            for drop, customer, addr in rows
        ]
    }
class SendNotificationIn(BaseModel):
    type: str  # "on_the_way" | "reschedule" | "scheduling_link" | "pickup_ready"
    message: str | None = None          # optional override for reschedule body
    scheduling_link: str | None = None  # required for scheduling_link type
    admin_override: bool = False


@router.post("/drops/{drop_id}/send-notification")
def send_notification(
    drop_id: str,
    payload: SendNotificationIn,
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER, UserRole.ADMIN)),
    db: Session = Depends(db_dep),
):
    from app.api.notification_service import notify_customer

    row = db.execute(
        select(Drop, Customer)
        .join(Customer, Customer.id == Drop.customer_id)
        .where(Drop.tenant_id == user.tenant_id, Drop.id == drop_id)
        .with_for_update()
    ).one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Drop not found"})
    drop, customer = row

    # Rate limit reschedule notifications (5 min cooldown, bypassable)
    if payload.type == "reschedule" and not payload.admin_override:
        if drop.last_reschedule_sms_at and now_utc() - drop.last_reschedule_sms_at < timedelta(minutes=5):
            raise HTTPException(status_code=409, detail={
                "code": "rate_limited",
                "message": "A notification was already sent in the last 5 minutes.",
                "next_step": "Wait a few minutes or enable admin override.",
            })

    # Rate limit on_the_way (5 min cooldown, bypassable)
    if payload.type == "on_the_way" and not payload.admin_override:
        if drop.notify_sent_at and now_utc() - drop.notify_sent_at < timedelta(minutes=5):
            raise HTTPException(status_code=409, detail={
                "code": "rate_limited",
                "message": "An on-the-way notification was already sent recently.",
                "next_step": "Wait a few minutes or enable admin override.",
            })

    context = {}
    if payload.message:
        context["message"] = payload.message
    if payload.scheduling_link:
        context["scheduling_link"] = payload.scheduling_link

    result = notify_customer(
        db, user.tenant_id, drop, customer,
        payload.type, context,
    )

    if not result.any_sent:
        raise HTTPException(status_code=400, detail={
            "code": "no_channel",
            "message": "Customer has no notification channel set up. Add SMS opt-in or email opt-in first.",
        })

    # Update timestamps
    if payload.type == "on_the_way":
        drop.notify_sent_at = now_utc()
    elif payload.type in ("reschedule", "scheduling_link"):
        drop.last_reschedule_sms_at = now_utc()

    log_event(db, user.tenant_id, "notification.sent", "dispatch", {
        "drop_id": drop_id,
        "type": payload.type,
        **result.to_dict(),
    })
    db.commit()
    invalidate_suggestion_cache(str(user.tenant_id))
    return {"status": "sent", **result.to_dict()}


class AssignIn(BaseModel):
    load_ids: list[str]
    driver_user_id: str | None = None
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
        l.status = LoadStatus.ASSIGNED if payload.driver_user_id else LoadStatus.ASSIGNED
    log_event(db, user.tenant_id, "loads.assigned" if payload.driver_user_id else "loads.unassigned", "api", payload.model_dump())
    db.commit()
    invalidate_suggestion_cache(str(user.tenant_id))
    return {"updated": len(rows)}


class DispatchStatusIn(BaseModel):
    status: str
    reason_code: str | None = None
    notes: str | None = None


@router.post("/loads/{load_id}/status")
def dispatcher_update_load_status(
    load_id: str,
    payload: DispatchStatusIn,
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER, UserRole.ADMIN)),
    db: Session = Depends(db_dep),
):
    """Allow dispatchers/admins to set any load status — no driver ownership or POD checks."""
    try:
        requested = LoadStatus(payload.status)
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "invalid_status",
                "message": f"'{payload.status}' is not a valid status. Valid: {', '.join(s.value for s in LoadStatus)}",
            },
        ) from exc

    load = db.execute(
        select(Load).where(Load.id == load_id, Load.tenant_id == user.tenant_id).with_for_update()
    ).scalar_one_or_none()
    if not load:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Load not found"})

    old_status = load.status.value
    load.status = requested

    if requested == LoadStatus.EXCEPTION:
        if payload.reason_code:
            try:
                load.exception_reason_code = ExceptionReasonCode(payload.reason_code)
            except ValueError:
                pass
        load.exception_notes = payload.notes

    log_event(
        db,
        user.tenant_id,
        "LOAD_STATUS_CHANGED",
        "dispatch",
        {
            "load_id": load_id,
            "from_status": old_status,
            "status": requested.value,
            "reason_code": payload.reason_code,
            "notes": payload.notes,
            "changed_by": str(user.user_id),
        },
    )
    db.commit()
    return {"load_id": load_id, "old_status": old_status, "new_status": requested.value}


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
    log_event(db, user.tenant_id, "SUGGESTION_APPLIED", "dispatch", {"suggestion_type": payload.suggestion_type, "referenced_entities": payload.referenced_entities})
    db.commit()
    return {"status": "logged"}


@router.post("/suggestions/dismissed")
def log_suggestion_dismissed(payload: SuggestionEventIn, user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)), db: Session = Depends(db_dep)):
    log_event(db, user.tenant_id, "SUGGESTION_DISMISSED", "dispatch", {"suggestion_type": payload.suggestion_type, "referenced_entities": payload.referenced_entities})
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
