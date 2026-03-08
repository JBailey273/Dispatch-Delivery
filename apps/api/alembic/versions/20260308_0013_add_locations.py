"""add location layer

Revision ID: 20260308_0013
Revises: 20260227_0012
Create Date: 2026-03-08
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20260308_0013"
down_revision = "20260227_0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. Create locations table
    op.create_table(
        "locations",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("slug", sa.String(120), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("address_line1", sa.String(255), nullable=True),
        sa.Column("address_line2", sa.String(255), nullable=True),
        sa.Column("city", sa.String(120), nullable=True),
        sa.Column("state", sa.String(120), nullable=True),
        sa.Column("postal_code", sa.String(20), nullable=True),
        sa.Column("phone", sa.String(30), nullable=True),
        sa.Column("timezone", sa.String(64), nullable=False, server_default="America/New_York"),
        sa.Column("service_days", sa.JSON(), nullable=False, server_default='["mon","tue","wed","thu","fri"]'),
        sa.Column("windowA_start", sa.Time(), nullable=False, server_default="09:00:00"),
        sa.Column("windowA_end", sa.Time(), nullable=False, server_default="13:00:00"),
        sa.Column("windowB_start", sa.Time(), nullable=False, server_default="13:00:00"),
        sa.Column("windowB_end", sa.Time(), nullable=False, server_default="17:00:00"),
        sa.Column("capacity_per_window", sa.Integer(), nullable=False, server_default="4"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("tenant_id", "slug", name="uq_location_tenant_slug"),
    )
    op.create_index("ix_locations_tenant_id", "locations", ["tenant_id"])
    op.create_index("ix_locations_slug", "locations", ["slug"])

    # 2. Seed one default location per tenant, copying settings from tenant
    conn = op.get_bind()
    conn.execute(sa.text("""
        INSERT INTO locations (
            id, tenant_id, name, slug, is_active,
            timezone, service_days,
            "windowA_start", "windowA_end", "windowB_start", "windowB_end",
            capacity_per_window, created_at, updated_at
        )
        SELECT
            gen_random_uuid(), id, name, slug, true,
            timezone, service_days,
            "windowA_start", "windowA_end", "windowB_start", "windowB_end",
            capacity_per_window, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        FROM tenants
    """))

    # 3. Add nullable location_id columns first (backfill before NOT NULL)
    op.add_column("drops", sa.Column("location_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.add_column("product_catalog_items", sa.Column("location_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.add_column("window_capacities", sa.Column("location_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.add_column("capacity_holds", sa.Column("location_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.add_column("operational_blackouts", sa.Column("location_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.add_column("users", sa.Column("home_location_id", postgresql.UUID(as_uuid=True), nullable=True))

    # 4. Backfill: assign each row to the default location for its tenant
    for table in ["drops", "product_catalog_items", "window_capacities", "capacity_holds", "operational_blackouts"]:
        conn.execute(sa.text(f"""
            UPDATE {table} t
            SET location_id = l.id
            FROM locations l
            WHERE l.tenant_id = t.tenant_id
        """))

    # 5. Enforce NOT NULL on operational tables (users.home_location_id stays nullable)
    op.alter_column("drops", "location_id", nullable=False)
    op.alter_column("product_catalog_items", "location_id", nullable=False)
    op.alter_column("window_capacities", "location_id", nullable=False)
    op.alter_column("capacity_holds", "location_id", nullable=False)
    op.alter_column("operational_blackouts", "location_id", nullable=False)

    # 6. Add FK constraints
    op.create_foreign_key("fk_drops_location", "drops", "locations", ["location_id"], ["id"])
    op.create_foreign_key("fk_products_location", "product_catalog_items", "locations", ["location_id"], ["id"])
    op.create_foreign_key("fk_window_capacities_location", "window_capacities", "locations", ["location_id"], ["id"])
    op.create_foreign_key("fk_capacity_holds_location", "capacity_holds", "locations", ["location_id"], ["id"])
    op.create_foreign_key("fk_blackouts_location", "operational_blackouts", "locations", ["location_id"], ["id"])
    op.create_foreign_key("fk_users_home_location", "users", "locations", ["home_location_id"], ["id"])

    # 7. Add indexes
    op.create_index("ix_drops_location_id", "drops", ["location_id"])
    op.create_index("ix_products_location_id", "product_catalog_items", ["location_id"])
    op.create_index("ix_window_capacities_location_id", "window_capacities", ["location_id"])
    op.create_index("ix_capacity_holds_location_id", "capacity_holds", ["location_id"])
    op.create_index("ix_blackouts_location_id", "operational_blackouts", ["location_id"])
    op.create_index("ix_users_home_location_id", "users", ["home_location_id"])

    # 8. Update unique constraints to include location_id
    # WindowCapacity
    op.drop_constraint("uq_capacity_window", "window_capacities", type_="unique")
    op.create_unique_constraint(
        "uq_capacity_window",
        "window_capacities",
        ["tenant_id", "location_id", "service_date", "window_code"]
    )
    # OperationalBlackout
    op.drop_constraint("uq_operational_blackout", "operational_blackouts", type_="unique")
    op.create_unique_constraint(
        "uq_operational_blackout",
        "operational_blackouts",
        ["tenant_id", "location_id", "service_date", "window_code"]
    )
    # ProductCatalogItem — SKU uniqueness is now per location
    op.drop_constraint("uq_product_tenant_sku", "product_catalog_items", type_="unique")
    op.create_unique_constraint(
        "uq_product_tenant_location_sku",
        "product_catalog_items",
        ["tenant_id", "location_id", "sku"]
    )


def downgrade() -> None:
    # Restore original unique constraints
    op.drop_constraint("uq_product_tenant_location_sku", "product_catalog_items", type_="unique")
    op.create_unique_constraint("uq_product_tenant_sku", "product_catalog_items", ["tenant_id", "sku"])

    op.drop_constraint("uq_operational_blackout", "operational_blackouts", type_="unique")
    op.create_unique_constraint("uq_operational_blackout", "operational_blackouts", ["tenant_id", "service_date", "window_code"])

    op.drop_constraint("uq_capacity_window", "window_capacities", type_="unique")
    op.create_unique_constraint("uq_capacity_window", "window_capacities", ["tenant_id", "service_date", "window_code"])

    # Drop indexes
    op.drop_index("ix_users_home_location_id", table_name="users")
    op.drop_index("ix_blackouts_location_id", table_name="operational_blackouts")
    op.drop_index("ix_capacity_holds_location_id", table_name="capacity_holds")
    op.drop_index("ix_window_capacities_location_id", table_name="window_capacities")
    op.drop_index("ix_products_location_id", table_name="product_catalog_items")
    op.drop_index("ix_drops_location_id", table_name="drops")

    # Drop FK constraints
    op.drop_constraint("fk_users_home_location", "users", type_="foreignkey")
    op.drop_constraint("fk_blackouts_location", "operational_blackouts", type_="foreignkey")
    op.drop_constraint("fk_capacity_holds_location", "capacity_holds", type_="foreignkey")
    op.drop_constraint("fk_window_capacities_location", "window_capacities", type_="foreignkey")
    op.drop_constraint("fk_products_location", "product_catalog_items", type_="foreignkey")
    op.drop_constraint("fk_drops_location", "drops", type_="foreignkey")

    # Drop location_id columns
    op.drop_column("users", "home_location_id")
    op.drop_column("operational_blackouts", "location_id")
    op.drop_column("capacity_holds", "location_id")
    op.drop_column("window_capacities", "location_id")
    op.drop_column("product_catalog_items", "location_id")
    op.drop_column("drops", "location_id")

    # Drop locations table
    op.drop_index("ix_locations_slug", table_name="locations")
    op.drop_index("ix_locations_tenant_id", table_name="locations")
    op.drop_table("locations")
