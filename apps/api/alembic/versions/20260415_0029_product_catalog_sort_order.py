"""add sort_order to product_catalog_items

Revision ID: 20260415_0029
Revises: 20260414_0028
Create Date: 2026-04-15
"""
from alembic import op
import sqlalchemy as sa

revision = "20260415_0029"
down_revision = "20260414_0028"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('product_catalog_items', sa.Column('sort_order', sa.Integer(), nullable=False, server_default='0'))


def downgrade():
    op.drop_column('product_catalog_items', 'sort_order')
