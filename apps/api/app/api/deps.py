import uuid
from dataclasses import dataclass
from hashlib import sha256

from fastapi import Depends, Header, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import get_db
from app.models.entities import Channel, UserRole

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login")


@dataclass
class AuthUser:
    user_id: uuid.UUID
    tenant_id: uuid.UUID
    role: UserRole


def api_error(detail: str, code: str = "bad_request") -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail={"code": code, "message": detail})


def get_current_user(token: str = Depends(oauth2_scheme)) -> AuthUser:
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
        return AuthUser(
            user_id=uuid.UUID(payload["sub"]),
            role=UserRole(payload["role"]),
            tenant_id=uuid.UUID(payload["tenant_id"]),
        )
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


def require_channel(x_channel_key: str = Header(alias="X-Channel-Key"), db: Session = Depends(db_dep)) -> ChannelAuth:
    key_hash = sha256(x_channel_key.encode("utf-8")).hexdigest()
    channel = db.query(Channel).filter(Channel.api_key_hash == key_hash, Channel.is_active == True).one_or_none()  # noqa: E712
    if not channel:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail={"code": "unauthorized", "message": "Invalid channel key"})
    return ChannelAuth(tenant_id=channel.tenant_id, channel_id=channel.id)
