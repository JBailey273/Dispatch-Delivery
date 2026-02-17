from fastapi import APIRouter, Depends

from app.api.deps import get_current_user, require_channel_api_key

router = APIRouter(prefix="/product-catalog", tags=["product-catalog"])


@router.post("/import")
def import_product_catalog(
    _user: dict = Depends(get_current_user),
    _channel_api_key: str = Depends(require_channel_api_key),
) -> dict:
    # V1 Build Scope: channel-ingested product catalog import placeholder.
    return {"status": "queued", "message": "Product catalog import scaffold endpoint."}


@router.get("")
def list_product_catalog(_user: dict = Depends(get_current_user)) -> dict:
    # V1 Build Scope: tenant-scoped product catalog listing placeholder.
    return {"items": []}
