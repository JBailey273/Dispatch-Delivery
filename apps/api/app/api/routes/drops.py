from fastapi import APIRouter, Depends

from app.api.deps import get_current_user

router = APIRouter(prefix="/drops", tags=["drops"])


@router.post("/manual")
def create_manual_drop(_user: dict = Depends(get_current_user)) -> dict:
    # V1 Build Scope: manual drop creation placeholder.
    return {"status": "created", "message": "Manual drop scaffold endpoint."}
