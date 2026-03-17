"""split customer name into first_name and last_name

Revision ID: 20260317_0017
Revises: 20260316_0016
Create Date: 2026-03-17
"""
from alembic import op
import sqlalchemy as sa

revision = "20260317_0017"
down_revision = "20260316_0016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("customers", sa.Column("first_name", sa.String(120), nullable=True))
    op.add_column("customers", sa.Column("last_name", sa.String(120), nullable=True))
    # Backfill from existing name field — split on first space
    op.execute("""
        UPDATE customers
        SET first_name = split_part(name, ' ', 1),
            last_name = CASE
                WHEN strpos(name, ' ') > 0
                THEN substring(name from strpos(name, ' ') + 1)
                ELSE ''
            END
    """)
    op.alter_column("customers", "first_name", nullable=False)
    op.alter_column("customers", "last_name", nullable=False)


def downgrade() -> None:
    op.drop_column("customers", "last_name")
    op.drop_column("customers", "first_name")
