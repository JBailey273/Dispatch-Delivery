"""add material_category to product_catalog_items and loads

Revision ID: 20260511_0031
Revises: 20260418_0030
Create Date: 2026-05-11
"""
from alembic import op
import sqlalchemy as sa

revision = "20260511_0031"
down_revision = "20260418_0030"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("product_catalog_items", sa.Column("material_category", sa.String(120), nullable=True))
    op.add_column("loads", sa.Column("material_category_snapshot", sa.String(120), nullable=True))


def downgrade() -> None:
    op.drop_column("loads", "material_category_snapshot")
    op.drop_column("product_catalog_items", "material_category")
