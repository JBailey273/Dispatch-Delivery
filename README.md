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

