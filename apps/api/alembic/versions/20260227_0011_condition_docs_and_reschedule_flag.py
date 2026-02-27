"""condition photos and needs_reschedule flag

Revision ID: 20260227_0011
Revises: 20260220_0010
Create Date: 2026-02-27
"""
from alembic import op
import sqlalchemy as sa

revision = "20260227_0011"
down_revision = "20260220_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("drops", sa.Column("needs_reschedule", sa.Boolean(), nullable=False, server_default=sa.text("false")))
    op.add_column("loads", sa.Column("condition_photo_url", sa.String(1024), nullable=True))
    op.add_column("loads", sa.Column("condition_notes", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("loads", "condition_notes")
    op.drop_column("loads", "condition_photo_url")
    op.drop_column("drops", "needs_reschedule")
