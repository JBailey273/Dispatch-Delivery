from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from app.core.config import settings

try:
    import stripe
except Exception:  # pragma: no cover - optional dependency fallback
    stripe = None


@dataclass
class CheckoutCustomer:
    customer_id: str


class BillingProvider(Protocol):
    def ensure_customer(self, tenant_slug: str, email: str | None) -> CheckoutCustomer: ...

    def create_or_update_subscription(self, customer_id: str, price_id: str) -> dict: ...

    def create_billing_portal_session(self, customer_id: str, return_url: str) -> str: ...

    def list_invoices(self, customer_id: str, limit: int = 12) -> list[dict]: ...


class StripeBillingProvider:
    def __init__(self) -> None:
        if stripe and settings.stripe_api_key:
            stripe.api_key = settings.stripe_api_key

    def _enabled(self) -> bool:
        return bool(stripe and settings.stripe_api_key)

    def ensure_customer(self, tenant_slug: str, email: str | None) -> CheckoutCustomer:
        if not self._enabled():
            return CheckoutCustomer(customer_id=f"test_customer_{tenant_slug}")
        existing = stripe.Customer.search(query=f"metadata['tenant_slug']:'{tenant_slug}'", limit=1)
        if existing.data:
            return CheckoutCustomer(customer_id=existing.data[0].id)
        created = stripe.Customer.create(email=email, metadata={"tenant_slug": tenant_slug})
        return CheckoutCustomer(customer_id=created.id)

    def create_or_update_subscription(self, customer_id: str, price_id: str) -> dict:
        if not self._enabled():
            return {"id": f"sub_{customer_id}", "status": "active", "price_id": price_id}
        subs = stripe.Subscription.list(customer=customer_id, status="all", limit=1)
        if subs.data:
            sub = subs.data[0]
            updated = stripe.Subscription.modify(sub.id, items=[{"id": sub["items"]["data"][0].id, "price": price_id}])
            return dict(updated)
        created = stripe.Subscription.create(customer=customer_id, items=[{"price": price_id}])
        return dict(created)

    def create_billing_portal_session(self, customer_id: str, return_url: str) -> str:
        if not self._enabled():
            return return_url
        session = stripe.billing_portal.Session.create(customer=customer_id, return_url=return_url)
        return session.url

    def list_invoices(self, customer_id: str, limit: int = 12) -> list[dict]:
        if not self._enabled():
            return []
        invoices = stripe.Invoice.list(customer=customer_id, limit=limit)
        return [dict(inv) for inv in invoices.data]
