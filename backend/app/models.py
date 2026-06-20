"""
VIVID ORM models — CLAUDE.md v4.0 §5, mirrored 1:1 with
supabase/migrations/0001_init.sql.

Dev runs on SQLite, launch on Supabase Postgres, so everything here is
dialect-portable: string enums (no native PG types), JSON columns, named
check constraints. user.id is a UUID string issued by Supabase auth at
launch and by the dev bypass locally.

Closed metric whitelist (§4): adding a column to daily_logs means editing
CLAUDE.md §4 first. Goals feed no score. Raw bodyweight is never scored —
only the weekly ISO median derived from bodyweight_entries.
"""
from datetime import date, datetime, timezone

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

# Portable UUID column: native `uuid` on Postgres, plain CHAR(36) string on
# SQLite (dev). On Postgres this makes SQLAlchemy/psycopg bind id parameters as
# `uuid`, so `WHERE id = :param` no longer fails with
# "operator does not exist: uuid = character varying". as_uuid=False keeps the
# Python value a plain str everywhere, so all id handling stays string-based and
# unchanged (and the dev SQLite DDL/behaviour is byte-for-byte what it was).
_UUID = String(36).with_variant(PGUUID(as_uuid=False), "postgresql")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


PILLARS = ("Health", "Fitness", "Finances")
BASELINE_METRIC_KEYS = (
    "morning_readiness",
    "sleep_hours",
    "rhr",
    "hrv",
    "deep_work_hours",
    "discretionary_spend",
    "weekly_median_bodyweight",
)


def str_enum(*values: str, name: str) -> Enum:
    """Portable enum: VARCHAR + CHECK on SQLite, plain varchar check on PG.
    The launch Postgres schema uses native enums via the SQL migration."""
    return Enum(*values, name=name, native_enum=False, validate_strings=True)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(_UUID, primary_key=True)
    email: Mapped[str] = mapped_column(String(255), nullable=False)
    name: Mapped[str | None] = mapped_column(String(80))
    currency: Mapped[str] = mapped_column(
        str_enum("CAD", "USD", name="currency_code"), nullable=False, default="CAD"
    )
    unit_pref: Mapped[str] = mapped_column(
        str_enum("lbs", "kg", name="unit_preference"), nullable=False, default="lbs"
    )
    active_pillars: Mapped[list] = mapped_column(
        JSON, nullable=False, default=lambda: list(PILLARS)
    )
    daily_budget: Mapped[float | None] = mapped_column(Float)
    bodyweight_goal: Mapped[float | None] = mapped_column(Float)
    # Weekly token-contract targets (set in the weekly review). Null = not yet
    # chosen → the client falls back to its sensible default (4 workouts / 3 rest).
    weekly_workout_target: Mapped[int | None] = mapped_column(Integer)
    weekly_rest_target: Mapped[int | None] = mapped_column(Integer)
    consent_timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )

    __table_args__ = (
        CheckConstraint("daily_budget IS NULL OR daily_budget >= 0", name="ck_users_budget"),
        CheckConstraint(
            "bodyweight_goal IS NULL OR bodyweight_goal BETWEEN 30 AND 660",
            name="ck_users_bw_goal",
        ),
        CheckConstraint(
            "weekly_workout_target IS NULL OR weekly_workout_target BETWEEN 0 AND 7",
            name="ck_users_workout_target",
        ),
        CheckConstraint(
            "weekly_rest_target IS NULL OR weekly_rest_target BETWEEN 0 AND 7",
            name="ck_users_rest_target",
        ),
    )


