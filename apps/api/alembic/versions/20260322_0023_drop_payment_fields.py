"""add payment fields to drops

Revision ID: 20260322_0023
Revises: 20260322_0022
Create Date: 2026-03-22
"""
from alembic import op
import sqlalchemy as sa

revision = "20260322_0023"
down_revision = "20260322_0022"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("drops", sa.Column("payment_method", sa.String(50), nullable=True))
    op.add_column("drops", sa.Column("payment_status", sa.String(50), nullable=True))
    op.add_column("drops", sa.Column("payment_note", sa.Text(), nullable=True))
    op.add_column("drops", sa.Column("stripe_payment_intent_id", sa.String(255), nullable=True))
    op.add_column("drops", sa.Column("stripe_payment_link_id", sa.String(255), nullable=True))
    op.add_column("drops", sa.Column("wc_customer_id", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("drops", "wc_customer_id")
    op.drop_column("drops", "stripe_payment_link_id")
    op.drop_column("drops", "stripe_payment_intent_id")
    op.drop_column("drops", "payment_note")
    op.drop_column("drops", "payment_status")
    op.drop_column("drops", "payment_method")
