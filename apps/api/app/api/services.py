import csv
import io
import json
from datetime import datetime, timezone

from redis import Redis
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.entities import CustomerAddress, EventLog

SMS_QUEUE_KEY = "jobs:sms"


def log_event(db: Session, tenant_id, event_type: str, source: str, payload: dict) -> None:
    db.add(EventLog(tenant_id=tenant_id, event_type=event_type, source=source, payload_json=payload))


def redis_client() -> Redis:
    return Redis.from_url(settings.redis_url, decode_responses=True)


def enqueue_sms_job(job: dict, dedupe_key: str) -> bool:
    r = redis_client()
    if not r.set(f"dedupe:{dedupe_key}", "1", nx=True, ex=3600):
        return False
    r.rpush(SMS_QUEUE_KEY, json.dumps(job))
    return True


def normalize_us_phone(raw: str) -> str:
    digits = "".join(ch for ch in raw if ch.isdigit())
    if len(digits) == 10:
        digits = f"1{digits}"
    if len(digits) != 11 or not digits.startswith("1"):
        raise ValueError("Invalid US phone number")
    return f"+{digits}"


def parse_csv_upload(content: bytes) -> list[dict[str, str]]:
    text = content.decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))
    return [row for row in reader]


def find_matching_address(db: Session, tenant_id, customer_id, payload: dict) -> CustomerAddress | None:
    q = select(CustomerAddress).where(
        CustomerAddress.tenant_id == tenant_id,
        CustomerAddress.customer_id == customer_id,
        CustomerAddress.line1.ilike(payload["line1"]),
        CustomerAddress.city.ilike(payload["city"]),
        CustomerAddress.state.ilike(payload["state"]),
        CustomerAddress.postal_code == payload["postal_code"],
    )
    return db.execute(q).scalar_one_or_none()


def customer_search_filter(model, q: str):
    like = f"%{q}%"
    return or_(model.name.ilike(like), model.phone_e164.ilike(like))


def now_utc():
    return datetime.now(timezone.utc)
