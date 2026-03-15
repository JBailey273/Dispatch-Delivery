"""make scheduled_date nullable for unscheduled drops

Revision ID: 20260315_0015
Revises: 20260315_0014
Create Date: 2026-03-15
"""
from alembic import op
import sqlalchemy as sa

revision = "20260315_0015"
down_revision = "20260315_0014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Make scheduled_date nullable on drops
    op.alter_column("drops", "scheduled_date",
        existing_type=sa.Date(),
        nullable=True,
    )
    # Make scheduled_window nullable on drops (already is, but explicit)
    op.alter_column("drops", "scheduled_window",
        existing_type=sa.Enum("A", "B", name="drop_window_code"),
        nullable=True,
    )
    # Make route_date nullable on loads (unscheduled drops have no loads yet,
    # but future-proofing in case we ever create placeholder loads)
    op.alter_column("loads", "route_date",
        existing_type=sa.Date(),
        nullable=True,
    )


def downgrade() -> None:
    op.alter_column("loads", "route_date",
        existing_type=sa.Date(),
        nullable=False,
    )
    op.alter_column("drops", "scheduled_date",
        existing_type=sa.Date(),
        nullable=False,
    )
