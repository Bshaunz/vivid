"""
Baseline & deviation tests (build step 8) — the Home "What Changed" layer.

Unit-level tests drive baseline_service.detect_deviations directly with an
explicit as_of (so each scenario is isolated on its own date range), then one
integration test confirms the deviations fold into /api/dashboard and that the
opportunistic baseline snapshot is persisted.

Env is set BEFORE importing the app so cached settings bind to the temp DB.
"""
import os
import tempfile
from datetime import date, timedelta

import pytest

_TMP = tempfile.mkdtemp()
_DB_PATH = os.path.join(_TMP, "test_baselines.db")
os.environ["DEV_MODE"] = "true"
os.environ["DATABASE_URL"] = f"sqlite:///{_DB_PATH}"
os.environ["FRONTEND_ORIGIN"] = "http://localhost:5173"
for marker in ("RENDER", "VERCEL", "PRODUCTION"):
    os.environ.pop(marker, None)

from fastapi.testclient import TestClient  # noqa: E402

from app import baseline_service as bs  # noqa: E402
from app.auth import DEV_USER_ID  # noqa: E402
from app.db import SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Baseline, Base, DailyLog, User  # noqa: E402


@pytest.fixture(scope="module")
def client():
    Base.metadata.create_all(engine)
    with TestClient(app) as c:
        assert c.get("/api/profile").status_code == 200  # materialize dev user
        yield c
    Base.metadata.drop_all(engine)


def _dev_user(db):
    return db.get(User, DEV_USER_ID)


def _full_row(d: date, **vals) -> DailyLog:
    """A complete morning+evening row; pass the metric values to vary."""
    base = dict(
        morning_readiness=7,
        sleep_hours=7.5,
        rhr=52,
        hrv=60,
        deep_work_hours=2.0,
        discretionary_spend=20.0,
        training_done=True,
        macro_adherence=True,
        morning_done=True,
        evening_done=True,
    )
    base.update(vals)
    return DailyLog(user_id=DEV_USER_ID, date=d, **base)


def _clear_logs(db):
    db.query(DailyLog).delete()
    db.query(Baseline).delete()
    db.commit()


# ── rich scenario: two adverse alerts, two single-gate non-alerts ────────────


def test_detects_significant_adverse_deviations_and_ranks_by_z(client):
    """Prior 10 days establish norms; the as_of day drops sleep and spikes spend
    (both significant + adverse), while rhr (z-yes/pct-no) and deep_work
    (pct-yes/z-no) each trip only ONE gate and must be filtered out."""
    sleep = [7.2, 7.5, 7.8, 7.4, 7.6, 7.3, 7.7, 7.5, 7.4, 7.6]   # mean 7.5, sd ~0.18
    rhr = [52, 52, 53, 52, 51, 52, 53, 52, 52, 51]               # mean ~52, sd ~0.67
    deep = [0, 4, 1, 5, 0, 4, 2, 5, 1, 3]                        # mean 2.5, sd ~1.93
    spend = [20, 22, 18, 21, 19, 23, 20, 22, 18, 21]             # mean ~20.4, sd ~1.7

    as_of = date(2026, 3, 12)
    with SessionLocal() as db:
        _clear_logs(db)
        for i in range(10):
            d = as_of - timedelta(days=10 - i)  # 03-02 .. 03-11
            db.add(_full_row(d, sleep_hours=sleep[i], rhr=rhr[i],
                             deep_work_hours=deep[i], discretionary_spend=spend[i]))
        # comparison day: sleep ↓, spend ↑, rhr +2 (small %), deep_work 4 (high var)
        db.add(_full_row(as_of, sleep_hours=6.0, rhr=54,
                         deep_work_hours=4.0, discretionary_spend=30.0))
        db.commit()

        devs = bs.detect_deviations(db, _dev_user(db), as_of=as_of)

    keys = [d.metric_key for d in devs]
    assert set(keys) == {"sleep_hours", "discretionary_spend"}
    # ranked by |z| desc → the sleep drop (sd tiny) outranks the spend spike
    assert keys[0] == "sleep_hours"

    by_key = {d.metric_key: d for d in devs}
    sleep_dev = by_key["sleep_hours"]
    assert sleep_dev.direction == "down" and sleep_dev.valence == "adverse"
    assert sleep_dev.pct_change == pytest.approx(-0.20, abs=0.01)
    assert sleep_dev.n_observations == 10

    spend_dev = by_key["discretionary_spend"]
    assert spend_dev.direction == "up" and spend_dev.valence == "adverse"
    assert spend_dev.pct_change > 0

    # bodyweight is never part of this daily panel
    assert "weekly_median_bodyweight" not in keys


