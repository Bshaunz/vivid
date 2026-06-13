"""
VIVID scoring engine — CLAUDE.md v4.0 §6, implemented exactly.

PURE by construction: this module imports only the standard library. No
SQLAlchemy, no session, no I/O. Every function takes plain values (the kind a
single ``v_daily_analysis`` row plus a little weekly context yields) and
returns a number or ``None``. That makes the whole engine smoke-testable
without a database and trivially portable to a TypeScript reimplementation for
the client.

Design rules carried verbatim from the spec:
  * Three pillars only — Health, Fitness, Finances. There is no "Performance"
    pillar; ``deep_work_hours`` is the 0.35 block *inside* Fitness (§6.5).
  * Goals contribute to nothing (§6.7). Not referenced here at all.
  * Bodyweight is scored only as a weekly median (§6.3) — never a raw daily.
  * Missing OPTIONAL blocks renormalize; they are never replaced by a constant
    filler (the v3.3 "default 0.6" bug). ``None`` means "absent → drop me".
  * Every division is guarded.

Why the functions return a decomposition, not just a number: the deviation
layer (§6.8) and the weekly synthesis (build step 10) need to correlate across
domains — e.g. "deep-work block down the same weeks the spend block cratered".
Returning each block's sub-score and which blocks were renormalized out is what
makes those cross-domain reads possible downstream. The composite is the
headline; the breakdown is the signal.
"""
from __future__ import annotations

from dataclasses import dataclass, field

# ── Constants (the contract; do not drift) ───────────────────────────────────

PILLARS = ("Health", "Fitness", "Finances")

MAX_HABIT_WEIGHT: dict[str, float] = {"Health": 0.20, "Fitness": 0.25, "Finances": 0.20}
PILLAR_BASE_WEIGHT: dict[str, float] = {"Health": 0.35, "Fitness": 0.35, "Finances": 0.30}

# Health core blocks, base weights before habit scaling / renormalization (§6.2)
HEALTH_BASE = {"readiness": 0.50, "bw_trend": 0.30, "nutrition": 0.20}
# Fitness core blocks (§6.5)
FITNESS_BASE = {"training": 0.45, "deep_work": 0.35, "rpe": 0.20}
# Finance core blocks (§6.6)
FINANCE_BASE = {"allocation": 0.50, "spend": 0.50}

STABLE_BAND = 0.002  # ±0.2% weekly bodyweight reads as stable (§6.3)
MAX_UNASSIGNED_WEIGHT = 0.10  # §6.7
_EPS = 1e-9


# ── Block-level pure functions (each unit-tested individually) ────────────────
# Convention: a return of ``None`` means the block is unavailable and must be
# renormalized out by its pillar — never coerced to a number here.


def readiness_score(morning_readiness: float | None) -> float | None:
    """§6.2 — required field, but guarded so a missing AM log drops the block."""
    if morning_readiness is None:
        return None
    return morning_readiness / 10


def bw_trend_score(
    this_week_median: float | None,
    prev_4wk_median_avg: float | None,
    bodyweight_goal: float | None,
) -> float | None:
    """§6.3 — weekly medians only. Excluded (None) when there is no goal, no
    sample this week, or no prior baseline to compare against."""
    if bodyweight_goal is None or this_week_median is None:
        return None
    if prev_4wk_median_avg is None or abs(prev_4wk_median_avg) < _EPS:
        return None
    delta_pct = (this_week_median - prev_4wk_median_avg) / prev_4wk_median_avg
    if abs(delta_pct) <= STABLE_BAND:
        return 0.7
    moving_down = delta_pct < 0
    need_to_lose = bodyweight_goal < this_week_median
    need_to_gain = bodyweight_goal > this_week_median
    toward_goal = (need_to_lose and moving_down) or (need_to_gain and not moving_down)
    return 1.0 if toward_goal else 0.4


def nutrition_score(
    macro_adherence: bool | None, caloric_variance_pct: float | None
) -> float | None:
    """§6.4 — excluded (None) only when macro_adherence was not logged."""
    if macro_adherence is None:
        return None
    if macro_adherence:
        return 1.0
    if caloric_variance_pct is not None:
        return max(0.0, 1 - abs(caloric_variance_pct) / 100)
    return 0.4


def training_score(training_done: bool, planned_rest: bool) -> float:
    """§6.5 — 1.0 trained / 0.5 declared rest / 0.0 skipped. ``planned_rest`` is
    decided upstream from habit frequency_days, not logged."""
    if training_done:
        return 1.0
    return 0.5 if planned_rest else 0.0


def deep_work_score(deep_work_hours: float | None) -> float | None:
    """§6.5 — required; guarded so a missing PM log drops the block."""
    if deep_work_hours is None:
        return None
    return min(deep_work_hours / 4, 1.0)


def rpe_score(workout_rpe: float | None) -> float | None:
    """§6.5 — excluded (None) when RPE was not logged (no constant filler)."""
    if workout_rpe is None:
        return None
    return workout_rpe / 10


