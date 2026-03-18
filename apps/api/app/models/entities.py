import enum
import uuid
from datetime import date, datetime, time

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    String,
    Text,
    Time,
    CheckConstraint,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.base_mixins import TenantScopedMixin, TimestampMixin


class UserRole(str, enum.Enum):
    ADMIN = "admin"
    DISPATCHER = "dispatcher"
    DRIVER = "driver"


class DeliveryMode(str, enum.Enum):
    BULK_LOAD = "bulk_load"
    BAG = "bag"
    PALLET = "pallet"


class WindowCode(str, enum.Enum):
    A = "A"
    B = "B"


class LoadStatus(str, enum.Enum):
    NEW = "new"
    ASSIGNED = "assigned"
    LOADED_LEAVING = "loaded_leaving"
    EXCEPTION = "exception"
    DELIVERED = "delivered"
    CANCELLED = "cancelled"


class ExceptionReasonCode(str, enum.Enum):
    CUSTOMER_UNAVAILABLE = "CUSTOMER_UNAVAILABLE"
    ACCESS_BLOCKED = "ACCESS_BLOCKED"
    SAFETY_RISK = "SAFETY_RISK"
    DAMAGED_GOODS = "DAMAGED_GOODS"
    OUT_OF_STOCK = "OUT_OF_STOCK"
    WRONG_ADDRESS = "WRONG_ADDRESS"
    CUSTOMER_REFUSED = "CUSTOMER_REFUSED"
    OTHER = "OTHER"


class CustomerType(str, enum.Enum):
    RESIDENTIAL = "residential"
    COMMERCIAL = "commercial"


class BlackoutReason(str, enum.Enum):
    WEATHER = "weather"
    EQUIPMENT = "equipment"
    STAFFING = "staffing"
    OTHER = "other"


class ChannelType(str, enum.Enum):
    MANUAL = "manual"
    WOOCOMMERCE = "woocommerce"
    CUSTOM = "custom"


class BillingAccountStatus(str, enum.Enum):
    TRIAL = "trial"
    ACTIVE = "active"
    PAST_DUE = "past_due"
    SUSPENDED = "suspended"


# ---------------------------------------------------------------------------
# Tenant
# ---------------------------------------------------------------------------

