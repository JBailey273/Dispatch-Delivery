import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import AuthUser, db_dep, require_roles
from app.api.email_service import send_pickup_ready_email
from app.api.services import enqueue_sms_job, log_event, now_utc
from app.api.woocommerce_service import sync_order_status
from app.models.entities import Channel, ChannelType, Customer, Drop, Load, UserRole

logger = logging.getLogger("dispatch.pickup")

router = APIRouter(prefix="/pickup", tags=["pickup"])


def _get_wc_channel(db: Session, tenant_id) -> Channel | None:
    return db.execute(
        select(Channel).where(
            Channel.tenant_id == tenant_id,
            Channel.channel_type == ChannelType.WOOCOMMERCE,
            Channel.is_active == True,
        )
    ).scalar_one_or_none()


@router.get("/queue")
def get_pickup_queue(
    location_id: str | None = Query(default=None),
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER, UserRole.ADMIN)),
    db: Session = Depends(db_dep),
):
    stmt = (
        select(Drop, Customer)
        .join(Customer, Customer.id == Drop.customer_id)
        .where(
            Drop.tenant_id == user.tenant_id,
            Drop.delivery_method == "pickup",
            Drop.fulfilled_at.is_(None),
        )
        .order_by(Drop.created_at.asc())
    )
    if location_id:
        stmt = stmt.where(Drop.location_id == location_id)

    rows = db.execute(stmt).all()

    result = []
    for drop, customer in rows:
        loads = db.execute(select(Load).where(Load.drop_id == drop.id)).scalars().all()
        items = [f"{l.qty} {l.unit} {l.material_name_snapshot}" for l in loads]
        result.append({
            "drop_id": str(drop.id),
            "order_number": drop.order_number,
            "external_order_id": drop.external_order_id,
            "source": drop.source or "manual",
            "customer_name": customer.name,
            "customer_phone": customer.phone_e164,
            "customer_email": customer.email,
            "customer_sms_opt_in": customer.sms_opt_in,
            "customer_email_opt_in": customer.email_opt_in,
            "items": items,
            "notes": drop.notes,
            "created_at": drop.created_at.isoformat(),
            "pickup_ready_sent_at": drop.pickup_ready_sent_at.isoformat() if drop.pickup_ready_sent_at else None,
        })

    return {"drops": result}


@router.post("/{drop_id}/notify-ready")
def notify_pickup_ready(
    drop_id: str,
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER, UserRole.ADMIN)),
    db: Session = Depends(db_dep),
):
    row = db.execute(
        select(Drop, Customer)
        .join(Customer, Customer.id == Drop.customer_id)
        .where(Drop.tenant_id == user.tenant_id, Drop.id == drop_id)
    ).one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Drop not found"})
    drop, customer = row

    if drop.delivery_method != "pickup":
        raise HTTPException(status_code=400, detail={"code": "not_pickup", "message": "This is not a pickup order"})

    sms_sent = False
    email_sent = False

    if customer.sms_opt_in and customer.phone_e164:
        order_label = f"Order #{drop.order_number}" if drop.order_number else "Your order"
        message = f"{order_label} is ready for pickup at East Meadow Garden Center! Head to the yard desk when you arrive."
        sms_sent = enqueue_sms_job(
            {
                "type": "SEND_SMS",
                "tenant_id": str(user.tenant_id),
                "drop_id": str(drop.id),
                "to": customer.phone_e164,
                "template": "custom",
                "message": message,
            },
            dedupe_key=f"pickup-ready-sms-{drop.id}",
        )

    if customer.email and customer.email_opt_in:
        loads = db.execute(select(Load).where(Load.drop_id == drop.id)).scalars().all()
        items = [f"{l.qty} {l.unit} {l.material_name_snapshot}" for l in loads]
        email_sent = send_pickup_ready_email(
            customer.email,
            customer.name,
            drop.order_number,
            items,
        )

    if not sms_sent and not email_sent:
        raise HTTPException(status_code=400, detail={
            "code": "no_channel",
            "message": "Customer has no notification channel — add SMS opt-in or email opt-in first.",
        })

    drop.pickup_ready_sent_at = now_utc()
    log_event(db, user.tenant_id, "pickup.ready_notified", "api", {"drop_id": drop_id})
    db.commit()

    return {
        "sms_sent": sms_sent,
        "email_sent": email_sent,
        "sent_at": drop.pickup_ready_sent_at.isoformat(),
    }


@router.post("/{drop_id}/fulfill")
def fulfill_pickup(
    drop_id: str,
    user: AuthUser = Depends(require_roles(UserRole.DISPATCHER, UserRole.ADMIN)),
    db: Session = Depends(db_dep),
):
    drop = db.execute(
        select(Drop).where(Drop.tenant_id == user.tenant_id, Drop.id == drop_id)
    ).scalar_one_or_none()
    if not drop:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Drop not found"})
    if drop.delivery_method != "pickup":
        raise HTTPException(status_code=400, detail={"code": "not_pickup", "message": "This is not a pickup order"})
    if drop.fulfilled_at:
        return {"already_fulfilled": True, "fulfilled_at": drop.fulfilled_at.isoformat()}

    drop.fulfilled_at = now_utc()

    # Sync completed status back to WooCommerce
    if drop.external_order_id:
        try:
            channel = _get_wc_channel(db, user.tenant_id)
            if channel and channel.wc_store_url and channel.wc_consumer_key:
                sync_order_status(
                    channel.wc_store_url,
                    channel.wc_consumer_key,
                    channel.wc_consumer_secret,
                    drop.external_order_id,
                    "completed",
                )
        except Exception:
            logger.exception("woocommerce_sync_failed on fulfill — continuing")

    log_event(db, user.tenant_id, "pickup.fulfilled", "api", {"drop_id": drop_id})
    db.commit()

    return {"fulfilled_at": drop.fulfilled_at.isoformat()}
