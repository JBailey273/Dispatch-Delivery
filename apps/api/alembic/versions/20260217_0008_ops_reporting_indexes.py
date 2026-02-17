"""ops reporting and diagnostics indexes

Revision ID: 20260217_0008
Revises: 20260217_0007
Create Date: 2026-02-17 00:08:00.000000
"""
from typing import Sequence, Union

from alembic import op

revision: str = "20260217_0008"
down_revision: Union[str, None] = "20260217_0007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_index("ix_window_capacities_tenant_service_date", "window_capacities", ["tenant_id", "service_date"], unique=False)
    op.create_index("ix_capacity_holds_tenant_service_window", "capacity_holds", ["tenant_id", "service_date", "window_code"], unique=False)
    op.create_index("ix_capacity_holds_tenant_expires", "capacity_holds", ["tenant_id", "expires_at"], unique=False)
    op.create_index("ix_drops_tenant_scheduled_date", "drops", ["tenant_id", "scheduled_date"], unique=False)
    op.create_index("ix_drops_tenant_status", "drops", ["tenant_id", "status"], unique=False)
    op.create_index("ix_loads_tenant_route_date", "loads", ["tenant_id", "route_date"], unique=False)
    op.create_index("ix_loads_tenant_status", "loads", ["tenant_id", "status"], unique=False)
    op.create_index("ix_loads_tenant_driver_route", "loads", ["tenant_id", "driver_user_id", "route_date"], unique=False)
    op.create_index("ix_event_logs_tenant_created", "event_logs", ["tenant_id", "created_at"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_event_logs_tenant_created", table_name="event_logs")
    op.drop_index("ix_loads_tenant_driver_route", table_name="loads")
    op.drop_index("ix_loads_tenant_status", table_name="loads")
    op.drop_index("ix_loads_tenant_route_date", table_name="loads")
    op.drop_index("ix_drops_tenant_status", table_name="drops")
    op.drop_index("ix_drops_tenant_scheduled_date", table_name="drops")
    op.drop_index("ix_capacity_holds_tenant_expires", table_name="capacity_holds")
    op.drop_index("ix_capacity_holds_tenant_service_window", table_name="capacity_holds")
    op.drop_index("ix_window_capacities_tenant_service_date", table_name="window_capacities")
