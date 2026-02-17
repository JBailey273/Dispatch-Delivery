from __future__ import annotations

from collections import defaultdict
import uuid
from dataclasses import dataclass
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.entities import Drop, EventLog, Load, LoadStatus, OptimizationProposal, Tenant, User, WindowCode


@dataclass
class LoadContext:
    load: Load
    drop: Drop
    normalized_address: str


def _normalize_address(drop: Drop) -> str:
    return f"{drop.address_id}".lower()


def _address_distance(a: str, b: str) -> int:
    if a == b:
        return 0
    at = set(a.replace('-', ' ').split())
    bt = set(b.replace('-', ' ').split())
    overlap = len(at & bt)
    return max(1, len(at | bt) - overlap)


def _route_cost(items: list[LoadContext]) -> int:
    if len(items) <= 1:
        return 0
    return sum(_address_distance(items[idx].normalized_address, items[idx + 1].normalized_address) for idx in range(len(items) - 1))


def _estimate_typical_delivery_hour(db: Session, tenant_id, load_ids: list[str]) -> float | None:
    if not load_ids:
        return None
    events = db.execute(
        select(EventLog).where(
            EventLog.tenant_id == tenant_id,
            EventLog.event_type == "load.status.updated",
            EventLog.payload_json["status"].astext == LoadStatus.DELIVERED.value,
            EventLog.payload_json["load_id"].astext.in_(load_ids),
        )
    ).scalars().all()
    if not events:
        return None
    hours = [event.created_at.hour + (event.created_at.minute / 60.0) for event in events]
    return round(sum(hours) / len(hours), 2)


def _confidence(level_value: float) -> str:
    if level_value >= 0.75:
        return "high"
    if level_value >= 0.45:
        return "medium"
    return "low"


def _aggressiveness_threshold(tenant: Tenant) -> int:
    return {"low": 2, "medium": 1, "high": 0}.get((tenant.optimization_aggressiveness or "medium").lower(), 1)


