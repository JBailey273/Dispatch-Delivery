from datetime import date, time
import uuid

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import db_dep
from app.core.security import create_access_token, get_password_hash
from app.db.base import Base
from app.main import app
from app.models.entities import Customer, CustomerAddress, Drop, Load, Tenant, User, UserRole, WindowCode


def _token(user: User, tenant: Tenant) -> str:
    return create_access_token(subject=str(user.id), extra_claims={"role": user.role.value, "tenant_id": str(tenant.id), "tenant_slug": tenant.slug})


def _setup_client():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)

    def override_db():
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[db_dep] = override_db
    return TestClient(app), TestingSessionLocal


def test_cross_tenant_customer_and_drop_id_guessing_returns_not_found():
    client, Session = _setup_client()
    with Session() as db:
        t1 = Tenant(name="Tenant One", slug="tenant-one", timezone="UTC", service_days=["mon"], windowA_start=time(9, 0), windowA_end=time(12, 0), windowB_start=time(12, 0), windowB_end=time(17, 0), capacity_per_window=1)
        t2 = Tenant(name="Tenant Two", slug="tenant-two", timezone="UTC", service_days=["mon"], windowA_start=time(9, 0), windowA_end=time(12, 0), windowB_start=time(12, 0), windowB_end=time(17, 0), capacity_per_window=1)
        db.add_all([t1, t2])
        db.flush()
        admin2 = User(tenant_id=t2.id, email="a2@example.com", hashed_password=get_password_hash("pw"), role=UserRole.ADMIN, is_active=True)
        customer1 = Customer(tenant_id=t1.id, name="C1", phone_e164="+15550000001")
        db.add_all([admin2, customer1])
        db.flush()
        addr1 = CustomerAddress(tenant_id=t1.id, customer_id=customer1.id, line1="1 Main", city="X", state="NY", postal_code="10001", country="US", is_default=True)
        db.add(addr1)
        db.flush()
        drop1 = Drop(tenant_id=t1.id, customer_id=customer1.id, address_id=addr1.id, scheduled_date=date.today(), scheduled_window=WindowCode.A)
        db.add(drop1)
        db.commit()
        token = _token(admin2, t2)

    headers = {"Authorization": f"Bearer {token}", "X-Tenant-Slug": "tenant-two"}
    customer_res = client.patch(f"/api/v1/customers/{customer1.id}/name", json={"name": "Hacker"}, headers=headers)
    drop_res = client.post(
        f"/api/v1/drops/{drop1.id}/reschedule",
        json={"scheduled_date": str(date.today()), "scheduled_window": "A", "reason": "x"},
        headers=headers,
    )

    assert customer_res.status_code == 404
    assert drop_res.status_code == 404


def test_cross_tenant_load_id_guessing_returns_not_found():
    client, Session = _setup_client()
    with Session() as db:
        t1 = Tenant(name="Tenant One", slug="tenant-one", timezone="UTC", service_days=["mon"], windowA_start=time(9, 0), windowA_end=time(12, 0), windowB_start=time(12, 0), windowB_end=time(17, 0), capacity_per_window=1)
        t2 = Tenant(name="Tenant Two", slug="tenant-two", timezone="UTC", service_days=["mon"], windowA_start=time(9, 0), windowA_end=time(12, 0), windowB_start=time(12, 0), windowB_end=time(17, 0), capacity_per_window=1)
        db.add_all([t1, t2])
        db.flush()
        driver2 = User(tenant_id=t2.id, email="d2@example.com", hashed_password=get_password_hash("pw"), role=UserRole.DRIVER, is_active=True)
        driver1 = User(tenant_id=t1.id, email="d1@example.com", hashed_password=get_password_hash("pw"), role=UserRole.DRIVER, is_active=True)
        customer1 = Customer(tenant_id=t1.id, name="C1", phone_e164="+15550000001")
        db.add_all([driver2, driver1, customer1])
        db.flush()
        addr1 = CustomerAddress(tenant_id=t1.id, customer_id=customer1.id, line1="1 Main", city="X", state="NY", postal_code="10001", country="US", is_default=True)
        db.add(addr1)
        db.flush()
        drop1 = Drop(tenant_id=t1.id, customer_id=customer1.id, address_id=addr1.id, scheduled_date=date.today(), scheduled_window=WindowCode.A)
        db.add(drop1)
        db.flush()
        load1 = Load(tenant_id=t1.id, drop_id=drop1.id, driver_user_id=driver1.id, route_date=date.today(), route_window=WindowCode.A, bulk_group_snapshot="g", material_name_snapshot="m", qty=1, unit="yard")
        db.add(load1)
        db.commit()
        token = _token(driver2, t2)

    headers = {"Authorization": f"Bearer {token}", "X-Tenant-Slug": "tenant-two"}
    res = client.get(f"/api/v1/driver/loads/{load1.id}", headers=headers)
    assert res.status_code == 404


def test_slug_mismatch_guard_blocks_access_without_identifier_leaks():
    client, Session = _setup_client()
    with Session() as db:
        t2 = Tenant(name="Tenant Two", slug="tenant-two", timezone="UTC", service_days=["mon"], windowA_start=time(9, 0), windowA_end=time(12, 0), windowB_start=time(12, 0), windowB_end=time(17, 0), capacity_per_window=1)
        user2 = User(id=uuid.uuid4(), tenant_id=t2.id, email="a2@example.com", hashed_password=get_password_hash("pw"), role=UserRole.ADMIN, is_active=True)
        db.add_all([t2, user2])
        db.commit()
        token = _token(user2, t2)

    headers = {"Authorization": f"Bearer {token}", "X-Tenant-Slug": "wrong-tenant"}
    res = client.get("/api/v1/users", headers=headers)
    assert res.status_code == 403
    assert "tenant-two" not in res.text
