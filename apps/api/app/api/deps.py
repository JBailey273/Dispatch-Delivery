import uuid
from dataclasses import dataclass
from hashlib import sha256

from fastapi import Depends, Header, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import get_db
from app.models.entities import Channel, Tenant, UserRole

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login")


@dataclass
class AuthUser:
    user_id: uuid.UUID
    tenant_id: uuid.UUID
    role: UserRole


def api_error(detail: str, code: str = "bad_request") -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail={"code": code, "message": detail})


def _enforce_tenant_guard(db: Session, request: Request | None, tenant_id: uuid.UUID) -> None:
    tenant_slug = getattr(request.state, "tenant_slug", None) if request else None
    if not tenant_slug:
        return
    tenant = db.query(Tenant).filter(Tenant.id == tenant_id).one_or_none()
    if tenant and tenant.slug != tenant_slug:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail={"code": "cross_tenant_forbidden", "message": "Cross-tenant access denied"})


def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db), request: Request = None) -> AuthUser:
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
        role_str = payload["role"].upper()
        user = AuthUser(
            user_id=uuid.UUID(payload["sub"]),
            role=UserRole(role_str),
            tenant_id=uuid.UUID(payload["tenant_id"]),
        )
        _enforce_tenant_guard(db, request, user.tenant_id)
        return user
    except (JWTError, KeyError, ValueError) as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail={"code": "unauthorized", "message": "Invalid token"}) from exc


def require_roles(*roles: UserRole):
    def _inner(user: AuthUser = Depends(get_current_user)) -> AuthUser:
        if user.role == UserRole.ADMIN or user.role in roles:
            return user
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail={"code": "forbidden", "message": "Insufficient role"})

    return _inner


def db_dep(db: Session = Depends(get_db)) -> Session:
    return db


@dataclass
class ChannelAuth:
    tenant_id: uuid.UUID
    channel_id: uuid.UUID


def require_channel(x_channel_key: str = Header(alias="X-Channel-Key"), db: Session = Depends(db_dep), request: Request = None) -> ChannelAuth:
    key_hash = sha256(x_channel_key.encode("utf-8")).hexdigest()
    channel = db.query(Channel).filter(Channel.api_key_hash == key_hash, Channel.is_active == True).one_or_none()  # noqa: E712
    if not channel:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail={"code": "unauthorized", "message": "Invalid channel key"})
    _enforce_tenant_guard(db, request, channel.tenant_id)
    channel.last_called_at = __import__("datetime").datetime.utcnow()
    db.add(channel)
    db.commit()
    return ChannelAuth(tenant_id=channel.tenant_id, channel_id=channel.id)
