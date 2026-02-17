from hashlib import sha256
from secrets import token_urlsafe

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import AuthUser, db_dep, require_roles
from app.models.entities import Channel, ChannelType, UserRole

router = APIRouter(prefix="/channels", tags=["channels"])


class CreateChannelIn(BaseModel):
    name: str
    type: ChannelType


@router.post("")
def create_channel(payload: CreateChannelIn, user: AuthUser = Depends(require_roles(UserRole.ADMIN)), db: Session = Depends(db_dep)):
    if payload.type != ChannelType.WOOCOMMERCE:
        raise HTTPException(status_code=400, detail={"code": "unsupported_channel", "message": "Only woocommerce is supported"})
    api_key = token_urlsafe(32)
    channel = Channel(
        tenant_id=user.tenant_id,
        name=payload.name,
        channel_type=payload.type,
        api_key_hash=sha256(api_key.encode("utf-8")).hexdigest(),
        is_active=True,
    )
    db.add(channel)
    db.commit()
    return {
        "id": str(channel.id),
        "name": channel.name,
        "type": channel.channel_type.value,
        "status": "active" if channel.is_active else "inactive",
        "api_key": api_key,
    }


@router.get("")
def list_channels(user: AuthUser = Depends(require_roles(UserRole.ADMIN, UserRole.DISPATCHER)), db: Session = Depends(db_dep)):
    channels = db.execute(select(Channel).where(Channel.tenant_id == user.tenant_id)).scalars().all()
    return {
        "items": [
            {"id": str(c.id), "name": c.name, "type": c.channel_type.value, "status": "active" if c.is_active else "inactive"}
            for c in channels
        ]
    }

