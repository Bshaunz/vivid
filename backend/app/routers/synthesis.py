"""
Weekly AI synthesis endpoints (CLAUDE.md §6 step 10).

The client may only ever name an ISO-week Monday — the entire cross-pillar
payload is assembled server-side from the authenticated user's own stored data
(§3.1/§4); no metrics and no user_id are ever accepted from the client. The
deterministic optimization_score is recomputed from the scoring engine on every
response and injected into the schema; the (currently mocked) LLM never scores.

Routes:
  POST /api/synthesis/weekly          generate (idempotent; force to regenerate)
  GET  /api/synthesis/weekly/{week}   the stored synthesis for that week, or null
  GET  /api/synthesis                 recent syntheses (newest first)

Errors: no logged days → 404; token budget tripped → 429; non-Monday → 422.
AI routes declare a stricter 10/min on top of the global 60/min (§3.4).
"""
from datetime import date as dt_date

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from app import synthesis_service as ss
from app.auth import get_current_user
from app.db import get_db
from app.models import User
from app.ratelimit import limiter
from app.schemas import SynthesisGenerateIn, SynthesisOut

router = APIRouter(prefix="/api/synthesis", tags=["synthesis"])


def _serialize(db: Session, user: User, row, *, cached: bool) -> SynthesisOut:
    """Attach the freshly recomputed (deterministic) optimization_score and parse
    the bullet insights out of the stored content."""
    opt = ss.compute_optimization_score(db, user, row.week_start)
    return SynthesisOut.from_row(row, optimization_score=opt, cached=cached)


@router.post("/weekly", response_model=SynthesisOut)
@limiter.limit("10/minute")
def generate_weekly(
    request: Request,  # required by slowapi's per-route limiter
    payload: SynthesisGenerateIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> SynthesisOut:
    try:
        row, cached = ss.generate_weekly(db, user, payload.week_start, force=payload.force)
    except ss.NoDataForWeek:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No logged days in the requested week to synthesize.",
        )
    except ss.BudgetExceeded as e:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"{e.scope} token budget exceeded; try again later.",
        )
    if not cached:
        db.commit()
        db.refresh(row)
    return _serialize(db, user, row, cached=cached)


@router.get("/weekly/{week_start}", response_model=SynthesisOut | None)
def get_weekly_synthesis(
    week_start: dt_date,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> SynthesisOut | None:
    if week_start.isoweekday() != 1:
        raise HTTPException(status_code=422, detail="week_start must be an ISO Monday")
    row = ss.get_for_week(db, user, week_start)
    if row is None:
        return None
    return _serialize(db, user, row, cached=True)


@router.get("", response_model=list[SynthesisOut])
def list_syntheses(
    limit: int = Query(default=8, ge=1, le=52),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[SynthesisOut]:
    rows = ss.list_recent(db, user, limit)
    return [_serialize(db, user, r, cached=True) for r in rows]
