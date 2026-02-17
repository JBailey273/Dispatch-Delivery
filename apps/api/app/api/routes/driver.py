from fastapi import APIRouter, Depends

from app.api.deps import get_current_user

router = APIRouter(prefix="/driver", tags=["driver"])


@router.get("/loads")
def poll_driver_loads(_user: dict = Depends(get_current_user)) -> dict:
    # V1 Build Scope: driver load polling placeholder.
    return {"loads": []}


@router.post("/loads/{load_id}/status")
def update_load_status(load_id: str, _user: dict = Depends(get_current_user)) -> dict:
    # V1 Build Scope: driver status updates placeholder.
    return {"load_id": load_id, "status": "updated"}
