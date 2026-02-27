"""normalize exception_reason_code enum values to uppercase

Revision ID: 20260227_0012
Revises: 20260227_0011
Branch_labels = None
depends_on = None
"""
from alembic import op

revision = "20260227_0012"
down_revision = "20260227_0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Update existing lowercase values in the loads table
    op.execute("UPDATE loads SET exception_reason_code = 'CUSTOMER_UNAVAILABLE' WHERE exception_reason_code = 'customer_unavailable'")
    op.execute("UPDATE loads SET exception_reason_code = 'ACCESS_BLOCKED' WHERE exception_reason_code = 'access_blocked'")
    op.execute("UPDATE loads SET exception_reason_code = 'SAFETY_RISK' WHERE exception_reason_code = 'safety_risk'")
    op.execute("UPDATE loads SET exception_reason_code = 'DAMAGED_GOODS' WHERE exception_reason_code = 'damaged_goods'")
    op.execute("UPDATE loads SET exception_reason_code = 'OTHER' WHERE exception_reason_code = 'other'")

    # Add the new uppercase values to the enum
    op.execute("ALTER TYPE exception_reason_code ADD VALUE IF NOT EXISTS 'CUSTOMER_UNAVAILABLE'")
    op.execute("ALTER TYPE exception_reason_code ADD VALUE IF NOT EXISTS 'ACCESS_BLOCKED'")
    op.execute("ALTER TYPE exception_reason_code ADD VALUE IF NOT EXISTS 'SAFETY_RISK'")
    op.execute("ALTER TYPE exception_reason_code ADD VALUE IF NOT EXISTS 'DAMAGED_GOODS'")
    op.execute("ALTER TYPE exception_reason_code ADD VALUE IF NOT EXISTS 'OTHER'")


def downgrade() -> None:
    pass
