from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.services import log_event
from app.models.entities import BillingAccount, BillingAccountStatus, BillingPlan, BillingWebhookEvent, Drop, User, UserRole


@dataclass
class FeatureGateResult:
    allowed: bool
    code: str | None = None
    message: str | None = None
    upgrade_required: bool = False


def ensure_billing_account(db: Session, tenant_id, default_plan_id: str = "starter") -> BillingAccount:
    account = db.execute(select(BillingAccount).where(BillingAccount.tenant_id == tenant_id)).scalar_one_or_none()
    if account:
        return account
    plan = db.execute(select(BillingPlan).where(BillingPlan.plan_id == default_plan_id, BillingPlan.is_active.is_(True))).scalar_one_or_none()
    if not plan:
        raise HTTPException(status_code=500, detail={"code": "plan_missing", "message": "Default plan not configured"})
    account = BillingAccount(
        tenant_id=tenant_id,
        plan_id=plan.plan_id,
        status=BillingAccountStatus.TRIAL,
        trial_ends_at=datetime.now(timezone.utc) + timedelta(days=14),
        current_period_start=datetime.now(timezone.utc),
        current_period_end=datetime.now(timezone.utc) + timedelta(days=30),
    )
    db.add(account)
    db.flush()
    log_event(db, tenant_id, "billing.account.created", "billing", {"plan_id": plan.plan_id, "status": account.status.value})
    return account


def get_plan(db: Session, plan_id: str) -> BillingPlan:
    plan = db.execute(select(BillingPlan).where(BillingPlan.plan_id == plan_id)).scalar_one_or_none()
    if not plan:
        raise HTTPException(status_code=404, detail={"code": "plan_not_found", "message": "Plan not found"})
    return plan


def usage_snapshot(db: Session, tenant_id) -> dict[str, int]:
    active_drivers = db.execute(
        select(func.count(User.id)).where(User.tenant_id == tenant_id, User.role == UserRole.DRIVER, User.is_active.is_(True))
    ).scalar_one()
    active_dispatchers = db.execute(
        select(func.count(User.id)).where(User.tenant_id == tenant_id, User.role == UserRole.DISPATCHER, User.is_active.is_(True))
    ).scalar_one()
    today_loads = db.execute(select(func.count(Drop.id)).where(Drop.tenant_id == tenant_id, Drop.scheduled_date == func.current_date())).scalar_one()
    return {"max_drivers": active_drivers, "max_dispatchers": active_dispatchers, "max_daily_loads": today_loads}


def evaluate_limit(db: Session, tenant_id, resource_key: str, next_value: int) -> FeatureGateResult:
    account = ensure_billing_account(db, tenant_id)
    if account.status == BillingAccountStatus.SUSPENDED:
        return FeatureGateResult(allowed=False, code="billing_suspended", message="Billing is suspended; account is read-only", upgrade_required=False)
    plan = get_plan(db, account.plan_id)
    limit = getattr(plan, resource_key)
    if limit is None:
        return FeatureGateResult(allowed=True)
    if next_value > limit:
        return FeatureGateResult(
            allowed=False,
            code="plan_limit_reached",
            message=f"Your plan allows up to {limit} {resource_key.replace('max_', '').replace('_', ' ')}.",
            upgrade_required=True,
        )
    return FeatureGateResult(allowed=True)


def scheduling_gate(db: Session, tenant_id) -> FeatureGateResult:
    account = ensure_billing_account(db, tenant_id)
    if account.status == BillingAccountStatus.SUSPENDED:
        return FeatureGateResult(False, "billing_suspended", "Account suspended: new scheduling and assignments are blocked")
    return FeatureGateResult(True)


def update_billing_status(db: Session, tenant_id, status: BillingAccountStatus, payload: dict[str, Any]) -> None:
    account = ensure_billing_account(db, tenant_id)
    old = account.status
    account.status = status
    db.add(account)
    log_event(db, tenant_id, "billing.status.changed", "billing", {"old_status": old.value, "new_status": status.value, "provider_payload": payload})


def register_webhook_event(db: Session, provider: str, event_id: str, event_type: str, payload: dict) -> bool:
    existing = db.execute(select(BillingWebhookEvent.id).where(BillingWebhookEvent.provider == provider, BillingWebhookEvent.provider_event_id == event_id)).scalar_one_or_none()
    if existing:
        return False
    db.add(BillingWebhookEvent(provider=provider, provider_event_id=event_id, event_type=event_type, payload_json=payload))
    return True
