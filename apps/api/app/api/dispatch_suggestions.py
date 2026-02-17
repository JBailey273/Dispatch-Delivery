from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timezone
from threading import Lock
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.entities import CustomerAddress, Drop, EventLog, Load, LoadStatus, User, UserRole

_CACHE_TTL_SECONDS = 180
_CACHE: dict[tuple[str, str], tuple[datetime, list[dict[str, Any]]]] = {}
_CACHE_LOCK = Lock()


@dataclass
class AddressHistory:
    address_id: str
    exception_count: int
    delivered_count: int
    typical_delivery_hour_utc: float | None
    recent_notes: list[str]


@dataclass
class DriverSignal:
    driver_user_id: str
    exceptions: int
    delivered: int



def _utc_now() -> datetime:
    return datetime.now(timezone.utc)



def invalidate_suggestion_cache(tenant_id: str) -> None:
    with _CACHE_LOCK:
        to_delete = [key for key in _CACHE if key[0] == tenant_id]
        for key in to_delete:
            del _CACHE[key]



def _parse_payload_id(payload: dict, field: str) -> str | None:
    value = payload.get(field)
    return str(value) if value else None



def get_address_history(db: Session, tenant_id: str, address_id: str) -> AddressHistory:
    loads = db.execute(select(Load).where(Load.tenant_id == tenant_id)).scalars().all()
    drops = db.execute(select(Drop).where(Drop.tenant_id == tenant_id)).scalars().all()
    load_to_drop = {str(load.id): str(load.drop_id) for load in loads}
    drop_to_address = {str(drop.id): str(drop.address_id) for drop in drops}

    event_rows = db.execute(
        select(EventLog).where(EventLog.tenant_id == tenant_id, EventLog.event_type == "LOAD_STATUS_CHANGED")
    ).scalars().all()

    exception_count = 0
    delivered_count = 0
    delivered_hours: list[float] = []
    recent_notes: list[str] = []

    for event in event_rows:
        payload = event.payload_json or {}
        load_id = _parse_payload_id(payload, "load_id")
        if not load_id:
            continue
        drop_id = load_to_drop.get(load_id)
        if not drop_id:
            continue
        mapped_address_id = drop_to_address.get(drop_id)
        if mapped_address_id != address_id:
            continue
        status = payload.get("status")
        if status == LoadStatus.EXCEPTION.value:
            exception_count += 1
            note = payload.get("notes")
            if note:
                recent_notes.append(str(note))
        if status == LoadStatus.DELIVERED.value:
            delivered_count += 1
            delivered_hours.append(event.created_at.hour + event.created_at.minute / 60)

    typical = round(sum(delivered_hours) / len(delivered_hours), 2) if delivered_hours else None
    return AddressHistory(
        address_id=address_id,
        exception_count=exception_count,
        delivered_count=delivered_count,
        typical_delivery_hour_utc=typical,
        recent_notes=recent_notes[-3:],
    )



def get_driver_performance_signals(db: Session, tenant_id: str, day: date) -> list[DriverSignal]:
    loads = db.execute(
        select(Load).where(Load.tenant_id == tenant_id, Load.route_date <= day, Load.driver_user_id.isnot(None))
    ).scalars().all()
    counters: dict[str, dict[str, int]] = defaultdict(lambda: {"exception": 0, "delivered": 0})
    for load in loads:
        if not load.driver_user_id:
            continue
        did = str(load.driver_user_id)
        if load.status == LoadStatus.EXCEPTION:
            counters[did]["exception"] += 1
        if load.status == LoadStatus.DELIVERED:
            counters[did]["delivered"] += 1
    return [DriverSignal(driver_user_id=k, exceptions=v["exception"], delivered=v["delivered"]) for k, v in counters.items()]



