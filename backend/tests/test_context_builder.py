"""
Weekly context-builder tests (build step 11) — the System Log Ingestion engine.

Seeds one complete, varied ISO week for the dev user against a throwaway SQLite
DB, then drives ``context_builder.get_weekly_context`` directly (no network, no
LLM) and asserts:
  * the dense Markdown carries the explicit pillar section headers;
  * the aggregates are correct — including finding the right highest-spend day,
    the discretionary total, sleep average, deep-work totals, and habit %;
  * the optional deterministic-correlations section is present only when passed;
  * LEAK GUARD: the deterministic optimization score and raw private DB column
    keys NEVER appear anywhere in the generated block.

Env is set BEFORE importing the app so cached settings bind to the temp DB.
"""
import os
import tempfile
from datetime import date, timedelta

import pytest

_TMP = tempfile.mkdtemp()
_DB_PATH = os.path.join(_TMP, "test_context_builder.db")
os.environ["DEV_MODE"] = "true"
os.environ["DATABASE_URL"] = f"sqlite:///{_DB_PATH}"
os.environ["FRONTEND_ORIGIN"] = "http://localhost:5173"
for marker in ("RENDER", "VERCEL", "PRODUCTION"):
    os.environ.pop(marker, None)

from fastapi.testclient import TestClient  # noqa: E402

from app import synthesis_service as ss  # noqa: E402
from app.auth import DEV_USER_ID  # noqa: E402
from app.db import SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Base, DailyLog, Habit, HabitCompletion, User  # noqa: E402
from app.services import context_builder  # noqa: E402

WEEK = date(2026, 3, 9)  # an ISO Monday → window 03-09 … 03-15

# Per-day matrix (Mon→Sun): spend spikes on Thu (03-12), one PM left incomplete,
# a real sleep drop midweek, and a deep-work series that sums cleanly.
SPEND = [10.0, 25.0, 5.0, 80.0, 15.0, 40.0, 12.0]   # total 187.00; max 80 on 03-12
SLEEP = [7.5, 7.0, 6.0, 8.0, 7.0, 7.5, 8.0]          # mean 7.2857 → "7.3 hrs"
DEEP = [2.0, 3.0, 1.0, 4.0, 2.0, 3.0, 0.0]           # total 15.0 over 7 → 2.1/day
CAL_VAR = [-5.0, -3.0, -4.0, -2.0, -6.0, -3.0, -5.0]  # mean -4.0
HABIT_DONE = [True, True, False, True, True, False, True]  # 5 of 7 → 71%


@pytest.fixture(scope="module")
def client():
    Base.metadata.create_all(engine)
    with TestClient(app) as c:
        assert c.get("/api/profile").status_code == 200  # materialize dev user
        yield c
    Base.metadata.drop_all(engine)


def _seed_matrix_week(db) -> None:
    """A complete 7-day week: varying spend/sleep/deep-work, one incomplete PM,
    a known daily budget + currency, and a habit with mixed completions."""
    db.query(HabitCompletion).delete()
    db.query(Habit).delete()
    db.query(DailyLog).delete()

    user = db.get(User, DEV_USER_ID)
    user.currency = "USD"
    user.daily_budget = 50.0  # → weekly budget 350.00; 187/350 = 53%

    for i in range(7):
        day = WEEK + timedelta(days=i)
        db.add(
            DailyLog(
                user_id=DEV_USER_ID,
                date=day,
                morning_readiness=7,
                sleep_hours=SLEEP[i],
                rhr=52,
                hrv=60,
                training_done=True,
                workout_rpe=8,
                deep_work_hours=DEEP[i],
                macro_adherence=True,
                caloric_variance_pct=CAL_VAR[i],
                discretionary_spend=SPEND[i],
                daily_reflection="PRIVATE_REFLECTION_TEXT",  # must never leak
                morning_done=True,
                evening_done=i != 1,  # one PM incomplete → PM 6/7 = 86%
            )
        )

    habit = Habit(user_id=DEV_USER_ID, name="Read", frequency_type="daily", frequency_count=1)
    db.add(habit)
    db.flush()  # need habit.id
    for i in range(7):
        db.add(
            HabitCompletion(
                user_id=DEV_USER_ID,
                habit_id=habit.id,
                date=WEEK + timedelta(days=i),
                completed=HABIT_DONE[i],
            )
        )
    db.commit()


