"""add email and notification opt-ins to customers

Revision ID: 20260316_0016
Revises: 20260315_0015
Create Date: 2026-03-16
"""
from alembic import op
import sqlalchemy as sa

revision = "20260316_0016"
down_revision = "20260315_0015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("customers", sa.Column("email", sa.String(255), nullable=True))
    op.add_column("customers", sa.Column("sms_opt_in", sa.Boolean(), nullable=False, server_default="false"))
    op.add_column("customers", sa.Column("email_opt_in", sa.Boolean(), nullable=False, server_default="false"))


def downgrade() -> None:
    op.drop_column("customers", "email_opt_in")
    op.drop_column("customers", "sms_opt_in")
    op.drop_column("customers", "email")
