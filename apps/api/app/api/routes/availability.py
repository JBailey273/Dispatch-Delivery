from fastapi import APIRouter, Depends

from app.api.deps import get_current_user

router = APIRouter(prefix="/availability", tags=["availability"])


@router.get("")
def check_availability(_user: dict = Depends(get_current_user)) -> dict:
    # V1 Build Scope: availability check placeholder.
    return {"windows": []}


@router.post("/holds")
def create_hold(_user: dict = Depends(get_current_user)) -> dict:
    # V1 Build Scope: hold creation placeholder.
    return {"status": "held", "message": "Hold scaffold endpoint."}
