"""make load route_date and route_window nullable

Revision ID: 20260319_0021
Revises: 20260318_0020
Create Date: 2026-03-19
"""
from alembic import op
import sqlalchemy as sa

revision = '20260319_0021'
down_revision = '20260318_0020'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column('loads', 'route_date',
                    existing_type=sa.DATE(),
                    nullable=True)
    op.alter_column('loads', 'route_window',
                    existing_type=sa.String(),
                    nullable=True)


def downgrade() -> None:
    op.alter_column('loads', 'route_window',
                    existing_type=sa.String(),
                    nullable=False)
    op.alter_column('loads', 'route_date',
                    existing_type=sa.DATE(),
                    nullable=False)
