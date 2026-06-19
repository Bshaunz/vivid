"""
Weekly AI synthesis integration tests (build step 10, directive 9).

Hits the real FastAPI app with the mock LLM seam against a throwaway SQLite DB.
Verifies the full endpoint contract:
  * generate → shape, deterministic optimization_score, parsed insights,
    non-empty content, mock model, cached:false
  * idempotency (cached:true) and budget-checked force regeneration
  * GET single / list / absent-week null
  * ISO-Monday → 422, unknown field → 422
  * no logged days → 404  (the contract we locked: REST-semantic "not found",
    NOT 422)
  * the token budget is enforced BEFORE the LLM, on both a brand-new generation
    AND a forced regeneration, and a blocked call persists nothing / mutates
    nothing
  * the private system prompt never appears in any response

Env is set BEFORE importing the app so cached settings bind to the temp DB and
DEV_MODE makes get_current_user return the dev user (no real token needed).
"""
import os
import tempfile
from contextlib import contextmanager
from datetime import date, timedelta

import pytest

# ── Bind a temp DB and dev mode before any app import ─────────────────────────
_TMP = tempfile.mkdtemp()
_DB_PATH = os.path.join(_TMP, "test_synthesis.db")
os.environ["DEV_MODE"] = "true"
os.environ["DATABASE_URL"] = f"sqlite:///{_DB_PATH}"
os.environ["FRONTEND_ORIGIN"] = "http://localhost:5173"
os.environ.pop("SYNTHESIS_PROMPT_PATH", None)  # use the safe dev fallback prompt
for marker in ("RENDER", "VERCEL", "PRODUCTION"):
    os.environ.pop(marker, None)

import anthropic  # noqa: E402
import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import llm  # noqa: E402
from app.auth import DEV_USER_ID  # noqa: E402
from app.config import get_settings  # noqa: E402
from app.db import SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models import AISynthesis, Base, DailyLog  # noqa: E402

# ISO Mondays. WEEK_A drives the happy-path/idempotency/force tests; WEEK_B is
# kept un-synthesized so the budget tests exercise the un-cached generation path;
# EMPTY_WEEK is a valid Monday with no logs (404); TUESDAY is a non-Monday (422).
WEEK_A = "2026-06-08"
WEEK_B = "2026-06-15"
EMPTY_WEEK = "2026-06-01"
TUESDAY = "2026-06-09"

MOCK_MODEL = "mock-synthesis-v0"
SYSTEM_PROMPT = llm.load_system_prompt()

SYNTHESIS_OUT_KEYS = {
    "id", "user_id", "type", "week_start", "generated_at",
    "optimization_score", "insights", "content", "model",
    "tokens_in", "tokens_out", "cached",
}


def _seed_week(db, user_id: str, monday_iso: str) -> None:
    """Six logged days with varied training/spend/sleep/readiness so the
    deterministic cross-pillar insights have enough paired data to emit."""
    y, m, d = map(int, monday_iso.split("-"))
    monday = date(y, m, d)
    for i in range(6):
        day = monday + timedelta(days=i)
        trained = i % 2 == 0
        db.add(
            DailyLog(
                user_id=user_id,
                date=day,
                morning_readiness=6 + (i % 3),
                sleep_hours=6.5 + 0.3 * i,
                rhr=52,
                hrv=60,
                morning_done=True,
                training_done=trained,
                workout_rpe=8 if trained else None,
                deep_work_hours=3.0 if trained else 1.0,
                macro_adherence=True,
                discretionary_spend=20.0 + 10 * i,
                evening_done=True,
            )
        )
    db.commit()


@contextmanager
def budget_override(*, daily: int | None = None, monthly: int | None = None):
    """Temporarily clamp the (cached singleton) budget settings, restoring them
    afterward so test order can't leak a shrunk budget into later tests."""
    s = get_settings()
    old_daily, old_monthly = s.daily_token_budget_per_user, s.max_monthly_tokens
    if daily is not None:
        s.daily_token_budget_per_user = daily
    if monthly is not None:
        s.max_monthly_tokens = monthly
    try:
        yield
    finally:
        s.daily_token_budget_per_user = old_daily
        s.max_monthly_tokens = old_monthly


@pytest.fixture(scope="module")
def client():
    Base.metadata.create_all(engine)
    with TestClient(app) as c:
        # First request materializes the dev user; then seed the two weeks.
        assert c.get("/api/profile").status_code == 200
        with SessionLocal() as db:
            _seed_week(db, DEV_USER_ID, WEEK_A)
            _seed_week(db, DEV_USER_ID, WEEK_B)
        yield c
    Base.metadata.drop_all(engine)


# ── Happy path: shape, determinism, mock seam ────────────────────────────────


