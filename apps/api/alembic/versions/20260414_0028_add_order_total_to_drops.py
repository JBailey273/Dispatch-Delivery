"""add order_total to drops

Revision ID: 20260414_0028
Revises: 20260408_0027
Create Date: 2026-04-14
"""
from alembic import op
import sqlalchemy as sa

revision = "20260414_0028"
down_revision = "20260408_0027"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("drops", sa.Column("order_total", sa.Numeric(10, 2), nullable=True))


def downgrade() -> None:
    op.drop_column("drops", "order_total")
