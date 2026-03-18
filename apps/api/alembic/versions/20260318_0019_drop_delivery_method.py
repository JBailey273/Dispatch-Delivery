"""add delivery_method, fulfilled_at, pickup_ready_sent_at to drops

Revision ID: 20260318_0019
Revises: 20260317_0018
Create Date: 2026-03-18
"""
from alembic import op
import sqlalchemy as sa

revision = "20260318_0019"
down_revision = "20260317_0018"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("drops", sa.Column("delivery_method", sa.String(20), nullable=False, server_default="delivery"))
    op.add_column("drops", sa.Column("fulfilled_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("drops", sa.Column("pickup_ready_sent_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("drops", "pickup_ready_sent_at")
    op.drop_column("drops", "fulfilled_at")
    op.drop_column("drops", "delivery_method")