class Tenant(Base, TimestampMixin):
    __tablename__ = "tenants"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    slug: Mapped[str] = mapped_column(String(120), nullable=False, unique=True, index=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    # Timezone and scheduling fields remain on Tenant as org-level defaults.
    # Each Location can override these independently.
    timezone: Mapped[str] = mapped_column(String(64), default="America/New_York", nullable=False)
    service_days: Mapped[list[str]] = mapped_column(JSON, default=lambda: ["mon", "tue", "wed", "thu", "fri"], nullable=False)
    windowA_start: Mapped[time] = mapped_column(Time, default=time(9, 0), nullable=False)
    windowA_end: Mapped[time] = mapped_column(Time, default=time(13, 0), nullable=False)
    windowB_start: Mapped[time] = mapped_column(Time, default=time(13, 0), nullable=False)
    windowB_end: Mapped[time] = mapped_column(Time, default=time(17, 0), nullable=False)
    capacity_per_window: Mapped[int] = mapped_column(Integer, default=4, nullable=False)
    optimization_reordering_enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    optimization_reassignment_enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    optimization_drop_split_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    optimization_aggressiveness: Mapped[str] = mapped_column(String(16), default="medium", nullable=False)


# ---------------------------------------------------------------------------
# Location — physical storefront/yard within a Tenant
# Each Location owns its own inventory, capacity windows, and deliveries.
# Customers and Users remain tenant-scoped; Users have an optional home_location_id.
# ---------------------------------------------------------------------------

class Location(Base, TenantScopedMixin, TimestampMixin):
    __tablename__ = "locations"
    __table_args__ = (
        UniqueConstraint("tenant_id", "slug", name="uq_location_tenant_slug"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    slug: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    address_line1: Mapped[str | None] = mapped_column(String(255), nullable=True)
    address_line2: Mapped[str | None] = mapped_column(String(255), nullable=True)
    city: Mapped[str | None] = mapped_column(String(120), nullable=True)
    state: Mapped[str | None] = mapped_column(String(120), nullable=True)
    postal_code: Mapped[str | None] = mapped_column(String(20), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(30), nullable=True)
    # Each location can have its own schedule/capacity independent of tenant defaults
    timezone: Mapped[str] = mapped_column(String(64), default="America/New_York", nullable=False)
    service_days: Mapped[list[str]] = mapped_column(JSON, default=lambda: ["mon", "tue", "wed", "thu", "fri"], nullable=False)
    windowA_start: Mapped[time] = mapped_column(Time, default=time(9, 0), nullable=False)
    windowA_end: Mapped[time] = mapped_column(Time, default=time(13, 0), nullable=False)
    windowB_start: Mapped[time] = mapped_column(Time, default=time(13, 0), nullable=False)
    windowB_end: Mapped[time] = mapped_column(Time, default=time(17, 0), nullable=False)
    capacity_per_window: Mapped[int] = mapped_column(Integer, default=4, nullable=False)


# ---------------------------------------------------------------------------
# User
# ---------------------------------------------------------------------------

class User(Base, TenantScopedMixin, TimestampMixin):
    __tablename__ = "users"
    __table_args__ = (
        UniqueConstraint("tenant_id", "email", name="uq_users_tenant_email"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    first_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    last_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    role: Mapped[UserRole] = mapped_column(Enum(UserRole, name="user_role"), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    default_truck_identifier: Mapped[str | None] = mapped_column(String(120), nullable=True)
    # Nullable: drivers are typically tied to one location; dispatchers/admins are location-agnostic
    home_location_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("locations.id"), nullable=True, index=True
    )

    @property
    def display_name(self) -> str:
        if self.first_name and self.last_name:
            return f"{self.first_name} {self.last_name}"
        if self.first_name:
            return self.first_name
        return self.email.split("@")[0]


# ---------------------------------------------------------------------------
# Product Catalog — location-scoped (each location has its own inventory)
# ---------------------------------------------------------------------------

class ProductCatalogItem(Base, TenantScopedMixin, TimestampMixin):
    __tablename__ = "product_catalog_items"
    __table_args__ = (
        # SKU uniqueness is now per location, not just per tenant
        UniqueConstraint("tenant_id", "location_id", "sku", name="uq_product_tenant_location_sku"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    location_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("locations.id"), nullable=False, index=True
    )
    sku: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    delivery_mode: Mapped[DeliveryMode] = mapped_column(Enum(DeliveryMode, name="delivery_mode"), nullable=False)
    unit: Mapped[str] = mapped_column(String(32), nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    category: Mapped[str | None] = mapped_column(String(120), nullable=True)
    bulk_group: Mapped[str] = mapped_column(String(120), nullable=False)


# ---------------------------------------------------------------------------
# Customer — tenant-scoped only (shared across locations)
# ---------------------------------------------------------------------------

class Customer(Base, TenantScopedMixin, TimestampMixin):
    __tablename__ = "customers"
    __table_args__ = (UniqueConstraint("tenant_id", "phone_e164", name="uq_customer_tenant_phone"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    first_name: Mapped[str] = mapped_column(String(120), nullable=False)
    last_name: Mapped[str] = mapped_column(String(120), nullable=False)
    company_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)  # legacy — will be removed after full migration
    phone_e164: Mapped[str] = mapped_column(String(30), nullable=False, index=True)
    customer_type: Mapped[CustomerType] = mapped_column(
        Enum(CustomerType, name="customer_type", values_callable=lambda e: [x.value for x in e]),
        nullable=False,
        default=CustomerType.RESIDENTIAL,
    )

    addresses = relationship("CustomerAddress", back_populates="customer")
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    sms_opt_in: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    email_opt_in: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


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
    is_default: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    customer = relationship("Customer", back_populates="addresses")


# ---------------------------------------------------------------------------
# Capacity — location-scoped
# ---------------------------------------------------------------------------

class WindowCapacity(Base, TenantScopedMixin, TimestampMixin):
    __tablename__ = "window_capacities"
    __table_args__ = (
        # location_id added to unique constraint — each location has its own capacity per window
        UniqueConstraint("tenant_id", "location_id", "service_date", "window_code", name="uq_capacity_window"),
        CheckConstraint("capacity_total >= 1", name="ck_capacity_total_min"),
        CheckConstraint("capacity_used >= 0", name="ck_capacity_used_nonnegative"),
        CheckConstraint("capacity_used <= capacity_total", name="ck_capacity_used_lte_total"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    location_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("locations.id"), nullable=False, index=True
    )
    service_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    window_code: Mapped[WindowCode] = mapped_column(Enum(WindowCode, name="window_code"), nullable=False)
    capacity_total: Mapped[int] = mapped_column(Integer, nullable=False)
    capacity_used: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class CapacityHold(Base, TenantScopedMixin, TimestampMixin):
    __tablename__ = "capacity_holds"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    location_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("locations.id"), nullable=False, index=True
    )
    service_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    window_code: Mapped[WindowCode] = mapped_column(Enum(WindowCode, name="window_code"), nullable=False)
    hold_token: Mapped[str] = mapped_column(String(128), nullable=False, unique=True, index=True)
    cart_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    units_held: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    released_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    converted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    converted_drop_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("drops.id"), nullable=True)


# ---------------------------------------------------------------------------
# Drop — location-scoped (a delivery originates from a specific location)
# ---------------------------------------------------------------------------

class Drop(Base, TenantScopedMixin, TimestampMixin):
    __tablename__ = "drops"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    location_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("locations.id"), nullable=False, index=True
    )
    customer_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("customers.id"), nullable=False)
    address_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("customer_addresses.id"), nullable=False)
    order_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    external_order_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    source: Mapped[str] = mapped_column(String(60), nullable=False, default="manual")
    is_priority: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    status: Mapped[str] = mapped_column(String(50), nullable=False, default="new")
    scheduled_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    scheduled_window: Mapped[WindowCode | None] = mapped_column(Enum(WindowCode, name="drop_window_code"), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    drop_photos: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    split_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    notify_sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_reschedule_sms_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    needs_reschedule: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

class SchedulingToken(Base):
    __tablename__ = "scheduling_tokens"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    drop_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("drops.id"), nullable=False, index=True)
    token: Mapped[str] = mapped_column(String(128), nullable=False, unique=True, index=True)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=lambda: __import__('datetime').datetime.now(__import__('datetime').timezone.utc))

# ---------------------------------------------------------------------------
# Load — inherits location scope via Drop
# ---------------------------------------------------------------------------

class Load(Base, TenantScopedMixin, TimestampMixin):
    __tablename__ = "loads"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    drop_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("drops.id"), nullable=False)
    driver_user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    truck_label: Mapped[str | None] = mapped_column(String(120), nullable=True)
    status: Mapped[LoadStatus] = mapped_column(Enum(LoadStatus, name="load_status"), nullable=False, default=LoadStatus.ASSIGNED)
    route_date: Mapped[date] = mapped_column(Date, nullable=False)
    route_window: Mapped[WindowCode] = mapped_column(Enum(WindowCode, name="load_window_code"), nullable=False)
    bulk_group_snapshot: Mapped[str] = mapped_column(String(120), nullable=False)
    material_name_snapshot: Mapped[str] = mapped_column(String(255), nullable=False)
    qty: Mapped[int] = mapped_column(Integer, nullable=False)
    unit: Mapped[str] = mapped_column(String(32), nullable=False)
    idempotency_key_last: Mapped[str | None] = mapped_column(String(128), nullable=True)
    pod_photo_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    exception_photo_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    exception_reason_code: Mapped[ExceptionReasonCode | None] = mapped_column(Enum(ExceptionReasonCode, name="exception_reason_code"), nullable=True)
    exception_notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    condition_photo_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    condition_notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    route_sequence: Mapped[int | None] = mapped_column(Integer, nullable=True)

    drop = relationship("Drop", lazy="select")


# ---------------------------------------------------------------------------
# Optimization — tenant-scoped (optimization is cross-location for now)
# ---------------------------------------------------------------------------

class OptimizationProposal(Base, TenantScopedMixin, TimestampMixin):
    __tablename__ = "optimization_proposals"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    proposal_type: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    proposal_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    window_code: Mapped[WindowCode] = mapped_column(Enum(WindowCode, name="optimization_window_code"), nullable=False)
    confidence_level: Mapped[str] = mapped_column(String(16), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="proposed")
    explanation: Mapped[str] = mapped_column(Text, nullable=False)
    estimated_benefit: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    affected_load_ids: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    before_state: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    after_state: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    application_record: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)


# ---------------------------------------------------------------------------
# Operational Blackouts — location-scoped
# ---------------------------------------------------------------------------

class OperationalBlackout(Base, TenantScopedMixin, TimestampMixin):
    __tablename__ = "operational_blackouts"
    __table_args__ = (
        # location_id added — blackouts are per-location
        UniqueConstraint("tenant_id", "location_id", "service_date", "window_code", name="uq_operational_blackout"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    location_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("locations.id"), nullable=False, index=True
    )
    service_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    window_code: Mapped[WindowCode | None] = mapped_column(Enum(WindowCode, name="window_code"), nullable=True)
    reason_code: Mapped[BlackoutReason] = mapped_column(Enum(BlackoutReason, name="blackout_reason"), nullable=False)
    reason_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


# ---------------------------------------------------------------------------
# Channels, Billing, Events — tenant-scoped, no location needed
# ---------------------------------------------------------------------------

class Channel(Base, TenantScopedMixin, TimestampMixin):
    __tablename__ = "channels"
    __table_args__ = (
        UniqueConstraint("tenant_id", "name", name="uq_channels_tenant_name"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    channel_type: Mapped[ChannelType] = mapped_column(Enum(ChannelType, name="channel_type"), nullable=False)
    api_key_hash: Mapped[str] = mapped_column(String(128), nullable=False, unique=True, index=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    last_called_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    wc_store_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    wc_consumer_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    wc_consumer_secret: Mapped[str | None] = mapped_column(String(255), nullable=True)


class BillingPlan(Base, TimestampMixin):
    __tablename__ = "billing_plans"

    plan_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    max_drivers: Mapped[int | None] = mapped_column(Integer, nullable=True)
    max_dispatchers: Mapped[int | None] = mapped_column(Integer, nullable=True)
    max_daily_loads: Mapped[int | None] = mapped_column(Integer, nullable=True)
    optimization_features_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    analytics_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    stripe_price_id: Mapped[str | None] = mapped_column(String(120), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class BillingAccount(Base, TimestampMixin):
    __tablename__ = "billing_accounts"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, unique=True, index=True)
    plan_id: Mapped[str] = mapped_column(ForeignKey("billing_plans.plan_id"), nullable=False)
    status: Mapped[BillingAccountStatus] = mapped_column(Enum(BillingAccountStatus, name="billing_account_status"), nullable=False, default=BillingAccountStatus.TRIAL)
    stripe_customer_id: Mapped[str | None] = mapped_column(String(120), nullable=True, index=True)
    stripe_subscription_id: Mapped[str | None] = mapped_column(String(120), nullable=True, index=True)
    trial_ends_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    current_period_start: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    current_period_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class BillingWebhookEvent(Base, TimestampMixin):
    __tablename__ = "billing_webhook_events"
    __table_args__ = (UniqueConstraint("provider", "provider_event_id", name="uq_billing_webhook_event"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    provider: Mapped[str] = mapped_column(String(32), nullable=False)
    provider_event_id: Mapped[str] = mapped_column(String(120), nullable=False)
    event_type: Mapped[str] = mapped_column(String(120), nullable=False)
    payload_json: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class EventLog(Base, TenantScopedMixin):
    __tablename__ = "event_logs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_type: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    source: Mapped[str] = mapped_column(String(120), nullable=False)
    payload_json: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)
