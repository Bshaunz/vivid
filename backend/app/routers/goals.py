"""
Goals CRUD — DISPLAY-ONLY (§6.7). These endpoints store and return goals and
their progress context, but goals feed NO score. Nothing here touches the
scoring engine. DELETE is a hard delete (goals carry no history worth keeping;
habit history lives on habit_completions).
"""
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.db import get_db
from app.models import Goal, User
from app.schemas import GoalCreate, GoalOut, GoalUpdate

router = APIRouter(prefix="/api/goals", tags=["goals"])


def _owned_goal(db: Session, user_id: str, goal_id: int) -> Goal:
    goal = db.scalar(select(Goal).where(Goal.id == goal_id, Goal.user_id == user_id))
    if goal is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Goal not found")
    return goal


@router.get("", response_model=list[GoalOut])
def list_goals(
    active_only: bool = Query(default=False),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[Goal]:
    stmt = select(Goal).where(Goal.user_id == user.id)
    if active_only:
        stmt = stmt.where(Goal.is_active.is_(True))
    return list(db.scalars(stmt.order_by(Goal.created_at)).all())


@router.post("", response_model=GoalOut, status_code=status.HTTP_201_CREATED)
def create_goal(
    payload: GoalCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Goal:
    goal = Goal(user_id=user.id, **payload.model_dump())
    db.add(goal)
    db.commit()
    db.refresh(goal)
    return goal


@router.put("/{goal_id}", response_model=GoalOut)
def update_goal(
    goal_id: int,
    patch: GoalUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Goal:
    goal = _owned_goal(db, user.id, goal_id)
    for field, value in patch.model_dump(exclude_unset=True).items():
        setattr(goal, field, value)
    db.commit()
    db.refresh(goal)
    return goal


@router.delete("/{goal_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_goal(
    goal_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    goal = _owned_goal(db, user.id, goal_id)
    db.delete(goal)
    db.commit()
