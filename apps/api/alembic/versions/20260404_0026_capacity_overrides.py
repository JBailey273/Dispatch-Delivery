"""add capacity_overrides table

Revision ID: 20260404_0026
Revises: 20260402_0025
Create Date: 2026-04-04
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260404_0026"
down_revision: Union[str, None] = "20260402_0025"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "capacity_overrides",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("location_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("start_date", sa.Date(), nullable=False),
        sa.Column("end_date", sa.Date(), nullable=False),
        sa.Column("window_a_capacity", sa.Integer(), nullable=False),
        sa.Column("window_b_capacity", sa.Integer(), nullable=False),
        sa.Column("label", sa.String(255), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.CheckConstraint("end_date >= start_date", name="ck_capacity_override_date_range"),
        sa.CheckConstraint("window_a_capacity >= 0", name="ck_capacity_override_a_nonneg"),
        sa.CheckConstraint("window_b_capacity >= 0", name="ck_capacity_override_b_nonneg"),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["location_id"], ["locations.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_capacity_overrides_tenant_location", "capacity_overrides", ["tenant_id", "location_id"], unique=False)
    op.create_index("ix_capacity_overrides_date_range", "capacity_overrides", ["start_date", "end_date"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_capacity_overrides_date_range", table_name="capacity_overrides")
    op.drop_index("ix_capacity_overrides_tenant_location", table_name="capacity_overrides")
    op.drop_table("capacity_overrides")
