from datetime import date, datetime, timedelta, timezone
from uuid import UUID, uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.api.deps import ChannelAuth
from app.api.routes.availability import (
    AvailabilityIn,
    CartItemIn,
    ConfirmOrderIn,
    CustomerIn,
    DateRangeIn,
    DropIn,
    ExternalOrderIn,
    HoldCreateIn,
    IngestOrderIn,
    channel_availability,
    confirm_hold,
    create_hold,
    ingest_order,
)
from app.db.base import Base
from app.models.entities import (
    CapacityHold,
    Channel,
    ChannelType,
    Customer,
    CustomerAddress,
    DeliveryMode,
    Drop,
    EventLog,
    Load,
    ProductCatalogItem,
    Tenant,
    WindowCapacity,
    WindowCode,
)


@pytest.fixture()
def db_session(tmp_path):
    engine = create_engine(f"sqlite+pysqlite:///{tmp_path / 'test.db'}", future=True)
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    session = SessionLocal()
    yield session
    session.close()


def seed_tenant_data(db: Session):
    tenant = Tenant(id=uuid4(), name="Tenant", slug=f"t-{uuid4().hex[:6]}", capacity_per_window=3)
    channel = Channel(id=uuid4(), tenant_id=tenant.id, name="Woo", channel_type=ChannelType.WOOCOMMERCE, api_key_hash="x", is_active=True)
    customer = Customer(id=uuid4(), tenant_id=tenant.id, name="Manual", phone_e164="+15555550000")
    address = CustomerAddress(
        id=uuid4(),
        tenant_id=tenant.id,
        customer_id=customer.id,
        line1="1 Main",
        city="Dallas",
        state="TX",
        postal_code="75001",
        country="US",
    )
    db.add_all(
        [
            tenant,
            channel,
            customer,
            address,
            ProductCatalogItem(tenant_id=tenant.id, sku="SKU1", name="Gravel", delivery_mode=DeliveryMode.BULK_LOAD, unit="yd", active=True, bulk_group="g1"),
            ProductCatalogItem(tenant_id=tenant.id, sku="SKU2", name="Mulch", delivery_mode=DeliveryMode.BULK_LOAD, unit="yd", active=True, bulk_group="g2"),
        ]
    )
    db.commit()
    return tenant, channel, customer, address


def make_confirm_payload(service_date: date, window: WindowCode, items: list[CartItemIn]):
    return ConfirmOrderIn(
        external_order=ExternalOrderIn(id=f"ord-{uuid4().hex[:8]}", placed_at=datetime.now(timezone.utc), url=None),
        customer=CustomerIn(name="Web", phone="+15555551212", email="web@example.com"),
        drop=DropIn(
            address={"line1": "2 Web St", "city": "Dallas", "state": "TX", "postal_code": "75001", "country": "US"},
            notes="note",
            photos=[],
            requested_date=service_date,
            requested_window=window,
        ),
        items=items,
    )


def test_channel_availability_handles_single_multi_and_near_capacity(db_session):
    tenant, channel, *_ = seed_tenant_data(db_session)
    service_date = date.today() + timedelta(days=1)
    db_session.add(WindowCapacity(tenant_id=tenant.id, service_date=service_date, window_code=WindowCode.A, capacity_total=3, capacity_used=1))
    db_session.add(CapacityHold(tenant_id=tenant.id, service_date=service_date, window_code=WindowCode.A, units_held=1, hold_token="h1", cart_hash="x", expires_at=datetime.now(timezone.utc) + timedelta(minutes=15)))
    db_session.commit()

    single = channel_availability(
        AvailabilityIn(date_range=DateRangeIn(start_date=service_date, end_date=service_date), cart_items=[CartItemIn(sku="SKU1", qty=1)]),
        ChannelAuth(tenant_id=tenant.id, channel_id=channel.id),
        db_session,
    )
    assert single["required_loads"] == 1
    assert single["dates"][0]["windows"][0]["remaining_slots"] == 1

    multi = channel_availability(
        AvailabilityIn(date_range=DateRangeIn(start_date=service_date, end_date=service_date), cart_items=[CartItemIn(sku="SKU1", qty=1), CartItemIn(sku="SKU2", qty=1)]),
        ChannelAuth(tenant_id=tenant.id, channel_id=channel.id),
        db_session,
    )
    assert multi["required_loads"] == 2
    assert multi["dates"][0]["windows"] == [{"window": "B", "remaining_slots": 3}]


def test_hold_creation_validates_required_loads_and_prevents_over_capacity(db_session):
    tenant, channel, *_ = seed_tenant_data(db_session)
    service_date = date.today() + timedelta(days=1)

    with pytest.raises(HTTPException) as bad_req:
        create_hold(HoldCreateIn(date=service_date, window=WindowCode.A, required_loads=2, cart_hash="x", cart_items=[CartItemIn(sku="SKU1", qty=1)]), ChannelAuth(tenant_id=tenant.id, channel_id=channel.id), db_session)
    assert bad_req.value.status_code == 400

    create_hold(HoldCreateIn(date=service_date, window=WindowCode.A, required_loads=2, cart_hash="x", cart_items=[CartItemIn(sku="SKU1", qty=1), CartItemIn(sku="SKU2", qty=1)]), ChannelAuth(tenant_id=tenant.id, channel_id=channel.id), db_session)
    with pytest.raises(HTTPException) as conflict:
        create_hold(HoldCreateIn(date=service_date, window=WindowCode.A, required_loads=2, cart_hash="x2", cart_items=[CartItemIn(sku="SKU1", qty=1), CartItemIn(sku="SKU2", qty=1)]), ChannelAuth(tenant_id=tenant.id, channel_id=channel.id), db_session)
    assert conflict.value.status_code == 409


