from datetime import date, timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import AuthUser, db_dep, require_roles
from app.models.entities import Tenant, UserRole, WindowCapacity, WindowCode

router = APIRouter(prefix="/availability", tags=["availability"])


@router.get("")
def check_availability(
    required_loads: int = Query(default=1, ge=0),
    start_date: date | None = Query(default=None),
    days: int = Query(default=7, ge=1, le=21),
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)),
    db: Session = Depends(db_dep),
) -> dict:
    tenant = db.execute(select(Tenant).where(Tenant.id == user.tenant_id)).scalar_one()
    start = start_date or date.today()
    windows = []
    for i in range(days):
        d = start + timedelta(days=i)
        for w in [WindowCode.A, WindowCode.B]:
            cap = db.execute(select(WindowCapacity).where(WindowCapacity.tenant_id == user.tenant_id, WindowCapacity.service_date == d, WindowCapacity.window_code == w)).scalar_one_or_none()
            total = cap.capacity_total if cap else tenant.capacity_per_window
            used = cap.capacity_used if cap else 0
            windows.append({"date": str(d), "window": w.value, "used": used, "total": total, "available": (total - used) >= required_loads})
    return {"required_loads": required_loads, "windows": windows}
