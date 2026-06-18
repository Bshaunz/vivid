"""
Baseline & deviation service — the Home "What Changed" layer.

Computes each user's rolling personal norm per whitelisted DAILY metric and
flags statistically significant, high-priority deviations of the most recent
logged day against that norm. Lives beside scoring_service (pure stats core +
DB-reading assembly); the scoring engine is untouched — deviations never feed a
score (§6.7 goals/§6 scoring stay separate).

WINDOW: 14 days. NOTE — this intentionally diverges from the §6.8 spec
reference, which describes a 30-day norm (and the Baseline model docstring still
says "30-day"). Per the approved step-8 config we use a 14-day rolling window;
the existing baselines.window_days column carries the value (default 30 is just a
column default — no migration needed), and the table's CHECK n_observations >= 7
is preserved, so a user with fewer than 7 logged days in the window gets no
alerts.

SIGNIFICANCE — hybrid gate (both must hold):
    z      = (x − mean) / max(sd, 1e-6)          statistical strength
    pct    = (x − mean) / mean                    human-readable magnitude
    significant ⇔ |z| ≥ z_threshold (1.5) AND |pct| ≥ pct_floor[metric]
Requiring both kills the two false-alarm classes: a big move inside a
high-variance metric (fails z), and a trivial absolute move when sd≈0 (fails
pct). When the baseline mean sits below a per-metric floor (e.g. a week of zero
spend), pct is undefined, so we fall back to an absolute-delta gate
(|x − mean| ≥ abs_floor) instead.

BODYWEIGHT is deliberately excluded here: weekly_median_bodyweight is a weekly
aggregate (§4), so a 14-day window can't reach n ≥ 7 weekly medians. Its trend
already surfaces via the weekly-median series on Home; a dedicated longer-window
deviation is a later follow-up.
"""
from __future__ import annotations

import statistics
from dataclasses import dataclass
from datetime import date as dt_date, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Baseline, DailyLog, User, utcnow

WINDOW_DAYS = 14
MIN_OBSERVATIONS = 7
Z_THRESHOLD = 1.5
SD_FLOOR = 1e-6  # documented guard against sd==0 (Baseline docstring)


@dataclass(frozen=True)
class MetricSpec:
    key: str          # baselines.metric_key (∈ BASELINE_METRIC_KEYS)
    column: str       # DailyLog attribute name
    adverse: str      # "up" | "down" — the direction that is bad for the user
    pct_floor: float  # |pct| gate when the mean is above mean_floor
    mean_floor: float # below |mean| this, switch to the absolute-delta gate
    abs_floor: float  # |x − mean| gate used in the mean≈0 fallback


# Daily metrics only — weekly_median_bodyweight is intentionally absent (see
# module docstring). Ordering is irrelevant; results are sorted by |z|.
METRIC_SPECS: tuple[MetricSpec, ...] = (
    MetricSpec("sleep_hours", "sleep_hours", "down", 0.15, 0.0, 1.0),
    MetricSpec("discretionary_spend", "discretionary_spend", "up", 0.20, 10.0, 25.0),
    MetricSpec("morning_readiness", "morning_readiness", "down", 0.15, 0.0, 1.5),
    MetricSpec("rhr", "rhr", "up", 0.07, 0.0, 4.0),
    MetricSpec("hrv", "hrv", "down", 0.15, 0.0, 8.0),
    MetricSpec("deep_work_hours", "deep_work_hours", "down", 0.25, 0.5, 1.5),
)


@dataclass(frozen=True)
class Deviation:
    metric_key: str
    latest_value: float
    latest_date: dt_date
    baseline_mean: float
    baseline_sd: float
    z_score: float
    abs_change: float            # x − mean (signed)
    pct_change: float | None     # signed fraction; None when the mean≈0 fallback was used
    direction: str               # "up" | "down"
    valence: str                 # "adverse" | "favorable"
    n_observations: int


# ── pure stats core ───────────────────────────────────────────────────────────

def _mean_sd(values: list[float]) -> tuple[float, float]:
    mean = statistics.fmean(values)
    sd = statistics.stdev(values) if len(values) >= 2 else 0.0
    return mean, sd


