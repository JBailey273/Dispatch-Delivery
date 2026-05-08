from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import case, func, or_, select, delete
from sqlalchemy.orm import Session

from app.api.deps import AuthUser, db_dep, require_roles
from app.api.services import find_matching_address, log_event, normalize_us_phone, now_utc
from app.models.entities import Customer, CustomerAddress, CustomerType, Drop, Load, UserRole

router = APIRouter(prefix="/customers", tags=["customers"])


class CustomerIn(BaseModel):
    first_name: str | None = None
    last_name: str | None = None
    name: str | None = None  # legacy full name fallback
    company_name: str | None = None
    phone: str
    email: str | None = None
    customer_type: str = "residential"


class AddressIn(BaseModel):
    label: str | None = None
    line1: str
    line2: str | None = None
    city: str
    state: str
    postal_code: str
    country: str = "US"
    is_default: bool = False

class CompanyNameIn(BaseModel):
    company_name: str | None = None


# ── Address normalization ─────────────────────────────────────────────────────
# Applied going-forward on all address creates and updates.

_TITLE_CASE_EXCEPTIONS = {
    "po", "p.o.", "rr", "hc",  # rural/PO prefixes kept lower until title'd
}

_ALWAYS_UPPER = {
    # Two-letter state abbreviations and common directional abbreviations
    "ne", "nw", "se", "sw", "n", "s", "e", "w",
}

_PRESERVE_UPPER = {
    # Abbreviations that should stay fully upper after title-casing
    "po", "p.o.",
}


def _normalize_word(word: str) -> str:
    """Title-case a single word with special-case handling."""
    lower = word.lower()
    # Keep short directionals upper: NE, SW etc.
    if lower in _ALWAYS_UPPER and len(lower) <= 2:
        return lower.upper()
    # Ordinals: 1st 2nd 3rd 4th → keep lowercase suffix
    if len(word) >= 2 and word[:-2].isdigit() and word[-2:].lower() in ("st", "nd", "rd", "th"):
        return word[:-2] + word[-2:].lower()
    # Hyphenated words: title-case each part
    if "-" in word:
        return "-".join(_normalize_word(p) for p in word.split("-"))
    return word.capitalize()


def normalize_address_field(value: str | None) -> str | None:
    """Title-case an address text field (line1, line2, city)."""
    if not value:
        return value
    return " ".join(_normalize_word(w) for w in value.strip().split())


def normalize_state(value: str | None) -> str | None:
    """Uppercase state abbreviation."""
    if not value:
        return value
    return value.strip().upper()


def normalize_postal(value: str | None) -> str | None:
    """Strip whitespace from postal code; preserve as-is otherwise."""
    if not value:
        return value
    return value.strip()


def apply_address_normalization(data: dict) -> dict:
    """Return a copy of address data with normalized fields."""
    return {
        **data,
        "line1": normalize_address_field(data.get("line1")),
        "line2": normalize_address_field(data.get("line2")),
        "city": normalize_address_field(data.get("city")),
        "state": normalize_state(data.get("state")),
        "postal_code": normalize_postal(data.get("postal_code")),
    }


# ── Helpers ───────────────────────────────────────────────────────────────────

def _customer_dict(c: Customer, last_ordered=None):
    return {
        "id": str(c.id),
        "first_name": c.first_name,
        "last_name": c.last_name,
        "company_name": c.company_name,
        "name": f"{c.first_name} {c.last_name}".strip(),
        "phone_e164": c.phone_e164,
        "customer_type": c.customer_type.value if c.customer_type else "residential",
        "last_ordered": str(last_ordered) if last_ordered else None,
        "email": c.email,
        "sms_opt_in": c.sms_opt_in,
        "email_opt_in": c.email_opt_in,
        "invoice_billing": c.invoice_billing,
        "stripe_customer_id": c.stripe_customer_id,
    }

def _get_customer_or_404(db: Session, customer_id: str, tenant_id) -> Customer:
    customer = db.execute(
        select(Customer).where(Customer.id == customer_id, Customer.tenant_id == tenant_id)
    ).scalar_one_or_none()
    if not customer:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Customer not found"})
    return customer


