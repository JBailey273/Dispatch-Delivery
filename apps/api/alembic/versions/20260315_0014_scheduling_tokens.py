"""add scheduling_tokens table

Revision ID: 20260315_0014
Revises: 20260308_0013
Create Date: 2026-03-15
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20260315_0014"
down_revision = "20260308_0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "scheduling_tokens",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("drop_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("token", sa.String(128), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),
        sa.ForeignKeyConstraint(["drop_id"], ["drops.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("token", name="uq_scheduling_token"),
    )
    op.create_index("ix_scheduling_tokens_token", "scheduling_tokens", ["token"])
    op.create_index("ix_scheduling_tokens_drop_id", "scheduling_tokens", ["drop_id"])
    op.create_index("ix_scheduling_tokens_tenant_id", "scheduling_tokens", ["tenant_id"])


def downgrade() -> None:
    op.drop_index("ix_scheduling_tokens_tenant_id", table_name="scheduling_tokens")
    op.drop_index("ix_scheduling_tokens_drop_id", table_name="scheduling_tokens")
    op.drop_index("ix_scheduling_tokens_token", table_name="scheduling_tokens")
    op.drop_table("scheduling_tokens")
