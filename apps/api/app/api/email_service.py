import logging
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from app.core.config import settings

logger = logging.getLogger("dispatch.email")


def send_email(to: str, subject: str, body_html: str, body_text: str | None = None) -> bool:
    """Send a transactional email via Office 365 SMTP. Returns True on success."""
    if not settings.smtp_user or not settings.smtp_password:
        logger.warning("SMTP credentials not configured — skipping email send")
        return False

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = f"{settings.smtp_from_name} <{settings.smtp_user}>"
    msg["To"] = to

    if body_text:
        msg.attach(MIMEText(body_text, "plain"))
    msg.attach(MIMEText(body_html, "html"))

    try:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=10) as server:
            server.ehlo()
            server.starttls()
            server.ehlo()
            server.login(settings.smtp_user, settings.smtp_password)
            server.sendmail(settings.smtp_user, to, msg.as_string())
        logger.info(f"Email sent to {to} — {subject}")
        return True
    except Exception as e:
        logger.error(f"Email send failed to {to}: {e}")
        return False


def send_delivery_notification_email(to: str, customer_name: str, scheduled_date: str, window_label: str) -> bool:
    first_name = customer_name.split()[0] if customer_name else "there"
    subject = f"Your Delivery is Scheduled — {scheduled_date}"
    body_html = f"""
    <div style="font-family: sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #166534;">East Meadow Garden Center</h2>
      <p>Hi {first_name},</p>
      <p>Your delivery is confirmed for <strong>{scheduled_date}</strong> during the <strong>{window_label}</strong> window.</p>
      <p>Please ensure the delivery area is accessible. If you have any questions, reply to this email or call us directly.</p>
      <p style="margin-top: 24px; color: #6b7280; font-size: 13px;">East Meadow Garden Center</p>
    </div>
    """
    body_text = f"Hi {first_name}, your delivery is confirmed for {scheduled_date} ({window_label}). Please ensure the delivery area is accessible."
    return send_email(to, subject, body_html, body_text)


def send_reschedule_notification_email(to: str, customer_name: str, scheduled_date: str, window_label: str) -> bool:
    first_name = customer_name.split()[0] if customer_name else "there"
    subject = f"Your Delivery Has Been Rescheduled — {scheduled_date}"
    body_html = f"""
    <div style="font-family: sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #166534;">East Meadow Garden Center</h2>
      <p>Hi {first_name},</p>
      <p>Your delivery has been rescheduled to <strong>{scheduled_date}</strong> during the <strong>{window_label}</strong> window.</p>
      <p>If you have any questions or need to make changes, please reply to this email or call us directly.</p>
      <p style="margin-top: 24px; color: #6b7280; font-size: 13px;">East Meadow Garden Center</p>
    </div>
    """
    body_text = f"Hi {first_name}, your delivery has been rescheduled to {scheduled_date} ({window_label}). Contact us with any questions."
    return send_email(to, subject, body_html, body_text)