def test_generate_weekly_shape_and_mock_model(client):
    r = client.post("/api/synthesis/weekly", json={"week_start": WEEK_A})
    assert r.status_code == 200, r.text
    body = r.json()

    # Exact output contract (response model is extra="forbid").
    assert set(body) == SYNTHESIS_OUT_KEYS
    assert body["type"] == "weekly"
    assert body["week_start"] == WEEK_A
    assert body["cached"] is False
    assert body["model"] == MOCK_MODEL

    # Deterministic optimization score: a real int in [0, 100].
    assert isinstance(body["optimization_score"], int)
    assert 0 <= body["optimization_score"] <= 100

    # Insights parsed from the content bullets; content non-empty.
    assert isinstance(body["insights"], list) and len(body["insights"]) >= 1
    assert all(isinstance(s, str) and s.strip() for s in body["insights"])
    assert body["content"].strip() != ""

    # Token accounting recorded.
    assert body["tokens_in"] > 0 and body["tokens_out"] > 0

    # The private system prompt must never ride along in the response.
    assert SYSTEM_PROMPT not in r.text


def test_optimization_score_is_engine_deterministic(client):
    """Recomputing the same week yields the identical score every time, and it
    matches a direct mean of the engine's per-day scores (the LLM never scores)."""
    from app import scoring_service, synthesis_service
    from app.models import User
    import statistics

    s1 = client.post("/api/synthesis/weekly", json={"week_start": WEEK_A}).json()
    s2 = client.get(f"/api/synthesis/weekly/{WEEK_A}").json()
    assert s1["optimization_score"] == s2["optimization_score"]

    with SessionLocal() as db:
        user = db.get(User, DEV_USER_ID)
        logs = synthesis_service._week_logs(db, DEV_USER_ID, date.fromisoformat(WEEK_A))
        manual = round(
            statistics.fmean(
                scoring_service.score_daily(db, user, l.date).day.day_score for l in logs
            )
        )
    assert s1["optimization_score"] == manual


# ── Idempotency + force ───────────────────────────────────────────────────────


def test_generation_is_idempotent(client):
    first = client.post("/api/synthesis/weekly", json={"week_start": WEEK_A}).json()
    again = client.post("/api/synthesis/weekly", json={"week_start": WEEK_A})
    assert again.status_code == 200
    body = again.json()
    assert body["cached"] is True
    assert body["id"] == first["id"]  # same row, no second generation


def test_force_regenerates_in_place(client):
    existing = client.get(f"/api/synthesis/weekly/{WEEK_A}").json()
    forced = client.post("/api/synthesis/weekly", json={"week_start": WEEK_A, "force": True})
    assert forced.status_code == 200
    body = forced.json()
    assert body["cached"] is False        # regenerated, not a cache hit
    assert body["id"] == existing["id"]   # replaced in place, id preserved


# ── Reads ─────────────────────────────────────────────────────────────────────


def test_get_single_and_list(client):
    single = client.get(f"/api/synthesis/weekly/{WEEK_A}")
    assert single.status_code == 200
    body = single.json()
    assert body is not None
    assert body["week_start"] == WEEK_A
    assert body["cached"] is True          # a stored read is reported cached
    assert len(body["insights"]) >= 1
    assert SYSTEM_PROMPT not in single.text

    # A valid Monday with no synthesis row → 200 null (not 404; that's reserved
    # for a generation request with no data).
    absent = client.get(f"/api/synthesis/weekly/{EMPTY_WEEK}")
    assert absent.status_code == 200 and absent.json() is None

    listed = client.get("/api/synthesis?limit=8")
    assert listed.status_code == 200
    rows = listed.json()
    assert isinstance(rows, list)
    assert any(s["week_start"] == WEEK_A for s in rows)
    assert SYSTEM_PROMPT not in listed.text


# ── Validation ────────────────────────────────────────────────────────────────


def test_iso_monday_validation(client):
    assert client.post("/api/synthesis/weekly", json={"week_start": TUESDAY}).status_code == 422
    assert client.get(f"/api/synthesis/weekly/{TUESDAY}").status_code == 422


def test_unknown_field_forbidden(client):
    # A client may only ever name the week — no user_id, no metrics (§3.1/§4).
    r = client.post(
        "/api/synthesis/weekly",
        json={"week_start": WEEK_A, "user_id": "someone-else"},
    )
    assert r.status_code == 422


# ── The locked 404 no-data contract ──────────────────────────────────────────


def test_no_data_week_returns_404(client):
    """A valid ISO Monday with no logged days is a 404 (NOT 422)."""
    r = client.post("/api/synthesis/weekly", json={"week_start": EMPTY_WEEK})
    assert r.status_code == 404, r.text
    # And nothing was persisted for that week.
    assert client.get(f"/api/synthesis/weekly/{EMPTY_WEEK}").json() is None


# ── Budget gateway: normal generation + forced regeneration ──────────────────


def test_budget_blocks_new_generation_before_llm(client):
    """A clamped daily budget refuses a brand-new generation with 429 and
    persists nothing — the gate runs before the LLM/persist."""
    assert client.get(f"/api/synthesis/weekly/{WEEK_B}").json() is None  # fresh week
    with budget_override(daily=0):
        r = client.post("/api/synthesis/weekly", json={"week_start": WEEK_B})
    assert r.status_code == 429, r.text
    assert "daily" in r.json()["detail"]
    # No row written for WEEK_B despite the attempt.
    assert client.get(f"/api/synthesis/weekly/{WEEK_B}").json() is None


