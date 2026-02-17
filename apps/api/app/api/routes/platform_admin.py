from hashlib import sha256
from secrets import token_urlsafe

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, EmailStr
from redis import Redis
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.api.deps import db_dep
from app.api.services import log_event
from app.core.config import settings
from app.core.security import get_password_hash
from app.models.entities import Channel, ChannelType, Drop, EventLog, Load, LoadStatus, ProductCatalogItem, Tenant, User, UserRole

router = APIRouter(prefix="/platform", tags=["platform-admin"])


def platform_guard(x_platform_admin: str = Header(default="")):
    if not settings.jwt_secret or x_platform_admin != settings.jwt_secret:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail={"code": "forbidden", "message": "Platform admin required"})


class OnboardingAdminIn(BaseModel):
    email: EmailStr
    password: str


class OnboardingChannelIn(BaseModel):
    name: str
    type: ChannelType


class TenantOnboardIn(BaseModel):
    tenant: dict
    admin_user: OnboardingAdminIn
    channels: list[OnboardingChannelIn] = []
    seed_catalog_template: bool = False


@router.get("/tenants", dependencies=[Depends(platform_guard)])
def list_tenants(db: Session = Depends(db_dep)):
    tenants = db.execute(select(Tenant).order_by(Tenant.created_at.desc())).scalars().all()
    return {"items": [{"id": str(t.id), "name": t.name, "slug": t.slug, "status": "active" if t.is_active else "inactive", "created_at": t.created_at.isoformat()} for t in tenants]}


@router.post("/onboarding", dependencies=[Depends(platform_guard)])
def onboarding(payload: TenantOnboardIn, db: Session = Depends(db_dep)):
    if db.execute(select(Tenant.id).where(Tenant.slug == payload.tenant["slug"])).scalar_one_or_none():
        raise HTTPException(status_code=409, detail={"code": "slug_taken", "message": "Tenant slug already exists"})

    tenant = Tenant(**payload.tenant)
    db.add(tenant)
    db.flush()

    admin = User(
        tenant_id=tenant.id,
        email=str(payload.admin_user.email),
        hashed_password=get_password_hash(payload.admin_user.password),
        role=UserRole.ADMIN,
        is_active=True,
    )
    db.add(admin)

    channels = []
    for channel_in in payload.channels:
        api_key = token_urlsafe(32)
        channel = Channel(
            tenant_id=tenant.id,
            name=channel_in.name,
            channel_type=channel_in.type,
            api_key_hash=sha256(api_key.encode("utf-8")).hexdigest(),
            is_active=True,
        )
        db.add(channel)
        channels.append({"name": channel_in.name, "type": channel_in.type.value, "api_key": api_key})

    if payload.seed_catalog_template:
        db.add(
            ProductCatalogItem(
                tenant_id=tenant.id,
                sku="TEMPLATE-BULK-001",
                name="Template Bulk Product",
                delivery_mode="bulk_load",
                unit="yard",
                bulk_group="template",
                category="template",
                active=True,
            )
        )

    log_event(db, tenant.id, "tenant.onboarding.completed", "api", {"slug": tenant.slug, "channels": [c["name"] for c in channels]})
    db.commit()
    return {
        "tenant_slug": tenant.slug,
        "created_admin_user": {"id": str(admin.id), "email": admin.email},
        "created_channels": channels,
    }


@router.get("/tenants/{tenant_id}/health", dependencies=[Depends(platform_guard)])
def tenant_health(tenant_id: str, db: Session = Depends(db_dep)):
    tenant = db.execute(select(Tenant).where(Tenant.id == tenant_id)).scalar_one_or_none()
    if not tenant:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Tenant not found"})

    db_ok = True
    try:
        db.execute(text("SELECT 1"))
    except Exception:
        db_ok = False

    redis_ok = True
    try:
        Redis.from_url(settings.redis_url).ping()
    except Exception:
        redis_ok = False

    last_sms = db.execute(
        select(EventLog.created_at)
        .where(EventLog.tenant_id == tenant.id, EventLog.event_type.like("sms.%"))
        .order_by(EventLog.created_at.desc())
        .limit(1)
    ).scalar_one_or_none()
    ingest_failures = int(
        db.execute(select(func.count(EventLog.id)).where(EventLog.tenant_id == tenant.id, EventLog.event_type.like("%ingest%failed%"))).scalar_one()
    )
    capacity_conflicts = int(
        db.execute(select(func.count(EventLog.id)).where(EventLog.tenant_id == tenant.id, EventLog.event_type.like("capacity.%"))).scalar_one()
    )

    return {
        "tenant_id": tenant_id,
        "db_connectivity_status": "ok" if db_ok else "error",
        "redis_connectivity_status": "ok" if redis_ok else "error",
        "worker_heartbeat": "unknown",
        "last_sms_sent_timestamp": last_sms.isoformat() if last_sms else None,
        "recent_ingestion_failures_count": ingest_failures,
        "recent_capacity_conflicts_count": capacity_conflicts,
    }


@router.get("/tenants/{tenant_id}/activity", dependencies=[Depends(platform_guard)])
def tenant_activity(tenant_id: str, db: Session = Depends(db_dep)):
    tenant = db.execute(select(Tenant).where(Tenant.id == tenant_id)).scalar_one_or_none()
    if not tenant:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Tenant not found"})

    deliveries_7d = int(
        db.execute(
            select(func.count(Load.id)).where(Load.tenant_id == tenant.id, Load.status == LoadStatus.DELIVERED, Load.route_date >= func.current_date() - text("INTERVAL '7 day'"))
        ).scalar_one()
    )
    loads_per_day = db.execute(
        select(Load.route_date, func.count(Load.id)).where(Load.tenant_id == tenant.id, Load.route_date >= func.current_date() - text("INTERVAL '7 day'")).group_by(Load.route_date)
    ).all()
    exceptions_7d = int(
        db.execute(select(func.count(Load.id)).where(Load.tenant_id == tenant.id, Load.status == LoadStatus.EXCEPTION, Load.route_date >= func.current_date() - text("INTERVAL '7 day'"))).scalar_one()
    )
    return {
        "deliveries_last_7_days": deliveries_7d,
        "loads_per_day": [{"date": str(day), "count": int(count)} for day, count in loads_per_day],
        "exceptions_last_7_days": exceptions_7d,
    }


@router.get("/tenants/{tenant_id}", dependencies=[Depends(platform_guard)])
def tenant_detail(tenant_id: str, db: Session = Depends(db_dep)):
    tenant = db.execute(select(Tenant).where(Tenant.id == tenant_id)).scalar_one_or_none()
    if not tenant:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Tenant not found"})
    users = db.execute(select(User).where(User.tenant_id == tenant.id)).scalars().all()
    channels = db.execute(select(Channel).where(Channel.tenant_id == tenant.id)).scalars().all()
    return {
        "tenant": {"id": str(tenant.id), "name": tenant.name, "slug": tenant.slug, "timezone": tenant.timezone, "capacity_per_window": tenant.capacity_per_window},
        "users": [{"id": str(u.id), "email": u.email, "role": u.role.value, "is_active": u.is_active} for u in users],
        "channels": [{"id": str(c.id), "name": c.name, "type": c.channel_type.value, "is_active": c.is_active} for c in channels],
    }
