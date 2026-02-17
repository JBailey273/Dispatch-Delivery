from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import db_dep
from app.core.bootstrap import ensure_dev_seed
from app.core.security import create_access_token, verify_password
from app.models.entities import Tenant, User
from app.schemas.auth import LoginRequest, TokenResponse

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, db: Session = Depends(db_dep)) -> TokenResponse:
    ensure_dev_seed(db)
    user = db.execute(select(User).where(User.email == payload.email)).scalar_one_or_none()
    if not user or not user.is_active or not verify_password(payload.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "invalid_credentials", "message": "Email or password is invalid"},
        )
    tenant = db.execute(select(Tenant).where(Tenant.id == user.tenant_id)).scalar_one()
    token = create_access_token(subject=str(user.id), extra_claims={"role": user.role.value, "tenant_id": str(user.tenant_id), "tenant_slug": tenant.slug})
    return TokenResponse(access_token=token, role=user.role.value, tenant_id=str(user.tenant_id))
