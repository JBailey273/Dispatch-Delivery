"""add qd_number for internal/quick-drop orders

Revision ID: 20260401_0024
Revises: 20260318_0023
Create Date: 2026-04-01
"""
from alembic import op
import sqlalchemy as sa

revision = "20260401_0024"
down_revision = "20260322_0023"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("drops", sa.Column("qd_number", sa.Integer(), nullable=True))
    op.create_index("ix_drops_tenant_qd_number", "drops", ["tenant_id", "qd_number"], unique=True)
    op.alter_column("drops", "order_number", nullable=True)


def downgrade() -> None:
    op.drop_index("ix_drops_tenant_qd_number")
    op.drop_column("drops", "qd_number")
