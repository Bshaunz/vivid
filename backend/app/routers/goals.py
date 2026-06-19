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

# Focus guardrails (step 13 polish). Enforced server-side so the limits hold
# regardless of client; the frontend mirrors them for a clean UX, but this is
# the authority. Only ACTIVE goals count toward either limit.
MAX_ACTIVE_GOALS = 10
MAX_GOALS_PER_TARGET = 2


def _owned_goal(db: Session, user_id: str, goal_id: int) -> Goal:
    goal = db.scalar(select(Goal).where(Goal.id == goal_id, Goal.user_id == user_id))
    if goal is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Goal not found")
    return goal


def _enforce_active_limits(db: Session, user_id: str, payload: GoalCreate) -> None:
    """Reject a new ACTIVE goal that would breach the global cap (≤10 active)
    or the per-target cap (≤2 active goals on the same habit_id / metric_key).
    Inactive goals are unconstrained — only the active working set is limited."""
    if not payload.is_active:
        return

    active = list(
        db.scalars(
            select(Goal).where(Goal.user_id == user_id, Goal.is_active.is_(True))
        ).all()
    )

    if len(active) >= MAX_ACTIVE_GOALS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Maximum of 10 active goals reached. Archive a goal to create a new one.",
        )

    if payload.type == "habit":
        same = sum(1 for g in active if g.type == "habit" and g.habit_id == payload.habit_id)
        label = "habit"
    else:
        same = sum(1 for g in active if g.type == "metric" and g.metric_key == payload.metric_key)
        label = "metric"
    if same >= MAX_GOALS_PER_TARGET:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"This {label} already has the maximum of 2 active goals.",
        )


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
    _enforce_active_limits(db, user.id, payload)
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
