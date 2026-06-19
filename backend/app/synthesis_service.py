"""
Synthesis service — the DB→engine→LLM bridge for the weekly cross-pillar
synthesis (CLAUDE.md §6 step 10).

This is the only place that assembles a user's stored week into the consolidated
cross-pillar payload, gates the token budget, and calls the (currently mocked)
LLM seam in ``app.llm``. The endpoints stay thin; all the policy lives here.

Hard invariants enforced in this module (do not relax):
  * ``optimization_score`` is DETERMINISTIC — the mean Day Score over the week's
    LOGGED days, taken straight from the scoring engine. The LLM never sees it
    (it is kept out of <user_data>) and never produces it. It is NOT persisted;
    it is recomputed from the engine on every read (``compute_optimization_score``).
  * The token budget is checked BEFORE the LLM call — per-user daily
    (``daily_token_budget_per_user``) and global monthly (``max_monthly_tokens``).
    A force-regenerate is gated the same way. Over budget → BudgetExceeded (429).
  * Idempotent per (user_id, type='weekly', week_start). A cache hit short-circuits
    before assembly, budget, and the LLM. ``force=True`` regenerates in place.
  * All user free text is sealed before it enters <user_data> so it cannot forge
    a closing tag and break out of the data envelope (prompt-injection containment).
    The single real </user_data> is emitted by us.
  * The system prompt is loaded via ``app.llm.load_system_prompt`` and is never
    returned, logged, or embedded in any output here.

A "logged day" is a daily_logs row in the ISO week with morning or evening
completed — partial-but-real days count and renormalize per pillar (§6.7); empty
shells (which the engine would score 0) do not pollute the mean.
"""
from __future__ import annotations

import re
import statistics
from dataclasses import dataclass
from datetime import date as dt_date, datetime, time, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import llm, scoring_service
from app.config import get_settings
from app.services import context_builder
from app.models import AISynthesis, DailyLog, User, WeeklyLog, utcnow

SYNTHESIS_TYPE = "weekly"

# Minimum paired observations before a deterministic correlation is emitted, so a
# one- or two-day week doesn't produce noise dressed up as a trend.
_MIN_GROUP = 2


class NoDataForWeek(Exception):
    """No logged days in the requested ISO week — nothing to synthesize (→422)."""


class BudgetExceeded(Exception):
    """Per-user daily or global monthly token budget would be exceeded (→429)."""

    def __init__(self, scope: str):
        self.scope = scope  # "daily" | "monthly" — never leak counts to clients
        super().__init__(f"{scope} token budget exceeded")


@dataclass
class SynthesisContext:
    week_start: dt_date
    logged_days: int
    optimization_score: int          # 0–100, deterministic; NOT sent to the LLM
    insights: list[str]              # deterministic cross-pillar correlations
    summary: str
    user_block: str                  # sealed <user_data>…</user_data> envelope


# ── time helpers (UTC, mirror scoring_service conventions) ────────────────────

def _start_of_day_utc() -> datetime:
    now = datetime.now(timezone.utc)
    return datetime.combine(now.date(), time.min, tzinfo=timezone.utc)


def _start_of_month_utc() -> datetime:
    now = datetime.now(timezone.utc)
    return datetime(now.year, now.month, 1, tzinfo=timezone.utc)


# ── week data ─────────────────────────────────────────────────────────────────

def _week_logs(db: Session, user_id: str, week_start: dt_date) -> list[DailyLog]:
    week_end = week_start + timedelta(days=6)
    rows = db.scalars(
        select(DailyLog)
        .where(
            DailyLog.user_id == user_id,
            DailyLog.date >= week_start,
            DailyLog.date <= week_end,
        )
        .order_by(DailyLog.date)
    ).all()
    # Only genuinely-logged days; empty shells would score 0 and skew the mean.
    return [l for l in rows if l.morning_done or l.evening_done]


def _week_weekly_log(db: Session, user_id: str, week_start: dt_date) -> WeeklyLog | None:
    return db.scalar(
        select(WeeklyLog).where(
            WeeklyLog.user_id == user_id, WeeklyLog.week_start == week_start
        )
    )


