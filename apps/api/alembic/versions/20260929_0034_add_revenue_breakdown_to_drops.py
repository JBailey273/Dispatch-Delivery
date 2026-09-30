"""add revenue breakdown (materials / delivery fee / tax) to drops

Revision ID: 20260929_0034
Revises: 20260516_0033
Create Date: 2026-09-29
"""
from alembic import op
import sqlalchemy as sa

revision = "20260929_0034"
down_revision = "20260516_0033"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("drops", sa.Column("materials_total", sa.Numeric(10, 2), nullable=True))
    op.add_column("drops", sa.Column("delivery_fee", sa.Numeric(10, 2), nullable=True))
    op.add_column("drops", sa.Column("tax_total", sa.Numeric(10, 2), nullable=True))


def downgrade() -> None:
    op.drop_column("drops", "tax_total")
    op.drop_column("drops", "delivery_fee")
    op.drop_column("drops", "materials_total")
