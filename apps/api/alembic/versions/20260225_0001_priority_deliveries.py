"""add customer_type and priority delivery support

Revision ID: 20260225_0001
Revises: 20260220_0010
Create Date: 2026-02-25

"""
from alembic import op
import sqlalchemy as sa


revision = "20260225_0001"
down_revision = "20260220_0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Create customer_type enum
    customer_type_enum = sa.Enum("residential", "commercial", name="customer_type")
    customer_type_enum.create(op.get_bind(), checkfirst=True)

    # Add customer_type to customers table (default residential)
    op.add_column(
        "customers",
        sa.Column(
            "customer_type",
            customer_type_enum,
            nullable=False,
            server_default="residential",
        ),
    )

    # Add is_priority to drops table (default false)
    op.add_column(
        "drops",
        sa.Column(
            "is_priority",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )

    # Make scheduled_window nullable (priority drops have no window)
    op.alter_column(
        "drops",
        "scheduled_window",
        existing_type=sa.Enum("A", "B", name="drop_window_code"),
        nullable=True,
    )

    # Remove server defaults (they were just for backfill)
    op.alter_column("customers", "customer_type", server_default=None)
    op.alter_column("drops", "is_priority", server_default=None)

    # Add OUT_OF_STOCK, WRONG_ADDRESS, CUSTOMER_REFUSED to exception_reason_code enum
    # (PostgreSQL requires ALTER TYPE ... ADD VALUE)
    op.execute("ALTER TYPE exception_reason_code ADD VALUE IF NOT EXISTS 'OUT_OF_STOCK'")
    op.execute("ALTER TYPE exception_reason_code ADD VALUE IF NOT EXISTS 'WRONG_ADDRESS'")
    op.execute("ALTER TYPE exception_reason_code ADD VALUE IF NOT EXISTS 'CUSTOMER_REFUSED'")


def downgrade() -> None:
    op.alter_column(
        "drops",
        "scheduled_window",
        existing_type=sa.Enum("A", "B", name="drop_window_code"),
        nullable=False,
    )
    op.drop_column("drops", "is_priority")
    op.drop_column("customers", "customer_type")
    sa.Enum(name="customer_type").drop(op.get_bind(), checkfirst=True)
