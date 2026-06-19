"""
API integration test (build step 5, directive 3). Hits the real FastAPI app
with a mock dev session against a throwaway SQLite DB, verifying:
  a) data persists to the database,
  b) the scoring engine computes daily scores on save,
  c) renormalization triggers when a user leaves a non-required field blank.

Env is set BEFORE importing the app so the cached settings + module-level
engine bind to the temp DB. DEV_MODE makes get_current_user return the dev
user, so no real token is needed.
"""
import os
import tempfile
from datetime import date as dt_date

import pytest

# ── Bind a temp DB and dev mode before any app import ─────────────────────────
_TMP = tempfile.mkdtemp()
_DB_PATH = os.path.join(_TMP, "test_api.db")
os.environ["DEV_MODE"] = "true"
os.environ["DATABASE_URL"] = f"sqlite:///{_DB_PATH}"
os.environ["FRONTEND_ORIGIN"] = "http://localhost:5173"
# Make sure no production marker is set (would 503 the dev bypass).
for marker in ("RENDER", "VERCEL", "PRODUCTION"):
    os.environ.pop(marker, None)

from fastapi.testclient import TestClient  # noqa: E402

from app.db import engine  # noqa: E402
from app.models import Base, BodyweightEntry, DailyLog  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture(scope="module")
def client():
    Base.metadata.create_all(engine)
    with TestClient(app) as c:
        yield c
    Base.metadata.drop_all(engine)


