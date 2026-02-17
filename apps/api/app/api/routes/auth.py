from fastapi import APIRouter

from app.core.security import create_access_token
from app.schemas.auth import LoginRequest, TokenResponse

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest) -> TokenResponse:
    # V1 Build Scope: placeholder login endpoint; real credential verification comes later.
    token = create_access_token(subject=payload.email, extra_claims={"role": "dispatcher", "tenant_id": "placeholder-tenant"})
    return TokenResponse(access_token=token)
