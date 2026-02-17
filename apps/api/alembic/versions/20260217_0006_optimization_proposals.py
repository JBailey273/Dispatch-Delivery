"""optimization proposals and tenant controls

Revision ID: 20260217_0006
Revises: 20260217_0005
Create Date: 2026-02-17 00:06:00.000000
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260217_0006"
down_revision: Union[str, None] = "20260217_0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

optimization_window_code = sa.Enum("A", "B", name="optimization_window_code")


def upgrade() -> None:
    bind = op.get_bind()
    optimization_window_code.create(bind, checkfirst=True)

    op.add_column("tenants", sa.Column("optimization_reordering_enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")))
    op.add_column("tenants", sa.Column("optimization_reassignment_enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")))
    op.add_column("tenants", sa.Column("optimization_drop_split_enabled", sa.Boolean(), nullable=False, server_default=sa.text("false")))
    op.add_column("tenants", sa.Column("optimization_aggressiveness", sa.String(length=16), nullable=False, server_default="medium"))

    op.add_column("drops", sa.Column("split_enabled", sa.Boolean(), nullable=False, server_default=sa.text("false")))
    op.add_column("loads", sa.Column("route_sequence", sa.Integer(), nullable=True))

    op.create_table(
        "optimization_proposals",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("proposal_type", sa.String(length=40), nullable=False),
        sa.Column("proposal_date", sa.Date(), nullable=False),
        sa.Column("window_code", sa.Enum("A", "B", name="optimization_window_code", create_type=False), nullable=False),
        sa.Column("confidence_level", sa.String(length=16), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="proposed"),
        sa.Column("explanation", sa.Text(), nullable=False),
        sa.Column("estimated_benefit", sa.JSON(), nullable=False, server_default=sa.text("'{}'::json")),
        sa.Column("affected_load_ids", sa.JSON(), nullable=False, server_default=sa.text("'[]'::json")),
        sa.Column("before_state", sa.JSON(), nullable=False, server_default=sa.text("'{}'::json")),
        sa.Column("after_state", sa.JSON(), nullable=False, server_default=sa.text("'{}'::json")),
        sa.Column("application_record", sa.JSON(), nullable=False, server_default=sa.text("'{}'::json")),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_optimization_proposals_proposal_type", "optimization_proposals", ["proposal_type"], unique=False)
    op.create_index("ix_optimization_proposals_proposal_date", "optimization_proposals", ["proposal_date"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_optimization_proposals_proposal_date", table_name="optimization_proposals")
    op.drop_index("ix_optimization_proposals_proposal_type", table_name="optimization_proposals")
    op.drop_table("optimization_proposals")

    op.drop_column("loads", "route_sequence")
    op.drop_column("drops", "split_enabled")

    op.drop_column("tenants", "optimization_aggressiveness")
    op.drop_column("tenants", "optimization_drop_split_enabled")
    op.drop_column("tenants", "optimization_reassignment_enabled")
    op.drop_column("tenants", "optimization_reordering_enabled")