def test_confirm_hold_expired_and_duplicate(db_session):
    tenant, channel, *_ = seed_tenant_data(db_session)
    service_date = date.today() + timedelta(days=1)
    hold = create_hold(HoldCreateIn(date=service_date, window=WindowCode.A, required_loads=1, cart_hash="x", cart_items=[CartItemIn(sku="SKU1", qty=1)]), ChannelAuth(tenant_id=tenant.id, channel_id=channel.id), db_session)

    row = db_session.execute(select(CapacityHold).where(CapacityHold.hold_token == hold["hold_token"])) .scalar_one()
    row.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
    db_session.commit()
    with pytest.raises(HTTPException) as expired:
        confirm_hold(hold["hold_token"], make_confirm_payload(service_date, WindowCode.A, [CartItemIn(sku="SKU1", qty=1)]), ChannelAuth(tenant_id=tenant.id, channel_id=channel.id), db_session)
    assert expired.value.status_code == 409

    fresh = create_hold(HoldCreateIn(date=service_date, window=WindowCode.A, required_loads=1, cart_hash="y", cart_items=[CartItemIn(sku="SKU1", qty=1)]), ChannelAuth(tenant_id=tenant.id, channel_id=channel.id), db_session)
    confirm_hold(fresh["hold_token"], make_confirm_payload(service_date, WindowCode.A, [CartItemIn(sku="SKU1", qty=1)]), ChannelAuth(tenant_id=tenant.id, channel_id=channel.id), db_session)
    with pytest.raises(HTTPException) as dup:
        confirm_hold(fresh["hold_token"], make_confirm_payload(service_date, WindowCode.A, [CartItemIn(sku="SKU1", qty=1)]), ChannelAuth(tenant_id=tenant.id, channel_id=channel.id), db_session)
    assert dup.value.status_code == 409


def test_ingest_requires_hold_and_matches_manual_drop_structure(db_session):
    tenant, channel, customer, address = seed_tenant_data(db_session)
    service_date = date.today() + timedelta(days=1)
    manual_drop = Drop(tenant_id=tenant.id, customer_id=customer.id, address_id=address.id, scheduled_date=service_date, scheduled_window=WindowCode.A, notes="same")
    db_session.add(manual_drop)
    db_session.flush()
    db_session.add_all([
        Load(tenant_id=tenant.id, drop_id=manual_drop.id, route_date=service_date, route_window=WindowCode.A, bulk_group_snapshot="g1", material_name_snapshot="Gravel", qty=1, unit="yd"),
        Load(tenant_id=tenant.id, drop_id=manual_drop.id, route_date=service_date, route_window=WindowCode.A, bulk_group_snapshot="g2", material_name_snapshot="Mulch", qty=1, unit="yd"),
    ])
    db_session.commit()

    with pytest.raises(HTTPException):
        ingest_order(
            IngestOrderIn(
                hold_token="missing",
                **make_confirm_payload(service_date, WindowCode.B, [CartItemIn(sku="SKU1", qty=1)]).model_dump(),
            ),
            ChannelAuth(tenant_id=tenant.id, channel_id=channel.id),
            db_session,
        )

    hold = create_hold(HoldCreateIn(date=service_date, window=WindowCode.B, required_loads=2, cart_hash="ing", cart_items=[CartItemIn(sku="SKU1", qty=1), CartItemIn(sku="SKU2", qty=1)]), ChannelAuth(tenant_id=tenant.id, channel_id=channel.id), db_session)
    ingested = ingest_order(
        IngestOrderIn(hold_token=hold["hold_token"], **make_confirm_payload(service_date, WindowCode.B, [CartItemIn(sku="SKU1", qty=1), CartItemIn(sku="SKU2", qty=1)]).model_dump()),
        ChannelAuth(tenant_id=tenant.id, channel_id=channel.id),
        db_session,
    )

    manual_loads = db_session.execute(select(Load).where(Load.drop_id == manual_drop.id).order_by(Load.bulk_group_snapshot)).scalars().all()
    ingested_loads = db_session.execute(select(Load).where(Load.drop_id == UUID(ingested["drop_id"])).order_by(Load.bulk_group_snapshot)).scalars().all()
    assert len(manual_loads) == len(ingested_loads) == 2
    assert [(l.bulk_group_snapshot, l.qty, l.unit) for l in manual_loads] == [(l.bulk_group_snapshot, l.qty, l.unit) for l in ingested_loads]

    events = db_session.execute(select(EventLog.event_type)).scalars().all()
    assert "HOLD_CREATED" in events
    assert "HOLD_CONVERTED" in events
    assert "ORDER_INGEST_FAILED" in events
