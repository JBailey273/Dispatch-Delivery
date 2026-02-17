from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import AuthUser, db_dep, require_roles
from app.api.services import enqueue_billing_webhook_job
from app.billing.providers import StripeBillingProvider
from app.billing.service import ensure_billing_account, evaluate_limit, get_plan, register_webhook_event, scheduling_gate, update_billing_status, usage_snapshot
from app.core.config import settings
from app.models.entities import BillingAccount, BillingAccountStatus, BillingPlan, BillingWebhookEvent, EventLog, Tenant, UserRole

router = APIRouter(prefix="/billing", tags=["billing"])


class ChangePlanIn(BaseModel):
    plan_id: str


@router.get("/plans")
def list_plans(user: AuthUser = Depends(require_roles(UserRole.ADMIN)), db: Session = Depends(db_dep)):
    plans = db.execute(select(BillingPlan).where(BillingPlan.is_active.is_(True))).scalars().all()
    return {
        "items": [
            {
                "plan_id": p.plan_id,
                "name": p.name,
                "limits": {
                    "max_drivers": p.max_drivers,
                    "max_dispatchers": p.max_dispatchers,
                    "max_daily_loads": p.max_daily_loads,
                },
                "entitlements": {
                    "optimization_features_enabled": p.optimization_features_enabled,
                    "analytics_enabled": p.analytics_enabled,
                },
            }
            for p in plans
        ]
    }


@router.get("/status")
def billing_status(user: AuthUser = Depends(require_roles(UserRole.ADMIN)), db: Session = Depends(db_dep)):
    tenant = db.execute(select(Tenant).where(Tenant.id == user.tenant_id)).scalar_one()
    account = ensure_billing_account(db, user.tenant_id)
    plan = get_plan(db, account.plan_id)
    usage = usage_snapshot(db, user.tenant_id)
    warnings = []
    for key in ["max_drivers", "max_dispatchers", "max_daily_loads"]:
        limit = getattr(plan, key)
        used = usage[key]
        if limit and used / limit >= 0.8:
            warnings.append({"code": "approaching_limit", "resource": key, "used": used, "limit": limit})
    if account.status == BillingAccountStatus.PAST_DUE:
        warnings.append({"code": "payment_past_due", "message": "Payment failed. Operations continue but resource creation may be limited."})
    if account.status == BillingAccountStatus.SUSPENDED:
        warnings.append({"code": "billing_suspended", "message": "Account is read-only until billing is restored."})
    db.commit()
    return {
        "tenant": {"id": str(tenant.id), "slug": tenant.slug, "name": tenant.name},
        "account": {
            "status": account.status.value,
            "plan_id": account.plan_id,
            "trial_ends_at": account.trial_ends_at.isoformat() if account.trial_ends_at else None,
            "current_period_start": account.current_period_start.isoformat() if account.current_period_start else None,
            "current_period_end": account.current_period_end.isoformat() if account.current_period_end else None,
            "next_billing_date": account.current_period_end.isoformat() if account.current_period_end else None,
        },
        "usage": usage,
        "limits": {
            "max_drivers": plan.max_drivers,
            "max_dispatchers": plan.max_dispatchers,
            "max_daily_loads": plan.max_daily_loads,
        },
        "entitlements": {
            "optimization_features_enabled": plan.optimization_features_enabled,
            "analytics_enabled": plan.analytics_enabled,
        },
        "warnings": warnings,
    }


@router.get("/history")
def billing_history(user: AuthUser = Depends(require_roles(UserRole.ADMIN)), db: Session = Depends(db_dep)):
    events = db.execute(
        select(EventLog.event_type, EventLog.source, EventLog.payload_json, EventLog.created_at)
        .where(EventLog.tenant_id == user.tenant_id, EventLog.event_type.like("billing.%"))
        .order_by(EventLog.created_at.desc())
        .limit(250)
    ).all()
    return {"items": [{"event_type": e, "source": s, "payload": p, "created_at": c.isoformat()} for e, s, p, c in events]}