def _evaluate(
    spec: MetricSpec, x: float, values: list[float], *, z_threshold: float
) -> Deviation | None:
    """Apply the hybrid gate for one metric. Returns a Deviation only when the
    move is significant, else None."""
    mean, sd = _mean_sd(values)
    abs_change = x - mean
    if abs_change == 0:
        return None
    z = abs_change / max(sd, SD_FLOOR)

    use_pct = abs(mean) >= spec.mean_floor and mean != 0
    pct: float | None = (abs_change / mean) if use_pct else None
    magnitude_ok = (
        abs(pct) >= spec.pct_floor if pct is not None else abs(abs_change) >= spec.abs_floor
    )
    if abs(z) < z_threshold or not magnitude_ok:
        return None

    direction = "up" if abs_change > 0 else "down"
    valence = "adverse" if direction == spec.adverse else "favorable"
    return Deviation(
        metric_key=spec.key,
        latest_value=float(x),
        latest_date=dt_date.min,  # filled by caller (it knows as_of)
        baseline_mean=round(mean, 4),
        baseline_sd=round(sd, 4),
        z_score=round(z, 3),
        abs_change=round(abs_change, 4),
        pct_change=round(pct, 4) if pct is not None else None,
        direction=direction,
        valence=valence,
        n_observations=len(values),
    )


# ── DB-reading assembly ───────────────────────────────────────────────────────

def _latest_log_date(db: Session, user_id: str) -> dt_date | None:
    return db.scalar(select(func.max(DailyLog.date)).where(DailyLog.user_id == user_id))


def detect_deviations(
    db: Session,
    user: User,
    *,
    as_of: dt_date | None = None,
    window_days: int = WINDOW_DAYS,
    z_threshold: float = Z_THRESHOLD,
    min_observations: int = MIN_OBSERVATIONS,
) -> list[Deviation]:
    """Significant deviations of the most recent logged day against the trailing
    `window_days` that PRECEDE it (the comparison day is excluded from its own
    baseline). Sorted by |z| descending — the high-priority alerts first.

    Returns [] when the user has no logs or no baseline reaches min_observations.
    """
    if as_of is None:
        as_of = _latest_log_date(db, user.id)
        if as_of is None:
            return []

    start = as_of - timedelta(days=window_days)  # prior window: [as_of−14, as_of−1]
    rows = list(
        db.scalars(
            select(DailyLog)
            .where(
                DailyLog.user_id == user.id,
                DailyLog.date >= start,
                DailyLog.date <= as_of,
            )
            .order_by(DailyLog.date)
        ).all()
    )
    as_of_row = next((r for r in rows if r.date == as_of), None)
    if as_of_row is None:
        return []
    prior = [r for r in rows if r.date < as_of]

    out: list[Deviation] = []
    for spec in METRIC_SPECS:
        x = getattr(as_of_row, spec.column)
        if x is None:
            continue
        values = [
            v for r in prior if (v := getattr(r, spec.column)) is not None
        ]
        if len(values) < min_observations:
            continue
        dev = _evaluate(spec, float(x), values, z_threshold=z_threshold)
        if dev is not None:
            # Stamp the real comparison date (the pure core doesn't know it).
            out.append(
                Deviation(
                    metric_key=dev.metric_key,
                    latest_value=dev.latest_value,
                    latest_date=as_of,
                    baseline_mean=dev.baseline_mean,
                    baseline_sd=dev.baseline_sd,
                    z_score=dev.z_score,
                    abs_change=dev.abs_change,
                    pct_change=dev.pct_change,
                    direction=dev.direction,
                    valence=dev.valence,
                    n_observations=dev.n_observations,
                )
            )
    out.sort(key=lambda d: abs(d.z_score), reverse=True)
    return out


def refresh_baselines(
    db: Session,
    user: User,
    *,
    window_days: int = WINDOW_DAYS,
    min_observations: int = MIN_OBSERVATIONS,
) -> None:
    """Opportunistically upsert the persisted norm snapshots into the baselines
    table (the "job" deliverable, without job infra). Snapshot window is the
    trailing `window_days` up to AND INCLUDING the latest log — i.e. the current
    norm. Deviation detection does NOT depend on these rows (it computes live);
    this is a cache for future reads. The caller owns the commit.
    """
    as_of = _latest_log_date(db, user.id)
    if as_of is None:
        return
    start = as_of - timedelta(days=window_days - 1)  # inclusive, window_days days
    rows = list(
        db.scalars(
            select(DailyLog).where(
                DailyLog.user_id == user.id,
                DailyLog.date >= start,
                DailyLog.date <= as_of,
            )
        ).all()
    )
    for spec in METRIC_SPECS:
        values = [v for r in rows if (v := getattr(r, spec.column)) is not None]
        if len(values) < min_observations:  # honors the CHECK n_observations >= 7
            continue
        mean, sd = _mean_sd(values)
        existing = db.scalar(
            select(Baseline).where(
                Baseline.user_id == user.id, Baseline.metric_key == spec.key
            )
        )
        if existing is None:
            db.add(
                Baseline(
                    user_id=user.id,
                    metric_key=spec.key,
                    window_days=window_days,
                    mean=mean,
                    sd=sd,
                    n_observations=len(values),
                )
            )
        else:
            existing.window_days = window_days
            existing.mean = mean
            existing.sd = sd
            existing.n_observations = len(values)
            existing.computed_at = utcnow()