# ── deterministic optimization score (engine only) ───────────────────────────

def _mean_day_score(db: Session, user: User, logs: list[DailyLog]) -> int | None:
    """Mean Day Score over the given logged days, rounded to an int 0–100. The
    LLM is never involved. Returns None when there are no logged days."""
    if not logs:
        return None
    scores = [scoring_service.score_daily(db, user, l.date).day.day_score for l in logs]
    return max(0, min(100, round(statistics.fmean(scores))))


def compute_optimization_score(db: Session, user: User, week_start: dt_date) -> int:
    """Read-path recompute (deterministic, from the engine). Used to populate
    SynthesisOut.optimization_score on GET without persisting it. Falls back to 0
    only if every logged day was removed after the synthesis was generated."""
    logs = _week_logs(db, user.id, week_start)
    return _mean_day_score(db, user, logs) or 0


# ── deterministic cross-pillar insights (None-guarded) ───────────────────────

def _avg(values: list[float]) -> float:
    return statistics.fmean(values)


def _insight_deepwork_vs_training(logs: list[DailyLog]) -> str | None:
    """Fitness×Fitness: deep work on training vs rest days."""
    trained = [l.deep_work_hours for l in logs
               if l.training_done is True and l.deep_work_hours is not None]
    rest = [l.deep_work_hours for l in logs
            if l.training_done is False and l.deep_work_hours is not None]
    if len(trained) < _MIN_GROUP or len(rest) < _MIN_GROUP:
        return None
    return (f"Deep work averaged {_avg(trained):.1f}h on training days "
            f"vs {_avg(rest):.1f}h on rest days.")


def _insight_sleep_vs_spend(logs: list[DailyLog]) -> str | None:
    """Health×Finances: sleep on higher- vs lower-spend days, split at the
    week's own median discretionary spend."""
    pairs = [(l.sleep_hours, l.discretionary_spend) for l in logs
             if l.sleep_hours is not None and l.discretionary_spend is not None]
    if len(pairs) < _MIN_GROUP * 2:
        return None
    median_spend = statistics.median(sp for _, sp in pairs)
    high = [s for s, sp in pairs if sp >= median_spend]
    low = [s for s, sp in pairs if sp < median_spend]
    if len(high) < _MIN_GROUP or len(low) < _MIN_GROUP:
        return None
    return (f"Sleep averaged {_avg(high):.1f}h on higher-spend days "
            f"vs {_avg(low):.1f}h on lower-spend days.")


def _insight_readiness_vs_training(logs: list[DailyLog]) -> str | None:
    """Health×Fitness: morning readiness on training vs rest days."""
    trained = [l.morning_readiness for l in logs
               if l.training_done is True and l.morning_readiness is not None]
    rest = [l.morning_readiness for l in logs
            if l.training_done is False and l.morning_readiness is not None]
    if len(trained) < _MIN_GROUP or len(rest) < _MIN_GROUP:
        return None
    return (f"Morning readiness averaged {_avg(trained):.1f}/10 on training days "
            f"vs {_avg(rest):.1f}/10 on rest days.")


_INSIGHT_BUILDERS = (
    _insight_deepwork_vs_training,
    _insight_sleep_vs_spend,
    _insight_readiness_vs_training,
)


def _build_insights(logs: list[DailyLog]) -> list[str]:
    out: list[str] = []
    for build in _INSIGHT_BUILDERS:
        line = build(logs)
        if line:
            out.append(line)
    return out


# ── <user_data> rendering with injection sealing ─────────────────────────────

_TAG_RE = re.compile(r"</?\s*user_data\b[^>]*>", re.IGNORECASE)


def _seal(text: str) -> str:
    """Neutralize any user_data tag a user may have typed into free text, so it
    cannot forge the closing tag and escape the data envelope. The only real
    </user_data> is the one we emit ourselves."""
    return _TAG_RE.sub("[redacted-tag]", text).replace("\n", " ").strip()