@router.get("/invoices")
def list_invoices(user: AuthUser = Depends(require_roles(UserRole.ADMIN)), db: Session = Depends(db_dep)):
    provider = StripeBillingProvider()
    account = ensure_billing_account(db, user.tenant_id)
    if not account.stripe_customer_id:
        return {"items": []}
    rows = provider.list_invoices(account.stripe_customer_id)
    return {
        "items": [
            {
                "id": inv.get("id"),
                "number": inv.get("number"),
                "status": inv.get("status"),
                "total": inv.get("total"),
                "currency": inv.get("currency"),
                "hosted_invoice_url": inv.get("hosted_invoice_url"),
                "created": datetime.fromtimestamp(inv.get("created"), tz=UTC).isoformat() if inv.get("created") else None,
            }
            for inv in rows
        ]
    }


@router.post("/change-plan")
def change_plan(payload: ChangePlanIn, user: AuthUser = Depends(require_roles(UserRole.ADMIN)), db: Session = Depends(db_dep)):
    account = ensure_billing_account(db, user.tenant_id)
    plan = get_plan(db, payload.plan_id)
    account.plan_id = plan.plan_id
    db.add(account)
    from app.api.services import log_event

    log_event(db, user.tenant_id, "billing.plan.changed", "api", {"plan_id": plan.plan_id})
    if account.stripe_customer_id and plan.stripe_price_id:
        StripeBillingProvider().create_or_update_subscription(account.stripe_customer_id, plan.stripe_price_id)
    db.commit()
    return {"status": "ok", "plan_id": plan.plan_id}


class PortalIn(BaseModel):
    return_url: str


@router.post("/portal")
def billing_portal(payload: PortalIn, user: AuthUser = Depends(require_roles(UserRole.ADMIN)), db: Session = Depends(db_dep)):
    account = ensure_billing_account(db, user.tenant_id)
    tenant = db.execute(select(Tenant).where(Tenant.id == user.tenant_id)).scalar_one()
    provider = StripeBillingProvider()
    if not account.stripe_customer_id:
        account.stripe_customer_id = provider.ensure_customer(tenant.slug, None).customer_id
    db.add(account)
    db.commit()
    return {"url": provider.create_billing_portal_session(account.stripe_customer_id, payload.return_url)}


@router.post("/webhooks/stripe")
async def stripe_webhook(request: Request, stripe_signature: str = Header(default="", alias="Stripe-Signature"), db: Session = Depends(db_dep)):
    body = await request.body()
    if settings.stripe_webhook_secret and (not stripe_signature):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail={"code": "missing_signature", "message": "Stripe signature required"})

    import json

    payload = json.loads(body.decode("utf-8") or "{}")
    event_id = payload.get("id")
    event_type = payload.get("type")
    if not event_id or not event_type:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail={"code": "invalid_event", "message": "Invalid webhook payload"})

    accepted = register_webhook_event(db, "stripe", event_id, event_type, payload)
    if not accepted:
        db.commit()
        return {"status": "duplicate_ignored"}
    db.commit()
    enqueue_billing_webhook_job({"provider": "stripe", "event_id": event_id, "event_type": event_type, "payload": payload}, dedupe_key=f"billing-webhook-{event_id}")
    return {"status": "accepted"}


@router.get("/gates")
def gates(resource: str, next_value: int, user: AuthUser = Depends(require_roles(UserRole.ADMIN)), db: Session = Depends(db_dep)):
    decision = evaluate_limit(db, user.tenant_id, resource, next_value)
    return decision.__dict__


# convenience dependency for boundary guards in routes

def enforce_scheduling_allowed(db: Session, tenant_id):
    decision = scheduling_gate(db, tenant_id)
    if not decision.allowed:
        raise HTTPException(status_code=402, detail={"code": decision.code, "message": decision.message})


def enforce_limit_allowed(db: Session, tenant_id, resource: str, next_value: int):
    decision = evaluate_limit(db, tenant_id, resource, next_value)
    if not decision.allowed:
        raise HTTPException(status_code=402, detail={"code": decision.code, "message": decision.message, "upgrade_required": decision.upgrade_required})
