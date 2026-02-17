# Dispatch & Delivery Monorepo

## Structure
- `apps/web` - Next.js frontend
- `apps/api` - FastAPI backend + Alembic migrations
- `apps/worker` - Background worker entrypoint

## Local run (recommended)

Use Docker Compose for Postgres + Redis, then run API/Web locally.

```bash
# from repo root
cat > docker-compose.yml <<'YAML'
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: dispatch
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    ports: ["5432:5432"]
  redis:
    image: redis:7
    ports: ["6379:6379"]
YAML

docker compose up -d
```

### API
```bash
cd apps/api
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
alembic upgrade head
uvicorn app.main:app --reload --port 8000
```

### Web
```bash
cd apps/web
npm install
npm run dev
```

Dev login users (password `password`):
- `admin@example.com`
- `dispatcher@example.com`
- `driver@example.com`

## WooCommerce adapter contract (channel API)

WooCommerce is treated as a channel adapter only. It must call canonical backend APIs with `X-Channel-Key`.

1) Check availability:

```http
POST /api/v1/availability
X-Channel-Key: <channel-key>
Content-Type: application/json

{
  "date_range": {"start_date": "2026-02-20", "end_date": "2026-02-27"},
  "cart_items": [{"sku": "STONE-3-4", "qty": 2}, {"sku": "MULCH-BLK", "qty": 5}]
}
```

```json
{
  "required_loads": 2,
  "dates": [{"date": "2026-02-21", "windows": [{"window": "A", "remaining_slots": 3}]}]
}
```

2) Place capacity hold:

```http
POST /api/v1/holds
X-Channel-Key: <channel-key>
Content-Type: application/json

{"date": "2026-02-21", "window": "A", "required_loads": 2, "cart_hash": "wc:cart:a1b2"}
```

```json
{"hold_token": "...", "expires_at": "2026-02-21T16:00:00+00:00"}
```

3) Confirm hold after payment:

```http
POST /api/v1/holds/{hold_token}/confirm
X-Channel-Key: <channel-key>
Content-Type: application/json
```

Canonical body:

```json
{
  "external_order": {"id": "1234", "placed_at": "2026-02-21T15:44:00Z", "url": "https://shop.example/orders/1234"},
  "customer": {"name": "Jane Doe", "phone": "+15555550123", "email": "jane@example.com"},
  "drop": {
    "address": {"line1": "123 Main St", "city": "Dallas", "state": "TX", "postal_code": "75001", "country": "US"},
    "notes": "Leave near garage",
    "photos": [],
    "requested_date": "2026-02-21",
    "requested_window": "A"
  },
  "items": [{"sku": "STONE-3-4", "qty": 2}]
}
```

Fallback ingestion (for channels that cannot hold):

```http
POST /api/v1/orders/ingest
X-Channel-Key: <channel-key>
Content-Type: application/json
```

Uses the same canonical body as hold confirmation and returns `409` if capacity is unavailable.
