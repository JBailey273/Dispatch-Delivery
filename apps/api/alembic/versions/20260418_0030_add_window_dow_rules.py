"""add window_dow_rules to locations

Revision ID: 20260418_0030
Revises: 20260415_0029
Create Date: 2026-04-18
"""
from alembic import op
import sqlalchemy as sa

revision = '20260418_0030'
down_revision = '20260415_0029'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        'locations',
        sa.Column(
            'window_dow_rules',
            sa.JSON(),
            nullable=False,
            server_default='{"A": {"disabled_days": []}, "B": {"disabled_days": []}}',
        )
    )


def downgrade():
    op.drop_column('locations', 'window_dow_rules')