class DailyLog(Base):
    __tablename__ = "daily_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(
        _UUID, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    date: Mapped[date] = mapped_column(Date, nullable=False)

    # Morning (AM)
    morning_readiness: Mapped[int | None] = mapped_column(Integer)
    sleep_hours: Mapped[float | None] = mapped_column(Float)
    rhr: Mapped[int | None] = mapped_column(Integer)
    hrv: Mapped[int | None] = mapped_column(Integer)
    # Optional free-text morning note/journal (the "Anything else?" wizard step).
    # Mirrors daily_reflection's evening role; capped at 1000 chars like it.
    morning_note: Mapped[str | None] = mapped_column(Text)
    morning_done: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # Evening (PM)
    training_done: Mapped[bool | None] = mapped_column(Boolean)
    # Token-contract training status: "trained" (1.0) / "rest" (0.5) / "skipped"
    # (0.0). When present it drives the §6.5 planned-rest distinction explicitly;
    # null falls back to the frequency_days derivation. training_done stays in
    # sync (trained → true) so the evening_complete constraint + scoring hold.
    workout_status: Mapped[str | None] = mapped_column(
        str_enum("trained", "rest", "skipped", name="workout_status")
    )
    workout_rpe: Mapped[int | None] = mapped_column(Integer)
    deep_work_hours: Mapped[float | None] = mapped_column(Float)
    macro_adherence: Mapped[bool | None] = mapped_column(Boolean)
    caloric_variance_pct: Mapped[float | None] = mapped_column(Float)
    discretionary_spend: Mapped[float | None] = mapped_column(Float)
    daily_reflection: Mapped[str | None] = mapped_column(Text)
    evening_done: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    __table_args__ = (
        UniqueConstraint("user_id", "date", name="uq_daily_logs_user_date"),
        CheckConstraint(
            "morning_readiness IS NULL OR morning_readiness BETWEEN 1 AND 10",
            name="ck_daily_readiness",
        ),
        CheckConstraint(
            "sleep_hours IS NULL OR sleep_hours BETWEEN 0 AND 16", name="ck_daily_sleep"
        ),
        CheckConstraint("rhr IS NULL OR rhr BETWEEN 20 AND 250", name="ck_daily_rhr"),
        CheckConstraint("hrv IS NULL OR hrv BETWEEN 0 AND 300", name="ck_daily_hrv"),
        CheckConstraint(
            "workout_rpe IS NULL OR workout_rpe BETWEEN 1 AND 10", name="ck_daily_rpe"
        ),
        CheckConstraint(
            "deep_work_hours IS NULL OR deep_work_hours BETWEEN 0 AND 24",
            name="ck_daily_deep_work",
        ),
        CheckConstraint(
            "discretionary_spend IS NULL OR "
            "(discretionary_spend >= 0 AND discretionary_spend < 1e9)",
            name="ck_daily_spend",
        ),
        CheckConstraint(
            "daily_reflection IS NULL OR length(daily_reflection) <= 1000",
            name="ck_daily_reflection_len",
        ),
        CheckConstraint(
            "morning_note IS NULL OR length(morning_note) <= 1000",
            name="ck_daily_morning_note_len",
        ),
        CheckConstraint(
            "NOT morning_done OR (morning_readiness IS NOT NULL AND sleep_hours IS NOT NULL)",
            name="ck_daily_morning_complete",
        ),
        CheckConstraint(
            "NOT evening_done OR (training_done IS NOT NULL "
            "AND deep_work_hours IS NOT NULL AND discretionary_spend IS NOT NULL)",
            name="ck_daily_evening_complete",
        ),
        Index("idx_daily_logs_user_date", "user_id", "date"),
    )


class BodyweightEntry(Base):
    """Raw samples — many per day allowed. Scoring consumes the weekly ISO
    median only; that aggregate is computed by the score engine (step 7),
    never logged."""

    __tablename__ = "bodyweight_entries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(
        _UUID, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    logged_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )
    value: Mapped[float] = mapped_column(Float, nullable=False)

    __table_args__ = (
        CheckConstraint("value BETWEEN 30 AND 660", name="ck_bw_value"),
        Index("idx_bodyweight_user_time", "user_id", "logged_at"),
    )


class Habit(Base):
    __tablename__ = "habits"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(
        _UUID, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    pillar: Mapped[str | None] = mapped_column(str_enum(*PILLARS, name="pillar_type"))
    frequency_type: Mapped[str] = mapped_column(
        str_enum("daily", "weekly", "monthly", name="frequency_type"),
        nullable=False,
        default="daily",
    )
    frequency_count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    frequency_days: Mapped[list | None] = mapped_column(JSON)  # ISO weekdays 1-7
    # Tracking shape: "binary" = simple done/not-done completion; "numeric" logs a
    # per-session quantity (unit_label + target_per_session). Display-only metadata
    # — completions are still stored as done/not-done in habit_completions.
    value_type: Mapped[str] = mapped_column(
        str_enum("binary", "numeric", name="habit_value_type"),
        nullable=False,
        default="binary",
        server_default="binary",
    )
    unit_label: Mapped[str | None] = mapped_column(String(40))  # e.g. "miles", "pages"
    target_per_session: Mapped[float | None] = mapped_column(Float)  # default quantity
    is_preset: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )

    __table_args__ = (
        CheckConstraint("frequency_count >= 1", name="ck_habits_freq_count"),
        Index("idx_habits_user_active", "user_id", "is_active"),
    )


class HabitCompletion(Base):
    __tablename__ = "habit_completions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(
        _UUID, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    habit_id: Mapped[int] = mapped_column(
        ForeignKey("habits.id", ondelete="CASCADE"), nullable=False
    )
    date: Mapped[date] = mapped_column(Date, nullable=False)
    completed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # Per-session numeric volume for numeric habits (e.g. miles, pages), captured
    # in the Evening Log wizard. Null for binary habits / when not supplied.
    # Display-only metadata — scoring still counts logged sessions (§6.7).
    quantity: Mapped[float | None] = mapped_column(Float)

    __table_args__ = (
        UniqueConstraint("user_id", "habit_id", "date", name="uq_completion_user_habit_date"),
        CheckConstraint("quantity IS NULL OR quantity >= 0", name="ck_completion_quantity"),
        Index("idx_habit_completions_user_date", "user_id", "date"),
    )