def build_dispatch_suggestions(db: Session, tenant_id: str, day: date) -> list[dict[str, Any]]:
    key = (tenant_id, str(day))
    with _CACHE_LOCK:
        cached = _CACHE.get(key)
        if cached and (_utc_now() - cached[0]).total_seconds() < _CACHE_TTL_SECONDS:
            return cached[1]

    loads_rows = db.execute(
        select(Load, Drop, CustomerAddress)
        .join(Drop, Drop.id == Load.drop_id)
        .join(CustomerAddress, CustomerAddress.id == Drop.address_id)
        .where(Load.tenant_id == tenant_id, Load.route_date == day)
    ).all()

    suggestions: list[dict[str, Any]] = []
    address_ids = {str(drop.address_id) for _, drop, _ in loads_rows}
    history_by_address = {address_id: get_address_history(db, tenant_id, address_id) for address_id in address_ids}

    # Rule 1: nearby drops that are both unassigned in same window
    by_geo_window: dict[tuple[str, str, str], list[tuple[Load, Drop]]] = defaultdict(list)
    for load, drop, address in loads_rows:
        geo_key = (address.postal_code.strip().upper(), address.city.strip().upper(), load.route_window.value)
        by_geo_window[geo_key].append((load, drop))

    for (postal_code, city, window), entries in by_geo_window.items():
        unassigned = [(load, drop) for load, drop in entries if load.driver_user_id is None]
        if len(unassigned) >= 2:
            load1, drop1 = unassigned[0]
            load2, drop2 = unassigned[1]
            suggestions.append(
                {
                    "suggestion_type": "co_assign_nearby_drops",
                    "confidence": "high",
                    "explanation": f"These two Drops are in {city} {postal_code} during window {window}; one driver may handle both.",
                    "why": "Shared city/postal code and delivery window with both loads currently unassigned.",
                    "data_used": ["drop address postal code", "drop address city", "route window", "driver assignment status"],
                    "referenced_entities": {
                        "drop_ids": [str(drop1.id), str(drop2.id)],
                        "load_ids": [str(load1.id), str(load2.id)],
                    },
                }
            )

    # Rule 2: lower-load driver in window
    drivers = db.execute(select(User).where(User.tenant_id == tenant_id, User.role == UserRole.DRIVER, User.is_active.is_(True))).scalars().all()
    for window in ["A", "B"]:
        driver_counts = {str(driver.id): 0 for driver in drivers}
        for load, _, _ in loads_rows:
            if load.route_window.value == window and load.driver_user_id:
                driver_counts[str(load.driver_user_id)] = driver_counts.get(str(load.driver_user_id), 0) + 1
        if len(driver_counts) >= 2:
            min_driver = min(driver_counts.items(), key=lambda item: item[1])
            max_driver = max(driver_counts.items(), key=lambda item: item[1])
            if max_driver[1] - min_driver[1] >= 2:
                suggestions.append(
                    {
                        "suggestion_type": "balance_driver_load",
                        "confidence": "medium",
                        "explanation": "One active driver has substantially fewer assigned loads in this window.",
                        "why": f"Driver {min_driver[0]} has {min_driver[1]} loads vs {max_driver[1]} for driver {max_driver[0]} in window {window}.",
                        "data_used": ["active drivers", "assigned load counts by window"],
                        "referenced_entities": {
                            "window": window,
                            "target_driver_user_id": min_driver[0],
                            "most_loaded_driver_user_id": max_driver[0],
                        },
                    }
                )

    # Rule 3: late window + exception history
    for load, drop, _ in loads_rows:
        history = history_by_address[str(drop.address_id)]
        if load.route_window.value == "B" and history.exception_count > 0:
            suggestions.append(
                {
                    "suggestion_type": "watch_late_window_exception_risk",
                    "confidence": "medium" if history.exception_count < 3 else "high",
                    "explanation": "This Drop is in the later window and the address has past exceptions.",
                    "why": f"Window B delivery and {history.exception_count} historical exception(s) at this address.",
                    "data_used": ["scheduled window", "event log exception history by address"],
                    "referenced_entities": {
                        "drop_id": str(drop.id),
                        "address_id": str(drop.address_id),
                        "load_id": str(load.id),
                    },
                }
            )

    with _CACHE_LOCK:
        _CACHE[key] = (_utc_now(), suggestions)

    return suggestions
