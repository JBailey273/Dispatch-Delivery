from sqlalchemy import select
from sqlalchemy.orm import Session

from app.billing.service import ensure_billing_account
from app.core.security import get_password_hash
from app.models.entities import Tenant, User, UserRole


def ensure_dev_seed(db: Session) -> Tenant:
    tenant = db.execute(select(Tenant).where(Tenant.slug == "default-tenant")).scalar_one_or_none()
    if tenant:
        return tenant
    tenant = Tenant(name="Default Tenant", slug="default-tenant")
    db.add(tenant)
    db.flush()

    for email, role in [
        ("admin@example.com", UserRole.ADMIN),
        ("dispatcher@example.com", UserRole.DISPATCHER),
        ("driver@example.com", UserRole.DRIVER),
    ]:
        db.add(
            User(
                tenant_id=tenant.id,
                email=email,
                hashed_password=get_password_hash("password"),
                role=role,
                is_active=True,
            )
        )
    ensure_billing_account(db, tenant.id)
    db.commit()
    db.refresh(tenant)
    return tenant
