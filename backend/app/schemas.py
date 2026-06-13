"""
Pydantic request/response models — the validation boundary (§3.5).

Every write is range-checked here against the canonical v4.0 schema before it
can reach the ORM. ``extra="forbid"`` rejects unknown fields so a client can
never smuggle an off-whitelist metric (§4) past the API. Dates are never in the
future. Free-text caps match the DB check constraints.

Bodyweight is accepted on both log forms as an OPTIONAL quick-entry; when
present it becomes a bodyweight_entries row, never a daily_logs column (§4).
"""
from __future__ import annotations

from datetime import date as dt_date

from pydantic import BaseModel, ConfigDict, Field, field_validator


class _Base(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _reject_future(v: dt_date) -> dt_date:
    if v > dt_date.today():
        raise ValueError("date cannot be in the future")
    return v


class MorningLogIn(_Base):
    date: dt_date = Field(default_factory=dt_date.today)
    morning_readiness: int = Field(ge=1, le=10)
    sleep_hours: float = Field(ge=0, le=16)
    rhr: int | None = Field(default=None, ge=20, le=250)
    hrv: int | None = Field(default=None, ge=0, le=300)
    # Optional quick-entry → bodyweight_entries (30–300 kg / 66–660 lbs).
    bodyweight: float | None = Field(default=None, ge=30, le=660)

    _nf = field_validator("date")(_reject_future)


class EveningLogIn(_Base):
    date: dt_date = Field(default_factory=dt_date.today)
    training_done: bool
    deep_work_hours: float = Field(ge=0, le=24)
    discretionary_spend: float = Field(ge=0, lt=1e9)
    macro_adherence: bool | None = None
    caloric_variance_pct: float | None = Field(default=None, ge=-100, le=1000)
    workout_rpe: int | None = Field(default=None, ge=1, le=10)
    daily_reflection: str | None = Field(default=None, max_length=1000)
    bodyweight: float | None = Field(default=None, ge=30, le=660)

    _nf = field_validator("date")(_reject_future)


# ── Response models ───────────────────────────────────────────────────────────


class PillarScoreOut(BaseModel):
    score: float | None
    core_composite: float | None
    blocks: dict[str, float | None]
    dropped: list[str]
    habit_weight: float
    habit_rate: float | None


class ScoresOut(BaseModel):
    """Computed on save, returned for immediate UI feedback. NOT persisted to
    daily_logs — the canonical score is recomputed from the data layer, because
    it depends on context (weekly bw median, habit rates, pillar toggles) that
    changes after the log is written."""

    day_score: int
    composite: float
    pillar_scores: dict[str, float]
    pillar_weights: dict[str, float]
    unassigned_weight: float
    pillars: dict[str, PillarScoreOut]


class DailyLogOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    user_id: str
    date: dt_date
    morning_readiness: int | None
    sleep_hours: float | None
    rhr: int | None
    hrv: int | None
    morning_done: bool
    training_done: bool | None
    workout_rpe: int | None
    deep_work_hours: float | None
    macro_adherence: bool | None
    caloric_variance_pct: float | None
    discretionary_spend: float | None
    daily_reflection: str | None
    evening_done: bool


class LogSaveResponse(BaseModel):
    log: DailyLogOut
    scores: ScoresOut
