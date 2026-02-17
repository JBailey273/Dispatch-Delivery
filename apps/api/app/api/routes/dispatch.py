from fastapi import APIRouter, Depends

from app.api.deps import get_current_user

router = APIRouter(prefix="/dispatch", tags=["dispatch"])


@router.get("/schedule")
def dispatch_schedule(_user: dict = Depends(get_current_user)) -> dict:
    # V1 Build Scope: schedule view placeholder.
    return {"loads": []}


@router.post("/reassign")
def reassign_drop(_user: dict = Depends(get_current_user)) -> dict:
    # V1 Build Scope: dispatcher reassignment placeholder.
    return {"status": "accepted", "message": "Reassignment scaffold endpoint."}
