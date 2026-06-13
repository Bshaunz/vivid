"""Weekly logs (Sunday review) + the read-only summary anchors. week_start is
always an ISO Monday. The summary's bodyweight figure is the weekly MEDIAN
(§4), never an average; raw dailies are never scored."""
from datetime import date as dt_date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.db import get_db
from app.models import DailyLog, User, WeeklyLog
from app.schemas import WeeklyLogIn, WeeklyLogOut, WeeklySummaryOut
from app.scoring_service import _weekly_median_bw

router = APIRouter(prefix="/api/weekly", tags=["weekly"])


@router.get("", response_model=list[WeeklyLogOut])
def list_weekly(
    limit: int | None = Query(default=None, ge=1, le=520),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[WeeklyLog]:
    stmt = select(WeeklyLog).where(WeeklyLog.user_id == user.id).order_by(WeeklyLog.week_start.desc())
    if limit is not None:
        stmt = stmt.limit(limit)
    return list(db.scalars(stmt).all())


@router.get("/{week_start}", response_model=WeeklyLogOut | None)
def get_weekly(
    week_start: dt_date,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> WeeklyLog | None:
    return db.scalar(
        select(WeeklyLog).where(WeeklyLog.user_id == user.id, WeeklyLog.week_start == week_start)
    )


@router.get("/{week_start}/summary", response_model=WeeklySummaryOut)
def weekly_summary(
    week_start: dt_date,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> WeeklySummaryOut:
    if week_start.isoweekday() != 1:
        raise HTTPException(status_code=422, detail="week_start must be an ISO Monday")
    week_end = week_start + timedelta(days=6)
    median = _weekly_median_bw(db, user.id, week_start)
    n_samples = _bw_sample_count(db, user.id, week_start)
    logs = list(
        db.scalars(
            select(DailyLog).where(
                DailyLog.user_id == user.id,
                DailyLog.date >= week_start,
                DailyLog.date <= week_end,
            )
        ).all()
    )
    return WeeklySummaryOut(
        week_start=week_start,
        median_bodyweight=median,
        n_bw_samples=n_samples,
        low_confidence=0 < n_samples < 3,
        training_sessions=sum(1 for l in logs if l.training_done is True),
        evenings_logged=sum(1 for l in logs if l.evening_done),
    )


@router.post("", response_model=WeeklyLogOut)
def upsert_weekly(
    payload: WeeklyLogIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> WeeklyLog:
    row = db.scalar(
        select(WeeklyLog).where(
            WeeklyLog.user_id == user.id, WeeklyLog.week_start == payload.week_start
        )
    )
    if row is None:
        row = WeeklyLog(user_id=user.id, **payload.model_dump())
        db.add(row)
    else:
        row.capital_allocated = payload.capital_allocated
        row.bottleneck_audit = payload.bottleneck_audit
    db.commit()
    db.refresh(row)
    return row


def _bw_sample_count(db: Session, user_id: str, week_start: dt_date) -> int:
    from datetime import datetime, time, timezone

    from app.models import BodyweightEntry

    week_end = week_start + timedelta(days=6)
    start = datetime.combine(week_start, time.min, tzinfo=timezone.utc)
    end = datetime.combine(week_end + timedelta(days=1), time.min, tzinfo=timezone.utc)
    return len(
        db.scalars(
            select(BodyweightEntry.id).where(
                BodyweightEntry.user_id == user_id,
                BodyweightEntry.logged_at >= start,
                BodyweightEntry.logged_at < end,
            )
        ).all()
    )
