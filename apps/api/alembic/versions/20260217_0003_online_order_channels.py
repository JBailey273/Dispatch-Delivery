"""online order channels and holds tokenization

Revision ID: 20260217_0003
Revises: 20260217_0002
Create Date: 2026-02-17 00:03:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260217_0003"
down_revision: Union[str, None] = "20260217_0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

channel_type = sa.Enum("woocommerce", name="channel_type")


def upgrade() -> None:
    bind = op.get_bind()
    channel_type.create(bind, checkfirst=True)

    op.create_table(
        "channels",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("channel_type", channel_type, nullable=False),
        sa.Column("api_key_hash", sa.String(length=128), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_channels_tenant_id"), "channels", ["tenant_id"], unique=False)
    op.create_index(op.f("ix_channels_api_key_hash"), "channels", ["api_key_hash"], unique=True)

    op.add_column("capacity_holds", sa.Column("hold_token", sa.String(length=128), nullable=True))
    op.add_column("capacity_holds", sa.Column("cart_hash", sa.String(length=255), nullable=True))
    op.add_column("capacity_holds", sa.Column("converted_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("capacity_holds", sa.Column("converted_drop_id", sa.UUID(), nullable=True))
    op.create_index(op.f("ix_capacity_holds_hold_token"), "capacity_holds", ["hold_token"], unique=True)
    op.create_foreign_key(None, "capacity_holds", "drops", ["converted_drop_id"], ["id"])

    op.execute("UPDATE capacity_holds SET hold_token = md5(id::text), cart_hash = md5(id::text) WHERE hold_token IS NULL")
    op.alter_column("capacity_holds", "hold_token", nullable=False)
    op.alter_column("capacity_holds", "cart_hash", nullable=False)


def downgrade() -> None:
    op.drop_constraint(None, "capacity_holds", type_="foreignkey")
    op.drop_index(op.f("ix_capacity_holds_hold_token"), table_name="capacity_holds")
    op.drop_column("capacity_holds", "converted_drop_id")
    op.drop_column("capacity_holds", "converted_at")
    op.drop_column("capacity_holds", "cart_hash")
    op.drop_column("capacity_holds", "hold_token")

    op.drop_table("channels")
    channel_type.drop(op.get_bind(), checkfirst=True)
