from datetime import datetime, timedelta, timezone
from uuid import uuid4

import boto3
from botocore.client import Config
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import AuthUser, db_dep, require_roles
from app.api.services import log_event
from app.core.config import settings
from app.models.entities import Drop, Load, UserRole

router = APIRouter(prefix="/uploads", tags=["uploads"])


class PresignIn(BaseModel):
    entity_type: str
    entity_id: str
    content_type: str = "image/jpeg"


class ConfirmIn(BaseModel):
    entity_type: str
    entity_id: str
    object_key: str


def _storage_client():
    if not all([settings.r2_endpoint_url, settings.r2_access_key_id, settings.r2_secret_access_key, settings.r2_bucket]):
        raise HTTPException(status_code=500, detail={"code": "r2_not_configured", "message": "R2 config missing"})
    return boto3.client(
        "s3",
        endpoint_url=settings.r2_endpoint_url,
        aws_access_key_id=settings.r2_access_key_id,
        aws_secret_access_key=settings.r2_secret_access_key,
        config=Config(signature_version="s3v4"),
    )


def _photo_url(object_key: str) -> str:
    return f"{settings.r2_endpoint_url.rstrip('/')}/{settings.r2_bucket}/{object_key}"


@router.post("/presign")
def create_presigned_upload(
    payload: PresignIn,
    user: AuthUser = Depends(require_roles(UserRole.DRIVER, UserRole.DISPATCHER, UserRole.ADMIN)),
    db: Session = Depends(db_dep),
):
    if payload.content_type != "image/jpeg":
        raise HTTPException(status_code=400, detail={"code": "invalid_content_type", "message": "Only image/jpeg is supported"})
    if payload.entity_type not in {"DROP_PHOTO", "POD_PHOTO", "EXCEPTION_PHOTO"}:
        raise HTTPException(status_code=400, detail={"code": "invalid_entity_type", "message": "Unsupported entity_type"})

    if payload.entity_type == "DROP_PHOTO":
        exists = db.execute(select(Drop.id).where(Drop.tenant_id == user.tenant_id, Drop.id == payload.entity_id)).scalar_one_or_none()
    else:
        exists = db.execute(select(Load.id).where(Load.tenant_id == user.tenant_id, Load.id == payload.entity_id)).scalar_one_or_none()
    if not exists:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Entity not found"})

    object_key = f"{user.tenant_id}/{payload.entity_type.lower()}/{payload.entity_id}/{uuid4()}.jpg"
    expires_in = 600
    url = _storage_client().generate_presigned_url(
        "put_object",
        Params={"Bucket": settings.r2_bucket, "Key": object_key, "ContentType": payload.content_type},
        ExpiresIn=expires_in,
        HttpMethod="PUT",
    )
    return {
        "upload_url": url,
        "object_key": object_key,
        "expires_at": (datetime.now(timezone.utc) + timedelta(seconds=expires_in)).isoformat(),
    }


@router.post("/confirm")
def confirm_upload(
    payload: ConfirmIn,
    user: AuthUser = Depends(require_roles(UserRole.DRIVER, UserRole.DISPATCHER, UserRole.ADMIN)),
    db: Session = Depends(db_dep),
):
    if payload.entity_type == "DROP_PHOTO":
        drop = db.execute(select(Drop).where(Drop.tenant_id == user.tenant_id, Drop.id == payload.entity_id).with_for_update()).scalar_one_or_none()
        if not drop:
            raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Drop not found"})
        drop.drop_photos = [*drop.drop_photos, _photo_url(payload.object_key)]
    elif payload.entity_type == "POD_PHOTO":
        load = db.execute(select(Load).where(Load.tenant_id == user.tenant_id, Load.id == payload.entity_id).with_for_update()).scalar_one_or_none()
        if not load:
            raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Load not found"})
        load.pod_photo_url = _photo_url(payload.object_key)
    elif payload.entity_type == "EXCEPTION_PHOTO":
        load = db.execute(select(Load).where(Load.tenant_id == user.tenant_id, Load.id == payload.entity_id).with_for_update()).scalar_one_or_none()
        if not load:
            raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Load not found"})
        load.exception_photo_url = _photo_url(payload.object_key)
    elif payload.entity_type == "CONDITION_PHOTO":
        load = db.execute(select(Load).where(Load.tenant_id == user.tenant_id, Load.id == payload.entity_id).with_for_update()).scalar_one_or_none()
        if not load:
            raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Load not found"})
        load.condition_photo_url = _photo_url(payload.object_key)
    else:
        raise HTTPException(status_code=400, detail={"code": "invalid_entity_type", "message": "Unsupported entity_type"})

    log_event(db, user.tenant_id, "PHOTO_ATTACHED", "api", payload.model_dump())
    db.commit()
    return {"status": "confirmed", "photo_url": _photo_url(payload.object_key)}
