"""make address_id nullable on drops for pickup orders

Revision ID: 20260402_0025
Revises: 20260401_0024
Create Date: 2026-04-02
"""
from alembic import op
import sqlalchemy as sa

revision = "20260402_0025"
down_revision = "20260401_0024"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("drops", "address_id", nullable=True)


def downgrade() -> None:
    op.alter_column("drops", "address_id", nullable=False)