def generate_proposals(db: Session, tenant_id, day: date, window: WindowCode | None = None) -> list[OptimizationProposal]:
    tenant = db.execute(select(Tenant).where(Tenant.id == tenant_id)).scalar_one()
    threshold = _aggressiveness_threshold(tenant)
    q = select(Load, Drop).join(Drop, Drop.id == Load.drop_id).where(Load.tenant_id == tenant_id, Load.route_date == day)
    if window:
        q = q.where(Load.route_window == window)
    rows = db.execute(q).all()

    contexts: list[LoadContext] = []
    for load, drop in rows:
        if load.status in (LoadStatus.DELIVERED, LoadStatus.EXCEPTION):
            continue
        contexts.append(LoadContext(load=load, drop=drop, normalized_address=_normalize_address(drop)))

    by_driver_window: dict[tuple[str, WindowCode], list[LoadContext]] = defaultdict(list)
    unassigned: list[LoadContext] = []
    for ctx in contexts:
        if not ctx.load.driver_user_id:
            unassigned.append(ctx)
            continue
        by_driver_window[(str(ctx.load.driver_user_id), ctx.load.route_window)].append(ctx)

    proposals: list[OptimizationProposal] = []

    if tenant.optimization_reordering_enabled:
        for (driver_id, route_window), items in by_driver_window.items():
            ordered_before = sorted(items, key=lambda x: ((x.load.route_sequence or 9999), str(x.load.id)))
            ordered_after = sorted(items, key=lambda x: x.normalized_address)
            before_cost = _route_cost(ordered_before)
            after_cost = _route_cost(ordered_after)
            improvement = before_cost - after_cost
            if improvement <= threshold:
                continue
            typ_hour = _estimate_typical_delivery_hour(db, tenant_id, [str(i.load.id) for i in ordered_before])
            confidence = _confidence(min(1.0, 0.4 + (improvement / max(before_cost, 1))))
            proposals.append(
                OptimizationProposal(
                    tenant_id=tenant_id,
                    proposal_type="REORDER",
                    proposal_date=day,
                    window_code=route_window,
                    confidence_level=confidence,
                    explanation=f"Reordering {len(items)} loads for driver {driver_id[:8]} reduces route backtracking.",
                    affected_load_ids=[str(i.load.id) for i in ordered_before],
                    estimated_benefit={"distance_reduction_units": improvement, "time_saved_minutes": improvement * 4},
                    before_state={"order": [str(i.load.id) for i in ordered_before], "typical_delivery_hour_utc": typ_hour},
                    after_state={"order": [str(i.load.id) for i in ordered_after]},
                )
            )

    if tenant.optimization_reassignment_enabled:
        for route_window in [WindowCode.A, WindowCode.B]:
            pools = {drv: items for (drv, wnd), items in by_driver_window.items() if wnd == route_window}
            if len(pools) < 2:
                continue
            max_driver = max(pools.items(), key=lambda kv: len(kv[1]))
            min_driver = min(pools.items(), key=lambda kv: len(kv[1]))
            imbalance = len(max_driver[1]) - len(min_driver[1])
            if imbalance <= (1 + threshold):
                continue
            move_candidate = sorted(max_driver[1], key=lambda i: (i.load.route_sequence or 9999, str(i.load.id)))[-1]
            confidence = _confidence(min(1.0, 0.35 + imbalance / 10))
            proposals.append(
                OptimizationProposal(
                    tenant_id=tenant_id,
                    proposal_type="BALANCE",
                    proposal_date=day,
                    window_code=route_window,
                    confidence_level=confidence,
                    explanation="Reassigning one load balances workload across drivers in this window.",
                    affected_load_ids=[str(move_candidate.load.id)],
                    estimated_benefit={"workload_delta_before": imbalance, "workload_delta_after": imbalance - 2},
                    before_state={"from_driver_user_id": max_driver[0], "to_driver_user_id": min_driver[0]},
                    after_state={"load_driver_updates": {str(move_candidate.load.id): min_driver[0]}},
                )
            )

    if tenant.optimization_drop_split_enabled:
        by_drop: dict[str, list[LoadContext]] = defaultdict(list)
        for ctx in contexts:
            by_drop[str(ctx.drop.id)].append(ctx)
        for _, items in by_drop.items():
            if len(items) < 2 or not items[0].drop.split_enabled:
                continue
            drivers = {str(i.load.driver_user_id) for i in items if i.load.driver_user_id}
            if len(drivers) > 1:
                continue
            donor = next(iter(drivers), None)
            receiver = next((d for (d, w) in by_driver_window.keys() if w == items[0].load.route_window and d != donor), None)
            if not donor or not receiver:
                continue
            candidate = sorted(items, key=lambda i: i.qty)[0]
            proposals.append(
                OptimizationProposal(
                    tenant_id=tenant_id,
                    proposal_type="SPLIT_OPTION",
                    proposal_date=day,
                    window_code=items[0].load.route_window,
                    confidence_level="medium",
                    explanation="This drop is split-enabled; moving the smallest load can reduce single-driver congestion.",
                    affected_load_ids=[str(candidate.load.id)],
                    estimated_benefit={"workload_balance_units": 1},
                    before_state={"from_driver_user_id": donor, "split_enabled": True},
                    after_state={"load_driver_updates": {str(candidate.load.id): receiver}},
                )
            )

    return proposals


def apply_proposal(db: Session, proposal: OptimizationProposal, selected_load_ids: list[str] | None = None) -> dict:
    selected = set(selected_load_ids or proposal.affected_load_ids)
    affected = [l for l in proposal.affected_load_ids if l in selected]
    if not affected:
        return {"updated": 0}

    loads = db.execute(select(Load).where(Load.tenant_id == proposal.tenant_id, Load.id.in_(affected)).with_for_update()).scalars().all()
    snapshot = {str(l.id): {"driver_user_id": str(l.driver_user_id) if l.driver_user_id else None, "route_sequence": l.route_sequence} for l in loads}

    if proposal.proposal_type == "REORDER":
        after_order = [lid for lid in proposal.after_state.get("order", []) if lid in selected]
        for idx, lid in enumerate(after_order, start=1):
            load = next((l for l in loads if str(l.id) == lid), None)
            if load:
                load.route_sequence = idx
    else:
        updates = proposal.after_state.get("load_driver_updates", {})
        for load in loads:
            to_driver = updates.get(str(load.id))
            if to_driver:
                load.driver_user_id = uuid.UUID(to_driver)

    proposal.status = "applied"
    proposal.application_record = {"before": snapshot, "selected_load_ids": list(selected)}
    return {"updated": len(loads)}


def undo_proposal(db: Session, proposal: OptimizationProposal) -> dict:
    before = (proposal.application_record or {}).get("before", {})
    if not before:
        return {"updated": 0}
    loads = db.execute(select(Load).where(Load.tenant_id == proposal.tenant_id, Load.id.in_(list(before.keys()))).with_for_update()).scalars().all()
    for load in loads:
        snap = before.get(str(load.id), {})
        load.driver_user_id = uuid.UUID(snap["driver_user_id"]) if snap.get("driver_user_id") else None
        load.route_sequence = snap.get("route_sequence")
    proposal.status = "reverted"
    return {"updated": len(loads)}
