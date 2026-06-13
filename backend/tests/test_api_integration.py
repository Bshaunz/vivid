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
