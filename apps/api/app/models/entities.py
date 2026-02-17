import enum
import uuid
from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, Enum, ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.base_mixins import TenantScopedMixin, TimestampMixin


class UserRole(str, enum.Enum):
    ADMIN = "admin"
    DISPATCHER = "dispatcher"
    DRIVER = "driver"


class Tenant(Base, TimestampMixin):
    __tablename__ = "tenants"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class User(Base, TenantScopedMixin, TimestampMixin):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[UserRole] = mapped_column(Enum(UserRole, name="user_role"), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class Channel(Base, TenantScopedMixin, TimestampMixin):
    __tablename__ = "channels"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    api_key_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class ProductCatalogItem(Base, TenantScopedMixin, TimestampMixin):
    __tablename__ = "product_catalog_items"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    sku: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    metadata_json: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)


class Customer(Base, TenantScopedMixin, TimestampMixin):
    __tablename__ = "customers"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    external_ref: Mapped[str | None] = mapped_column(String(120), nullable=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    phone_e164: Mapped[str | None] = mapped_column(String(30), nullable=True, index=True)

    addresses = relationship("CustomerAddress", back_populates="customer")


class CustomerAddress(Base, TenantScopedMixin, TimestampMixin):
    __tablename__ = "customer_addresses"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    customer_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("customers.id"), nullable=False)
    label: Mapped[str | None] = mapped_column(String(120), nullable=True)
    line1: Mapped[str] = mapped_column(String(255), nullable=False)
    line2: Mapped[str | None] = mapped_column(String(255), nullable=True)
    city: Mapped[str] = mapped_column(String(120), nullable=False)
    state: Mapped[str] = mapped_column(String(120), nullable=False)
    postal_code: Mapped[str] = mapped_column(String(20), nullable=False)
    country: Mapped[str] = mapped_column(String(2), nullable=False, default="US")

    customer = relationship("Customer", back_populates="addresses")


class WindowCapacity(Base, TenantScopedMixin, TimestampMixin):
    __tablename__ = "window_capacities"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    service_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    window_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    window_end: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    capacity_units: Mapped[int] = mapped_column(Integer, nullable=False)
    used_units: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class Hold(Base, TenantScopedMixin, TimestampMixin):
    __tablename__ = "holds"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    customer_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("customers.id"), nullable=True)
    status: Mapped[str] = mapped_column(String(50), nullable=False, default="active")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    payload_json: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)


class Drop(Base, TenantScopedMixin, TimestampMixin):
    __tablename__ = "drops"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    customer_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("customers.id"), nullable=False)
    address_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("customer_addresses.id"), nullable=False)
    status: Mapped[str] = mapped_column(String(50), nullable=False, default="new")
    scheduled_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)


class Load(Base, TenantScopedMixin, TimestampMixin):
    __tablename__ = "loads"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    driver_user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    status: Mapped[str] = mapped_column(String(50), nullable=False, default="pending")
    route_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    total_stops: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class EventLog(Base, TenantScopedMixin):
    __tablename__ = "event_logs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_type: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    source: Mapped[str] = mapped_column(String(120), nullable=False)
    payload_json: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)
