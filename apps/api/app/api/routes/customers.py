from fastapi import APIRouter, Depends

from app.api.deps import get_current_user

router = APIRouter(prefix="/customers", tags=["customers"])


@router.get("/search")
def search_customers(query: str, _user: dict = Depends(get_current_user)) -> dict:
    # V1 Build Scope: customer search placeholder.
    return {"query": query, "results": []}


@router.post("")
def create_customer(_user: dict = Depends(get_current_user)) -> dict:
    # V1 Build Scope: customer creation placeholder.
    return {"status": "created", "message": "Customer scaffold endpoint."}
