"""add invoice_billing to customers

Revision ID: 0025
Revises: 0024
Create Date: 2026-04-08
"""
from alembic import op
import sqlalchemy as sa

revision = '0025'
down_revision = '0024'
branch_labels = None
depends_on = None

def upgrade():
    op.add_column('customers', sa.Column('invoice_billing', sa.Boolean(), nullable=False, server_default='false'))

def downgrade():
    op.drop_column('customers', 'invoice_billing')