def allocation_score(
    has_weekly_log_this_week: bool,
    capital_allocated: float | None,
    prev_allocation_score: float | None,
) -> float | None:
    """§6.6 — after this week's weekly log: 1.0 if capital allocated else 0.0.
    Before it: carry last week's score; with no history the block is excluded
    (None) and spend carries Finance. Fixes the v3.3 Mon–Sat-always-0 bug."""
    if has_weekly_log_this_week:
        return 1.0 if (capital_allocated is not None and capital_allocated > 0) else 0.0
    return prev_allocation_score


def spend_score(discretionary_spend: float, daily_budget: float | None) -> float:
    """§6.6 — neutral 0.8 when no budget is set; otherwise 1.0 at/under budget
    decaying to 0.0 at 2× budget. Always present."""
    if daily_budget is None or daily_budget <= 0:
        return 0.8
    ratio = discretionary_spend / daily_budget
    return max(0.0, 1 - max(0.0, ratio - 1))


# ── Habit scaling (§6.1) ──────────────────────────────────────────────────────


def pillar_habit_scale(active_habit_count: int) -> float:
    return min(active_habit_count / 3, 1.0)


def pillar_habit_weight(pillar: str, active_habit_count: int) -> float:
    return pillar_habit_scale(active_habit_count) * MAX_HABIT_WEIGHT[pillar]


def habit_rate(due: int, completed: int) -> float | None:
    """7-day completion rate. ``None`` when nothing was due (block contributes
    nothing rather than a misleading 0)."""
    if due <= 0:
        return None
    return max(0.0, min(completed / due, 1.0))


# ── Renormalization + composition ─────────────────────────────────────────────


@dataclass(frozen=True)
class Block:
    name: str
    score: float | None
    base_weight: float


def renormalize(blocks: list[Block]) -> tuple[float | None, list[str]]:
    """Weighted average of PRESENT blocks, rescaled so their weights sum to 1.
    Returns (composite, dropped_block_names). composite is None when every
    block is absent. Guarded division throughout (§6, "all division guarded")."""
    present = [b for b in blocks if b.score is not None]
    dropped = [b.name for b in blocks if b.score is None]
    total_w = sum(b.base_weight for b in present)
    if total_w < _EPS:
        return None, dropped
    composite = sum(b.score * b.base_weight for b in present) / total_w  # type: ignore[operator]
    return composite, dropped


@dataclass
class PillarScore:
    pillar: str
    score: float | None
    core_composite: float | None
    blocks: dict[str, float | None]
    dropped: list[str]
    habit_weight: float
    habit_rate: float | None


def _compose_pillar(
    pillar: str,
    core_blocks: list[Block],
    habit_weight: float,
    rate: float | None,
) -> PillarScore:
    core, dropped = renormalize(core_blocks)
    blocks = {b.name: b.score for b in core_blocks}
    if core is None:
        # No core data at all — fall back to habits if any, else no score.
        score = rate if (habit_weight > _EPS and rate is not None) else None
    elif habit_weight <= _EPS or rate is None:
        # No habits in this pillar (or none due): core occupies the whole pillar.
        score = core
    else:
        score = core * (1 - habit_weight) + rate * habit_weight
    return PillarScore(
        pillar=pillar,
        score=score,
        core_composite=core,
        blocks=blocks,
        dropped=dropped,
        habit_weight=habit_weight,
        habit_rate=rate,
    )


# ── Pillar inputs + scorers ───────────────────────────────────────────────────


@dataclass
class HealthInputs:
    morning_readiness: float | None
    this_week_median_bw: float | None = None
    prev_4wk_median_avg_bw: float | None = None
    bodyweight_goal: float | None = None
    macro_adherence: bool | None = None
    caloric_variance_pct: float | None = None


@dataclass
class FitnessInputs:
    training_done: bool
    deep_work_hours: float | None
    planned_rest: bool = False
    workout_rpe: float | None = None


@dataclass
class FinanceInputs:
    discretionary_spend: float
    daily_budget: float | None = None
    has_weekly_log_this_week: bool = False
    capital_allocated: float | None = None
    prev_allocation_score: float | None = None


def score_health(
    inp: HealthInputs, active_habit_count: int = 0, rate: float | None = None
) -> PillarScore:
    """§6.2 — readiness 0.50, bw_trend 0.30, nutrition 0.20 (renormalized)."""
    blocks = [
        Block("readiness", readiness_score(inp.morning_readiness), HEALTH_BASE["readiness"]),
        Block(
            "bw_trend",
            bw_trend_score(inp.this_week_median_bw, inp.prev_4wk_median_avg_bw, inp.bodyweight_goal),
            HEALTH_BASE["bw_trend"],
        ),
        Block(
            "nutrition",
            nutrition_score(inp.macro_adherence, inp.caloric_variance_pct),
            HEALTH_BASE["nutrition"],
        ),
    ]
    return _compose_pillar("Health", blocks, pillar_habit_weight("Health", active_habit_count), rate)


