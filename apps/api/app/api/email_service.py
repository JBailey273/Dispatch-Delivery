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
            "User-Agent": "dispatch-app/1.0",
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


def _preheader(text: str) -> str:
    return f'<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">{text}&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;</div>'


def _layout(accent: tuple, content: str, preheader_text: str = "") -> str:
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet"/>
</head>
<body style="margin:0;padding:0;background:#fafaf7;font-family:'Inter',Arial,sans-serif;-webkit-font-smoothing:antialiased;">
{_preheader(preheader_text)}
<table width="100%" cellpadding="0" cellspacing="0" style="background:#fafaf7;padding:48px 16px;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;">

  <!-- Logo header -->
  <tr><td style="padding-bottom:24px;" align="center">
    <img src="https://eastmeadowgardencenter.com/wp-content/uploads/2024/10/cropped-East-Meadow-Transparent-Logo.png"
         alt="East Meadow Garden Center"
         width="180"
         style="display:block;height:auto;filter:drop-shadow(0 2px 8px rgba(0,0,0,0.08));"
         onerror="this.style.display='none'" />
  </td></tr>

  <!-- Card -->
  <tr><td style="background:#ffffff;border-radius:16px;box-shadow:0 4px 24px rgba(74,112,82,0.10),0 1px 4px rgba(0,0,0,0.04);overflow:hidden;">
    <!-- Accent bar -->
    <div style="height:5px;background:linear-gradient(90deg,{accent[0]},{accent[1]});"></div>
    <!-- Body -->
    <div style="padding:40px 48px 44px;">
      {content}
    </div>
  </td></tr>

  <!-- Footer -->
  <tr><td style="padding:28px 0 0;text-align:center;">
    <p style="margin:0 0 6px;font-family:'Outfit',Arial,sans-serif;font-size:13px;font-weight:600;color:#4a7052;letter-spacing:0.3px;">East Meadow Garden Center</p>
    <p style="margin:0;font-size:12px;color:#999;line-height:1.6;">Questions? Reply to this email or call us directly.<br/>
    <a href="https://eastmeadowgardencenter.com" style="color:#4a7052;text-decoration:none;">eastmeadowgardencenter.com</a></p>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>"""


def _detail_card(bg: str, border: str, label_color: str, label: str, rows: list[tuple[str, str]]) -> str:
    rows_html = "".join(f"""
      <tr><td style="padding-bottom:{'0' if i == len(rows)-1 else '16'}px;">
        <p style="margin:0;font-size:11px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:0.06em;font-family:'Inter',Arial,sans-serif;">{r[0]}</p>
        <p style="margin:5px 0 0;font-family:'Outfit',Arial,sans-serif;font-size:18px;font-weight:700;color:#2c2c2c;letter-spacing:-0.01em;">{r[1]}</p>
      </td></tr>""" for i, r in enumerate(rows))
    return f"""
    <table width="100%" cellpadding="0" cellspacing="0" style="background:{bg};border:1px solid {border};border-radius:12px;margin:24px 0;">
      <tr><td style="padding:24px 28px;">
        <p style="margin:0 0 16px;font-family:'Outfit',Arial,sans-serif;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:{label_color};">{label}</p>
        <table width="100%" cellpadding="0" cellspacing="0">{rows_html}</table>
      </td></tr>
    </table>"""


def _info_box(text: str) -> str:
    return f"""
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f8f4;border:1px solid #d4e8d4;border-radius:10px;margin:24px 0 0;">
      <tr><td style="padding:16px 20px;">
        <p style="margin:0;font-size:14px;color:#4a7052;line-height:1.65;font-family:'Inter',Arial,sans-serif;">{text}</p>
      </td></tr>
    </table>"""


def send_on_the_way_email(to: str, customer_name: str, scheduled_date: str, window_label: str, driver_name: str | None = None) -> bool:
    first_name = customer_name.split()[0] if customer_name else "there"
    subject = "Your Delivery is On the Way! 🚚"
    driver_line = f"<strong>{driver_name}</strong> is" if driver_name else "Your driver is"
    content = f"""
      <h1 style="margin:0 0 12px;font-family:'Outfit',Arial,sans-serif;font-size:26px;font-weight:800;color:#2c2c2c;letter-spacing:-0.02em;line-height:1.2;">Your delivery is on the way! 🚚</h1>
      <p style="margin:0;font-size:16px;color:#666;line-height:1.65;">Hi {first_name} — {driver_line} headed your way now. Please make sure the delivery area is clear and accessible.</p>

      {_detail_card('#f4f8f4', '#c8dfc8', '#3d5a45', 'Delivery Details', [
          ('Date', scheduled_date),
          ('Arrival Window', window_label),
      ])}

      {_info_box('🏡 &nbsp;Please ensure your <strong>delivery area is clear and accessible</strong>. Our driver will arrive within your scheduled window.')}

      <p style="margin:24px 0 0;font-size:14px;color:#888;line-height:1.65;">Have questions? Just reply to this email and we'll get back to you right away.</p>
    """
    return send_email(to, subject, _layout(('#4a7052', '#a4c639'), content, f"Your delivery from East Meadow Garden Center is on the way — {scheduled_date}"))


def send_reschedule_notification_email(to: str, customer_name: str, scheduled_date: str, window_label: str) -> bool:
    first_name = customer_name.split()[0] if customer_name else "there"
    subject = f"Your Delivery Has Been Rescheduled — {scheduled_date}"
    content = f"""
      <h1 style="margin:0 0 12px;font-family:'Outfit',Arial,sans-serif;font-size:26px;font-weight:800;color:#2c2c2c;letter-spacing:-0.02em;line-height:1.2;">Your delivery has been rescheduled</h1>
      <p style="margin:0;font-size:16px;color:#666;line-height:1.65;">Hi {first_name} — we've updated your delivery to a new date and time. Here are your new details:</p>

      {_detail_card('#fff9f0', '#f5ddb8', '#b07d2a', 'Updated Delivery Details', [
          ('New Date', scheduled_date),
          ('Arrival Window', window_label),
      ])}

      {_info_box("📅 &nbsp;Please note your <strong>updated delivery window</strong>. If this date doesn't work for you, just reply to this email and we'll find a better time.")}

      <p style="margin:24px 0 0;font-size:14px;color:#888;line-height:1.65;">We apologize for any inconvenience and truly appreciate your patience.</p>
    """
    return send_email(to, subject, _layout(('#b07d2a', '#e6a83a'), content, f"Your East Meadow delivery has been rescheduled to {scheduled_date}"))


def send_delivery_confirmation_email(to: str, customer_name: str, scheduled_date: str, pod_photo_url: str | None = None) -> bool:
    first_name = customer_name.split()[0] if customer_name else "there"
    subject = "Your Delivery is Complete ✅"
    pod_section = ""
    if pod_photo_url:
        pod_section = f"""
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0 0;">
      <tr><td>
        <p style="margin:0 0 10px;font-family:'Outfit',Arial,sans-serif;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#3d5a45;">Proof of Delivery</p>
        <img src="{pod_photo_url}" alt="Proof of delivery" width="100%" style="border-radius:10px;display:block;max-width:484px;border:1px solid #e8f0e8;" />
      </td></tr>
    </table>"""

    content = f"""
      <h1 style="margin:0 0 12px;font-family:'Outfit',Arial,sans-serif;font-size:26px;font-weight:800;color:#2c2c2c;letter-spacing:-0.02em;line-height:1.2;">Your delivery is complete! ✅</h1>
      <p style="margin:0;font-size:16px;color:#666;line-height:1.65;">Hi {first_name} — great news! Your delivery from East Meadow Garden Center has been successfully completed.</p>

      {_detail_card('#f4f8f4', '#c8dfc8', '#3d5a45', 'Delivery Summary', [
          ('Delivered On', scheduled_date),
      ])}

      {pod_section}

      {_info_box("🌿 &nbsp;Thank you for choosing East Meadow Garden Center! We hope everything arrived in perfect condition. If you have any concerns, please reply to this email.")}

      <p style="margin:24px 0 0;font-size:14px;color:#888;line-height:1.65;">We appreciate your business and look forward to serving you again!</p>
    """
    return send_email(to, subject, _layout(('#4a7052', '#a4c639'), content, f"Your East Meadow Garden Center delivery has been completed — thank you!"))
