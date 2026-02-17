"""initial scaffold

Revision ID: 20260217_0001
Revises:
Create Date: 2026-02-17 00:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260217_0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

user_role = sa.Enum("admin", "dispatcher", "driver", name="user_role")
delivery_mode = sa.Enum("bulk_load", "bag", "pallet", name="delivery_mode")
window_code = sa.Enum("A", "B", name="window_code")
drop_window_code = sa.Enum("A", "B", name="drop_window_code")
load_window_code = sa.Enum("A", "B", name="load_window_code")
load_status = sa.Enum("pending", "loaded_leaving", "exception", "delivered", "cancelled", name="load_status")


def upgrade() -> None:
    bind = op.get_bind()
    for enum in [user_role, delivery_mode, window_code, drop_window_code, load_window_code, load_status]:
        enum.create(bind, checkfirst=True)

    op.create_table(
        "tenants",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("timezone", sa.String(length=64), nullable=False),
        sa.Column("service_days", sa.JSON(), nullable=False),
        sa.Column("windowA_start", sa.Time(), nullable=False),
        sa.Column("windowA_end", sa.Time(), nullable=False),
        sa.Column("windowB_start", sa.Time(), nullable=False),
        sa.Column("windowB_end", sa.Time(), nullable=False),
        sa.Column("capacity_per_window", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("email", sa.String(length=255), nullable=False),
        sa.Column("hashed_password", sa.String(length=255), nullable=False),
        sa.Column("role", user_role, nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_users_email"), "users", ["email"], unique=False)
    op.create_index(op.f("ix_users_tenant_id"), "users", ["tenant_id"], unique=False)
    op.create_table(
        "product_catalog_items",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("sku", sa.String(length=100), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("delivery_mode", delivery_mode, nullable=False),
        sa.Column("unit", sa.String(length=32), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("category", sa.String(length=120), nullable=True),
        sa.Column("bulk_group", sa.String(length=120), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("tenant_id", "sku", name="uq_product_tenant_sku"),
    )
    op.create_index(op.f("ix_product_catalog_items_sku"), "product_catalog_items", ["sku"], unique=False)
    op.create_index(op.f("ix_product_catalog_items_tenant_id"), "product_catalog_items", ["tenant_id"], unique=False)
    op.create_table(
        "customers",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("phone_e164", sa.String(length=30), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("tenant_id", "phone_e164", name="uq_customer_tenant_phone"),
    )
    op.create_index(op.f("ix_customers_phone_e164"), "customers", ["phone_e164"], unique=False)
    op.create_index(op.f("ix_customers_tenant_id"), "customers", ["tenant_id"], unique=False)
    op.create_table(
        "customer_addresses",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("customer_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("label", sa.String(length=120), nullable=True),
        sa.Column("line1", sa.String(length=255), nullable=False),
        sa.Column("line2", sa.String(length=255), nullable=True),
        sa.Column("city", sa.String(length=120), nullable=False),
        sa.Column("state", sa.String(length=120), nullable=False),
        sa.Column("postal_code", sa.String(length=20), nullable=False),
        sa.Column("country", sa.String(length=2), nullable=False),
        sa.Column("is_default", sa.Boolean(), nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["customer_id"], ["customers.id"]),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_customer_addresses_tenant_id"), "customer_addresses", ["tenant_id"], unique=False)
    op.create_table(
        "window_capacities",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("service_date", sa.Date(), nullable=False),
        sa.Column("window_code", window_code, nullable=False),
        sa.Column("capacity_total", sa.Integer(), nullable=False),
        sa.Column("capacity_used", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("tenant_id", "service_date", "window_code", name="uq_capacity_window"),
    )
    op.create_index(op.f("ix_window_capacities_service_date"), "window_capacities", ["service_date"], unique=False)
    op.create_index(op.f("ix_window_capacities_tenant_id"), "window_capacities", ["tenant_id"], unique=False)
    op.create_table(
        "drops",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("customer_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("address_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("status", sa.String(length=50), nullable=False),
        sa.Column("scheduled_date", sa.Date(), nullable=False),
        sa.Column("scheduled_window", drop_window_code, nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["address_id"], ["customer_addresses.id"]),
        sa.ForeignKeyConstraint(["customer_id"], ["customers.id"]),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_drops_tenant_id"), "drops", ["tenant_id"], unique=False)
    op.create_table(
        "loads",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("drop_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("driver_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("truck_label", sa.String(length=120), nullable=True),
        sa.Column("status", load_status, nullable=False),
        sa.Column("route_date", sa.Date(), nullable=False),
        sa.Column("route_window", load_window_code, nullable=False),
        sa.Column("bulk_group_snapshot", sa.String(length=120), nullable=False),
        sa.Column("material_name_snapshot", sa.String(length=255), nullable=False),
        sa.Column("qty", sa.Integer(), nullable=False),
        sa.Column("unit", sa.String(length=32), nullable=False),
        sa.Column("idempotency_key_last", sa.String(length=128), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["driver_user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["drop_id"], ["drops.id"]),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_loads_tenant_id"), "loads", ["tenant_id"], unique=False)
    op.create_table(
        "event_logs",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("event_type", sa.String(length=120), nullable=False),
        sa.Column("source", sa.String(length=120), nullable=False),
        sa.Column("payload_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_event_logs_event_type"), "event_logs", ["event_type"], unique=False)
    op.create_index(op.f("ix_event_logs_tenant_id"), "event_logs", ["tenant_id"], unique=False)


def downgrade() -> None:
    op.drop_table("event_logs")
    op.drop_table("loads")
    op.drop_table("drops")
    op.drop_table("window_capacities")
    op.drop_table("customer_addresses")
    op.drop_table("customers")
    op.drop_table("product_catalog_items")
    op.drop_table("users")
    op.drop_table("tenants")
