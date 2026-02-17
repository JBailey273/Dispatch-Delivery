"""multi-tenant saas hardening

Revision ID: 20260217_0004
Revises: 20260217_0003
Create Date: 2026-02-17 00:04:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260217_0004"
down_revision: Union[str, None] = "20260217_0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


channel_type = sa.Enum("manual", "woocommerce", name="channel_type")


def upgrade() -> None:
    bind = op.get_bind()
    channel_type.create(bind, checkfirst=True)

    op.add_column("tenants", sa.Column("slug", sa.String(length=120), nullable=True))
    op.execute("UPDATE tenants SET slug = 'default-tenant' WHERE slug IS NULL")
    op.alter_column("tenants", "slug", nullable=False)
    op.create_index(op.f("ix_tenants_slug"), "tenants", ["slug"], unique=True)

    op.add_column("users", sa.Column("default_truck_identifier", sa.String(length=120), nullable=True))
    op.add_column("channels", sa.Column("last_called_at", sa.DateTime(timezone=True), nullable=True))

    op.create_check_constraint("ck_capacity_total_min", "window_capacities", "capacity_total >= 1")
    op.create_check_constraint("ck_capacity_used_nonnegative", "window_capacities", "capacity_used >= 0")
    op.create_check_constraint("ck_capacity_used_lte_total", "window_capacities", "capacity_used <= capacity_total")


def downgrade() -> None:
    op.drop_constraint("ck_capacity_used_lte_total", "window_capacities", type_="check")
    op.drop_constraint("ck_capacity_used_nonnegative", "window_capacities", type_="check")
    op.drop_constraint("ck_capacity_total_min", "window_capacities", type_="check")

    op.drop_column("channels", "last_called_at")
    op.drop_column("users", "default_truck_identifier")

    op.drop_index(op.f("ix_tenants_slug"), table_name="tenants")
    op.drop_column("tenants", "slug")
