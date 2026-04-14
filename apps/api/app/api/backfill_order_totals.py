"""
One-time backfill: populate order_total on drops where it is NULL.
Run on Render with:
  PYTHONPATH=/opt/render/project/src/apps/api python backfill_order_totals.py
"""
import json
import os
import urllib.parse
import urllib.request
import urllib.error

DATABASE_URL = os.environ["DATABASE_URL"]
WC_STORE_URL = os.environ["WC_STORE_URL"]
WC_CONSUMER_KEY = os.environ["WC_CONSUMER_KEY"]
WC_CONSUMER_SECRET = os.environ["WC_CONSUMER_SECRET"]

import psycopg2

def wc_get_order_total(wc_order_id: str) -> float | None:
    path = f"orders/{wc_order_id}"
    separator = "&" if "?" in path else "?"
    url = (
        f"{WC_STORE_URL.rstrip('/')}/wp-json/wc/v3/{path}"
        f"{separator}consumer_key={urllib.parse.quote(WC_CONSUMER_KEY)}"
        f"&consumer_secret={urllib.parse.quote(WC_CONSUMER_SECRET)}"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "dispatch-app/1.0"}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
            total = data.get("total")
            return float(total) if total else None
    except Exception as e:
        print(f"  ✗ WC fetch failed for order {wc_order_id}: {e}")
        return None


def main():
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()

    cur.execute("""
        SELECT id, external_order_id
        FROM drops
        WHERE order_total IS NULL
          AND external_order_id IS NOT NULL
    """)
    rows = cur.fetchall()
    print(f"Found {len(rows)} drops to backfill\n")

    updated = 0
    skipped = 0

    for drop_id, wc_order_id in rows:
        print(f"Drop {drop_id} → WC order {wc_order_id} ... ", end="", flush=True)
        total = wc_get_order_total(wc_order_id)
        if total is not None:
            cur.execute(
                "UPDATE drops SET order_total = %s WHERE id = %s",
                (total, drop_id)
            )
            print(f"${total:.2f} ✓")
            updated += 1
        else:
            print("skipped (no total returned)")
            skipped += 1

    conn.commit()
    cur.close()
    conn.close()

    print(f"\nDone — {updated} updated, {skipped} skipped")


if __name__ == "__main__":
    main()
