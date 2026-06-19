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

from datetime import date as dt_date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


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
    # Optional free-text morning note ("Anything else?" wizard step).
    morning_note: str | None = Field(default=None, max_length=1000)
    # Optional quick-entry → bodyweight_entries (30–300 kg / 66–660 lbs).
    bodyweight: float | None = Field(default=None, ge=30, le=660)

    _nf = field_validator("date")(_reject_future)


class EveningLogIn(_Base):
    date: dt_date = Field(default_factory=dt_date.today)
    training_done: bool
    # Token-contract status; null on legacy clients. The client keeps it
    # consistent with training_done (trained ⇒ true).
    workout_status: Literal["trained", "rest", "skipped"] | None = None
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
    morning_note: str | None
    morning_done: bool
    training_done: bool | None
    workout_status: Literal["trained", "rest", "skipped"] | None
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


# ── Profile ───────────────────────────────────────────────────────────────────

Pillar = Literal["Health", "Fitness", "Finances"]


class ProfileOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    email: str
    name: str | None
    currency: Literal["CAD", "USD"]
    unit_pref: Literal["lbs", "kg"]
    active_pillars: list[Pillar]
    daily_budget: float | None
    bodyweight_goal: float | None
    weekly_workout_target: int | None
    weekly_rest_target: int | None
    consent_timestamp: datetime
    created_at: datetime


class ProfileUpdate(_Base):
    name: str | None = Field(default=None, max_length=80)
    currency: Literal["CAD", "USD"] | None = None
    unit_pref: Literal["lbs", "kg"] | None = None
    active_pillars: list[Pillar] | None = None
    daily_budget: float | None = Field(default=None, ge=0)
    bodyweight_goal: float | None = Field(default=None, ge=30, le=660)
    weekly_workout_target: int | None = Field(default=None, ge=0, le=7)
    weekly_rest_target: int | None = Field(default=None, ge=0, le=7)


# ── Habits ────────────────────────────────────────────────────────────────────


class HabitOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    user_id: str
    name: str
    description: str | None
    pillar: Pillar | None
    frequency_type: Literal["daily", "weekly", "monthly"]
    frequency_count: int
    frequency_days: list[int] | None
    value_type: Literal["binary", "numeric"]
    unit_label: str | None
    target_per_session: float | None
    is_preset: bool
    is_active: bool
    created_at: datetime


class HabitCreate(_Base):
    name: str = Field(min_length=1, max_length=80)
    description: str | None = Field(default=None, max_length=1000)
    pillar: Pillar | None = None
    frequency_type: Literal["daily", "weekly", "monthly"] = "daily"
    frequency_count: int = Field(default=1, ge=1)
    frequency_days: list[int] | None = None
    value_type: Literal["binary", "numeric"] = "binary"
    unit_label: str | None = Field(default=None, max_length=40)
    target_per_session: float | None = Field(default=None, gt=0)
    is_preset: bool = False
    is_active: bool = True

    @field_validator("frequency_days")
    @classmethod
    def _iso_weekdays(cls, v: list[int] | None) -> list[int] | None:
        if v is not None and any(d < 1 or d > 7 for d in v):
            raise ValueError("frequency_days must be ISO weekdays 1–7")
        return v


class HabitUpdate(_Base):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    description: str | None = Field(default=None, max_length=1000)
    pillar: Pillar | None = None
    frequency_type: Literal["daily", "weekly", "monthly"] | None = None
    frequency_count: int | None = Field(default=None, ge=1)
    frequency_days: list[int] | None = None
    value_type: Literal["binary", "numeric"] | None = None
    unit_label: str | None = Field(default=None, max_length=40)
    target_per_session: float | None = Field(default=None, gt=0)
    is_active: bool | None = None


class HabitCompletionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    user_id: str
    habit_id: int
    date: dt_date
    completed: bool
    quantity: float | None


class CompletionUpdate(_Base):
    date: dt_date = Field(default_factory=dt_date.today)
    completed: bool = True
    # Optional per-session numeric volume (numeric habits only). Display-only.
    quantity: float | None = Field(default=None, ge=0)

    _nf = field_validator("date")(_reject_future)


# ── Goals (display-only) ───────────────────────────────────────────────────────


class GoalOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    user_id: str
    name: str
    type: Literal["metric", "habit"]
    metric_key: str | None
    target_value: float | None
    direction: Literal["above", "below"] | None
    habit_id: int | None
    pillar: Pillar | None
    target_date: dt_date
    is_active: bool
    completed: bool
    is_recurring: bool
    created_at: datetime


