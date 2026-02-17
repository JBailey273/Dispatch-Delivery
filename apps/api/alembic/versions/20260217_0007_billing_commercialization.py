"""billing commercialization foundation

Revision ID: 20260217_0007
Revises: 20260217_0006
Create Date: 2026-02-17 00:07:00.000000
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260217_0007"
down_revision: Union[str, None] = "20260217_0006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

billing_account_status = sa.Enum("trial", "active", "past_due", "suspended", name="billing_account_status")


def upgrade() -> None:
    bind = op.get_bind()
    billing_account_status.create(bind, checkfirst=True)

    op.create_table(
        "billing_plans",
        sa.Column("plan_id", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("max_drivers", sa.Integer(), nullable=True),
        sa.Column("max_dispatchers", sa.Integer(), nullable=True),
        sa.Column("max_daily_loads", sa.Integer(), nullable=True),
        sa.Column("optimization_features_enabled", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("analytics_enabled", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("stripe_price_id", sa.String(length=120), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.PrimaryKeyConstraint("plan_id"),
    )

    op.create_table(
        "billing_accounts",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("plan_id", sa.String(length=64), nullable=False),
        sa.Column("status", sa.Enum("trial", "active", "past_due", "suspended", name="billing_account_status", create_type=False), nullable=False, server_default="trial"),
        sa.Column("stripe_customer_id", sa.String(length=120), nullable=True),
        sa.Column("stripe_subscription_id", sa.String(length=120), nullable=True),
        sa.Column("trial_ends_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("current_period_start", sa.DateTime(timezone=True), nullable=True),
        sa.Column("current_period_end", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.ForeignKeyConstraint(["plan_id"], ["billing_plans.plan_id"]),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("tenant_id"),
    )
    op.create_index("ix_billing_accounts_tenant_id", "billing_accounts", ["tenant_id"], unique=True)
    op.create_index("ix_billing_accounts_stripe_customer_id", "billing_accounts", ["stripe_customer_id"], unique=False)
    op.create_index("ix_billing_accounts_stripe_subscription_id", "billing_accounts", ["stripe_subscription_id"], unique=False)

    op.create_table(
        "billing_webhook_events",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("provider_event_id", sa.String(length=120), nullable=False),
        sa.Column("event_type", sa.String(length=120), nullable=False),
        sa.Column("payload_json", sa.JSON(), nullable=False, server_default=sa.text("'{}'::json")),
        sa.Column("processed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("provider", "provider_event_id", name="uq_billing_webhook_event"),
    )

    op.execute(
        """
        INSERT INTO billing_plans (plan_id, name, max_drivers, max_dispatchers, max_daily_loads, optimization_features_enabled, analytics_enabled, is_active)
        VALUES
            ('starter', 'Starter', 5, 3, 150, false, false, true),
            ('growth', 'Growth', 25, 10, 1000, true, true, true),
            ('enterprise', 'Enterprise', null, null, null, true, true, true)
        """
    )


def downgrade() -> None:
    op.drop_table("billing_webhook_events")
    op.drop_index("ix_billing_accounts_stripe_subscription_id", table_name="billing_accounts")
    op.drop_index("ix_billing_accounts_stripe_customer_id", table_name="billing_accounts")
    op.drop_index("ix_billing_accounts_tenant_id", table_name="billing_accounts")
    op.drop_table("billing_accounts")
    op.drop_table("billing_plans")
