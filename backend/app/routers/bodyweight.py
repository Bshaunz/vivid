"""Bodyweight entries (§4): many per day allowed. Raw values are returned for
history/quick-entry, but scoring and trends consume only the weekly median
exposed at /weekly/{week_start}."""
from datetime import date as dt_date, datetime, time, timedelta, timezone

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.db import get_db
from app.models import BodyweightEntry, User
from app.schemas import BodyweightEntryOut, BodyweightIn, WeeklyBodyweightOut
from app.scoring_service import _weekly_median_bw

router = APIRouter(prefix="/api/bodyweight", tags=["bodyweight"])


@router.post("", response_model=BodyweightEntryOut, status_code=status.HTTP_201_CREATED)
def add_entry(
    payload: BodyweightIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> BodyweightEntry:
    entry = BodyweightEntry(
        user_id=user.id, value=payload.value, **({"logged_at": payload.logged_at} if payload.logged_at else {})
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return entry


@router.get("", response_model=list[BodyweightEntryOut])
def list_entries(
    from_date: dt_date = Query(alias="from"),
    to_date: dt_date = Query(alias="to"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[BodyweightEntry]:
    start = datetime.combine(from_date, time.min, tzinfo=timezone.utc)
    end = datetime.combine(to_date + timedelta(days=1), time.min, tzinfo=timezone.utc)
    return list(
        db.scalars(
            select(BodyweightEntry)
            .where(
                BodyweightEntry.user_id == user.id,
                BodyweightEntry.logged_at >= start,
                BodyweightEntry.logged_at < end,
            )
            .order_by(BodyweightEntry.logged_at)
        ).all()
    )


@router.get("/latest", response_model=BodyweightEntryOut | None)
def latest_entry(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> BodyweightEntry | None:
    return db.scalar(
        select(BodyweightEntry)
        .where(BodyweightEntry.user_id == user.id)
        .order_by(BodyweightEntry.logged_at.desc())
        .limit(1)
    )


@router.get("/weekly/{week_start}", response_model=WeeklyBodyweightOut | None)
def weekly_median(
    week_start: dt_date,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> WeeklyBodyweightOut | None:
    week_end = week_start + timedelta(days=6)
    start = datetime.combine(week_start, time.min, tzinfo=timezone.utc)
    end = datetime.combine(week_end + timedelta(days=1), time.min, tzinfo=timezone.utc)
    values = db.scalars(
        select(BodyweightEntry.value).where(
            BodyweightEntry.user_id == user.id,
            BodyweightEntry.logged_at >= start,
            BodyweightEntry.logged_at < end,
        )
    ).all()
    if not values:
        return None
    median = _weekly_median_bw(db, user.id, week_start)
    return WeeklyBodyweightOut(
        week_start=week_start,
        weekly_median_bodyweight=median,  # type: ignore[arg-type]
        n_samples=len(values),
        low_confidence=len(values) < 3,
    )
