from fastapi import APIRouter, Depends

from app.api.deps import get_current_user

router = APIRouter(prefix="/uploads", tags=["uploads"])


@router.post("/presign")
def create_presigned_upload(_user: dict = Depends(get_current_user)) -> dict:
    # V1 Build Scope: Cloudflare R2 pre-sign upload scaffold.
    return {"upload_url": "https://example.com/presigned", "fields": {}}


@router.post("/confirm")
def confirm_upload(_user: dict = Depends(get_current_user)) -> dict:
    # V1 Build Scope: upload completion confirmation placeholder.
    return {"status": "confirmed"}
