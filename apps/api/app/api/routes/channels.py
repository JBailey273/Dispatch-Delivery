from hashlib import sha256
from secrets import token_urlsafe

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import AuthUser, db_dep, require_roles
from app.api.services import log_event
from app.models.entities import Channel, ChannelType, UserRole

router = APIRouter(prefix="/channels", tags=["channels"])


class CreateChannelIn(BaseModel):
    name: str
    type: ChannelType


@router.post("")
def create_channel(payload: CreateChannelIn, user: AuthUser = Depends(require_roles(UserRole.ADMIN)), db: Session = Depends(db_dep)):
    api_key = token_urlsafe(32)
    channel = Channel(
        tenant_id=user.tenant_id,
        name=payload.name,
        channel_type=payload.type,
        api_key_hash=sha256(api_key.encode("utf-8")).hexdigest(),
        is_active=True,
    )
    db.add(channel)
    log_event(db, user.tenant_id, "channel.created", "api", {"name": payload.name, "type": payload.type.value})
    db.commit()
    return {
        "id": str(channel.id),
        "name": channel.name,
        "type": channel.channel_type.value,
        "status": "active" if channel.is_active else "inactive",
        "api_key": api_key,
    }


@router.post("/{channel_id}/rotate-key")
def rotate_channel_key(channel_id: str, user: AuthUser = Depends(require_roles(UserRole.ADMIN)), db: Session = Depends(db_dep)):
    channel = db.execute(select(Channel).where(Channel.id == channel_id, Channel.tenant_id == user.tenant_id)).scalar_one_or_none()
    if not channel:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Channel not found"})
    api_key = token_urlsafe(32)
    channel.api_key_hash = sha256(api_key.encode("utf-8")).hexdigest()
    db.add(channel)
    log_event(db, user.tenant_id, "channel.key_rotated", "api", {"channel_id": channel_id})
    db.commit()
    return {"id": channel_id, "api_key": api_key}


@router.get("")
def list_channels(user: AuthUser = Depends(require_roles(UserRole.ADMIN)), db: Session = Depends(db_dep)):
    channels = db.execute(select(Channel).where(Channel.tenant_id == user.tenant_id)).scalars().all()
    return {
        "items": [
            {
                "id": str(c.id),
                "name": c.name,
                "type": c.channel_type.value,
                "status": "active" if c.is_active else "inactive",
                "last_call_at": c.last_called_at.isoformat() if c.last_called_at else None,
            }
            for c in channels
        ]
    }