def _get_address_or_404(db: Session, customer_id: str, address_id: str, tenant_id) -> CustomerAddress:
    addr = db.execute(
        select(CustomerAddress).where(
            CustomerAddress.id == address_id,
            CustomerAddress.customer_id == customer_id,
            CustomerAddress.tenant_id == tenant_id,
        )
    ).scalar_one_or_none()
    if not addr:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Address not found"})
    return addr


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("")
def list_customers(
    limit: int = Query(default=500, ge=1, le=2000),
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER, UserRole.DRIVER)),
    db: Session = Depends(db_dep),
):
    last_ordered_subquery = (
        select(Drop.customer_id, func.max(
            func.coalesce(Drop.scheduled_date, func.cast(Drop.created_at, Date))
        ).label("last_ordered"))
        .where(Drop.tenant_id == user.tenant_id)
        .group_by(Drop.customer_id)
        .subquery()
    )
    stmt = (
        select(Customer, last_ordered_subquery.c.last_ordered)
        .outerjoin(last_ordered_subquery, last_ordered_subquery.c.customer_id == Customer.id)
        .where(Customer.tenant_id == user.tenant_id)
        .order_by(last_ordered_subquery.c.last_ordered.desc().nullslast(), Customer.name.asc())
        .limit(limit)
    )
    customers = db.execute(stmt).all()
    return {"results": [_customer_dict(c, last_ordered) for c, last_ordered in customers]}


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
        select(Drop.customer_id, func.max(
            func.coalesce(Drop.scheduled_date, func.cast(Drop.created_at, Date))
        ).label("last_ordered"))
        .where(Drop.tenant_id == user.tenant_id)
        .group_by(Drop.customer_id)
        .subquery()
    )
    stmt = (
        select(Customer, last_ordered_subquery.c.last_ordered)
        .outerjoin(last_ordered_subquery, last_ordered_subquery.c.customer_id == Customer.id)
        .where(
            Customer.tenant_id == user.tenant_id,
            or_(
                Customer.name.ilike(like),
                Customer.phone_e164.ilike(like),
                Customer.company_name.ilike(like),
            ),
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
                **_customer_dict(c, last_ordered),
                "exact_phone_match": bool(normalized_phone and c.phone_e164 == normalized_phone),
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

    existing = db.execute(
        select(Customer).where(Customer.tenant_id == user.tenant_id, Customer.phone_e164 == phone)
    ).scalar_one_or_none()
    if existing:
        return {"existing": True, "customer": _customer_dict(existing)}

    ct = CustomerType.COMMERCIAL if payload.customer_type == "commercial" else CustomerType.RESIDENTIAL
    # Support both split and full name
    first_name = payload.first_name.strip() if hasattr(payload, 'first_name') and payload.first_name else payload.name.strip().split()[0] if payload.name else "Unknown"
    last_name = payload.last_name.strip() if hasattr(payload, 'last_name') and payload.last_name else " ".join(payload.name.strip().split()[1:]) if payload.name and len(payload.name.strip().split()) > 1 else ""
    customer = Customer(
        tenant_id=user.tenant_id,
        name=f"{first_name} {last_name}".strip(),
        first_name=first_name,
        last_name=last_name,
        company_name=payload.company_name.strip() if payload.company_name else None,
        email=payload.email.strip().lower() if payload.email else None,
        phone_e164=phone,
        customer_type=ct,
    )
    db.add(customer)
    db.commit()
    db.refresh(customer)
    return {"existing": False, "customer": _customer_dict(customer)}


@router.get("/{customer_id}")
def get_customer(
    customer_id: str,
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER, UserRole.DRIVER)),
    db: Session = Depends(db_dep),
):
    customer = _get_customer_or_404(db, customer_id, user.tenant_id)
    last_ordered_subquery = (
        select(func.max(func.cast(Drop.created_at, Date)).label("last_ordered"))
        .where(Drop.tenant_id == user.tenant_id, Drop.customer_id == customer.id)
    ).scalar_subquery()
    last_ordered = db.execute(select(last_ordered_subquery)).scalar_one_or_none()
    return {**_customer_dict(customer, last_ordered)}


@router.delete("/{customer_id}", status_code=200)
def delete_customer(
    customer_id: str,
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)),
    db: Session = Depends(db_dep),
):
    """
    Hard-delete a customer and all their addresses.
    Blocked if the customer has any drops (orders) on record.
    """
    customer = _get_customer_or_404(db, customer_id, user.tenant_id)

    # Safety check: do not delete customers with existing orders
    drop_count = db.execute(
        select(func.count()).select_from(Drop).where(
            Drop.customer_id == customer_id,
            Drop.tenant_id == user.tenant_id,
        )
    ).scalar_one()
    if drop_count > 0:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "customer_has_orders",
                "message": f"Cannot delete customer with {drop_count} existing order(s). Archive or reassign orders first.",
            },
        )

    log_event(db, user.tenant_id, "customer.deleted", "api", {
        "customer_id": customer_id,
        "name": customer.name,
        "phone": customer.phone_e164,
    })
    # Cascade delete addresses first
    db.execute(
        delete(CustomerAddress).where(
            CustomerAddress.customer_id == customer_id,
            CustomerAddress.tenant_id == user.tenant_id,
        )
    )
    db.delete(customer)
    db.commit()
    return {"deleted": True, "customer_id": customer_id}


