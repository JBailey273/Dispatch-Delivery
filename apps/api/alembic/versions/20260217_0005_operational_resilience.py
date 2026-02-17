"""operational resilience analytics and blackout controls

Revision ID: 20260217_0005
Revises: 20260217_0004
Create Date: 2026-02-17 00:05:00.000000
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260217_0005"
down_revision: Union[str, None] = "20260217_0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

blackout_reason = sa.Enum("weather", "equipment", "staffing", "other", name="blackout_reason")


def upgrade() -> None:
    bind = op.get_bind()
    blackout_reason.create(bind, checkfirst=True)

    op.create_table(
        "operational_blackouts",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("service_date", sa.Date(), nullable=False),
        sa.Column("window_code", sa.Enum("A", "B", name="window_code", create_type=False), nullable=True),
        sa.Column("reason_code", blackout_reason, nullable=False),
        sa.Column("reason_note", sa.Text(), nullable=True),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("tenant_id", "service_date", "window_code", name="uq_operational_blackout"),
    )
    op.create_index("ix_operational_blackouts_service_date", "operational_blackouts", ["service_date"], unique=False)

    op.create_index("ix_event_logs_tenant_created", "event_logs", ["tenant_id", "created_at"], unique=False)
    op.create_index("ix_loads_tenant_route_date_window_status", "loads", ["tenant_id", "route_date", "route_window", "status"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_loads_tenant_route_date_window_status", table_name="loads")
    op.drop_index("ix_event_logs_tenant_created", table_name="event_logs")
    op.drop_index("ix_operational_blackouts_service_date", table_name="operational_blackouts")
    op.drop_table("operational_blackouts")