def test_morning_persists_and_scores(client):
    r = client.post(
        "/api/logs/morning",
        json={
            "date": "2026-06-10",
            "morning_readiness": 8,
            "sleep_hours": 7.5,
            "bodyweight": 184.0,  # optional quick-entry → bodyweight_entries
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()

    # (a) persistence: the daily_logs row and the bodyweight entry both landed.
    with SessionLocal() as db:
        row = db.query(DailyLog).all()
        assert len(row) == 1
        assert row[0].morning_done is True
        assert row[0].sleep_hours == 7.5
        bw = db.query(BodyweightEntry).all()
        assert len(bw) == 1 and bw[0].value == 184.0
        # bodyweight is NOT a daily_logs column
        assert not hasattr(row[0], "bodyweight")

    # (b) scoring computed on save: Health is scorable from readiness alone.
    scores = body["scores"]
    assert "Health" in scores["pillars"]
    assert scores["pillars"]["Health"]["score"] == pytest.approx(0.8)  # readiness only
    assert 0 <= scores["day_score"] <= 100

    # (c) renormalization: no bodyweight GOAL and macros not logged → both
    # optional Health blocks drop, leaving readiness at full weight.
    assert set(scores["pillars"]["Health"]["dropped"]) == {"bw_trend", "nutrition"}
    # Fitness / Finance not scorable yet (no evening log) → excluded from day.
    assert "Fitness" not in scores["pillars"]
    assert "Finances" not in scores["pillars"]


def test_evening_completes_day_and_renormalizes_optional_blocks(client):
    r = client.post(
        "/api/logs/evening",
        json={
            "date": "2026-06-10",
            "training_done": True,
            "deep_work_hours": 4,
            "discretionary_spend": 0,
            # macro_adherence + workout_rpe deliberately omitted (non-required)
        },
    )
    assert r.status_code == 200, r.text
    scores = r.json()["scores"]

    # (a) evening persisted onto the SAME row.
    with SessionLocal() as db:
        rows = db.query(DailyLog).all()
        assert len(rows) == 1
        assert rows[0].evening_done is True
        assert rows[0].training_done is True
        assert rows[0].macro_adherence is None  # left blank stays null

    # (b) all three pillars now score.
    assert {"Health", "Fitness", "Finances"} <= set(scores["pillars"])

    # (c) renormalization on the blank optionals:
    #   - Fitness: RPE omitted → rpe block dropped.
    #   - Health:  macros still omitted → nutrition dropped.
    assert "rpe" in scores["pillars"]["Fitness"]["dropped"]
    assert "nutrition" in scores["pillars"]["Health"]["dropped"]
    # Finance with no budget set → spend neutral 0.8, allocation excluded
    # (no weekly log yet, no prior week) → Finance == spend == 0.8.
    assert "allocation" in scores["pillars"]["Finances"]["dropped"]
    assert scores["pillars"]["Finances"]["score"] == pytest.approx(0.8)


def test_validation_rejects_out_of_range(client):
    r = client.post(
        "/api/logs/morning",
        json={"date": "2026-06-10", "morning_readiness": 99, "sleep_hours": 7.5},
    )
    assert r.status_code == 422  # Pydantic range check (1–10)


def test_validation_rejects_future_date(client):
    r = client.post(
        "/api/logs/morning",
        json={"date": "2999-01-01", "morning_readiness": 5, "sleep_hours": 7},
    )
    assert r.status_code == 422


def test_validation_rejects_unknown_field(client):
    r = client.post(
        "/api/logs/morning",
        json={
            "date": "2026-06-09",
            "morning_readiness": 5,
            "sleep_hours": 7,
            "screen_time_hours": 3,  # off-whitelist (§4) → forbidden
        },
    )
    assert r.status_code == 422


# ── Read/CRUD endpoints (the cutover surface) ─────────────────────────────────


def test_profile_read_and_update(client):
    r = client.get("/api/profile")
    assert r.status_code == 200
    assert r.json()["active_pillars"] == ["Health", "Fitness", "Finances"]

    r = client.put("/api/profile", json={"bodyweight_goal": 180.0, "daily_budget": 100.0})
    assert r.status_code == 200
    assert r.json()["bodyweight_goal"] == 180.0
    assert client.get("/api/profile").json()["daily_budget"] == 100.0

    # weekly token targets default to null and round-trip; out-of-range rejected.
    assert r.json()["weekly_workout_target"] is None
    set_targets = client.put("/api/profile", json={"weekly_workout_target": 5, "weekly_rest_target": 2})
    assert set_targets.status_code == 200
    assert set_targets.json()["weekly_workout_target"] == 5
    assert client.get("/api/profile").json()["weekly_rest_target"] == 2
    assert client.put("/api/profile", json={"weekly_workout_target": 9}).status_code == 422


def test_habits_crud_and_soft_delete(client):
    created = client.post(
        "/api/habits",
        json={"name": "Read 30 minutes", "pillar": "Health", "frequency_type": "daily"},
    )
    assert created.status_code == 201
    hid = created.json()["id"]
    # value_type defaults to binary; numeric metadata is null for completion habits.
    assert created.json()["value_type"] == "binary"
    assert created.json()["unit_label"] is None
    assert created.json()["target_per_session"] is None

    assert any(h["id"] == hid for h in client.get("/api/habits?active_only=true").json())

    renamed = client.put(f"/api/habits/{hid}", json={"name": "Read 45 minutes"})
    assert renamed.json()["name"] == "Read 45 minutes"

    assert client.delete(f"/api/habits/{hid}").status_code == 204
    # soft delete: gone from active, still present (archived) in the full list
    assert all(h["id"] != hid for h in client.get("/api/habits?active_only=true").json())
    archived = next(h for h in client.get("/api/habits").json() if h["id"] == hid)
    assert archived["is_active"] is False


def test_numeric_habit_round_trips(client):
    """A numeric habit persists its unit_label + per-session default, and the
    tracking shape can be edited back to binary (clearing the numeric metadata)."""
    created = client.post(
        "/api/habits",
        json={
            "name": "Running",
            "pillar": "Fitness",
            "value_type": "numeric",
            "unit_label": "miles",
            "target_per_session": 1,
        },
    )
    assert created.status_code == 201
    body = created.json()
    assert body["value_type"] == "numeric"
    assert body["unit_label"] == "miles"
    assert body["target_per_session"] == 1
    hid = body["id"]

    # per-session must be > 0 when supplied
    assert (
        client.post(
            "/api/habits",
            json={"name": "Bad", "value_type": "numeric", "target_per_session": 0},
        ).status_code
        == 422
    )

    # switch back to a completion habit, clearing the numeric metadata
    edited = client.put(
        f"/api/habits/{hid}",
        json={"value_type": "binary", "unit_label": None, "target_per_session": None},
    )
    assert edited.status_code == 200
    assert edited.json()["value_type"] == "binary"
    assert edited.json()["unit_label"] is None
    assert edited.json()["target_per_session"] is None


def test_habit_completion_persists(client):
    hid = client.post("/api/habits", json={"name": "Cold shower"}).json()["id"]
    r = client.put(f"/api/habits/{hid}/completion", json={"date": "2026-06-10", "completed": True})
    assert r.status_code == 200 and r.json()["completed"] is True
    rows = client.get("/api/habits/completions?from=2026-06-10&to=2026-06-10").json()
    assert any(c["habit_id"] == hid and c["completed"] for c in rows)
    # idempotent upsert on (habit, date)
    client.put(f"/api/habits/{hid}/completion", json={"date": "2026-06-10", "completed": False})
    rows = client.get("/api/habits/completions?from=2026-06-10&to=2026-06-10").json()
    assert sum(1 for c in rows if c["habit_id"] == hid) == 1


def test_completion_quantity_round_trips(client):
    """A numeric habit's per-session volume persists on the completion (Evening
    wizard) and is echoed on save + read; omitting it yields null; negative is
    rejected. The completion stays a binary done/not-done — quantity is extra."""
    hid = client.post(
        "/api/habits",
        json={"name": "Run", "value_type": "numeric", "unit_label": "miles"},
    ).json()["id"]

    # quantity rides along with the completion …
    r = client.put(
        f"/api/habits/{hid}/completion",
        json={"date": "2026-06-11", "completed": True, "quantity": 5.5},
    )
    assert r.status_code == 200, r.text
    assert r.json()["completed"] is True and r.json()["quantity"] == 5.5
    rows = client.get("/api/habits/completions?from=2026-06-11&to=2026-06-11").json()
    assert any(c["habit_id"] == hid and c["quantity"] == 5.5 for c in rows)

    # … the upsert can clear it back to null (quantity omitted → null) …
    cleared = client.put(f"/api/habits/{hid}/completion", json={"date": "2026-06-11", "completed": True})
    assert cleared.status_code == 200 and cleared.json()["quantity"] is None

    # … and a negative quantity is rejected before any write.
    bad = client.put(
        f"/api/habits/{hid}/completion",
        json={"date": "2026-06-11", "completed": True, "quantity": -1},
    )
    assert bad.status_code == 422


def test_goals_crud_display_only(client):
    created = client.post(
        "/api/goals",
        json={
            "name": "Cut to 180",
            "type": "metric",
            "metric_key": "weekly_median_bodyweight",
            "target_value": 180,
            "direction": "below",
            "pillar": "Fitness",
            "target_date": "2026-09-01",
        },
    )
    assert created.status_code == 201
    gid = created.json()["id"]
    assert created.json()["is_recurring"] is False  # defaults off
    # shape validation mirrors the DB check constraint
    bad = client.post("/api/goals", json={"name": "broken", "type": "metric", "target_date": "2026-09-01"})
    assert bad.status_code == 422

    # is_recurring round-trips through POST and toggles via PUT.
    rec = client.post(
        "/api/goals",
        json={
            "name": "Run weekly",
            "type": "metric",
            "metric_key": "deep_work_hours",
            "target_value": 8,
            "direction": "above",
            "target_date": "2026-09-01",
            "is_recurring": True,
        },
    )
    assert rec.status_code == 201
    assert rec.json()["is_recurring"] is True
    rid = rec.json()["id"]
    toggled = client.put(f"/api/goals/{rid}", json={"is_recurring": False})
    assert toggled.status_code == 200
    assert toggled.json()["is_recurring"] is False

    assert client.delete(f"/api/goals/{gid}").status_code == 204
    assert client.delete(f"/api/goals/{rid}").status_code == 204


def test_active_goal_focus_limits(client):
    """Step-13 polish guardrails on POST /api/goals: ≤2 active goals per exact
    target (habit_id / metric_key) and ≤10 active goals globally. Inactive goals
    are unconstrained. Only the active working set is capped."""
    from app.models import Goal

    client.get("/api/profile")  # ensure dev user exists

    def clear_goals() -> None:
        with SessionLocal() as db:
            db.query(Goal).delete()
            db.commit()

    def metric_goal(key: str, *, active: bool = True):
        return client.post(
            "/api/goals",
            json={
                "name": f"g-{key}",
                "type": "metric",
                "metric_key": key,
                "target_value": 10,
                "direction": "above",
                "target_date": "2026-12-31",
                "is_active": active,
            },
        )

    # (a) per-target cap — 2 active goals on the same metric_key are fine, 3rd 422s.
    clear_goals()
    assert metric_goal("sleep_hours").status_code == 201
    assert metric_goal("sleep_hours").status_code == 201
    third = metric_goal("sleep_hours")
    assert third.status_code == 422
    assert "2 active goals" in third.json()["detail"]

    # (b) global cap — 10 active goals (distinct targets) allowed, 11th 422s.
    clear_goals()
    for i in range(10):
        assert metric_goal(f"metric_{i}").status_code == 201, i
    eleventh = metric_goal("metric_overflow")
    assert eleventh.status_code == 422
    assert "10 active goals" in eleventh.json()["detail"]

    # (c) an INACTIVE goal is never blocked, even sitting at the global cap.
    assert metric_goal("metric_parked", active=False).status_code == 201

    clear_goals()


def test_weekly_upsert_and_summary(client):
    # 2026-06-08 is the ISO Monday covering the 2026-06-10 logs above.
    r = client.post(
        "/api/weekly",
        json={"week_start": "2026-06-08", "capital_allocated": 500, "bottleneck_audit": "late training"},
    )
    assert r.status_code == 200 and r.json()["capital_allocated"] == 500
    # ISO-Monday enforcement
    assert client.post("/api/weekly", json={"week_start": "2026-06-09", "capital_allocated": 0}).status_code == 422

    summary = client.get("/api/weekly/2026-06-08/summary").json()
    assert summary["median_bodyweight"] == 184.0  # single sample from the morning log
    assert summary["n_bw_samples"] == 1 and summary["low_confidence"] is True
    assert summary["training_sessions"] == 1  # 2026-06-10 training_done=true
    assert summary["evenings_logged"] == 1


def test_dashboard_returns_analysis_rows_and_scores(client):
    r = client.get("/api/dashboard?days=30")
    assert r.status_code == 200
    body = r.json()
    # flattened v_daily_analysis rows include the 2026-06-10 day
    dates = [d["date"] for d in body["days"]]
    assert "2026-06-10" in dates
    day = next(d for d in body["days"] if d["date"] == "2026-06-10")
    assert day["evening_done"] is True
    assert "habit_completion_ratio" in day
    # today's scores present and well-formed
    assert 0 <= body["today_scores"]["day_score"] <= 100
    # weekly median bodyweight series carries the single sample week
    assert any(w["week_start"] == "2026-06-08" for w in body["weekly_bodyweight"])
    # per-day score series powers the hero delta + pillar sparklines
    pts = {p["date"]: p for p in body["score_series"]}
    assert "2026-06-10" in pts
    assert 0 <= pts["2026-06-10"]["day_score"] <= 100
    assert pts["2026-06-10"]["fitness"] is not None  # evening logged that day


def test_morning_note_round_trips(client):
    """The wizard's optional "Anything else?" note persists to
    daily_logs.morning_note and is echoed back on save + on read. No bodyweight
    is sent, so this upsert leaves the week's single bodyweight sample intact."""
    note = "Slept poorly but pushed through. Knees a bit stiff."
    r = client.post(
        "/api/logs/morning",
        json={
            "date": "2026-06-10",  # upsert onto the existing row (no new bodyweight)
            "morning_readiness": 8,
            "sleep_hours": 7.5,
            "morning_note": note,
        },
    )
    assert r.status_code == 200, r.text
    # echoed on the save response …
    assert r.json()["log"]["morning_note"] == note
    # … persisted to the column …
    with SessionLocal() as db:
        row = db.query(DailyLog).filter(DailyLog.date == dt_date(2026, 6, 10)).one()
        assert row.morning_note == note
    # … and surfaced on the read endpoint.
    assert client.get("/api/logs/2026-06-10").json()["morning_note"] == note

    # the note is strictly optional — omitting it is valid and clears nothing else.
    assert client.post(
        "/api/logs/morning",
        json={"date": "2026-06-10", "morning_readiness": 8, "sleep_hours": 7.5},
    ).status_code == 200

    # over the 1000-char cap → rejected before any write (Pydantic max_length).
    assert client.post(
        "/api/logs/morning",
        json={
            "date": "2026-06-10",
            "morning_readiness": 8,
            "sleep_hours": 7.5,
            "morning_note": "x" * 1001,
        },
    ).status_code == 422


def test_workout_status_drives_fitness_training_block(client):
    """The token-contract status logs the §6.5 rest/skip distinction explicitly:
    skipped → training block 0.0, rest → 0.5, trained → 1.0, independent of any
    habit schedule. It also round-trips on the day row."""

    def training_block(status: str, training_done: bool) -> float:
        r = client.post(
            "/api/logs/evening",
            json={
                "date": "2026-06-15",  # a fresh ISO week, isolated from other rows
                "training_done": training_done,
                "workout_status": status,
                "deep_work_hours": 4,
                "discretionary_spend": 0,
            },
        )
        assert r.status_code == 200, r.text
        return r.json()["scores"]["pillars"]["Fitness"]["blocks"]["training"]

    assert training_block("skipped", False) == pytest.approx(0.0)
    assert training_block("rest", False) == pytest.approx(0.5)
    assert training_block("trained", True) == pytest.approx(1.0)
    assert client.get("/api/logs/2026-06-15").json()["workout_status"] == "trained"

    # bad status is rejected before any write
    assert (
        client.post(
            "/api/logs/evening",
            json={
                "date": "2026-06-15",
                "training_done": True,
                "workout_status": "lazy",
                "deep_work_hours": 4,
                "discretionary_spend": 0,
            },
        ).status_code
        == 422
    )
