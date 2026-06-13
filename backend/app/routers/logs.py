"""
Daily log endpoints (build step 5). Scoring-aware: every save runs the scoring
engine and returns the computed Pillar + Day Scores in the response, so the
client gets immediate feedback. Scores are NOT written to daily_logs — they are
derived and recomputed from the data layer, because they depend on context
(weekly bodyweight median, 7-day habit rates, pillar toggles) that changes
after the log row is written.

No endpoint accepts a user_id from the client (§3.1): the row owner is always
the authenticated user. Bodyweight, when supplied, becomes a bodyweight_entries
row (§4) — never a daily_logs column.
"""
from datetime import date as dt_date, datetime, time, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import scoring_service
from app.auth import get_current_user
from app.db import get_db
from app.models import BodyweightEntry, DailyLog, User
from app.schemas import (
    DailyLogOut,
    EveningLogIn,
    LogSaveResponse,
    MorningLogIn,
    PillarScoreOut,
    ScoresOut,
)

router = APIRouter(prefix="/api/logs", tags=["logs"])


def _get_or_create_log(db: Session, user_id: str, d: dt_date) -> DailyLog:
    log = db.scalar(select(DailyLog).where(DailyLog.user_id == user_id, DailyLog.date == d))
    if log is None:
        log = DailyLog(user_id=user_id, date=d)
        db.add(log)
    return log


def _add_bodyweight(db: Session, user_id: str, value: float, log_date: dt_date) -> None:
    # Timestamp the sample on the log's own date (noon UTC) so a backfilled log
    # lands the entry in the correct ISO week for the weekly median (§4).
    logged_at = datetime.combine(log_date, time(12, 0), tzinfo=timezone.utc)
    db.add(BodyweightEntry(user_id=user_id, value=value, logged_at=logged_at))


def _serialize_scores(result: scoring_service.ScoreResult) -> ScoresOut:
    pillars = {
        name: PillarScoreOut(
            score=ps.score,
            core_composite=ps.core_composite,
            blocks=ps.blocks,
            dropped=ps.dropped,
            habit_weight=ps.habit_weight,
            habit_rate=ps.habit_rate,
        )
        for name, ps in result.pillars.items()
    }
    d = result.day
    return ScoresOut(
        day_score=d.day_score,
        composite=d.composite,
        pillar_scores=d.pillar_scores,
        pillar_weights=d.pillar_weights,
        unassigned_weight=d.unassigned_weight,
        pillars=pillars,
    )


@router.get("", response_model=list[DailyLogOut])
def list_logs(
    from_date: dt_date = Query(alias="from"),
    to_date: dt_date = Query(alias="to"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[DailyLog]:
    stmt = (
        select(DailyLog)
        .where(DailyLog.user_id == user.id, DailyLog.date >= from_date, DailyLog.date <= to_date)
        .order_by(DailyLog.date)
    )
    return list(db.scalars(stmt).all())


@router.get("/{log_date}", response_model=DailyLogOut | None)
def get_log(
    log_date: dt_date,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DailyLog | None:
    return db.scalar(
        select(DailyLog).where(DailyLog.user_id == user.id, DailyLog.date == log_date)
    )


@router.post("/morning", response_model=LogSaveResponse)
def save_morning(
    payload: MorningLogIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> LogSaveResponse:
    log = _get_or_create_log(db, user.id, payload.date)
    log.morning_readiness = payload.morning_readiness
    log.sleep_hours = payload.sleep_hours
    log.rhr = payload.rhr
    log.hrv = payload.hrv
    log.morning_done = True
    if payload.bodyweight is not None:
        _add_bodyweight(db, user.id, payload.bodyweight, payload.date)
    db.commit()
    db.refresh(log)

    result = scoring_service.score_daily(db, user, payload.date)
    return LogSaveResponse(log=DailyLogOut.model_validate(log), scores=_serialize_scores(result))


@router.post("/evening", response_model=LogSaveResponse)
def save_evening(
    payload: EveningLogIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> LogSaveResponse:
    log = _get_or_create_log(db, user.id, payload.date)
    log.training_done = payload.training_done
    log.deep_work_hours = payload.deep_work_hours
    log.discretionary_spend = payload.discretionary_spend
    log.macro_adherence = payload.macro_adherence
    log.caloric_variance_pct = payload.caloric_variance_pct
    log.workout_rpe = payload.workout_rpe
    log.daily_reflection = payload.daily_reflection
    log.evening_done = True
    if payload.bodyweight is not None:
        _add_bodyweight(db, user.id, payload.bodyweight, payload.date)
    db.commit()
    db.refresh(log)

    result = scoring_service.score_daily(db, user, payload.date)
    return LogSaveResponse(log=DailyLogOut.model_validate(log), scores=_serialize_scores(result))
