import json
import logging
import os
from datetime import datetime, timezone
from uuid import uuid4

from redis import Redis
from sqlalchemy import create_engine, text
from twilio.rest import Client

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql+psycopg2://postgres:postgres@localhost:5432/dispatch")
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
TWILIO_ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID", "")
TWILIO_AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN", "")
TWILIO_FROM_NUMBER = os.getenv("TWILIO_FROM_NUMBER", "")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("dispatch.worker")

engine = create_engine(DATABASE_URL, future=True)
redis_client = Redis.from_url(REDIS_URL, decode_responses=True)


def _render_message(job: dict) -> str:
    if job.get("template") == "on_the_way":
        return "Your delivery is on the way. Reply to this message if you need help."
    if job.get("template") == "custom":
        return job["message"]
    return "Dispatch update"


def _log_event(conn, tenant_id: str, event_type: str, payload: dict):
    conn.execute(
        text(
            """
            INSERT INTO event_logs (id, tenant_id, event_type, source, payload_json, created_at)
            VALUES (:id, :tenant_id, :event_type, 'worker', CAST(:payload_json AS JSON), :created_at)
            """
        ),
        {
            "id": str(uuid4()),
            "tenant_id": tenant_id,
            "event_type": event_type,
            "payload_json": json.dumps(payload),
            "created_at": datetime.now(timezone.utc),
        },
    )


def process_sms_job(raw_job: str) -> dict:
    job = json.loads(raw_job)
    message = _render_message(job)
    sid = "twilio-disabled"
    if TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER:
        client = Client(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
        resp = client.messages.create(to=job["to"], from_=TWILIO_FROM_NUMBER, body=message)
        sid = resp.sid

    with engine.begin() as conn:
        _log_event(conn, job["tenant_id"], "SMS_SENT", {"drop_id": job.get("drop_id"), "to": job["to"], "message": message, "twilio_message_sid": sid})
        if job.get("drop_id") and job.get("template") == "on_the_way":
            conn.execute(text("UPDATE drops SET notify_sent_at = COALESCE(notify_sent_at, :ts) WHERE id = :drop_id"), {"ts": datetime.now(timezone.utc), "drop_id": job["drop_id"]})
    return {"status": "sent", "sid": sid}


def process_sms_queue_once(timeout_s: int = 1) -> dict:
    popped = redis_client.blpop("jobs:sms", timeout=timeout_s)
    if not popped:
        return {"status": "idle"}
    _, raw = popped
    for attempt in range(1, 4):
        try:
            return process_sms_job(raw)
        except Exception as exc:
            logger.exception("sms_send_failed", extra={"attempt": attempt, "error": str(exc)})
            if attempt == 3:
                return {"status": "failed", "error": str(exc)}
    return {"status": "failed"}


def expire_holds_job() -> dict:
    now = datetime.now(timezone.utc)
    released = 0
    with engine.begin() as conn:
        holds = conn.execute(
            text(
                """
                SELECT id, tenant_id, service_date, window_code, units_held
                FROM capacity_holds
                WHERE expires_at <= :now AND released_at IS NULL AND converted_at IS NULL
                FOR UPDATE
                """
            ),
            {"now": now},
        ).mappings().all()
        for hold in holds:
            conn.execute(text("UPDATE capacity_holds SET released_at = :now WHERE id = :id"), {"now": now, "id": hold["id"]})
            _log_event(conn, str(hold["tenant_id"]), "HOLD_EXPIRED", {"hold_id": str(hold["id"]), "units": hold["units_held"]})
            released += 1
    return {"status": "completed", "released": released}


def diagnostics_job() -> dict:
    now = datetime.now(timezone.utc)
    found = 0
    with engine.begin() as conn:
        over = conn.execute(text("SELECT id, tenant_id, service_date, window_code, capacity_used, capacity_total FROM window_capacities WHERE capacity_used > capacity_total")).mappings().all()
        for row in over:
            _log_event(conn, str(row["tenant_id"]), "anomaly.capacity_overrun", {"window_capacity_id": str(row["id"]), "service_date": str(row["service_date"]), "window": row["window_code"], "used": row["capacity_used"], "total": row["capacity_total"]})
            found += 1

        drops_zero = conn.execute(text("""
            SELECT d.id, d.tenant_id FROM drops d
            LEFT JOIN loads l ON l.drop_id = d.id
            WHERE l.id IS NULL
        """)).mappings().all()
        for row in drops_zero:
            _log_event(conn, str(row["tenant_id"]), "anomaly.drop_without_load", {"drop_id": str(row["id"])})
            found += 1

        stuck = conn.execute(text("""
            SELECT l.id, l.tenant_id, l.route_date, l.route_window
            FROM loads l
            WHERE l.status = 'assigned' AND l.route_date < CURRENT_DATE
        """)).mappings().all()
        for row in stuck:
            _log_event(conn, str(row["tenant_id"]), "anomaly.load_stuck_assigned", {"load_id": str(row["id"]), "route_date": str(row["route_date"]), "route_window": row["route_window"]})
            found += 1

        stale_holds = conn.execute(text("""
            SELECT id, tenant_id, units_held FROM capacity_holds
            WHERE expires_at <= :now AND released_at IS NULL AND converted_at IS NULL
            FOR UPDATE
        """), {"now": now}).mappings().all()
        for row in stale_holds:
            conn.execute(text("UPDATE capacity_holds SET released_at = :now WHERE id = :id"), {"now": now, "id": row["id"]})
            _log_event(conn, str(row["tenant_id"]), "anomaly.expired_hold_autoreleased", {"hold_id": str(row["id"]), "units": row["units_held"]})
            found += 1
    return {"status": "completed", "anomalies": found}
