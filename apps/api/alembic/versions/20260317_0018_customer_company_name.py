"""add company_name to customers

Revision ID: 20260317_0018
Revises: 20260317_0017
Create Date: 2026-03-17
"""
from alembic import op
import sqlalchemy as sa

revision = "20260317_0018"
down_revision = "20260317_0017"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("customers", sa.Column("company_name", sa.String(255), nullable=True))


def downgrade() -> None:
    op.drop_column("customers", "company_name")
