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
    # Add new uppercase values to the enum first
    op.execute("ALTER TYPE exception_reason_code ADD VALUE IF NOT EXISTS 'CUSTOMER_UNAVAILABLE'")
    op.execute("ALTER TYPE exception_reason_code ADD VALUE IF NOT EXISTS 'ACCESS_BLOCKED'")
    op.execute("ALTER TYPE exception_reason_code ADD VALUE IF NOT EXISTS 'SAFETY_RISK'")
    op.execute("ALTER TYPE exception_reason_code ADD VALUE IF NOT EXISTS 'DAMAGED_GOODS'")
    op.execute("ALTER TYPE exception_reason_code ADD VALUE IF NOT EXISTS 'OTHER'")

    # Commit the enum changes before updating rows
    op.execute("COMMIT")

    # Now update existing rows, casting to text for comparison
    op.execute("UPDATE loads SET exception_reason_code = 'CUSTOMER_UNAVAILABLE'::exception_reason_code WHERE exception_reason_code::text = 'customer_unavailable'")
    op.execute("UPDATE loads SET exception_reason_code = 'ACCESS_BLOCKED'::exception_reason_code WHERE exception_reason_code::text = 'access_blocked'")
    op.execute("UPDATE loads SET exception_reason_code = 'SAFETY_RISK'::exception_reason_code WHERE exception_reason_code::text = 'safety_risk'")
    op.execute("UPDATE loads SET exception_reason_code = 'DAMAGED_GOODS'::exception_reason_code WHERE exception_reason_code::text = 'damaged_goods'")
    op.execute("UPDATE loads SET exception_reason_code = 'OTHER'::exception_reason_code WHERE exception_reason_code::text = 'other'")


def downgrade() -> None:
    pass
