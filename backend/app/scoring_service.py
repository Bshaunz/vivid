"""
Scoring service — the bridge from persisted rows to the pure scoring engine.

This is the only place that reads the DB for scoring. It assembles the weekly
and habit context each pillar needs, then calls ``app.scoring`` (which stays
pure and DB-free). Partial days are tolerated: a pillar with no usable data
yet (e.g. Fitness before the evening log) is simply excluded, and the Day Score
renormalizes over whatever pillars are present (§6.7).

Interpretations made explicit where the spec leaves a choice:
  * planned_rest (§6.5): a not-trained day counts as a *declared* rest (0.5,
    not 0.0) only when the user has active Fitness habits with an explicit
    weekly schedule (frequency_days) and none of them schedule today. With no
    scheduled training habits, a skip is a skip.
  * 7-day habit rate (§6.1): completed / due over the trailing 7 days, where
    "due" honors frequency_days when set, else daily=7, else frequency_count.
"""
from __future__ import annotations

import statistics
from dataclasses import dataclass
from datetime import date as dt_date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import scoring
from app.models import BodyweightEntry, DailyLog, Habit, HabitCompletion, User, WeeklyLog


def iso_week_start(d: dt_date) -> dt_date:
    """Monday of d's ISO week."""
    return d - timedelta(days=d.weekday())


@dataclass
class ScoreResult:
    day: scoring.DayScore
    pillars: dict[str, scoring.PillarScore]


def _weekly_median_bw(db: Session, user_id: str, week_start: dt_date) -> float | None:
    week_end = week_start + timedelta(days=6)
    rows = db.scalars(
        select(BodyweightEntry.value).where(
            BodyweightEntry.user_id == user_id,
            BodyweightEntry.logged_at >= _start_of(week_start),
            BodyweightEntry.logged_at < _start_of(week_end + timedelta(days=1)),
        )
    ).all()
    return round(statistics.median(rows), 2) if rows else None


def _start_of(d: dt_date):
    from datetime import datetime, time, timezone

    return datetime.combine(d, time.min, tzinfo=timezone.utc)


def _prev_4wk_median_avg(db: Session, user_id: str, week_start: dt_date) -> float | None:
    medians: list[float] = []
    for i in range(1, 5):
        wk = week_start - timedelta(weeks=i)
        m = _weekly_median_bw(db, user_id, wk)
        if m is not None:
            medians.append(m)
    return round(sum(medians) / len(medians), 2) if medians else None


def _planned_rest(active_fitness_habits: list[Habit], target: dt_date) -> bool:
    scheduled = [h for h in active_fitness_habits if h.frequency_days]
    if not scheduled:
        return False
    iso_dow = target.isoweekday()  # 1=Mon … 7=Sun
    return all(iso_dow not in (h.frequency_days or []) for h in scheduled)


def _habit_rate(
    habits: list[Habit], completions: list[HabitCompletion], window: list[dt_date]
) -> float | None:
    """completed / due over the trailing window for the given habit set."""
    if not habits:
        return None
    done_by_habit: dict[int, set[dt_date]] = {}
    for c in completions:
        if c.completed:
            done_by_habit.setdefault(c.habit_id, set()).add(c.date)

    total_due = 0
    total_done = 0
    iso_dows = [d.isoweekday() for d in window]
    for h in habits:
        if h.frequency_days:
            due_days = [d for d, dow in zip(window, iso_dows) if dow in h.frequency_days]
        elif h.frequency_type == "daily":
            due_days = list(window)
        else:
            due_days = window[: min(h.frequency_count, len(window))]
        if not due_days:
            continue
        total_due += len(due_days)
        done = done_by_habit.get(h.id, set())
        total_done += sum(1 for d in due_days if d in done)
    if total_due == 0:
        return None
    return max(0.0, min(total_done / total_due, 1.0))