def _render_day(l: DailyLog) -> str:
    parts: list[str] = [f"{l.date.isoformat()} ({l.date.strftime('%a')}):"]
    am: list[str] = []
    if l.morning_readiness is not None:
        am.append(f"readiness={l.morning_readiness}/10")
    if l.sleep_hours is not None:
        am.append(f"sleep={l.sleep_hours:g}h")
    if l.rhr is not None:
        am.append(f"rhr={l.rhr}")
    if l.hrv is not None:
        am.append(f"hrv={l.hrv}")
    if am:
        parts.append("AM[" + " ".join(am) + "]")
    pm: list[str] = []
    if l.training_done is not None:
        pm.append("trained=" + ("yes" if l.training_done else "no"))
    if l.workout_rpe is not None:
        pm.append(f"rpe={l.workout_rpe}")
    if l.deep_work_hours is not None:
        pm.append(f"deep_work={l.deep_work_hours:g}h")
    if l.macro_adherence is not None:
        pm.append("macro=" + ("ok" if l.macro_adherence else "off"))
    if l.discretionary_spend is not None:
        pm.append(f"spend={l.discretionary_spend:.2f}")
    if pm:
        parts.append("PM[" + " ".join(pm) + "]")
    if l.daily_reflection:
        parts.append(f'reflection="{_seal(l.daily_reflection)}"')
    return " ".join(parts)


def _render_user_block(
    week_start: dt_date,
    logs: list[DailyLog],
    weekly_log: WeeklyLog | None,
    insights: list[str],
) -> str:
    lines: list[str] = ["<user_data>"]
    lines.append(
        f"VIVID weekly data for the ISO week starting {week_start.isoformat()} (Monday)."
    )
    lines.append(f"Logged days: {len(logs)}.")
    lines.append("")
    lines.append("Daily entries:")
    for l in logs:
        lines.append("  " + _render_day(l))
    if weekly_log is not None:
        lines.append("")
        lines.append(f"Weekly capital allocated: {weekly_log.capital_allocated:.2f}")
        if weekly_log.bottleneck_audit:
            lines.append(f'Weekly bottleneck audit: "{_seal(weekly_log.bottleneck_audit)}"')
    lines.append("")
    lines.append(
        "Computed cross-pillar correlations (deterministic — narrate these; "
        "do not recompute or invent numbers):"
    )
    if insights:
        for ins in insights:
            lines.append(f"  - {ins}")
    else:
        lines.append("  - (insufficient paired data this week)")
    lines.append("</user_data>")
    return "\n".join(lines)


# ── context assembly ──────────────────────────────────────────────────────────

def assemble_context(db: Session, user: User, week_start: dt_date) -> SynthesisContext:
    """Build the full deterministic context for one ISO week. Raises
    NoDataForWeek when the week has no logged days."""
    logs = _week_logs(db, user.id, week_start)
    if not logs:
        raise NoDataForWeek(week_start.isoformat())

    opt = _mean_day_score(db, user, logs)
    assert opt is not None  # logs is non-empty here
    weekly_log = _week_weekly_log(db, user.id, week_start)
    insights = _build_insights(logs)
    summary = (
        f"Week of {week_start.strftime('%b %d, %Y')}: {len(logs)} day(s) logged, "
        f"optimization score {opt}/100."
    )
    user_block = _render_user_block(week_start, logs, weekly_log, insights)
    return SynthesisContext(
        week_start=week_start,
        logged_days=len(logs),
        optimization_score=opt,
        insights=insights,
        summary=summary,
        user_block=user_block,
    )


# ── token budget gateway (pre-call) ──────────────────────────────────────────

def _tokens_used_today(db: Session, user_id: str) -> int:
    return db.scalar(
        select(func.coalesce(func.sum(AISynthesis.tokens_in + AISynthesis.tokens_out), 0))
        .where(
            AISynthesis.user_id == user_id,
            AISynthesis.generated_at >= _start_of_day_utc(),
        )
    ) or 0


