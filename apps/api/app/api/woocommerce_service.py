import json
import logging
import re
import urllib.error
import urllib.parse
import urllib.request

logger = logging.getLogger("dispatch.woocommerce")

# Hostinger's LiteSpeed bot verification challenges non-browser clients, so
# server-to-server WooCommerce calls identify like a standard browser.
WC_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
}

_SECRET_RE = re.compile(r"(consumer_(?:key|secret)=)[^&\s\"'<>]+")


def wc_redact(text: str, limit: int = 300) -> str:
    """Strip WooCommerce keys from text before logging, and trim long HTML bodies."""
    text = _SECRET_RE.sub(r"\1[redacted]", text or "")
    if "<html" in text.lower():
        m = re.search(r"<title>(.*?)</title>", text, re.I | re.S)
        text = f"HTML page: {m.group(1).strip() if m else 'untitled'}"
    return text[:limit]


def sync_order_status(
    wc_store_url: str,
    wc_consumer_key: str,
    wc_consumer_secret: str,
    external_order_id: str,
    wc_status: str,
) -> bool:
    """
    Update a WooCommerce order status via the REST API.
    Non-fatal — returns True on success, False on any failure.
    """
    if not all([wc_store_url, wc_consumer_key, wc_consumer_secret, external_order_id]):
        logger.warning("woocommerce_sync skipped — missing credentials or order id")
        return False

    url = (
        f"{wc_store_url.rstrip('/')}/wp-json/wc/v3/orders/{external_order_id}"
        f"?consumer_key={urllib.parse.quote(wc_consumer_key)}"
        f"&consumer_secret={urllib.parse.quote(wc_consumer_secret)}"
    )

    payload = json.dumps({"status": wc_status}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        headers={**WC_HEADERS, "Content-Type": "application/json"},
        method="PUT",
    )

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            logger.info(f"WooCommerce order {external_order_id} → '{wc_status}' (HTTP {resp.status})")
            return True
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        logger.error(f"WooCommerce sync failed for order {external_order_id}: HTTP {e.code} — {wc_redact(body)}")
        return False
    except Exception as e:
        logger.error(f"WooCommerce sync error for order {external_order_id}: {wc_redact(str(e))}")
        return False
