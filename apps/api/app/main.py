from fastapi import FastAPI

from app.api.router import api_router
from app.core.config import settings

app = FastAPI(title=settings.app_name)
app.include_router(api_router, prefix=settings.api_prefix)


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok"}
