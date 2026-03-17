import logging
import urllib.request
import urllib.error
import json

from app.core.config import settings

logger = logging.getLogger("dispatch.email")


def send_email(to: str, subject: str, body_html: str, body_text: str | None = None) -> bool:
    if not settings.resend_api_key:
        logger.warning("RESEND_API_KEY not configured — skipping email send")
        return False

    payload = {
        "from": f"{settings.smtp_from_name} <info@eastmeadowgardencenter.com>",
        "to": [to],
        "subject": subject,
        "html": body_html,
    }
    if body_text:
        payload["text"] = body_text

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        "https://api.resend.com/emails",
        data=data,
        headers={
            "Authorization": f"Bearer {settings.resend_api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            logger.info(f"Email sent to {to} — {subject} (status {resp.status})")
            return True
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        logger.error(f"Resend API error sending to {to}: {e.code} {body}")
        return False
    except Exception as e:
        logger.error(f"Email send failed to {to}: {e}")
        return False


def _layout(accent: tuple, content: str) -> str:
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet"/>
</head>
<body style="margin:0;padding:0;background:#F4F4F1;font-family:'DM Sans',Arial,sans-serif;-webkit-font-smoothing:antialiased;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F4F4F1;padding:40px 16px;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">

  <!-- Logo -->
  <tr><td style="padding-bottom:20px;" align="center">
    <table cellpadding="0" cellspacing="0"><tr>
      <td style="background:#0F8530;border-radius:10px;width:40px;height:40px;text-align:center;vertical-align:middle;">
        <span style="color:white;font-family:'Plus Jakarta Sans',Arial,sans-serif;font-size:18px;font-weight:800;line-height:40px;">E</span>
      </td>
      <td style="padding-left:10px;vertical-align:middle;">
        <span style="font-family:'Plus Jakarta Sans',Arial,sans-serif;font-size:15px;font-weight:800;color:#282824;letter-spacing:-0.02em;">East Meadow Garden Center</span>
      </td>
    </tr></table>
  </td></tr>

  <!-- Card -->
  <tr><td style="background:#FFFFFF;border-radius:16px;box-shadow:0 1px 3px rgba(23,23,20,0.08);overflow:hidden;">
    <div style="height:4px;background:linear-gradient(90deg,{accent[0]},{accent[1]});"></div>
    <div style="padding:36px 40px;">
      {content}
    </div>
  </td></tr>

  <!-- Footer -->
  <tr><td style="padding:20px 0 0;text-align:center;">
    <p style="margin:0;font-size:12px;color:#9C9C94;line-height:1.6;">
      East Meadow Garden Center &nbsp;·&nbsp; East Meadow, NY<br/>
      <span style="font-size:11px;">Questions? Reply to this email or call us directly.</span>
    </p>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>"""


def _detail_card(bg: str, border: str, label_color: str, label: str, rows: list[tuple[str, str]]) -> str:
    rows_html = "".join(f"""
      <tr><td style="padding-bottom:{'0' if i == len(rows)-1 else '14'}px;">
        <p style="margin:0;font-size:11px;font-weight:600;color:#9C9C94;text-transform:uppercase;letter-spacing:0.05em;">{r[0]}</p>
        <p style="margin:4px 0 0;font-family:'Plus Jakarta Sans',Arial,sans-serif;font-size:17px;font-weight:700;color:#171714;">{r[1]}</p>
      </td></tr>""" for i, r in enumerate(rows))
    return f"""
    <table width="100%" cellpadding="0" cellspacing="0" style="background:{bg};border:1px solid {border};border-radius:12px;margin-bottom:24px;">
      <tr><td style="padding:22px 26px;">
        <p style="margin:0 0 14px;font-family:'Plus Jakarta Sans',Arial,sans-serif;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:{label_color};">{label}</p>
        <table width="100%" cellpadding="0" cellspacing="0">{rows_html}</table>
      </td></tr>
    </table>"""


def _info_box(text: str) -> str:
    return f"""
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAF9;border:1px solid #EFEFED;border-radius:10px;margin-bottom:24px;">
      <tr><td style="padding:16px 20px;">
        <p style="margin:0;font-size:14px;color:#52524C;line-height:1.6;">{text}</p>
      </td></tr>
    </table>"""


# ── 1. On the Way ─────────────────────────────────────────────────────────────

def send_on_the_way_email(to: str, customer_name: str, scheduled_date: str, window_label: str, driver_name: str | None = None) -> bool:
    first_name = customer_name.split()[0] if customer_name else "there"
    subject = f"Your Delivery is On the Way! 🚚"
    driver_line = f"<strong>{driver_name}</strong> is" if driver_name else "Your driver is"
    content = f"""
      <h1 style="margin:0 0 8px;font-family:'Plus Jakarta Sans',Arial,sans-serif;font-size:24px;font-weight:800;color:#171714;letter-spacing:-0.02em;">Your delivery is on the way! 🚚</h1>
      <p style="margin:0 0 28px;font-size:15px;color:#6E6E66;line-height:1.55;">Hi {first_name} — {driver_line} headed your way now. Please make sure the delivery area is accessible.</p>

      {_detail_card('#F4FBF6', '#C6EDCF', '#1A9E3A', 'Delivery Details', [
          ('Date', scheduled_date),
          ('Window', window_label),
      ])}

      {_info_box('🏡 &nbsp;Please ensure your <strong>delivery area is clear and accessible</strong>. Our driver will be there shortly within your window.')}

      <p style="margin:0;font-size:14px;color:#6E6E66;line-height:1.55;">Need to reach us? Just reply to this email and we'll get back to you right away.</p>
    """
    return send_email(to, subject, _layout(('#0F8530', '#2DB84E'), content))


# ── 2. Rescheduled ────────────────────────────────────────────────────────────

def send_reschedule_notification_email(to: str, customer_name: str, scheduled_date: str, window_label: str) -> bool:
    first_name = customer_name.split()[0] if customer_name else "there"
    subject = f"Your Delivery Has Been Rescheduled — {scheduled_date}"
    content = f"""
      <h1 style="margin:0 0 8px;font-family:'Plus Jakarta Sans',Arial,sans-serif;font-size:24px;font-weight:800;color:#171714;letter-spacing:-0.02em;">Your delivery has been rescheduled</h1>
      <p style="margin:0 0 28px;font-size:15px;color:#6E6E66;line-height:1.55;">Hi {first_name} — we've updated your delivery to a new date and time. Here are your updated details:</p>

      {_detail_card('#FFF9EB', '#FEDF89', '#DC6803', 'Updated Delivery Details', [
          ('New Date', scheduled_date),
          ('Window', window_label),
      ])}

      {_info_box("📅 &nbsp;Please note your <strong>updated delivery window</strong> and make sure the delivery area is accessible. If this date doesn't work, just reply to this email and we'll find a better time.")}

      <p style="margin:0;font-size:14px;color:#6E6E66;line-height:1.55;">We apologize for any inconvenience and appreciate your patience.</p>
    """
    return send_email(to, subject, _layout(('#DC6803', '#FDB022'), content))


# ── 3. Delivered ──────────────────────────────────────────────────────────────

def send_delivery_confirmation_email(to: str, customer_name: str, scheduled_date: str, pod_photo_url: str | None = None) -> bool:
    first_name = customer_name.split()[0] if customer_name else "there"
    subject = "Your Delivery is Complete ✅"
    pod_section = ""
    if pod_photo_url:
        pod_section = f"""
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr><td>
        <p style="margin:0 0 10px;font-family:'Plus Jakarta Sans',Arial,sans-serif;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:#1A9E3A;">Proof of Delivery</p>
        <img src="{pod_photo_url}" alt="Proof of delivery photo" width="100%" style="border-radius:10px;display:block;max-width:480px;border:1px solid #EFEFED;" />
      </td></tr>
    </table>"""

    content = f"""
      <h1 style="margin:0 0 8px;font-family:'Plus Jakarta Sans',Arial,sans-serif;font-size:24px;font-weight:800;color:#171714;letter-spacing:-0.02em;">Your delivery is complete! ✅</h1>
      <p style="margin:0 0 28px;font-size:15px;color:#6E6E66;line-height:1.55;">Hi {first_name} — great news! Your delivery from East Meadow Garden Center has been successfully completed.</p>

      {_detail_card('#F4FBF6', '#C6EDCF', '#1A9E3A', 'Delivery Summary', [
          ('Delivered On', scheduled_date),
      ])}

      {pod_section}

      {_info_box("🌿 &nbsp;Thank you for choosing East Meadow Garden Center. We hope everything arrived in perfect condition. If you have any concerns about your delivery, please reply to this email.")}

      <p style="margin:0;font-size:14px;color:#6E6E66;line-height:1.55;">We appreciate your business and look forward to serving you again!</p>
    """
    return send_email(to, subject, _layout(('#0F8530', '#2DB84E'), content))
    """
    body_text = f"Hi {first_name}, your delivery has been rescheduled to {scheduled_date} ({window_label}). Contact us with any questions."
    return send_email(to, subject, body_html, body_text)
