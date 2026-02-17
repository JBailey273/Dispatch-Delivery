from datetime import time

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import AuthUser, db_dep, require_roles
from app.api.services import log_event
from app.core.config import settings
from app.models.entities import Tenant, UserRole

router = APIRouter(prefix="/tenant", tags=["tenant"])


class TenantUpsertIn(BaseModel):
    name: str = Field(min_length=2)
    slug: str = Field(min_length=2, pattern=r"^[a-z0-9-]+$")
    timezone: str
    service_days: list[str]
    windowA_start: time
    windowA_end: time
    windowB_start: time
    windowB_end: time
    capacity_per_window: int = Field(ge=1)

    @field_validator("service_days")
    @classmethod
    def validate_days(cls, values: list[str]):
        allowed = {"mon", "tue", "wed", "thu", "fri", "sat", "sun"}
        if not values or any(v not in allowed for v in values):
            raise ValueError("service_days must contain weekday tokens")
        return values

    @field_validator("windowB_start")
    @classmethod
    def window_order(cls, v: time, info):
        if "windowA_end" in info.data and v < info.data["windowA_end"]:
            raise ValueError("Window ranges must not overlap")
        return v


def _platform_guard(x_platform_admin: str = Header(default="")):
    if not settings.jwt_secret or x_platform_admin != settings.jwt_secret:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail={"code": "forbidden", "message": "Platform admin required"})


@router.post("", dependencies=[Depends(_platform_guard)])
def create_tenant(payload: TenantUpsertIn, db: Session = Depends(db_dep)):
    existing = db.execute(select(Tenant).where(Tenant.slug == payload.slug)).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail={"code": "slug_taken", "message": "Tenant slug already exists"})
    tenant = Tenant(**payload.model_dump())
    db.add(tenant)
    db.commit()
    db.refresh(tenant)
    log_event(db, tenant.id, "tenant.created", "api", {"slug": tenant.slug, "name": tenant.name})
    db.commit()
    return {"id": str(tenant.id), "slug": tenant.slug}


@router.get("/settings")
def get_settings(user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)), db: Session = Depends(db_dep)):
    tenant = db.execute(select(Tenant).where(Tenant.id == user.tenant_id)).scalar_one()
    return {
        "name": tenant.name,
        "slug": tenant.slug,
        "timezone": tenant.timezone,
        "service_days": tenant.service_days,
        "windowA_start": tenant.windowA_start.isoformat(),
        "windowA_end": tenant.windowA_end.isoformat(),
        "windowB_start": tenant.windowB_start.isoformat(),
        "windowB_end": tenant.windowB_end.isoformat(),
        "capacity_per_window": tenant.capacity_per_window,
    }


@router.put("/settings")
def update_settings(payload: TenantUpsertIn, user: AuthUser = Depends(require_roles(UserRole.ADMIN)), db: Session = Depends(db_dep)):
    tenant = db.execute(select(Tenant).where(Tenant.id == user.tenant_id)).scalar_one()
    if payload.slug != tenant.slug:
        raise HTTPException(status_code=400, detail={"code": "slug_immutable", "message": "Tenant slug cannot be changed here"})
    for key, value in payload.model_dump().items():
        setattr(tenant, key, value)
    db.add(tenant)
    log_event(db, user.tenant_id, "tenant.settings.updated", "api", payload.model_dump(mode="json"))
    db.commit()
    return {"status": "ok"}