@router.patch("/{customer_id}/name")
def update_customer_name(
    customer_id: str,
    payload: dict,
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)),
    db: Session = Depends(db_dep),
):
    customer = _get_customer_or_404(db, customer_id, user.tenant_id)
    old_name = f"{customer.first_name} {customer.last_name}".strip()

    if "first_name" in payload or "last_name" in payload:
        first_name = payload.get("first_name", customer.first_name or "").strip()
        last_name = payload.get("last_name", customer.last_name or "").strip()
    elif "name" in payload:
        parts = payload.get("name", "").strip().split()
        first_name = parts[0] if parts else ""
        last_name = " ".join(parts[1:]) if len(parts) > 1 else ""
    else:
        raise HTTPException(status_code=400, detail={"code": "invalid_name", "message": "Name required"})

    if not first_name:
        raise HTTPException(status_code=400, detail={"code": "invalid_name", "message": "First name required"})

    customer.first_name = first_name
    customer.last_name = last_name
    customer.name = f"{first_name} {last_name}".strip()

    log_event(db, user.tenant_id, "customer.name_changed", "api", {
        "customer_id": customer_id, "from": old_name, "to": customer.name,
    })
    db.commit()
    return {"customer_id": customer_id, "first_name": first_name, "last_name": last_name, "name": customer.name}

@router.patch("/{customer_id}/company")
def update_customer_company(
    customer_id: str,
    payload: CompanyNameIn,
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER, UserRole.ADMIN)),
    db: Session = Depends(db_dep),
):
    customer = _get_customer_or_404(db, customer_id, user.tenant_id)
    customer.company_name = payload.company_name.strip() if payload.company_name else None
    db.commit()
    return {"company_name": customer.company_name}
    
@router.patch("/{customer_id}/phone")
def update_customer_phone(
    customer_id: str,
    payload: dict,
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)),
    db: Session = Depends(db_dep),
):
    customer = _get_customer_or_404(db, customer_id, user.tenant_id)
    raw_phone = payload.get("phone", "").strip()
    try:
        new_phone = normalize_us_phone(raw_phone)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"code": "invalid_phone", "message": str(exc)}) from exc

    # Check uniqueness within tenant
    conflict = db.execute(
        select(Customer).where(
            Customer.tenant_id == user.tenant_id,
            Customer.phone_e164 == new_phone,
            Customer.id != customer_id,
        )
    ).scalar_one_or_none()
    if conflict:
        raise HTTPException(
            status_code=409,
            detail={"code": "phone_conflict", "message": "Another customer already has this phone number."},
        )

    old_phone = customer.phone_e164
    customer.phone_e164 = new_phone
    log_event(db, user.tenant_id, "customer.phone_changed", "api", {
        "customer_id": customer_id, "from": old_phone, "to": new_phone,
    })
    db.commit()
    return {"customer_id": customer_id, "phone_e164": new_phone}


@router.patch("/{customer_id}/type")
def update_customer_type(
    customer_id: str,
    payload: dict,
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)),
    db: Session = Depends(db_dep),
):
    customer = _get_customer_or_404(db, customer_id, user.tenant_id)
    new_type = payload.get("customer_type", "").strip().lower()
    if new_type not in ("residential", "commercial"):
        raise HTTPException(status_code=400, detail={"code": "invalid_type", "message": "Must be 'residential' or 'commercial'"})
    old_type = customer.customer_type.value if customer.customer_type else "residential"
    customer.customer_type = CustomerType.COMMERCIAL if new_type == "commercial" else CustomerType.RESIDENTIAL
    if old_type != new_type:
        log_event(db, user.tenant_id, "customer.type_changed", "api", {
            "customer_id": customer_id, "from": old_type, "to": new_type,
        })
    db.commit()
    return {"customer_id": customer_id, "customer_type": new_type}

class EmailIn(BaseModel):
    email: str | None = None

@router.patch("/{customer_id}/email")
def update_customer_email(customer_id: str, payload: EmailIn, user: AuthUser = Depends(require_roles(UserRole.DISPATCHER, UserRole.ADMIN)), db: Session = Depends(db_dep)):
    customer = _get_customer_or_404(db, customer_id, user.tenant_id)
    customer.email = payload.email.strip().lower() if payload.email else None
    db.commit()
    return {"email": customer.email}


