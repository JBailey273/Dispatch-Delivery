"""change loads.qty from integer to numeric for half-yard support

Revision ID: 20260516_0033
Revises: 20260511_0032
Create Date: 2026-05-16
"""
from alembic import op
import sqlalchemy as sa

revision = "20260516_0033"
down_revision = "20260511_0032"
branch_labels = None
depends_on = None


def upgrade():
    op.alter_column(
        "loads",
        "qty",
        type_=sa.Numeric(10, 2),
        existing_type=sa.Integer(),
        existing_nullable=False,
        postgresql_using="qty::numeric(10,2)",
    )


def downgrade():
    op.alter_column(
        "loads",
        "qty",
        type_=sa.Integer(),
        existing_type=sa.Numeric(10, 2),
        existing_nullable=False,
        postgresql_using="qty::integer",
    )
