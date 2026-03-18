import logging
import urllib.request
import urllib.error
import json
import base64

logger = logging.getLogger("dispatch.woocommerce")


def sync_order_status(
    wc_store_url: str,
    wc_consumer_key: str,
    wc_consumer_secret: str,
    external_order_id: str,
    wc_status: str,  # e.g. "completed"
) -> bool:
    """
    Update a WooCommerce order status via the REST API.
    Returns True on success, False on any failure (non-fatal — caller should log and continue).
    """
    if not all([wc_store_url, wc_consumer_key, wc_consumer_secret, external_order_id]):
        logger.warning("woocommerce_sync skipped — missing credentials or order id")
        return False

    url = f"{wc_store_url.rstrip('/')}/wp-json/wc/v3/orders/{external_order_id}"
    credentials = base64.b64encode(
        f"{wc_consumer_key}:{wc_consumer_secret}".encode("utf-8")
    ).decode("utf-8")

    payload = json.dumps({"status": wc_status}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Authorization": f"Basic {credentials}",
            "Content-Type": "application/json",
            "User-Agent": "dispatch-app/1.0",
        },
        method="PUT",
    )

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            logger.info(
                f"WooCommerce order {external_order_id} set to '{wc_status}' "
                f"(HTTP {resp.status})"
            )
            return True
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        logger.error(
            f"WooCommerce sync failed for order {external_order_id}: "
            f"HTTP {e.code} — {body}"
        )
        return False
    except Exception as e:
        logger.error(f"WooCommerce sync error for order {external_order_id}: {e}")
        return False
