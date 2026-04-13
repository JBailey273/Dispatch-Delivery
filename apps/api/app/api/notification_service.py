"""
Unified customer notification service.
Handles channel routing (SMS / email / both) based on customer preferences.
All notification types route through notify_customer().
"""
import logging
from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.api.services import enqueue_sms_job, now_utc
from app.models.entities import Customer, Drop, WindowCode

logger = logging.getLogger("dispatch.notifications")


@dataclass
class NotifyResult:
    sms_sent: bool = False
    email_sent: bool = False

    @property
    def any_sent(self) -> bool:
        return self.sms_sent or self.email_sent

    def to_dict(self) -> dict:
        return {"sms_sent": self.sms_sent, "email_sent": self.email_sent}


def _window_label(drop: Drop, db: Session = None) -> str:
    if drop.is_priority and not drop.scheduled_window:
        return "Priority Delivery"
    if db and drop.location_id:
        from app.models.entities import Location, WindowCode
        from sqlalchemy import select
        location = db.execute(
            select(Location).where(Location.id == drop.location_id)
        ).scalar_one_or_none()
        if location and drop.scheduled_window:
            from app.api.routes.availability import _fmt_window_range
            time_range = _fmt_window_range(location, drop.scheduled_window)
            label = "Morning" if drop.scheduled_window.value == "A" else "Afternoon"
            return f"{label} ({time_range})"
    # fallback if no db or location
    if drop.scheduled_window and drop.scheduled_window.value == "A":
        return "Morning (9am–1pm)"
    return "Afternoon (1pm–5pm)"


def _date_label(drop: Drop) -> str:
    if drop.scheduled_date:
        return drop.scheduled_date.strftime("%A, %B %d")
    return "your scheduled date"


def notify_customer(
    db: Session,
    tenant_id,
    drop: Drop,
    customer: Customer,
    notification_type: str,
    context: dict | None = None,
) -> NotifyResult:
    # Pre-resolve window label once for this notification
    _wlabel = _window_label(drop, db)
    """
    Send a notification to a customer via their preferred channel(s).

    notification_type: "on_the_way" | "reschedule" | "scheduling_link" | "pickup_ready"
    context keys:
      - scheduling_link (str): required for scheduling_link type
      - driver_user_id (str): optional, for logging on on_the_way
    """
    from app.api.email_service import (
        send_on_the_way_email,
        send_reschedule_notification_email,
        send_scheduling_link_email,
        send_pickup_ready_email,
    )

    context = context or {}
    result = NotifyResult()

    has_sms = bool(customer.sms_opt_in and customer.phone_e164)
    has_email = bool(customer.email and customer.email_opt_in)

    if not has_sms and not has_email:
        return result  # caller should check any_sent and raise 400

    # ── Build SMS message ─────────────────────────────────────────────────────
    if has_sms:
        sms_message = None
        dedupe_key = None

        if notification_type == "on_the_way":
            sms_message = (
                f"Your delivery from East Meadow Garden Center is on the way! "
                f"Your driver will arrive within 30 minutes."
            )
            dedupe_key = f"drop-on-the-way-{drop.id}"

        elif notification_type == "reschedule":
            sms_message = context.get("message") or (
                f"Your East Meadow Garden Center delivery has been rescheduled to "
                f"{_date_label(drop)}, {_wlabel}. "
                f"Reply to this message with any questions."
            )
            dedupe_key = f"reschedule-{drop.id}-{int(now_utc().timestamp() // 300)}"

        elif notification_type == "scheduling_link":
            link = context.get("scheduling_link", "")
            first = customer.name.split()[0] if customer.name else "there"
            sms_message = (
                f"Hi {first}, please use this link to schedule your delivery "
                f"from East Meadow Garden Center: {link}"
            )
            dedupe_key = f"schedlink-{drop.id}-{int(now_utc().timestamp() // 300)}"

        elif notification_type == "pickup_ready":
            order_label = f"Order #{drop.order_number}" if drop.order_number else "Your order"
            sms_message = (
                f"{order_label} is ready for pickup at East Meadow Garden Center! "
                f"Head to the yard desk when you arrive."
            )
            dedupe_key = f"pickup-ready-sms-{drop.id}"

        elif notification_type == "delivered":
            sms_message = (
                f"Your East Meadow Garden Center delivery has been completed! "
                f"Thank you for your order."
            )
            dedupe_key = f"drop-delivered-{drop.id}"

        if sms_message and dedupe_key:
            job = {
                "type": "SEND_SMS",
                "tenant_id": str(tenant_id),
                "drop_id": str(drop.id),
                "to": customer.phone_e164,
                "template": "custom",
                "message": sms_message,
            }
            result.sms_sent = bool(enqueue_sms_job(job, dedupe_key=dedupe_key))

    # ── Send email ────────────────────────────────────────────────────────────
    if has_email:
        try:
            if notification_type == "on_the_way":
                result.email_sent = send_on_the_way_email(
                    customer.email,
                    customer.name,
                    _date_label(drop),
                    _wlabel,
                )
            elif notification_type == "reschedule":
                result.email_sent = send_reschedule_notification_email(
                    customer.email,
                    customer.name,
                    _date_label(drop),
                    _wlabel,
                )

            elif notification_type == "scheduling_link":
                link = context.get("scheduling_link", "")
                result.email_sent = send_scheduling_link_email(
                    customer.email,
                    customer.name,
                    link,
                )

            elif notification_type == "pickup_ready":
                items = context.get("items", [])
                result.email_sent = send_pickup_ready_email(
                    customer.email,
                    customer.name,
                    drop.order_number,
                    items,
                )

            elif notification_type == "delivered":
                pod_photo_url = context.get("pod_photo_url")
                from zoneinfo import ZoneInfo
                eastern = ZoneInfo("America/New_York")
                local_now = now_utc().astimezone(eastern)
                tz_label = "EDT" if local_now.dst() else "EST"
                date_label = local_now.strftime("%A, %B %d at %-I:%M %p") + f" {tz_label}"
                from app.api.email_service import send_delivery_confirmation_email
                result.email_sent = send_delivery_confirmation_email(
                    customer.email,
                    customer.name,
                    date_label,
                    pod_photo_url,
                )
        except Exception:
            logger.exception(f"Email send failed for {notification_type} drop={drop.id}")

    return result
