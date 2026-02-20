"""add order numbering to drops

Revision ID: 20260220_0009
Revises: 20260217_0008
Create Date: 2026-02-20
"""
from alembic import op
import sqlalchemy as sa

revision = "20260220_0009"
down_revision = "20260217_0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("drops", sa.Column("order_number", sa.Integer(), nullable=True))
    op.add_column("drops", sa.Column("external_order_id", sa.String(255), nullable=True))
    op.add_column("drops", sa.Column("source", sa.String(60), nullable=True, server_default="manual"))

    # Backfill existing drops with sequential order numbers per tenant
    conn = op.get_bind()
    conn.execute(sa.text("""
        WITH numbered AS (
            SELECT id, tenant_id, ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY created_at) as rn
            FROM drops
        )
        UPDATE drops SET order_number = numbered.rn
        FROM numbered WHERE drops.id = numbered.id
    """))

    op.create_index("ix_drops_tenant_order_number", "drops", ["tenant_id", "order_number"], unique=True)
    op.create_index("ix_drops_external_order_id", "drops", ["tenant_id", "external_order_id"])


def downgrade() -> None:
    op.drop_index("ix_drops_external_order_id")
    op.drop_index("ix_drops_tenant_order_number")
    op.drop_column("drops", "source")
    op.drop_column("drops", "external_order_id")
    op.drop_column("drops", "order_number")