def test_budget_blocks_forced_regeneration(client):
    """force=True is budget-checked too: a clamped budget cannot be bypassed by
    forcing, and the existing row is left untouched (not wiped)."""
    before = client.get(f"/api/synthesis/weekly/{WEEK_A}").json()
    assert before is not None

    with budget_override(daily=0):
        blocked = client.post("/api/synthesis/weekly", json={"week_start": WEEK_A, "force": True})
    assert blocked.status_code == 429, blocked.text
    assert "daily" in blocked.json()["detail"]

    after = client.get(f"/api/synthesis/weekly/{WEEK_A}").json()
    assert after is not None
    assert after["id"] == before["id"]
    assert after["generated_at"] == before["generated_at"]  # never regenerated

    # With the budget restored, the same force now succeeds — proving the 429 was
    # the budget gate, not a broken route.
    ok = client.post("/api/synthesis/weekly", json={"week_start": WEEK_A, "force": True})
    assert ok.status_code == 200 and ok.json()["cached"] is False


def test_global_monthly_budget_blocks_generation(client):
    """The global monthly cap (checked after the per-user daily cap) also blocks,
    reporting the monthly scope."""
    assert client.get(f"/api/synthesis/weekly/{WEEK_B}").json() is None  # still fresh
    with budget_override(monthly=0):  # daily left generous → monthly is the tripwire
        r = client.post("/api/synthesis/weekly", json={"week_start": WEEK_B})
    assert r.status_code == 429, r.text
    assert "monthly" in r.json()["detail"]
    assert client.get(f"/api/synthesis/weekly/{WEEK_B}").json() is None


# ── System prompt secrecy (consolidated) ─────────────────────────────────────


def test_system_prompt_never_leaks_in_any_response(client):
    """Belt-and-suspenders: the dev-fallback system prompt text must not surface
    in any synthesis response surface."""
    assert SYSTEM_PROMPT.strip() != ""  # guard: we're actually checking something
    bodies = [
        client.post("/api/synthesis/weekly", json={"week_start": WEEK_A}).text,
        client.get(f"/api/synthesis/weekly/{WEEK_A}").text,
        client.get("/api/synthesis?limit=8").text,
    ]
    for text in bodies:
        assert SYSTEM_PROMPT not in text


# ── Real-client error handling (step 10.5) ───────────────────────────────────

# A throwaway httpx.Request/Response is all the SDK exception constructors need.
_DUMMY_REQUEST = httpx.Request("POST", "https://api.anthropic.com/v1/messages")

_PROVIDER_ERRORS = [
    pytest.param(
        anthropic.RateLimitError(
            "slow down",
            response=httpx.Response(429, request=_DUMMY_REQUEST),
            body=None,
        ),
        "rate_limited",
        id="rate_limit",
    ),
    pytest.param(
        anthropic.APITimeoutError(_DUMMY_REQUEST),
        "timeout",
        id="timeout",
    ),
]

# Distinctive sentinels so a leak would be unmistakable in the surfaced error.
_SECRET_SYSTEM = "TOP-SECRET-SYNTHESIS-PROMPT-DO-NOT-LEAK"
_SEALED_USER = "<user_data>private metrics 42 here</user_data>"


@pytest.mark.parametrize("provider_exc, expected_reason", _PROVIDER_ERRORS)
def test_complete_real_wraps_provider_errors_securely(
    client, monkeypatch, provider_exc, expected_reason
):
    """_complete_real must catch the SDK's typed exceptions and re-raise a
    SynthesisLLMError that: carries the coarse reason ("rate_limited"/"timeout"),
    chains the original provider error as __cause__ (debuggable), leaks neither
    the private system prompt nor the sealed <user_data> payload, and persists /
    mutates nothing."""

    class _RaisingMessages:
        def create(self, **kwargs):
            raise provider_exc

    class _RaisingClient:
        messages = _RaisingMessages()

    # Swap the cached client builder for one whose .messages.create() throws.
    monkeypatch.setattr(llm, "_client", lambda: _RaisingClient())

    with SessionLocal() as db:
        rows_before = db.query(AISynthesis).count()

    with pytest.raises(llm.SynthesisLLMError) as excinfo:
        llm._complete_real(_SECRET_SYSTEM, _SEALED_USER, max_tokens=128)

    err = excinfo.value
    # Coarse, non-sensitive reason — exactly the mapped code, nothing more.
    assert err.reason == expected_reason
    # The provider error is chained for debugging, and it is a real SDK error.
    assert err.__cause__ is provider_exc
    assert isinstance(err.__cause__, anthropic.APIError)
    # Neither the prompt nor the sealed payload may appear in anything surfaced.
    surfaced = f"{err!s} {err.reason} {err.args}"
    assert _SECRET_SYSTEM not in surfaced
    assert _SEALED_USER not in surfaced
    # No row written; no half-open transaction left behind.
    with SessionLocal() as db:
        assert db.query(AISynthesis).count() == rows_before