def score_daily(db: Session, user: User, target: dt_date) -> ScoreResult:
    """Assemble context and score one user-day. Pure engine, impure assembly."""
    log = db.scalar(
        select(DailyLog).where(DailyLog.user_id == user.id, DailyLog.date == target)
    )

    week_start = iso_week_start(target)
    week_median = _weekly_median_bw(db, user.id, week_start)
    prev_avg = _prev_4wk_median_avg(db, user.id, week_start)

    habits = list(
        db.scalars(select(Habit).where(Habit.user_id == user.id, Habit.is_active.is_(True))).all()
    )
    window = [target - timedelta(days=i) for i in range(7)]
    completions = list(
        db.scalars(
            select(HabitCompletion).where(
                HabitCompletion.user_id == user.id,
                HabitCompletion.date >= window[-1],
                HabitCompletion.date <= target,
            )
        ).all()
    )

    by_pillar: dict[str | None, list[Habit]] = {}
    for h in habits:
        by_pillar.setdefault(h.pillar, []).append(h)

    def count(p: str) -> int:
        return len(by_pillar.get(p, []))

    def rate(p: str) -> float | None:
        return _habit_rate(by_pillar.get(p, []), completions, window)

    # Finance weekly context
    this_week_log = db.scalar(
        select(WeeklyLog).where(WeeklyLog.user_id == user.id, WeeklyLog.week_start == week_start)
    )
    prev_week_log = db.scalar(
        select(WeeklyLog).where(
            WeeklyLog.user_id == user.id,
            WeeklyLog.week_start == week_start - timedelta(weeks=1),
        )
    )
    prev_alloc = (
        None
        if prev_week_log is None
        else (1.0 if prev_week_log.capital_allocated > 0 else 0.0)
    )

    pillars: dict[str, scoring.PillarScore] = {}

    # Health — scorable as soon as the morning readiness exists.
    if log is not None and log.morning_readiness is not None:
        pillars["Health"] = scoring.score_health(
            scoring.HealthInputs(
                morning_readiness=log.morning_readiness,
                this_week_median_bw=week_median,
                prev_4wk_median_avg_bw=prev_avg,
                bodyweight_goal=user.bodyweight_goal,
                macro_adherence=log.macro_adherence,
                caloric_variance_pct=log.caloric_variance_pct,
            ),
            active_habit_count=count("Health"),
            rate=rate("Health"),
        )

    # Fitness — needs the evening log (training_done + deep_work).
    if log is not None and log.evening_done and log.training_done is not None and log.deep_work_hours is not None:
        # Token-contract status, when logged, decides rest vs skip explicitly
        # ("rest" → 0.5, "skipped" → 0.0); otherwise fall back to the
        # frequency_days derivation for legacy/unset days (§6.5).
        planned_rest = (
            log.workout_status == "rest"
            if log.workout_status is not None
            else _planned_rest(by_pillar.get("Fitness", []), target)
        )
        pillars["Fitness"] = scoring.score_fitness(
            scoring.FitnessInputs(
                training_done=log.training_done,
                deep_work_hours=log.deep_work_hours,
                planned_rest=planned_rest,
                workout_rpe=log.workout_rpe,
            ),
            active_habit_count=count("Fitness"),
            rate=rate("Fitness"),
        )

    # Finance — needs discretionary_spend (evening).
    if log is not None and log.evening_done and log.discretionary_spend is not None:
        pillars["Finances"] = scoring.score_finance(
            scoring.FinanceInputs(
                discretionary_spend=log.discretionary_spend,
                daily_budget=user.daily_budget,
                has_weekly_log_this_week=this_week_log is not None,
                capital_allocated=this_week_log.capital_allocated if this_week_log else None,
                prev_allocation_score=prev_alloc,
            ),
            active_habit_count=count("Finances"),
            rate=rate("Finances"),
        )

    active_pillars = [p for p in (user.active_pillars or scoring.PILLARS) if p in scoring.PILLARS]
    day = scoring.score_day(
        pillars,
        active_pillars=active_pillars,
        unassigned_active_count=count(None),  # type: ignore[arg-type]
        unassigned_rate=rate(None),  # type: ignore[arg-type]
    )
    return ScoreResult(day=day, pillars=pillars)
