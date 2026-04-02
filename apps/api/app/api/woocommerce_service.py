import json
import logging
import urllib.error
import urllib.parse
import urllib.request

logger = logging.getLogger("dispatch.woocommerce")


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
        headers={
            "Content-Type": "application/json",
            "User-Agent": "dispatch-app/1.0",
        },
        method="PUT",
    )

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            logger.info(f"WooCommerce order {external_order_id} → '{wc_status}' (HTTP {resp.status})")
            return True
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        logger.error(f"WooCommerce sync failed for order {external_order_id}: HTTP {e.code} — {body}")
        return False
    except Exception as e:
        logger.error(f"WooCommerce sync error for order {external_order_id}: {e}")
        return False