def _tokens_used_this_month(db: Session) -> int:
    return db.scalar(
        select(func.coalesce(func.sum(AISynthesis.tokens_in + AISynthesis.tokens_out), 0))
        .where(AISynthesis.generated_at >= _start_of_month_utc())
    ) or 0


def _check_budget(db: Session, user: User, system_prompt: str, user_block: str) -> None:
    """Gate BEFORE the LLM. Charges a worst-case prospective cost (estimated
    input + the full max_tokens output ceiling) against the per-user daily then
    the global monthly budget. Raises BudgetExceeded with a scope only."""
    settings = get_settings()
    prospective = (
        llm.estimate_tokens(system_prompt)
        + llm.estimate_tokens(user_block)
        + settings.synthesis_max_tokens
    )
    if _tokens_used_today(db, user.id) + prospective > settings.daily_token_budget_per_user:
        raise BudgetExceeded("daily")
    if _tokens_used_this_month(db) + prospective > settings.max_monthly_tokens:
        raise BudgetExceeded("monthly")


# ── generation (idempotent, budget-gated) ────────────────────────────────────

def _existing(db: Session, user_id: str, week_start: dt_date) -> AISynthesis | None:
    return db.scalar(
        select(AISynthesis).where(
            AISynthesis.user_id == user_id,
            AISynthesis.type == SYNTHESIS_TYPE,
            AISynthesis.week_start == week_start,
        )
    )


def get_for_week(db: Session, user: User, week_start: dt_date) -> AISynthesis | None:
    """Read the stored weekly synthesis for an ISO week, or None. No generation,
    no budget, no LLM — pure lookup for the GET path."""
    return _existing(db, user.id, week_start)


def list_recent(db: Session, user: User, limit: int) -> list[AISynthesis]:
    """Most-recent syntheses for the user, newest first."""
    return list(
        db.scalars(
            select(AISynthesis)
            .where(AISynthesis.user_id == user.id, AISynthesis.type == SYNTHESIS_TYPE)
            .order_by(AISynthesis.generated_at.desc())
            .limit(limit)
        ).all()
    )


def generate_weekly(
    db: Session, user: User, week_start: dt_date, force: bool = False
) -> tuple[AISynthesis, bool]:
    """Idempotent weekly synthesis for (user, week_start).

    Returns (row, cached). A cache hit short-circuits before assembly, budget,
    and the LLM. ``force=True`` regenerates in place through the same budget
    gate. Raises NoDataForWeek (→422) for an empty week and BudgetExceeded
    (→429) when a budget would be tripped.
    """
    row = _existing(db, user.id, week_start)
    if row is not None and not force:
        return row, True

    system_prompt = llm.load_system_prompt()           # model-only; never echoed
    ctx = assemble_context(db, user, week_start)        # may raise NoDataForWeek

    # The model payload is the dense cross-pillar aggregate (step 11), carrying
    # the deterministic correlations to narrate. Still sealed in <user_data>; the
    # optimization score is never included.
    user_block = context_builder.get_weekly_context(
        db, user.id, week_start, correlations=ctx.insights
    )
    _check_budget(db, user, system_prompt, user_block)  # may raise BudgetExceeded

    settings = get_settings()
    result = llm.complete_synthesis(
        system_prompt,
        user_block,
        max_tokens=settings.synthesis_max_tokens,
        mock_summary=ctx.summary,
        mock_insights=ctx.insights,
    )

    if row is None:
        row = AISynthesis(
            user_id=user.id,
            type=SYNTHESIS_TYPE,
            week_start=week_start,
            content=result.content,
            tokens_in=result.tokens_in,
            tokens_out=result.tokens_out,
            model=result.model,
        )
        db.add(row)
    else:  # force regenerate — replace in place, keep the id
        row.content = result.content
        row.tokens_in = result.tokens_in
        row.tokens_out = result.tokens_out
        row.model = result.model
        row.generated_at = utcnow()
    db.flush()
    db.refresh(row)
    return row, False
