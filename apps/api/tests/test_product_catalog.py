from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.api.deps import AuthUser
from app.api.routes.product_catalog import ProductIn, create_product
from app.db.base import Base
from app.models.entities import DeliveryMode, ProductCatalogItem, Tenant, UserRole


def _setup_db(tmp_path):
    engine = create_engine(f"sqlite+pysqlite:///{tmp_path / 'catalog.db'}", future=True)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    db = Session()
    tenant = Tenant(id=uuid4(), name="Tenant", slug="tenant-catalog")
    db.add(tenant)
    db.commit()
    return db, tenant


def test_create_product_accepts_bulk_group_without_type_error(tmp_path):
    db, tenant = _setup_db(tmp_path)
    user = AuthUser(user_id=uuid4(), tenant_id=tenant.id, role=UserRole.ADMIN)
    payload = ProductIn(
        sku="STONE-34",
        name="3/4 Crushed Stone",
        delivery_mode=DeliveryMode.BULK_LOAD,
        unit="yard",
        active=True,
        bulk_group="AGGREGATE-34",
    )

    result = create_product(payload, user, db)

    created = db.query(ProductCatalogItem).filter(ProductCatalogItem.tenant_id == tenant.id, ProductCatalogItem.sku == "STONE-34").one()
    assert result["id"] == str(created.id)
    assert created.bulk_group == "AGGREGATE-34"


def test_create_product_returns_conflict_for_duplicate_sku(tmp_path):
    db, tenant = _setup_db(tmp_path)

    db.add(
        ProductCatalogItem(
            tenant_id=tenant.id,
            sku="STONE-34",
            name="3/4 Crushed Stone",
            delivery_mode=DeliveryMode.BULK_LOAD,
            unit="yard",
            active=True,
            bulk_group="STONE-34",
        )
    )
    db.commit()

    user = AuthUser(user_id=uuid4(), tenant_id=tenant.id, role=UserRole.ADMIN)
    payload = ProductIn(
        sku="STONE-34",
        name="Duplicate",
        delivery_mode=DeliveryMode.BULK_LOAD,
        unit="yard",
        active=True,
        bulk_group="STONE-34",
    )

    with pytest.raises(HTTPException) as exc:
        create_product(payload, user, db)

    assert exc.value.status_code == 409
    assert exc.value.detail["code"] == "duplicate_sku"