class GoalCreate(_Base):
    name: str = Field(min_length=1, max_length=80)
    type: Literal["metric", "habit"]
    metric_key: str | None = Field(default=None, max_length=64)
    target_value: float | None = None
    direction: Literal["above", "below"] | None = None
    habit_id: int | None = None
    pillar: Pillar | None = None
    target_date: dt_date
    is_active: bool = True
    completed: bool = False
    is_recurring: bool = False

    @model_validator(mode="after")
    def _shape(self) -> "GoalCreate":
        # Mirror the goal_shape DB check constraint.
        if self.type == "metric":
            if self.metric_key is None or self.target_value is None or self.direction is None:
                raise ValueError("metric goal requires metric_key, target_value, direction")
        elif self.habit_id is None:
            raise ValueError("habit goal requires habit_id")
        return self


class GoalUpdate(_Base):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    target_value: float | None = None
    direction: Literal["above", "below"] | None = None
    pillar: Pillar | None = None
    target_date: dt_date | None = None
    is_active: bool | None = None
    completed: bool | None = None
    is_recurring: bool | None = None


# ── Weekly logs ───────────────────────────────────────────────────────────────


class WeeklyLogOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    user_id: str
    week_start: dt_date
    capital_allocated: float
    bottleneck_audit: str | None


class WeeklyLogIn(_Base):
    week_start: dt_date
    capital_allocated: float = Field(ge=0, lt=1e9)
    bottleneck_audit: str | None = Field(default=None, max_length=1000)

    @field_validator("week_start")
    @classmethod
    def _iso_monday(cls, v: dt_date) -> dt_date:
        if v.isoweekday() != 1:
            raise ValueError("week_start must be an ISO Monday")
        return v


class WeeklySummaryOut(BaseModel):
    week_start: dt_date
    median_bodyweight: float | None
    n_bw_samples: int
    low_confidence: bool
    training_sessions: int
    evenings_logged: int


# ── Bodyweight ────────────────────────────────────────────────────────────────


class BodyweightEntryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    user_id: str
    logged_at: datetime
    value: float


class BodyweightIn(_Base):
    value: float = Field(ge=30, le=660)
    logged_at: datetime | None = None


class WeeklyBodyweightOut(BaseModel):
    week_start: dt_date
    weekly_median_bodyweight: float
    n_samples: int
    low_confidence: bool


# ── Dashboard (flattened v_daily_analysis + today scores) ──────────────────────


class DailyAnalysisOut(BaseModel):
    """One flattened v_daily_analysis row: the day's metrics + same-day habit
    completion ratio. One row per user-day so any two columns pair directly."""

    date: dt_date
    morning_readiness: int | None
    sleep_hours: float | None
    rhr: int | None
    hrv: int | None
    training_done: bool | None
    workout_rpe: int | None
    deep_work_hours: float | None
    macro_adherence: bool | None
    caloric_variance_pct: float | None
    discretionary_spend: float | None
    morning_done: bool
    evening_done: bool
    due_count: int
    completed_count: int
    habit_completion_ratio: float | None


class DayScorePoint(BaseModel):
    """Computed Day + Pillar scores for one logged day — the historical series
    behind the Day Score hero (delta, personal best) and the pillar sparklines.
    Only days with a log appear, so gaps in the chart are honest gaps."""

    date: dt_date
    day_score: int
    health: float | None
    fitness: float | None
    finance: float | None


class DeviationOut(BaseModel):
    """One significant "What Changed" alert: the latest logged value vs the
    user's 14-day rolling norm. valence drives the red/green treatment
    (adverse → negative, favorable → positive). pct_change is null when the
    mean≈0 absolute-delta fallback was used."""

    model_config = ConfigDict(from_attributes=True)

    metric_key: str
    latest_value: float
    latest_date: dt_date
    baseline_mean: float
    baseline_sd: float
    z_score: float
    abs_change: float
    pct_change: float | None
    direction: Literal["up", "down"]
    valence: Literal["adverse", "favorable"]
    n_observations: int


class DashboardOut(BaseModel):
    from_date: dt_date
    to_date: dt_date
    days: list[DailyAnalysisOut]
    today_scores: ScoresOut
    score_series: list[DayScorePoint]
    latest_bodyweight: float | None
    weekly_bodyweight: list[WeeklyBodyweightOut]
    # Live 14-day deviation alerts for the Home "What Changed" panel (step 8).
    deviations: list[DeviationOut]


# ── Synthesis (§6 step 10) — lives in app/schemas/synthesis.py, re-exported here
# so the rest of the app keeps importing `from app.schemas import ...`.
from app.schemas.synthesis import (  # noqa: E402
    SynthesisGenerateIn,
    SynthesisOut,
    parse_insights,
)
