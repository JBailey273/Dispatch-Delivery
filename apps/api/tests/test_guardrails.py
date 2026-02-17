from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException

from app.api import guardrails
from app.api.guardrails import CapacityMutationContext, guard_load_editable
from app.api.routes.driver import _ensure_transition
from app.models.entities import LoadStatus


def test_mutate_capacity_increments_within_limits(monkeypatch):
    cap = SimpleNamespace(id="c1", service_date="2026-01-01", window_code=SimpleNamespace(value="A"), capacity_total=5, capacity_used=2)
    monkeypatch.setattr(guardrails, "locked_capacity_row", lambda *args, **kwargs: cap)
    events: list[tuple[str, dict]] = []
    monkeypatch.setattr(guardrails, "log_event", lambda _db, _tenant, event_type, _source, payload: events.append((event_type, payload)))

    out = guardrails.mutate_capacity_or_409(Mock(), "tenant", "2026-01-01", SimpleNamespace(value="A"), 2, CapacityMutationContext(source="api", reason="test"))

    assert out.capacity_used == 4
    assert events[0][0] == "capacity.mutated"


def test_mutate_capacity_rejects_overrun(monkeypatch):
    cap = SimpleNamespace(id="c1", service_date="2026-01-01", window_code=SimpleNamespace(value="A"), capacity_total=3, capacity_used=2)
    monkeypatch.setattr(guardrails, "locked_capacity_row", lambda *args, **kwargs: cap)
    monkeypatch.setattr(guardrails, "log_event", lambda *_args, **_kwargs: None)

    with pytest.raises(HTTPException) as exc:
        guardrails.mutate_capacity_or_409(Mock(), "tenant", "2026-01-01", SimpleNamespace(value="A"), 2, CapacityMutationContext(source="api", reason="test"))
    assert exc.value.status_code == 409


def test_mutate_capacity_rejects_negative(monkeypatch):
    cap = SimpleNamespace(id="c1", service_date="2026-01-01", window_code=SimpleNamespace(value="A"), capacity_total=3, capacity_used=1)
    monkeypatch.setattr(guardrails, "locked_capacity_row", lambda *args, **kwargs: cap)
    monkeypatch.setattr(guardrails, "log_event", lambda *_args, **_kwargs: None)

    with pytest.raises(HTTPException) as exc:
        guardrails.mutate_capacity_or_409(Mock(), "tenant", "2026-01-01", SimpleNamespace(value="A"), -2, CapacityMutationContext(source="api", reason="test"))
    assert exc.value.status_code == 409


def test_delivered_load_is_not_editable():
    delivered = SimpleNamespace(status=LoadStatus.DELIVERED)
    with pytest.raises(HTTPException) as exc:
        guard_load_editable(delivered, "reassigned")
    assert exc.value.status_code == 409


def test_status_transition_machine_rejects_invalid():
    load = SimpleNamespace(status=LoadStatus.ASSIGNED)
    with pytest.raises(HTTPException):
        _ensure_transition(load, LoadStatus.DELIVERED)


def test_status_transition_machine_accepts_valid():
    load = SimpleNamespace(status=LoadStatus.ASSIGNED)
    _ensure_transition(load, LoadStatus.LOADED_LEAVING)
