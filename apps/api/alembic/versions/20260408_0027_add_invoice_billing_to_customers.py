"""add invoice_billing to customers

Revision ID: 0027
Revises: 0026
Create Date: 2026-04-08
"""
from alembic import op
import sqlalchemy as sa

revision = '20260408_0027'
down_revision = '20260404_0026'
branch_labels = None
depends_on = None

def upgrade():
    op.add_column('customers', sa.Column('invoice_billing', sa.Boolean(), nullable=False, server_default='false'))

def downgrade():
    op.drop_column('customers', 'invoice_billing')
