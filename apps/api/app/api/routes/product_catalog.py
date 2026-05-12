from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import AuthUser, db_dep, require_roles
from app.api.services import parse_csv_upload
from app.models.entities import DeliveryMode, ProductCatalogItem, UserRole

router = APIRouter(prefix="/product-catalog", tags=["product-catalog"])


class ProductIn(BaseModel):
    sku: str
    name: str
    delivery_mode: DeliveryMode
    unit: str
    active: bool = True
    category: str | None = None
    bulk_group: str | None = None
    material_category: str | None = None
    location_id: str | None = None
    sort_order: int = 0


@router.post("/import")
async def import_product_catalog(
    request: Request,
    user: AuthUser = Depends(require_roles(UserRole.ADMIN)),
    db: Session = Depends(db_dep),
):
    rows = parse_csv_upload(await request.body())
    required = {"sku", "name", "delivery_mode", "unit", "active"}
    created = updated = skipped = 0
    errors: list[dict] = []
    for idx, row in enumerate(rows, start=2):
        if not required.issubset(set(row.keys())):
            errors.append({"row": idx, "error": "Missing required columns"})
            continue
        try:
            sku = row["sku"].strip()
            if not sku:
                skipped += 1
                continue
            delivery_mode = DeliveryMode(row["delivery_mode"].strip())
            active = row["active"].strip().lower() in {"true", "1", "yes", "y"}
            bulk_group = (row.get("bulk_group") or sku).strip()
            existing = db.execute(select(ProductCatalogItem).where(ProductCatalogItem.tenant_id == user.tenant_id, ProductCatalogItem.sku == sku)).scalar_one_or_none()
            if existing:
                existing.name = row["name"].strip()
                existing.delivery_mode = delivery_mode
                existing.unit = row["unit"].strip()
                existing.active = active
                existing.category = (row.get("category") or None)
                existing.bulk_group = bulk_group
                updated += 1
            else:
                db.add(ProductCatalogItem(
                    tenant_id=user.tenant_id,
                    sku=sku,
                    name=row["name"].strip(),
                    delivery_mode=delivery_mode,
                    unit=row["unit"].strip(),
                    active=active,
                    category=(row.get("category") or None),
                    bulk_group=bulk_group,
                ))
                created += 1
        except Exception as exc:  # noqa: BLE001
            errors.append({"row": idx, "error": str(exc)})
    db.commit()
    return {"created": created, "updated": updated, "skipped": skipped, "errors": errors}


@router.post("")
def create_product(payload: ProductIn, user: AuthUser = Depends(require_roles(UserRole.ADMIN)), db: Session = Depends(db_dep)):
    # Resolve location
    from app.models.entities import Location
    if payload.location_id:
        location = db.execute(
            select(Location).where(Location.id == payload.location_id, Location.tenant_id == user.tenant_id)
        ).scalar_one_or_none()
        if not location:
            raise HTTPException(status_code=404, detail={"code": "location_not_found", "message": "Location not found"})
    else:
        location = db.execute(
            select(Location).where(Location.tenant_id == user.tenant_id, Location.is_active == True)
            .order_by(Location.created_at)
        ).scalars().first()
        if not location:
            raise HTTPException(status_code=400, detail={"code": "no_location", "message": "No active location found"})

    item = ProductCatalogItem(
        tenant_id=user.tenant_id,
        location_id=location.id,
        sku=payload.sku,
        name=payload.name,
        delivery_mode=payload.delivery_mode,
        unit=payload.unit,
        active=payload.active,
        category=payload.category,
        bulk_group=payload.bulk_group or payload.sku,
    )
    db.add(item)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail={"code": "duplicate_sku", "message": "A product with this SKU already exists"}) from exc
    db.refresh(item)
    return {"id": str(item.id)}


@router.patch("/{item_id}")
def update_product(item_id: str, payload: ProductIn, user: AuthUser = Depends(require_roles(UserRole.ADMIN)), db: Session = Depends(db_dep)):
    item = db.execute(select(ProductCatalogItem).where(ProductCatalogItem.id == item_id, ProductCatalogItem.tenant_id == user.tenant_id)).scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Product not found"})
    for k, v in payload.model_dump(exclude_none=True).items():
        setattr(item, k, v)
    if not item.bulk_group:
        item.bulk_group = item.sku
    db.commit()
    return {"status": "updated"}


@router.post("/{item_id}/disable")
def disable_product(item_id: str, user: AuthUser = Depends(require_roles(UserRole.ADMIN)), db: Session = Depends(db_dep)):
    item = db.execute(select(ProductCatalogItem).where(ProductCatalogItem.id == item_id, ProductCatalogItem.tenant_id == user.tenant_id)).scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Product not found"})
    item.active = False
    db.commit()
    return {"status": "disabled"}


@router.get("")
def list_product_catalog(
    q: str | None = Query(default=None),
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER, UserRole.DRIVER)),
    db: Session = Depends(db_dep),
):
    stmt = select(ProductCatalogItem).where(ProductCatalogItem.tenant_id == user.tenant_id)
    if q:
        like = f"%{q}%"
        stmt = stmt.where((ProductCatalogItem.sku.ilike(like)) | (ProductCatalogItem.name.ilike(like)))
    items = db.execute(stmt.order_by(ProductCatalogItem.sort_order, ProductCatalogItem.name)).scalars().all()
    return {"items": [{"id": str(i.id), "sku": i.sku, "name": i.name, "delivery_mode": i.delivery_mode.value, "unit": i.unit, "active": i.active, "bulk_group": i.bulk_group, "material_category": i.material_category, "sort_order": i.sort_order or 0} for i in items]}