class OptInsIn(BaseModel):
    sms_opt_in: bool | None = None
    email_opt_in: bool | None = None

@router.patch("/{customer_id}/opt-ins")
def update_customer_opt_ins(customer_id: str, payload: OptInsIn, user: AuthUser = Depends(require_roles(UserRole.DISPATCHER, UserRole.ADMIN)), db: Session = Depends(db_dep)):
    customer = _get_customer_or_404(db, customer_id, user.tenant_id)
    if payload.sms_opt_in is not None:
        customer.sms_opt_in = payload.sms_opt_in
    if payload.email_opt_in is not None:
        customer.email_opt_in = payload.email_opt_in
    db.commit()
    return {"sms_opt_in": customer.sms_opt_in, "email_opt_in": customer.email_opt_in}


@router.get("/{customer_id}/addresses")
def list_addresses(
    customer_id: str,
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER, UserRole.DRIVER)),
    db: Session = Depends(db_dep),
):
    rows = db.execute(
        select(CustomerAddress).where(
            CustomerAddress.customer_id == customer_id,
            CustomerAddress.tenant_id == user.tenant_id,
        )
    ).scalars().all()
    return {
        "addresses": [
            {
                "id": str(a.id),
                "line1": a.line1,
                "line2": a.line2,
                "city": a.city,
                "state": a.state,
                "postal_code": a.postal_code,
                "is_default": a.is_default,
            }
            for a in rows
        ]
    }


@router.post("/{customer_id}/addresses")
def create_address(
    customer_id: str,
    payload: AddressIn,
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)),
    db: Session = Depends(db_dep),
):
    if payload.is_default:
        db.query(CustomerAddress).filter(
            CustomerAddress.customer_id == customer_id,
            CustomerAddress.tenant_id == user.tenant_id,
        ).update({"is_default": False})

    data = apply_address_normalization(payload.model_dump())
    addr = CustomerAddress(
        tenant_id=user.tenant_id,
        customer_id=customer_id,
        **data,
        last_used_at=now_utc(),
    )
    db.add(addr)
    db.commit()
    db.refresh(addr)
    return {"id": str(addr.id)}


@router.patch("/{customer_id}/addresses/{address_id}")
def update_address(
    customer_id: str,
    address_id: str,
    payload: dict,
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)),
    db: Session = Depends(db_dep),
):
    addr = _get_address_or_404(db, customer_id, address_id, user.tenant_id)

    updatable = ["line1", "line2", "city", "state", "postal_code", "is_default", "label"]
    raw = {k: payload[k] for k in updatable if k in payload}
    normalized = apply_address_normalization(raw)

    if normalized.get("is_default"):
        db.query(CustomerAddress).filter(
            CustomerAddress.customer_id == customer_id,
            CustomerAddress.tenant_id == user.tenant_id,
            CustomerAddress.id != address_id,
        ).update({"is_default": False})

    for k, v in normalized.items():
        setattr(addr, k, v)

    db.commit()
    return {
        "id": str(addr.id),
        "line1": addr.line1,
        "line2": addr.line2,
        "city": addr.city,
        "state": addr.state,
        "postal_code": addr.postal_code,
        "is_default": addr.is_default,
    }


@router.delete("/{customer_id}/addresses/{address_id}", status_code=200)
def delete_address(
    customer_id: str,
    address_id: str,
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)),
    db: Session = Depends(db_dep),
):
    addr = _get_address_or_404(db, customer_id, address_id, user.tenant_id)
    db.delete(addr)
    db.commit()
    return {"deleted": True, "address_id": address_id}


@router.post("/{customer_id}/addresses/resolve")
def resolve_address(
    customer_id: str,
    payload: dict,
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER)),
    db: Session = Depends(db_dep),
):
    address = find_matching_address(db, user.tenant_id, customer_id, payload)
    if address:
        address.last_used_at = now_utc()
        db.commit()
        return {"id": str(address.id), "created": False}
    if payload.get("create_if_missing", True):
        data = apply_address_normalization({
            "line1": payload["line1"],
            "line2": payload.get("line2"),
            "city": payload["city"],
            "state": payload["state"],
            "postal_code": payload["postal_code"],
        })
        addr = CustomerAddress(
            tenant_id=user.tenant_id,
            customer_id=customer_id,
            country=payload.get("country", "US"),
            is_default=payload.get("is_default", False),
            last_used_at=now_utc(),
            **data,
        )
        db.add(addr)
        db.commit()
        db.refresh(addr)
        return {"id": str(addr.id), "created": True}
    raise HTTPException(status_code=404, detail={"code": "address_not_found", "message": "No matching address"})
