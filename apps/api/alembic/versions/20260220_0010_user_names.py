"""add user names

Revision ID: 20260220_0010
Revises: 20260220_0009
Create Date: 2026-02-20
"""
from alembic import op
import sqlalchemy as sa

revision = "20260220_0010"
down_revision = "20260220_0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("first_name", sa.String(120), nullable=True))
    op.add_column("users", sa.Column("last_name", sa.String(120), nullable=True))

    # Backfill: extract name from email prefix (e.g. "john.doe" -> "John" / "Doe")
    conn = op.get_bind()
    conn.execute(sa.text("""
        UPDATE users SET
            first_name = INITCAP(SPLIT_PART(SPLIT_PART(email, '@', 1), '.', 1)),
            last_name = CASE
                WHEN POSITION('.' IN SPLIT_PART(email, '@', 1)) > 0
                THEN INITCAP(SPLIT_PART(SPLIT_PART(email, '@', 1), '.', 2))
                ELSE NULL
            END
    """))


def downgrade() -> None:
    op.drop_column("users", "last_name")
    op.drop_column("users", "first_name")
