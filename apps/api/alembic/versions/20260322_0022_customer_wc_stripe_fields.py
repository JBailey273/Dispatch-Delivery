"""add wc_customer_id, stripe_customer_id, is_contractor to customers

Revision ID: 20260322_0022
Revises: 20260319_0021
Create Date: 2026-03-22
"""
from alembic import op
import sqlalchemy as sa

revision = "20260322_0022"
down_revision = "20260319_0021"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("customers", sa.Column("wc_customer_id", sa.Integer(), nullable=True))
    op.add_column("customers", sa.Column("stripe_customer_id", sa.String(255), nullable=True))
    op.add_column("customers", sa.Column("is_contractor", sa.Boolean(), nullable=False, server_default=sa.text("false")))
    op.create_index("ix_customers_wc_customer_id", "customers", ["wc_customer_id"])
    op.create_index("ix_customers_stripe_customer_id", "customers", ["stripe_customer_id"])


def downgrade() -> None:
    op.drop_index("ix_customers_stripe_customer_id", table_name="customers")
    op.drop_index("ix_customers_wc_customer_id", table_name="customers")
    op.drop_column("customers", "is_contractor")
    op.drop_column("customers", "stripe_customer_id")
    op.drop_column("customers", "wc_customer_id")
