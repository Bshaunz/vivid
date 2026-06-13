"""
Unit tests for the scoring engine — every §6 formula and, critically, every
renormalization path (§11: "Unit tests are mandatory for every formula in §6").

Pure: no DB, no fixtures beyond plain values. ``pytest`` from backend/.
"""
import math

import pytest

from app import scoring as s


def approx(x: float):
    return pytest.approx(x, abs=1e-9)


# ── 6.1 habit scaling ─────────────────────────────────────────────────────────


def test_habit_scale_caps_at_one():
    assert s.pillar_habit_scale(0) == 0.0
    assert s.pillar_habit_scale(2) == approx(2 / 3)
    assert s.pillar_habit_scale(3) == 1.0
    assert s.pillar_habit_scale(9) == 1.0  # min(.., 1.0)


def test_habit_weight_uses_pillar_max():
    assert s.pillar_habit_weight("Fitness", 3) == approx(0.25)
    assert s.pillar_habit_weight("Health", 3) == approx(0.20)
    assert s.pillar_habit_weight("Finances", 1) == approx((1 / 3) * 0.20)


def test_habit_rate_guards_zero_due():
    assert s.habit_rate(0, 0) is None  # nothing due → block contributes nothing
    assert s.habit_rate(7, 5) == approx(5 / 7)
    assert s.habit_rate(4, 9) == 1.0  # clamped


# ── 6.2 / 6.3 / 6.4 Health blocks ─────────────────────────────────────────────


def test_readiness_score():
    assert s.readiness_score(8) == approx(0.8)
    assert s.readiness_score(None) is None


def test_bw_trend_excluded_without_goal_or_samples():
    assert s.bw_trend_score(185.0, 186.0, None) is None  # no goal
    assert s.bw_trend_score(None, 186.0, 180.0) is None  # no sample this week
    assert s.bw_trend_score(185.0, None, 180.0) is None  # no baseline


def test_bw_trend_toward_away_stable():
    # Goal 180 (cutting). Median fell well below band → toward goal → 1.0
    assert s.bw_trend_score(184.0, 186.0, 180.0) == 1.0
    # Median rose beyond band, away from a cutting goal → 0.4
    assert s.bw_trend_score(188.0, 186.0, 180.0) == 0.4
    # Within ±0.2% → stable → 0.7
    assert s.bw_trend_score(186.1, 186.0, 180.0) == 0.7
    # Bulking goal 200, median rose → toward → 1.0
    assert s.bw_trend_score(188.0, 186.0, 200.0) == 1.0


def test_bw_trend_guards_zero_baseline():
    assert s.bw_trend_score(185.0, 0.0, 180.0) is None


def test_nutrition_paths():
    assert s.nutrition_score(True, None) == 1.0
    assert s.nutrition_score(False, 10) == approx(0.9)  # 1 - 10/100
    assert s.nutrition_score(False, 250) == 0.0  # clamped at 0
    assert s.nutrition_score(False, None) == 0.4
    assert s.nutrition_score(None, None) is None  # not logged → excluded


# ── 6.5 Fitness blocks ────────────────────────────────────────────────────────


def test_training_three_states():
    assert s.training_score(True, False) == 1.0
    assert s.training_score(False, True) == 0.5  # declared rest
    assert s.training_score(False, False) == 0.0  # skipped


def test_deep_work_caps_at_one():
    assert s.deep_work_score(2) == approx(0.5)
    assert s.deep_work_score(4) == 1.0
    assert s.deep_work_score(6) == 1.0
    assert s.deep_work_score(None) is None


def test_rpe_excluded_when_absent():
    assert s.rpe_score(7) == approx(0.7)
    assert s.rpe_score(None) is None  # no constant filler


# ── 6.6 Finance blocks ────────────────────────────────────────────────────────


def test_allocation_after_weekly_log():
    assert s.allocation_score(True, 500, None) == 1.0
    assert s.allocation_score(True, 0, None) == 0.0


def test_allocation_carries_or_excludes_before_log():
    assert s.allocation_score(False, None, 1.0) == 1.0  # carry last week
    assert s.allocation_score(False, None, None) is None  # no history → excluded


def test_spend_score_budget_paths():
    assert s.spend_score(0, None) == 0.8  # no budget → neutral
    assert s.spend_score(50, 100) == 1.0  # under budget
    assert s.spend_score(100, 100) == 1.0  # at budget
    assert s.spend_score(150, 100) == approx(0.5)  # 1.5x
    assert s.spend_score(200, 100) == 0.0  # 2x → floor
    assert s.spend_score(50, 0) == 0.8  # guarded: zero budget → neutral


# ── renormalization: the part the v3.3 bug lived in ───────────────────────────


def test_health_full_three_blocks():
    inp = s.HealthInputs(
        morning_readiness=8,
        this_week_median_bw=184.0,
        prev_4wk_median_avg_bw=186.0,
        bodyweight_goal=180.0,
        macro_adherence=True,
    )
    r = s.score_health(inp)
    # 0.8*.50 + 1.0*.30 + 1.0*.20 = .40 + .30 + .20 = .90
    assert r.core_composite == approx(0.90)
    assert r.score == approx(0.90)  # no habits
    assert r.dropped == []


def test_health_renormalizes_without_bw_and_nutrition():
    # No bodyweight goal, macros not logged → only readiness survives.
    inp = s.HealthInputs(morning_readiness=8)
    r = s.score_health(inp)
    assert set(r.dropped) == {"bw_trend", "nutrition"}
    # Only block left is readiness → composite == readiness, NOT diluted by a
    # filler constant.
    assert r.core_composite == approx(0.8)
    assert r.score == approx(0.8)


