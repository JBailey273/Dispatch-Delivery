from fastapi import Depends, Header, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import get_db

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login")


def get_current_user(token: str = Depends(oauth2_scheme)) -> dict:
    # V1 Build Scope: role-aware JWT auth scaffold for Admin/Dispatcher/Driver.
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
        return {"user_id": payload.get("sub"), "role": payload.get("role"), "tenant_id": payload.get("tenant_id")}
    except JWTError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token") from exc


def require_channel_api_key(x_channel_api_key: str | None = Header(default=None)) -> str:
    # V1 Build Scope: API-key auth scaffold for channel integrations.
    if not x_channel_api_key:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing channel API key")
    return x_channel_api_key


def db_dep(db: Session = Depends(get_db)) -> Session:
    return db
