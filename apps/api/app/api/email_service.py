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
    return f'<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;color:#fafaf7;">{text}&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;</div>'


def _layout(accent_color: str, content: str, preheader_text: str = "") -> str:
    return f"""<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <meta http-equiv="X-UA-Compatible" content="IE=edge"/>
  <!--[if mso]>
  <noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
  <![endif]-->
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet"/>
  <style>
    @media only screen and (max-width:600px) {{
      .email-container {{ width:100% !important; }}
      .content-pad {{ padding:28px 24px 32px !important; }}
      .detail-card {{ padding:18px 20px !important; }}
      h1 {{ font-size:22px !important; }}
    }}
  </style>
</head>
<body style="margin:0;padding:0;background-color:#fafaf7;-webkit-font-smoothing:antialiased;">
{_preheader(preheader_text)}
<!--[if mso]><table width="100%" cellpadding="0" cellspacing="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#fafaf7;">
<tr><td align="center" style="padding:48px 16px;">

  <table role="presentation" class="email-container" width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%;">

    <!-- Logo -->
    <tr><td align="center" style="padding-bottom:28px;">
      <img src="https://pub-2acb2bd410ad4b7094ea64a66e6531f5.r2.dev/logo/Garden%20Center%20PNG.png"
           alt="East Meadow Garden Center"
           width="200"
           style="display:block;height:auto;border:0;outline:none;text-decoration:none;"
           />
    </td></tr>

    <!-- Card -->
    <tr><td style="background-color:#ffffff;border-radius:12px;box-shadow:0 4px 20px rgba(74,112,82,0.10);">
      <!--[if mso]><table width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top:5px solid {accent_color};"><![endif]-->
      <!--[if !mso]><!-->
      <div style="height:5px;background-color:{accent_color};border-radius:12px 12px 0 0;font-size:0;line-height:0;">&nbsp;</div>
      <!--<![endif]-->

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td class="content-pad" style="padding:40px 48px 44px;">
          {content}
        </td></tr>
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td></tr>

    <!-- Footer -->
    <tr><td align="center" style="padding:28px 0 0;">
      <p style="margin:0 0 4px;font-family:Outfit,Arial,sans-serif;font-size:13px;font-weight:600;color:#4a7052;letter-spacing:0.3px;">East Meadow Garden Center</p>
      <p style="margin:0;font-family:Arial,sans-serif;font-size:12px;color:#999999;line-height:1.6;">Questions? Reply to this email or call us directly.<br/>
      <a href="https://eastmeadowgardencenter.com" style="color:#4a7052;text-decoration:none;">eastmeadowgardencenter.com</a></p>
    </td></tr>

  </table>
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</body>
</html>"""


def _detail_card(bg: str, border: str, label_color: str, label: str, rows: list[tuple[str, str]]) -> str:
    rows_html = "".join(f"""
      <tr><td style="padding-bottom:{'0' if i == len(rows)-1 else '16'}px;">
        <p style="margin:0;font-family:Arial,sans-serif;font-size:11px;font-weight:600;color:#999999;text-transform:uppercase;letter-spacing:0.06em;">{r[0]}</p>
        <p style="margin:5px 0 0;font-family:Outfit,Arial,sans-serif;font-size:18px;font-weight:700;color:#2c2c2c;">{r[1]}</p>
      </td></tr>""" for i, r in enumerate(rows))
    return f"""
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">
      <tr><td class="detail-card" style="background-color:{bg};border:1px solid {border};border-radius:10px;padding:22px 26px;">
        <p style="margin:0 0 14px;font-family:Outfit,Arial,sans-serif;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:{label_color};">{label}</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">{rows_html}</table>
      </td></tr>
    </table>"""


def _info_box(text: str) -> str:
    return f"""
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 0;">
      <tr><td style="background-color:#f4f8f4;border:1px solid #c8dfc8;border-radius:8px;padding:14px 18px;">
        <p style="margin:0;font-family:Arial,sans-serif;font-size:14px;color:#4a7052;line-height:1.65;">{text}</p>
      </td></tr>
    </table>"""


