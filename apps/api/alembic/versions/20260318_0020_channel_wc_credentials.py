"""add WooCommerce credentials to channels

Revision ID: 20260318_0020
Revises: 20260318_0019
Create Date: 2026-03-18
"""
from alembic import op
import sqlalchemy as sa

revision = "20260318_0020"
down_revision = "20260318_0019"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("channels", sa.Column("wc_store_url", sa.String(512), nullable=True))
    op.add_column("channels", sa.Column("wc_consumer_key", sa.String(255), nullable=True))
    op.add_column("channels", sa.Column("wc_consumer_secret", sa.String(255), nullable=True))


def downgrade() -> None:
    op.drop_column("channels", "wc_consumer_secret")
    op.drop_column("channels", "wc_consumer_key")
    op.drop_column("channels", "wc_store_url")
```

---

**STEP 3 — Run both migrations**
```
PYTHONPATH=/opt/render/project/src/apps/api alembic upgrade head
