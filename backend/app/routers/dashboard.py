"""
GET /api/dashboard — the Home screen's single read.

Returns the flattened v_daily_analysis rows (one per user-day: every daily
metric + that day's habit completion ratio) for the trailing window, the
computed Pillar/Day Scores for today, the latest bodyweight, and the weekly
median bodyweight series. The day rows feed the trend charts; today's scores
feed the pillar bars. v_daily_analysis is a Postgres view at launch; in dev
(SQLite) the identical shape is assembled here in Python.
"""
from collections import defaultdict
from datetime import date as dt_date, timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import scoring_service
from app.auth import get_current_user
from app.db import get_db
from app.models import DailyLog, HabitCompletion, User
from app.routers.logs import _serialize_scores
from app.schemas import (
    DailyAnalysisOut,
    DashboardOut,
    WeeklyBodyweightOut,
)

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])


@router.get("", response_model=DashboardOut)
def get_dashboard(
    days: int = Query(default=30, ge=1, le=365),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DashboardOut:
    today = dt_date.today()
    from_date = today - timedelta(days=days - 1)

    logs = list(
        db.scalars(
            select(DailyLog)
            .where(DailyLog.user_id == user.id, DailyLog.date >= from_date, DailyLog.date <= today)
            .order_by(DailyLog.date)
        ).all()
    )

    # Same-day habit completion counts (the v_daily_analysis lateral join).
    completions = db.execute(
        select(HabitCompletion.date, HabitCompletion.completed).where(
            HabitCompletion.user_id == user.id,
            HabitCompletion.date >= from_date,
            HabitCompletion.date <= today,
        )
    ).all()
    due: dict[dt_date, int] = defaultdict(int)
    done: dict[dt_date, int] = defaultdict(int)
    for d, completed in completions:
        due[d] += 1
        if completed:
            done[d] += 1

    day_rows: list[DailyAnalysisOut] = []
    for l in logs:
        d_count = due.get(l.date, 0)
        c_count = done.get(l.date, 0)
        day_rows.append(
            DailyAnalysisOut(
                date=l.date,
                morning_readiness=l.morning_readiness,
                sleep_hours=l.sleep_hours,
                rhr=l.rhr,
                hrv=l.hrv,
                training_done=l.training_done,
                workout_rpe=l.workout_rpe,
                deep_work_hours=l.deep_work_hours,
                macro_adherence=l.macro_adherence,
                caloric_variance_pct=l.caloric_variance_pct,
                discretionary_spend=l.discretionary_spend,
                morning_done=l.morning_done,
                evening_done=l.evening_done,
                due_count=d_count,
                completed_count=c_count,
                habit_completion_ratio=round(c_count / d_count, 3) if d_count > 0 else None,
            )
        )

    today_scores = _serialize_scores(scoring_service.score_daily(db, user, today))
    latest = _latest_bodyweight(db, user.id)

    weekly_bw: list[WeeklyBodyweightOut] = []
    week_start = scoring_service.iso_week_start(today)
    for i in range(12):
        wk = week_start - timedelta(weeks=i)
        n = _bw_count(db, user.id, wk)
        if n == 0:
            continue
        median = scoring_service._weekly_median_bw(db, user.id, wk)
        weekly_bw.append(
            WeeklyBodyweightOut(
                week_start=wk,
                weekly_median_bodyweight=median,  # type: ignore[arg-type]
                n_samples=n,
                low_confidence=n < 3,
            )
        )
    weekly_bw.reverse()  # chronological

    return DashboardOut(
        from_date=from_date,
        to_date=today,
        days=day_rows,
        today_scores=today_scores,
        latest_bodyweight=latest,
        weekly_bodyweight=weekly_bw,
    )


def _latest_bodyweight(db: Session, user_id: str) -> float | None:
    from app.models import BodyweightEntry

    return db.scalar(
        select(BodyweightEntry.value)
        .where(BodyweightEntry.user_id == user_id)
        .order_by(BodyweightEntry.logged_at.desc())
        .limit(1)
    )


def _bw_count(db: Session, user_id: str, week_start: dt_date) -> int:
    from datetime import datetime, time, timezone

    from app.models import BodyweightEntry

    start = datetime.combine(week_start, time.min, tzinfo=timezone.utc)
    end = datetime.combine(week_start + timedelta(days=7), time.min, tzinfo=timezone.utc)
    return len(
        db.scalars(
            select(BodyweightEntry.id).where(
                BodyweightEntry.user_id == user_id,
                BodyweightEntry.logged_at >= start,
                BodyweightEntry.logged_at < end,
            )
        ).all()
    )
