"""add collect_payment to drops

Revision ID: 20260511_0032
Revises: 20260511_0031
Create Date: 2026-05-11
"""
from alembic import op
import sqlalchemy as sa

revision = "20260511_0032"
down_revision = "20260511_0031"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("drops", sa.Column("collect_payment", sa.Boolean(), nullable=False, server_default=sa.text("false")))


def downgrade() -> None:
    op.drop_column("drops", "collect_payment")
