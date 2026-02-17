from fastapi import APIRouter, Depends

from app.api.deps import get_current_user

router = APIRouter(prefix="/sms", tags=["sms"])


@router.post("/enqueue")
def enqueue_sms(_user: dict = Depends(get_current_user)) -> dict:
    # V1 Build Scope: queue SMS job placeholder for worker/Twilio pipeline.
    return {"status": "queued"}