def test_health_renormalizes_without_nutrition_only():
    inp = s.HealthInputs(
        morning_readiness=6,
        this_week_median_bw=184.0,
        prev_4wk_median_avg_bw=186.0,
        bodyweight_goal=180.0,
    )
    r = s.score_health(inp)
    assert r.dropped == ["nutrition"]
    # readiness .60 weight, bw_trend .30 weight → renorm over .80 total
    # (0.6*.50 + 1.0*.30) / .80 = (.30 + .30)/.80 = .75
    assert r.core_composite == approx(0.75)


def test_fitness_renormalizes_without_rpe():
    inp = s.FitnessInputs(training_done=True, deep_work_hours=2, workout_rpe=None)
    r = s.score_fitness(inp)
    assert r.dropped == ["rpe"]
    # training 1.0*.45 + deep_work .5*.35 = .45 + .175 = .625 over .80 → .78125
    assert r.core_composite == approx(0.625 / 0.80)


def test_finance_renormalizes_to_spend_before_first_weekly_log():
    inp = s.FinanceInputs(
        discretionary_spend=50,
        daily_budget=100,
        has_weekly_log_this_week=False,
        prev_allocation_score=None,  # no history
    )
    r = s.score_finance(inp)
    assert r.dropped == ["allocation"]
    # Only spend survives → composite == spend == 1.0
    assert r.core_composite == 1.0


def test_pillar_blends_habits():
    # Fitness with 3 active habits (weight .25) at a 0.5 completion rate.
    inp = s.FitnessInputs(training_done=True, deep_work_hours=4, workout_rpe=8)
    r = s.score_fitness(inp, active_habit_count=3, rate=0.5)
    # core: 1.0*.45 + 1.0*.35 + .8*.20 = .45+.35+.16 = .96
    assert r.core_composite == approx(0.96)
    # blended: .96*(1-.25) + .5*.25 = .72 + .125 = .845
    assert r.score == approx(0.845)
    assert r.habit_weight == approx(0.25)


# ── 6.7 Day Score ─────────────────────────────────────────────────────────────


def _full_pillars():
    health = s.score_health(s.HealthInputs(morning_readiness=8, macro_adherence=True))
    fitness = s.score_fitness(s.FitnessInputs(training_done=True, deep_work_hours=4))
    finance = s.score_finance(
        s.FinanceInputs(discretionary_spend=0, daily_budget=100, has_weekly_log_this_week=True, capital_allocated=500)
    )
    return {"Health": health, "Fitness": fitness, "Finances": finance}


def test_day_score_three_active_pillars():
    pillars = _full_pillars()
    day = s.score_day(pillars, list(s.PILLARS))
    # Health: readiness .8*.50 + nutrition 1.0*.20 over .70 = (.40+.20)/.70 = .857142..
    # Fitness: training 1.0*.45 + deep_work 1.0*.35 over .80 = .80/.80 = 1.0
    # Finance: allocation 1.0*.50 + spend 1.0*.50 = 1.0
    h = (0.4 + 0.2) / 0.7
    composite = h * 0.35 + 1.0 * 0.35 + 1.0 * 0.30
    assert day.composite == approx(composite)
    assert day.day_score == round(composite * 100)
    assert day.unassigned_weight == 0.0


def test_day_score_renormalizes_inactive_pillar():
    pillars = _full_pillars()
    # Finances toggled off → Health+Fitness split 0.35/0.35 → 0.5/0.5
    day = s.score_day(pillars, ["Health", "Fitness"])
    assert set(day.pillar_weights) == {"Health", "Fitness"}
    assert day.pillar_weights["Health"] == approx(0.5)
    assert day.pillar_weights["Fitness"] == approx(0.5)


def test_day_score_unassigned_habits_take_up_to_ten_percent():
    pillars = _full_pillars()
    day = s.score_day(pillars, list(s.PILLARS), unassigned_active_count=3, unassigned_rate=0.0)
    # u_weight = min(3/3,1)*.10 = .10 ; pillars share the remaining .90
    assert day.unassigned_weight == approx(0.10)
    assert sum(day.pillar_weights.values()) == approx(0.90)
    # unassigned rate 0 drags the composite below the no-habit version
    bare = s.score_day(pillars, list(s.PILLARS))
    assert day.composite < bare.composite


def test_day_score_all_empty_is_zero():
    empty = s.PillarScore("Health", None, None, {}, [], 0.0, None)
    day = s.score_day({"Health": empty}, ["Health"])
    assert day.day_score == 0
    assert day.composite == 0.0


# ── whole-bundle convenience ──────────────────────────────────────────────────


def test_score_day_bundle_matches_individual():
    inp = s.DayInputs(
        health=s.HealthInputs(morning_readiness=8, macro_adherence=True),
        fitness=s.FitnessInputs(training_done=True, deep_work_hours=4),
        finance=s.FinanceInputs(
            discretionary_spend=0, daily_budget=100, has_weekly_log_this_week=True, capital_allocated=500
        ),
    )
    res = s.score_day_bundle(inp)
    assert 0 <= res.day.day_score <= 100
    # decomposition preserved for the deviation layer / synthesis
    assert res.pillars["Fitness"].blocks["deep_work"] == 1.0
    assert res.pillars["Health"].dropped == ["bw_trend"]
    assert not math.isnan(res.day.composite)
