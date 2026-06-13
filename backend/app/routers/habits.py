"""
Habits CRUD + completions.

DELETE is a SOFT archive (is_active = false) so completion history is preserved
for scoring and the synthesis — a hard delete would corrupt past habit rates.
Completion writes upsert on (user, habit, date), the same idempotent target the
client's optimistic toggle relies on.
"""
from datetime import date as dt_date

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.db import get_db
from app.models import Habit, HabitCompletion, User
from app.schemas import (
    CompletionUpdate,
    HabitCompletionOut,
    HabitCreate,
    HabitOut,
    HabitUpdate,
)

router = APIRouter(prefix="/api/habits", tags=["habits"])


def _owned_habit(db: Session, user_id: str, habit_id: int) -> Habit:
    habit = db.scalar(select(Habit).where(Habit.id == habit_id, Habit.user_id == user_id))
    if habit is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Habit not found")
    return habit


@router.get("", response_model=list[HabitOut])
def list_habits(
    active_only: bool = Query(default=False),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[Habit]:
    stmt = select(Habit).where(Habit.user_id == user.id)
    if active_only:
        stmt = stmt.where(Habit.is_active.is_(True))
    return list(db.scalars(stmt.order_by(Habit.created_at)).all())


@router.post("", response_model=HabitOut, status_code=status.HTTP_201_CREATED)
def create_habit(
    payload: HabitCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Habit:
    habit = Habit(user_id=user.id, **payload.model_dump())
    db.add(habit)
    db.commit()
    db.refresh(habit)
    return habit


@router.put("/{habit_id}", response_model=HabitOut)
def update_habit(
    habit_id: int,
    patch: HabitUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Habit:
    habit = _owned_habit(db, user.id, habit_id)
    for field, value in patch.model_dump(exclude_unset=True).items():
        setattr(habit, field, value)
    db.commit()
    db.refresh(habit)
    return habit


@router.delete("/{habit_id}", status_code=status.HTTP_204_NO_CONTENT)
def archive_habit(
    habit_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    habit = _owned_habit(db, user.id, habit_id)
    habit.is_active = False  # soft delete — preserve completion history
    db.commit()


# ── Completions ───────────────────────────────────────────────────────────────


@router.get("/completions", response_model=list[HabitCompletionOut])
def list_completions(
    from_date: dt_date = Query(alias="from"),
    to_date: dt_date = Query(alias="to"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[HabitCompletion]:
    stmt = (
        select(HabitCompletion)
        .where(
            HabitCompletion.user_id == user.id,
            HabitCompletion.date >= from_date,
            HabitCompletion.date <= to_date,
        )
        .order_by(HabitCompletion.date)
    )
    return list(db.scalars(stmt).all())


@router.put("/{habit_id}/completion", response_model=HabitCompletionOut)
def set_completion(
    habit_id: int,
    payload: CompletionUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> HabitCompletion:
    _owned_habit(db, user.id, habit_id)  # ownership + existence
    row = db.scalar(
        select(HabitCompletion).where(
            HabitCompletion.user_id == user.id,
            HabitCompletion.habit_id == habit_id,
            HabitCompletion.date == payload.date,
        )
    )
    if row is None:
        row = HabitCompletion(
            user_id=user.id, habit_id=habit_id, date=payload.date, completed=payload.completed
        )
        db.add(row)
    else:
        row.completed = payload.completed
    db.commit()
    db.refresh(row)
    return row
