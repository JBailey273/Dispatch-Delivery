from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import case, func, or_, select
from sqlalchemy.orm import Session

from app.api.deps import AuthUser, db_dep, require_roles
from app.api.services import find_matching_address, log_event, normalize_us_phone, now_utc
from app.models.entities import Customer, CustomerAddress, Drop, UserRole

router = APIRouter(prefix="/customers", tags=["customers"])


class CustomerIn(BaseModel):
    name: str
    phone: str


class AddressIn(BaseModel):
    label: str | None = None
    line1: str
    line2: str | None = None
    city: str
    state: str
    postal_code: str
    country: str = "US"
    is_default: bool = False


@router.get("/search")
def search_customers(
    q: str = Query(..., min_length=1),
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER, UserRole.DRIVER)),
    db: Session = Depends(db_dep),
):
    like = f"%{q}%"
    normalized_phone = None
    try:
        normalized_phone = normalize_us_phone(q)
    except ValueError:
        normalized_phone = None

    last_ordered_subquery = (
        select(Drop.customer_id, func.max(Drop.scheduled_date).label("last_ordered"))
        .where(Drop.tenant_id == user.tenant_id)
        .group_by(Drop.customer_id)
        .subquery()
    )
    stmt = (
        select(Customer, last_ordered_subquery.c.last_ordered)
        .outerjoin(last_ordered_subquery, last_ordered_subquery.c.customer_id == Customer.id)
        .where(
        Customer.tenant_id == user.tenant_id,
        or_(Customer.name.ilike(like), Customer.phone_e164.ilike(like)),
        )
        .order_by(
            case((Customer.phone_e164 == normalized_phone, 0), else_=1),
            last_ordered_subquery.c.last_ordered.desc().nullslast(),
            Customer.name.asc(),
        )
        .limit(20)
    )
    customers = db.execute(stmt).all()
    # address substring support
    addr_stmt = select(CustomerAddress.customer_id).where(
        CustomerAddress.tenant_id == user.tenant_id,
        or_(
            CustomerAddress.line1.ilike(like),
            CustomerAddress.line2.ilike(like),
            CustomerAddress.city.ilike(like),
            CustomerAddress.postal_code.ilike(like),
        ),
    )
    addr_ids = db.execute(addr_stmt).scalars().all()
    if addr_ids:
        more = db.execute(
            select(Customer, last_ordered_subquery.c.last_ordered)
            .outerjoin(last_ordered_subquery, last_ordered_subquery.c.customer_id == Customer.id)
            .where(Customer.id.in_(addr_ids), Customer.tenant_id == user.tenant_id)
        ).all()
        by_id = {c.id: (c, last_ordered) for c, last_ordered in customers}
        for c, last_ordered in more:
            by_id[c.id] = (c, last_ordered)
        customers = list(by_id.values())
    return {
        "results": [
            {
                "id": str(c.id),
                "name": c.name,
                "phone_e164": c.phone_e164,
                "exact_phone_match": bool(normalized_phone and c.phone_e164 == normalized_phone),
                "last_ordered": str(last_ordered) if last_ordered else None,
            }
            for c, last_ordered in customers
        ]
    }


@router.post("")
def create_customer(
    payload: CustomerIn,
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)),
    db: Session = Depends(db_dep),
):
    try:
        phone = normalize_us_phone(payload.phone)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"code": "invalid_phone", "message": str(exc)}) from exc

    existing = db.execute(select(Customer).where(Customer.tenant_id == user.tenant_id, Customer.phone_e164 == phone)).scalar_one_or_none()
    if existing:
        return {"existing": True, "customer": {"id": str(existing.id), "name": existing.name, "phone_e164": existing.phone_e164}}

    customer = Customer(tenant_id=user.tenant_id, name=payload.name, phone_e164=phone)
    db.add(customer)
    db.commit()
    db.refresh(customer)
    return {"existing": False, "customer": {"id": str(customer.id), "name": customer.name, "phone_e164": customer.phone_e164}}


@router.patch("/{customer_id}/name")
def update_customer_name(customer_id: str, payload: dict, user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)), db: Session = Depends(db_dep)):
    customer = db.execute(select(Customer).where(Customer.id == customer_id, Customer.tenant_id == user.tenant_id)).scalar_one_or_none()
    if not customer:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Customer not found"})
    old_name = customer.name
    new_name = payload.get("name", "").strip()
    if not new_name:
        raise HTTPException(status_code=400, detail={"code": "invalid_name", "message": "Name required"})
    mismatch = old_name.strip().lower() != new_name.lower()
    customer.name = new_name
    if mismatch:
        log_event(db, user.tenant_id, "customer.name_changed", "api", {"customer_id": customer_id, "from": old_name, "to": new_name})
    db.commit()
    return {"customer_id": customer_id, "name": new_name, "name_mismatch": mismatch}


@router.get("/{customer_id}/addresses")
def list_addresses(customer_id: str, user: AuthUser = Depends(require_roles(UserRole.DISPATCHER, UserRole.DRIVER)), db: Session = Depends(db_dep)):
    rows = db.execute(select(CustomerAddress).where(CustomerAddress.customer_id == customer_id, CustomerAddress.tenant_id == user.tenant_id)).scalars().all()
    return {"addresses": [{"id": str(a.id), "line1": a.line1, "city": a.city, "state": a.state, "postal_code": a.postal_code, "is_default": a.is_default} for a in rows]}


@router.post("/{customer_id}/addresses")
def create_address(customer_id: str, payload: AddressIn, user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)), db: Session = Depends(db_dep)):
    if payload.is_default:
        db.query(CustomerAddress).filter(CustomerAddress.customer_id == customer_id, CustomerAddress.tenant_id == user.tenant_id).update({"is_default": False})
    addr = CustomerAddress(tenant_id=user.tenant_id, customer_id=customer_id, **payload.model_dump(), last_used_at=now_utc())
    db.add(addr)
    db.commit()
    db.refresh(addr)
    return {"id": str(addr.id)}


@router.post("/{customer_id}/addresses/resolve")
def resolve_address(customer_id: str, payload: dict, user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)), db: Session = Depends(db_dep)):
    address = find_matching_address(db, user.tenant_id, customer_id, payload)
    if address:
        address.last_used_at = now_utc()
        db.commit()
        return {"id": str(address.id), "created": False}
    if payload.get("create_if_missing", True):
        addr = CustomerAddress(
            tenant_id=user.tenant_id,
            customer_id=customer_id,
            line1=payload["line1"],
            line2=payload.get("line2"),
            city=payload["city"],
            state=payload["state"],
            postal_code=payload["postal_code"],
            country=payload.get("country", "US"),
            is_default=payload.get("is_default", False),
            last_used_at=now_utc(),
        )
        db.add(addr)
        db.commit()
        db.refresh(addr)
        return {"id": str(addr.id), "created": True}
    raise HTTPException(status_code=404, detail={"code": "address_not_found", "message": "No matching address"})