def test_favorable_deviation_classified(client):
    """A genuine improvement (sleep well above norm) is significant but
    favorable, not adverse."""
    as_of = date(2026, 3, 25)
    with SessionLocal() as db:
        _clear_logs(db)
        for i in range(8):
            d = as_of - timedelta(days=8 - i)
            db.add(_full_row(d, sleep_hours=6.0))  # low, tight norm
        db.add(_full_row(as_of, sleep_hours=8.0))  # +33%
        db.commit()
        devs = {d.metric_key: d for d in bs.detect_deviations(db, _dev_user(db), as_of=as_of)}

    assert "sleep_hours" in devs
    assert devs["sleep_hours"].direction == "up"
    assert devs["sleep_hours"].valence == "favorable"


# ── guards ────────────────────────────────────────────────────────────────────


def test_insufficient_observations_yields_no_alerts(client):
    """Fewer than 7 prior days → no baseline → no alerts (graceful)."""
    as_of = date(2026, 4, 12)
    with SessionLocal() as db:
        _clear_logs(db)
        for i in range(5):  # only 5 prior days
            db.add(_full_row(as_of - timedelta(days=5 - i), sleep_hours=7.5))
        db.add(_full_row(as_of, sleep_hours=4.0))  # huge drop, but not enough history
        db.commit()
        devs = bs.detect_deviations(db, _dev_user(db), as_of=as_of)
    assert devs == []


def test_mean_zero_uses_absolute_delta_fallback(client):
    """A week of zero spend → pct undefined → the absolute-delta gate fires on a
    real spike, and pct_change is reported as None."""
    as_of = date(2026, 5, 12)
    with SessionLocal() as db:
        _clear_logs(db)
        for i in range(8):
            # morning blank so only the evening spend metric is in play; deep_work
            # held constant so it can't deviate.
            db.add(DailyLog(
                user_id=DEV_USER_ID, date=as_of - timedelta(days=8 - i),
                training_done=True, deep_work_hours=2.0, discretionary_spend=0.0,
                morning_done=False, evening_done=True,
            ))
        db.add(DailyLog(
            user_id=DEV_USER_ID, date=as_of,
            training_done=True, deep_work_hours=2.0, discretionary_spend=50.0,
            morning_done=False, evening_done=True,
        ))
        db.commit()
        devs = {d.metric_key: d for d in bs.detect_deviations(db, _dev_user(db), as_of=as_of)}

    assert "discretionary_spend" in devs
    spend = devs["discretionary_spend"]
    assert spend.pct_change is None          # fell back to absolute delta
    assert spend.abs_change == pytest.approx(50.0)
    assert spend.direction == "up" and spend.valence == "adverse"


def test_within_norm_is_silent(client):
    """A normal day inside the band raises nothing."""
    as_of = date(2026, 5, 26)
    with SessionLocal() as db:
        _clear_logs(db)
        for i in range(8):
            db.add(_full_row(as_of - timedelta(days=8 - i)))  # all defaults, stable
        db.add(_full_row(as_of))  # identical to norm
        db.commit()
        devs = bs.detect_deviations(db, _dev_user(db), as_of=as_of)
    assert devs == []


# ── /api/dashboard integration + opportunistic persistence ───────────────────


def test_dashboard_includes_deviations_and_persists_baselines(client):
    today = date.today()
    with SessionLocal() as db:
        _clear_logs(db)
        for i in range(9):  # 9 prior stable days
            db.add(_full_row(today - timedelta(days=9 - i), discretionary_spend=20.0))
        db.add(_full_row(today, discretionary_spend=45.0))  # latest day spikes spend
        db.commit()

    body = client.get("/api/dashboard?days=30").json()
    assert "deviations" in body
    metric_keys = [d["metric_key"] for d in body["deviations"]]
    assert "discretionary_spend" in metric_keys
    spend = next(d for d in body["deviations"] if d["metric_key"] == "discretionary_spend")
    assert spend["valence"] == "adverse" and spend["direction"] == "up"
    assert 0 <= spend["n_observations"]
    assert spend["latest_value"] == 45.0

    # opportunistic snapshot landed in the baselines table (window_days = 14,
    # n >= 7), and weekly_median_bodyweight is NOT among them.
    with SessionLocal() as db:
        rows = db.query(Baseline).filter(Baseline.user_id == DEV_USER_ID).all()
        persisted = {r.metric_key: r for r in rows}
    assert "discretionary_spend" in persisted
    assert persisted["discretionary_spend"].window_days == 14
    assert persisted["discretionary_spend"].n_observations >= 7
    assert "weekly_median_bodyweight" not in persisted