class WeeklyLog(Base):
    __tablename__ = "weekly_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(
        _UUID, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    week_start: Mapped[date] = mapped_column(Date, nullable=False)  # ISO Monday
    capital_allocated: Mapped[float] = mapped_column(Float, nullable=False)
    bottleneck_audit: Mapped[str | None] = mapped_column(Text)

    __table_args__ = (
        UniqueConstraint("user_id", "week_start", name="uq_weekly_logs_user_week"),
        CheckConstraint(
            "capital_allocated >= 0 AND capital_allocated < 1e9", name="ck_weekly_capital"
        ),
        CheckConstraint(
            "bottleneck_audit IS NULL OR length(bottleneck_audit) <= 1000",
            name="ck_weekly_audit_len",
        ),
    )


class Goal(Base):
    """DISPLAY-ONLY (§6.7): progress is rendered, never scored. pillar is a
    badge. Do not reintroduce a goal component into any formula."""

    __tablename__ = "goals"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(
        _UUID, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    type: Mapped[str] = mapped_column(
        str_enum("metric", "habit", name="goal_type"), nullable=False
    )
    metric_key: Mapped[str | None] = mapped_column(String(64))
    target_value: Mapped[float | None] = mapped_column(Float)
    direction: Mapped[str | None] = mapped_column(
        str_enum("above", "below", name="goal_direction")
    )
    habit_id: Mapped[int | None] = mapped_column(ForeignKey("habits.id", ondelete="CASCADE"))
    target_date: Mapped[date] = mapped_column(Date, nullable=False)
    pillar: Mapped[str | None] = mapped_column(str_enum(*PILLARS, name="pillar_type"))
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    completed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # Recurring goals re-evaluate every period ("every week"); one-offs target a
    # single period ("this week"). Display-only — feeds no score.
    is_recurring: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="0"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )

    __table_args__ = (
        CheckConstraint(
            "(type = 'metric' AND metric_key IS NOT NULL "
            "AND target_value IS NOT NULL AND direction IS NOT NULL) "
            "OR (type = 'habit' AND habit_id IS NOT NULL)",
            name="ck_goal_shape",
        ),
        Index("idx_goals_user_active", "user_id", "is_active"),
    )


class Baseline(Base):
    """30-day personal norms for the deviation layer (§6.8). Rows exist only
    when the window holds >= 7 observations; sd==0 is guarded at read time
    with max(sd, 1e-6)."""

    __tablename__ = "baselines"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(
        _UUID, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    metric_key: Mapped[str] = mapped_column(String(64), nullable=False)
    window_days: Mapped[int] = mapped_column(Integer, nullable=False, default=30)
    mean: Mapped[float] = mapped_column(Float, nullable=False)
    sd: Mapped[float] = mapped_column(Float, nullable=False)
    n_observations: Mapped[int] = mapped_column(Integer, nullable=False)
    computed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )

    __table_args__ = (
        UniqueConstraint("user_id", "metric_key", name="uq_baselines_user_metric"),
        CheckConstraint(
            "metric_key IN ({})".format(
                ", ".join(f"'{k}'" for k in BASELINE_METRIC_KEYS)
            ),
            name="ck_baseline_metric_key",
        ),
        CheckConstraint("sd >= 0", name="ck_baseline_sd"),
        CheckConstraint("n_observations >= 7", name="ck_baseline_n"),
    )


class AISynthesis(Base):
    __tablename__ = "ai_syntheses"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(
        _UUID, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    generated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )
    type: Mapped[str] = mapped_column(
        str_enum("weekly", name="synthesis_type"), nullable=False, default="weekly"
    )
    # ISO Monday of the synthesized week. Per-ISO-week idempotency key (§6 step 10);
    # the ORM always supplies this value. Postgres additionally enforces isodow=1
    # at the DB layer (mirrors weekly_logs); SQLite relies on the schema validator.
    week_start: Mapped[date] = mapped_column(Date, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    tokens_in: Mapped[int] = mapped_column(Integer, nullable=False)
    tokens_out: Mapped[int] = mapped_column(Integer, nullable=False)
    model: Mapped[str] = mapped_column(String(64), nullable=False)

    __table_args__ = (
        CheckConstraint("tokens_in >= 0 AND tokens_out >= 0", name="ck_synthesis_tokens"),
        UniqueConstraint(
            "user_id", "type", "week_start", name="uq_synthesis_user_type_week"
        ),
        Index("idx_ai_syntheses_user_time", "user_id", "generated_at"),
    )