# ── section headers + aggregates ─────────────────────────────────────────────


def test_sections_and_aggregate_accuracy(client):
    with SessionLocal() as db:
        _seed_matrix_week(db)
        block = context_builder.get_weekly_context(db, DEV_USER_ID, "2026-03-09")

    # Sealed envelope + explicit pillar headers.
    assert block.startswith("<user_data>") and block.rstrip().endswith("</user_data>")
    assert "### FITNESS / HEALTH" in block
    assert "### FINANCIALS" in block
    assert "### OUTPUT / HABITS" in block
    assert "7 day(s) logged" in block

    # Health aggregates.
    assert "Avg Sleep: 7.3 hrs" in block
    assert "Avg Resting HR: 52 bpm" in block
    assert "Avg HRV: 60 ms" in block
    assert "Training Sessions: 7 of 7 days" in block
    assert "Avg Caloric Variance: -4.0% vs target" in block

    # Financial aggregates — total, budget %, and the correct highest-spend day.
    assert "Discretionary Spend: $187.00" in block
    assert "Weekly Budget: $350.00 (53% used)" in block
    assert "Top Spend Day: 2026-03-12 ($80.00)" in block  # Thu carries the $80 spike

    # Output / habit aggregates.
    assert "Deep Work: 15.0 hrs total (2.1 hrs/day)" in block
    assert "Habit Completion: 71% (5 of 7)" in block
    assert "Routine Completion: AM 100% · PM 86%" in block


def test_highest_spend_day_tracks_the_actual_peak(client):
    """Move the peak to a different day and confirm the builder re-identifies it
    (not a fixed index, not the last row)."""
    with SessionLocal() as db:
        _seed_matrix_week(db)
        # Push Sunday (03-15) above the Thursday spike.
        sunday = db.query(DailyLog).filter(
            DailyLog.user_id == DEV_USER_ID, DailyLog.date == date(2026, 3, 15)
        ).one()
        sunday.discretionary_spend = 200.0
        db.commit()
        block = context_builder.get_weekly_context(db, DEV_USER_ID, "2026-03-09")

    assert "Top Spend Day: 2026-03-15 ($200.00)" in block
    assert "2026-03-12 ($80.00)" not in block  # old peak no longer the top


# ── optional correlations section ────────────────────────────────────────────


def test_correlations_section_is_opt_in(client):
    with SessionLocal() as db:
        _seed_matrix_week(db)
        logs = ss._week_logs(db, DEV_USER_ID, WEEK)
        correlations = ss._build_insights(logs)

        without = context_builder.get_weekly_context(db, DEV_USER_ID, "2026-03-09")
        with_corr = context_builder.get_weekly_context(
            db, DEV_USER_ID, "2026-03-09", correlations=correlations
        )

    assert "CROSS-PILLAR CORRELATIONS" not in without
    assert "CROSS-PILLAR CORRELATIONS" in with_corr
    assert correlations  # the seeded week genuinely produces deterministic findings
    for c in correlations:
        assert c in with_corr


# ── leak guard ───────────────────────────────────────────────────────────────


def test_optimization_score_and_private_keys_never_leak(client):
    """The deterministic score must not appear (it is never sent to the model),
    and no raw private DB column key / free-text field may surface."""
    with SessionLocal() as db:
        _seed_matrix_week(db)
        logs = ss._week_logs(db, DEV_USER_ID, WEEK)
        score = ss.compute_optimization_score(db, db.get(User, DEV_USER_ID), WEEK)
        # Pass correlations too, to leak-check the richest possible block.
        block = context_builder.get_weekly_context(
            db, DEV_USER_ID, "2026-03-09", correlations=ss._build_insights(logs)
        )

    lowered = block.lower()
    # Score is never narrated, by label or by its "/100" rendering elsewhere.
    assert "optimization" not in lowered
    assert "score" not in lowered
    assert f"{score}/100" not in block

    # No raw private/internal identifiers or unmapped free text.
    for token in (
        "PRIVATE_REFLECTION_TEXT",
        "daily_reflection",
        "reflection",
        "caloric_variance_pct",  # surfaced as the label "Avg Caloric Variance" only
        "morning_done",
        "evening_done",
        "workout_rpe",
        "macro_adherence",
        "user_id",
        "morning_readiness",
        "bottleneck",
        "consent",
        DEV_USER_ID,
    ):
        assert token not in block
