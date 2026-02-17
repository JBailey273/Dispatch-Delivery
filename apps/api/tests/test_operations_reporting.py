from datetime import date, datetime, timedelta, timezone
from uuid import uuid4

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.api.deps import AuthUser
from app.api.routes.operations import (
    BlackoutIn,
    anomalies,
    capacity_utilization_report,
    create_blackout,
    exceptions_report,
    throughput_report,
)
from app.db.base import Base
from app.models.entities import (
    BlackoutReason,
    CapacityHold,
    Customer,
    CustomerAddress,
    Drop,
    EventLog,
    Load,
    LoadStatus,
    Tenant,
    UserRole,
    WindowCapacity,
    WindowCode,
)


def test_reporting_and_anomaly_autofix(tmp_path):
    engine = create_engine(f"sqlite+pysqlite:///{tmp_path / 'ops.db'}", future=True)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    db = Session()

    tenant = Tenant(id=uuid4(), name='Tenant', slug='tenant-ops', capacity_per_window=4)
    customer = Customer(id=uuid4(), tenant_id=tenant.id, name='Acme', phone_e164='+15555550001')
    address = CustomerAddress(id=uuid4(), tenant_id=tenant.id, customer_id=customer.id, line1='1 Main St', city='Austin', state='TX', postal_code='78701', country='US')
    db.add_all([tenant, customer, address])
    db.flush()

    day = date.today()
    drop = Drop(id=uuid4(), tenant_id=tenant.id, customer_id=customer.id, address_id=address.id, scheduled_date=day, scheduled_window=WindowCode.A)
    load = Load(id=uuid4(), tenant_id=tenant.id, drop_id=drop.id, route_date=day, route_window=WindowCode.A, status=LoadStatus.EXCEPTION, bulk_group_snapshot='g', material_name_snapshot='Gravel', qty=1, unit='yd', exception_notes='gate blocked')
    cap = WindowCapacity(tenant_id=tenant.id, service_date=day, window_code=WindowCode.A, capacity_total=3, capacity_used=2)
    expired_hold = CapacityHold(tenant_id=tenant.id, service_date=day, window_code=WindowCode.A, units_held=1, hold_token='expired', cart_hash='x', expires_at=datetime.now(timezone.utc) - timedelta(minutes=10), converted_at=None, released_at=None)
    db.add_all([drop, load, cap, expired_hold])
    db.add(EventLog(tenant_id=tenant.id, event_type='LOAD_STATUS_CHANGED', source='driver', payload_json={'load_id': str(load.id), 'status': 'exception', 'exception_notes': 'gate blocked'}))
    db.commit()

    user = AuthUser(user_id=uuid4(), tenant_id=tenant.id, role=UserRole.ADMIN)
    cap_report = capacity_utilization_report(day, day, user, db)
    throughput = throughput_report(day, day, None, None, None, user, db)
    ex = exceptions_report(day, day, True, user, db)
    diag = anomalies(True, user, db)

    assert cap_report['totals']['capacity_used'] == 2
    assert throughput['per_day'][0]['loads_exceptioned'] == 1
    assert ex['exceptions_per_day'][0]['count'] == 1
    assert diag['auto_fix_applied'] == 1

    blackout_payload = BlackoutIn(service_date=day, window_code=None, reason_code=BlackoutReason.WEATHER, reason_note='storm')
    result = create_blackout(blackout_payload, user, db)
    assert result['status'] == 'ok'