def send_on_the_way_email(to: str, customer_name: str, scheduled_date: str, window_label: str, driver_name: str | None = None) -> bool:
    first_name = customer_name.split()[0] if customer_name else "there"
    subject = "Your Delivery is On the Way!"
    driver_line = f"<strong>{driver_name}</strong> is" if driver_name else "Your driver is"
    content = f"""
      <h1 style="margin:0 0 12px;font-family:Outfit,Arial,sans-serif;font-size:26px;font-weight:800;color:#2c2c2c;letter-spacing:-0.02em;line-height:1.25;mso-line-height-rule:exactly;">Your delivery is on the way! &#x1F69A;</h1>
      <p style="margin:0;font-family:Arial,sans-serif;font-size:16px;color:#666666;line-height:1.65;">Hi {first_name} &#8212; {driver_line} headed your way now. Please make sure the delivery area is clear and accessible.</p>
      {_detail_card('#f4f8f4', '#c8dfc8', '#3d5a45', 'Delivery Details', [('Date', scheduled_date), ('Arrival Window', window_label)])}
      {_info_box('Please ensure your <strong>delivery area is clear and accessible</strong>. Our driver will arrive within your scheduled window.')}
      <p style="margin:20px 0 0;font-family:Arial,sans-serif;font-size:14px;color:#999999;line-height:1.65;">Have questions? Just reply to this email and we&#8217;ll get back to you right away.</p>
    """
    return send_email(to, subject, _layout('#4a7052', content, f"Your delivery from East Meadow Garden Center is on the way — {scheduled_date}"))


def send_reschedule_notification_email(to: str, customer_name: str, scheduled_date: str, window_label: str) -> bool:
    first_name = customer_name.split()[0] if customer_name else "there"
    subject = f"Your Delivery Has Been Rescheduled — {scheduled_date}"
    content = f"""
      <h1 style="margin:0 0 12px;font-family:Outfit,Arial,sans-serif;font-size:26px;font-weight:800;color:#2c2c2c;letter-spacing:-0.02em;line-height:1.25;mso-line-height-rule:exactly;">Your delivery has been rescheduled</h1>
      <p style="margin:0;font-family:Arial,sans-serif;font-size:16px;color:#666666;line-height:1.65;">Hi {first_name} &#8212; we&#8217;ve updated your delivery to a new date and time. Here are your new details:</p>
      {_detail_card('#fff9f0', '#f5ddb8', '#b07d2a', 'Updated Delivery Details', [('New Date', scheduled_date), ('Arrival Window', window_label)])}
      {_info_box("Please note your <strong>updated delivery window</strong>. If this date doesn&#8217;t work for you, just reply to this email and we&#8217;ll find a better time.")}
      <p style="margin:20px 0 0;font-family:Arial,sans-serif;font-size:14px;color:#999999;line-height:1.65;">We apologize for any inconvenience and truly appreciate your patience.</p>
    """
    return send_email(to, subject, _layout('#b07d2a', content, f"Your East Meadow delivery has been rescheduled to {scheduled_date}"))


def send_delivery_confirmation_email(to: str, customer_name: str, scheduled_date: str, pod_photo_url: str | None = None) -> bool:
    first_name = customer_name.split()[0] if customer_name else "there"
    subject = "Your Delivery is Complete!"
    pod_section = ""
    if pod_photo_url:
        pod_section = f"""
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0 0;">
      <tr><td>
        <p style="margin:0 0 10px;font-family:Outfit,Arial,sans-serif;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#3d5a45;">Proof of Delivery</p>
        <img src="{pod_photo_url}" alt="Proof of delivery photo" width="484" style="display:block;width:100%;max-width:484px;height:auto;border-radius:8px;border:1px solid #e8f0e8;" />
      </td></tr>
    </table>"""
    content = f"""
      <h1 style="margin:0 0 12px;font-family:Outfit,Arial,sans-serif;font-size:26px;font-weight:800;color:#2c2c2c;letter-spacing:-0.02em;line-height:1.25;mso-line-height-rule:exactly;">Your delivery is complete! &#x2705;</h1>
      <p style="margin:0;font-family:Arial,sans-serif;font-size:16px;color:#666666;line-height:1.65;">Hi {first_name} &#8212; great news! Your delivery from East Meadow Garden Center has been successfully completed.</p>
      {_detail_card('#f4f8f4', '#c8dfc8', '#3d5a45', 'Delivery Summary', [('Delivered On', scheduled_date)])}
      {pod_section}
      {_info_box('Thank you for choosing East Meadow Garden Center! We hope everything arrived in perfect condition. If you have any concerns, please reply to this email.')}
      <p style="margin:20px 0 0;font-family:Arial,sans-serif;font-size:14px;color:#999999;line-height:1.65;">We appreciate your business and look forward to serving you again!</p>
    """
    return send_email(to, subject, _layout('#4a7052', content, "Your East Meadow Garden Center delivery has been completed — thank you!"))