def score_fitness(
    inp: FitnessInputs, active_habit_count: int = 0, rate: float | None = None
) -> PillarScore:
    """§6.5 — training 0.45, deep_work 0.35, rpe 0.20 (rpe renormalized out)."""
    blocks = [
        Block("training", training_score(inp.training_done, inp.planned_rest), FITNESS_BASE["training"]),
        Block("deep_work", deep_work_score(inp.deep_work_hours), FITNESS_BASE["deep_work"]),
        Block("rpe", rpe_score(inp.workout_rpe), FITNESS_BASE["rpe"]),
    ]
    return _compose_pillar("Fitness", blocks, pillar_habit_weight("Fitness", active_habit_count), rate)


def score_finance(
    inp: FinanceInputs, active_habit_count: int = 0, rate: float | None = None
) -> PillarScore:
    """§6.6 — allocation 0.50, spend 0.50 (allocation renormalized out before
    the week's first weekly log when there is no prior score to carry)."""
    blocks = [
        Block(
            "allocation",
            allocation_score(inp.has_weekly_log_this_week, inp.capital_allocated, inp.prev_allocation_score),
            FINANCE_BASE["allocation"],
        ),
        Block("spend", spend_score(inp.discretionary_spend, inp.daily_budget), FINANCE_BASE["spend"]),
    ]
    return _compose_pillar("Finances", blocks, pillar_habit_weight("Finances", active_habit_count), rate)


# ── Day Score (§6.7) ──────────────────────────────────────────────────────────


@dataclass
class DayScore:
    day_score: int  # 0–100
    pillar_scores: dict[str, float]  # only pillars that contributed
    pillar_weights: dict[str, float]  # effective weights after renormalization
    unassigned_weight: float
    unassigned_rate: float | None
    composite: float  # 0–1, pre-rounding


def score_day(
    pillars: dict[str, PillarScore],
    active_pillars: list[str],
    unassigned_active_count: int = 0,
    unassigned_rate: float | None = None,
) -> DayScore:
    """Composite of the active pillar scores (base 0.35/0.35/0.30, renormalized
    when a pillar is toggled inactive or has no data) plus unassigned habits
    (≤10%). Goals contribute nothing. Guarded so an all-empty day yields 0."""
    contributing = {
        p: ps.score
        for p, ps in pillars.items()
        if p in active_pillars and ps.score is not None
    }
    base_total = sum(PILLAR_BASE_WEIGHT[p] for p in contributing)

    u_scale = min(unassigned_active_count / 3, 1.0)
    u_weight = u_scale * MAX_UNASSIGNED_WEIGHT if unassigned_rate is not None else 0.0

    if base_total < _EPS:
        # No pillar data — the day is whatever the unassigned habits say (or 0).
        composite = unassigned_rate if unassigned_rate is not None else 0.0
        return DayScore(
            day_score=round(composite * 100),
            pillar_scores={},
            pillar_weights={},
            unassigned_weight=1.0 if unassigned_rate is not None else 0.0,
            unassigned_rate=unassigned_rate,
            composite=composite,
        )

    pillar_total = 1 - u_weight
    effective_weights: dict[str, float] = {}
    composite = 0.0
    for p, s in contributing.items():
        w = (PILLAR_BASE_WEIGHT[p] / base_total) * pillar_total
        effective_weights[p] = w
        composite += s * w
    if unassigned_rate is not None:
        composite += unassigned_rate * u_weight

    return DayScore(
        day_score=round(composite * 100),
        pillar_scores=dict(contributing),
        pillar_weights=effective_weights,
        unassigned_weight=u_weight,
        unassigned_rate=unassigned_rate,
        composite=composite,
    )


# ── Convenience: whole-day scoring from one bundle ────────────────────────────


@dataclass
class DayInputs:
    """Everything one user-day needs, mirroring a ``v_daily_analysis`` row plus
    the weekly context the pillars require. Habit counts/rates are per pillar."""

    health: HealthInputs
    fitness: FitnessInputs
    finance: FinanceInputs
    active_pillars: list[str] = field(default_factory=lambda: list(PILLARS))
    habit_counts: dict[str, int] = field(default_factory=dict)
    habit_rates: dict[str, float | None] = field(default_factory=dict)
    unassigned_active_count: int = 0
    unassigned_rate: float | None = None


@dataclass
class DayResult:
    day: DayScore
    pillars: dict[str, PillarScore]


def score_day_bundle(inp: DayInputs) -> DayResult:
    """Score all three pillars and the composite from a single bundle. The full
    per-block decomposition is preserved on each PillarScore for the deviation
    layer and synthesis to read."""
    pillars = {
        "Health": score_health(
            inp.health, inp.habit_counts.get("Health", 0), inp.habit_rates.get("Health")
        ),
        "Fitness": score_fitness(
            inp.fitness, inp.habit_counts.get("Fitness", 0), inp.habit_rates.get("Fitness")
        ),
        "Finances": score_finance(
            inp.finance, inp.habit_counts.get("Finances", 0), inp.habit_rates.get("Finances")
        ),
    }
    day = score_day(
        pillars, inp.active_pillars, inp.unassigned_active_count, inp.unassigned_rate
    )
    return DayResult(day=day, pillars=pillars)
