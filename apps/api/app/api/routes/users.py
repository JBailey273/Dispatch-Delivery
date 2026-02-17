from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import AuthUser, db_dep, require_roles
from app.api.services import log_event
from app.billing.service import evaluate_limit
from app.core.security import get_password_hash
from app.models.entities import User, UserRole

router = APIRouter(prefix="/users", tags=["users"])


class UserCreateIn(BaseModel):
    email: EmailStr
    password: str
    role: UserRole
    is_active: bool = True
    default_truck_identifier: str | None = None


class UserUpdateIn(BaseModel):
    role: UserRole | None = None
    is_active: bool | None = None
    default_truck_identifier: str | None = None


def _active_admin_count(db: Session, tenant_id: str) -> int:
    return int(
        db.execute(select(func.count(User.id)).where(User.tenant_id == tenant_id, User.role == UserRole.ADMIN, User.is_active.is_(True))).scalar_one()
    )


@router.get("")
def list_users(user: AuthUser = Depends(require_roles(UserRole.ADMIN)), db: Session = Depends(db_dep)):
    users = db.execute(select(User).where(User.tenant_id == user.tenant_id)).scalars().all()
    return {"items": [{"id": str(u.id), "email": u.email, "role": u.role.value, "is_active": u.is_active, "default_truck_identifier": u.default_truck_identifier} for u in users]}


@router.post("")
def create_user(payload: UserCreateIn, user: AuthUser = Depends(require_roles(UserRole.ADMIN)), db: Session = Depends(db_dep)):
    exists = db.execute(select(User.id).where(User.tenant_id == user.tenant_id, User.email == payload.email)).scalar_one_or_none()
    if exists:
        raise HTTPException(status_code=409, detail={"code": "duplicate_user", "message": "User email already exists"})
    if payload.role in {UserRole.DRIVER, UserRole.DISPATCHER}:
        active_count = db.execute(select(func.count(User.id)).where(User.tenant_id == user.tenant_id, User.role == payload.role, User.is_active == True)).scalar_one()  # noqa: E712
        resource = "max_drivers" if payload.role == UserRole.DRIVER else "max_dispatchers"
        gate = evaluate_limit(db, user.tenant_id, resource, int(active_count) + (1 if payload.is_active else 0))
        if not gate.allowed:
            raise HTTPException(status_code=402, detail={"code": gate.code, "message": gate.message, "upgrade_required": gate.upgrade_required})
    new_user = User(
        tenant_id=user.tenant_id,
        email=payload.email,
        hashed_password=get_password_hash(payload.password),
        role=payload.role,
        is_active=payload.is_active,
        default_truck_identifier=payload.default_truck_identifier,
    )
    db.add(new_user)
    log_event(db, user.tenant_id, "user.created", "api", {"email": payload.email, "role": payload.role.value})
    db.commit()
    return {"id": str(new_user.id)}


@router.patch("/{user_id}")
def update_user(user_id: str, payload: UserUpdateIn, actor: AuthUser = Depends(require_roles(UserRole.ADMIN)), db: Session = Depends(db_dep)):
    target = db.execute(select(User).where(User.id == user_id, User.tenant_id == actor.tenant_id)).scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "User not found"})

    if payload.role and target.role == UserRole.ADMIN and payload.role != UserRole.ADMIN and _active_admin_count(db, actor.tenant_id) <= 1:
        raise HTTPException(status_code=400, detail={"code": "last_admin", "message": "Cannot remove last Admin role"})

    if payload.is_active is False and target.role == UserRole.ADMIN and target.is_active and _active_admin_count(db, actor.tenant_id) <= 1:
        raise HTTPException(status_code=400, detail={"code": "last_admin", "message": "Cannot disable the last active Admin"})

    updates = payload.model_dump(exclude_unset=True)
    for key, value in updates.items():
        setattr(target, key, value)
    db.add(target)
    log_event(db, actor.tenant_id, "user.updated", "api", {"user_id": user_id, "updates": updates})
    db.commit()
    return {"status": "ok"}


@router.delete("/{user_id}")
def delete_user(user_id: str, actor: AuthUser = Depends(require_roles(UserRole.ADMIN)), db: Session = Depends(db_dep)):
    target = db.execute(select(User).where(User.id == user_id, User.tenant_id == actor.tenant_id)).scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "User not found"})
    if target.role == UserRole.ADMIN and target.is_active and _active_admin_count(db, actor.tenant_id) <= 1:
        raise HTTPException(status_code=400, detail={"code": "last_admin", "message": "Cannot delete the last active Admin"})
    db.delete(target)
    log_event(db, actor.tenant_id, "user.deleted", "api", {"user_id": user_id, "email": target.email})
    db.commit()
    return {"status": "ok"}
