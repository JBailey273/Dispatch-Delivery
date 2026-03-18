import logging
import time
import uuid

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from redis import Redis
from sqlalchemy import text

from app.api.router import api_router
from app.core.config import settings
from app.db.session import SessionLocal
from app.api.routes.pickup import router as pickup_router

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("dispatch.api")

app = FastAPI(title=settings.app_name)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "https://app.eastmeadowgardencenter.com",
        "https://dispatch-web-b6qc.onrender.com",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router, prefix=settings.api_prefix)
app.include_router(pickup_router, prefix="/api/v1")


@app.middleware("http")
async def request_context_middleware(request: Request, call_next):
    correlation_id = request.headers.get("X-Correlation-ID") or str(uuid.uuid4())
    request.state.correlation_id = correlation_id

    host = request.headers.get("host", "")
    tenant_slug = request.headers.get("X-Tenant-Slug")
    if not tenant_slug and host:
        first_label = host.split(":")[0].split(".")[0]
        if first_label not in {"localhost", "127", "api", "www", "app", "dispatch-api-mb6e"}:
            tenant_slug = first_label
    if not tenant_slug and request.url.path.startswith("/t/"):
        parts = request.url.path.split("/")
        if len(parts) > 2:
            tenant_slug = parts[2]
    request.state.tenant_slug = tenant_slug

    started = time.perf_counter()
    response = await call_next(request)
    duration_ms = int((time.perf_counter() - started) * 1000)
    response.headers["X-Correlation-ID"] = correlation_id
    logger.info(
        "request",
        extra={
            "correlation_id": correlation_id,
            "method": request.method,
            "path": request.url.path,
            "status_code": response.status_code,
            "duration_ms": duration_ms,
            "tenant_slug": tenant_slug,
        },
    )
    return response


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/health/db")
def health_db() -> JSONResponse:
    try:
        with SessionLocal() as db:
            db.execute(text("SELECT 1"))
        return JSONResponse({"status": "ok"})
    except Exception as exc:
        return JSONResponse(status_code=503, content={"status": "error", "detail": str(exc)})


@app.get("/health/redis")
def health_redis() -> JSONResponse:
    try:
        client = Redis.from_url(settings.redis_url)
        client.ping()
        return JSONResponse({"status": "ok"})
    except Exception as exc:
        return JSONResponse(status_code=503, content={"status": "error", "detail": str(exc)})


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok"}
