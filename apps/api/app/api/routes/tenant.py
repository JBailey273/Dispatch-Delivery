from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import AuthUser, db_dep, require_roles
from app.models.entities import Tenant, UserRole

router = APIRouter(prefix="/tenant", tags=["tenant"])


@router.get("/settings")
def get_settings(user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)), db: Session = Depends(db_dep)):
    tenant = db.execute(select(Tenant).where(Tenant.id == user.tenant_id)).scalar_one()
    return {
        "timezone": tenant.timezone,
        "service_days": tenant.service_days,
        "windowA_start": tenant.windowA_start.isoformat(),
        "windowA_end": tenant.windowA_end.isoformat(),
        "windowB_start": tenant.windowB_start.isoformat(),
        "windowB_end": tenant.windowB_end.isoformat(),
        "capacity_per_window": tenant.capacity_per_window,
    }
