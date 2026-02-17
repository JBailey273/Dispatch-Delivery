"""pod sms r2 fields

Revision ID: 20260217_0002
Revises: 20260217_0001
Create Date: 2026-02-17 00:02:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260217_0002"
down_revision: Union[str, None] = "20260217_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

new_load_status = sa.Enum("assigned", "loaded_leaving", "exception", "delivered", "cancelled", name="load_status")
exception_reason_code = sa.Enum(
    "customer_unavailable",
    "access_blocked",
    "safety_risk",
    "damaged_goods",
    "other",
    name="exception_reason_code",
)


def upgrade() -> None:
    bind = op.get_bind()
    exception_reason_code.create(bind, checkfirst=True)
    op.execute("ALTER TYPE load_status RENAME TO load_status_old")
    new_load_status.create(bind, checkfirst=True)
    op.execute(
        "ALTER TABLE loads ALTER COLUMN status TYPE load_status USING (CASE WHEN status::text='pending' THEN 'assigned' ELSE status::text END)::load_status"
    )
    op.execute("DROP TYPE load_status_old")

    op.add_column("drops", sa.Column("drop_photos", sa.JSON(), nullable=False, server_default="[]"))
    op.add_column("drops", sa.Column("notify_sent_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("drops", sa.Column("last_reschedule_sms_at", sa.DateTime(timezone=True), nullable=True))

    op.add_column("loads", sa.Column("pod_photo_url", sa.String(length=1024), nullable=True))
    op.add_column("loads", sa.Column("exception_photo_url", sa.String(length=1024), nullable=True))
    op.add_column("loads", sa.Column("exception_reason_code", exception_reason_code, nullable=True))
    op.add_column("loads", sa.Column("exception_notes", sa.Text(), nullable=True))

    op.create_table(
        "capacity_holds",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("service_date", sa.Date(), nullable=False),
        sa.Column("window_code", sa.Enum("A", "B", name="window_code", create_type=False), nullable=False),
        sa.Column("units_held", sa.Integer(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("released_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_capacity_holds_service_date"), "capacity_holds", ["service_date"], unique=False)
    op.create_index(op.f("ix_capacity_holds_tenant_id"), "capacity_holds", ["tenant_id"], unique=False)


def downgrade() -> None:
    op.drop_table("capacity_holds")
    op.drop_column("loads", "exception_notes")
    op.drop_column("loads", "exception_reason_code")
    op.drop_column("loads", "exception_photo_url")
    op.drop_column("loads", "pod_photo_url")

    op.drop_column("drops", "last_reschedule_sms_at")
    op.drop_column("drops", "notify_sent_at")
    op.drop_column("drops", "drop_photos")

    op.execute("ALTER TYPE load_status RENAME TO load_status_new")
    old_load_status = sa.Enum("pending", "loaded_leaving", "exception", "delivered", "cancelled", name="load_status")
    old_load_status.create(op.get_bind(), checkfirst=True)
    op.execute(
        "ALTER TABLE loads ALTER COLUMN status TYPE load_status USING (CASE WHEN status::text='assigned' THEN 'pending' ELSE status::text END)::load_status"
    )
    op.execute("DROP TYPE load_status_new")
    exception_reason_code.drop(op.get_bind(), checkfirst=True)
