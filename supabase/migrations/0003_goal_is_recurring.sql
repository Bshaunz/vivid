-- ============================================================================
-- 0003 — goals.is_recurring (one-off "this period" vs recurring "every period")
-- Mirrors backend/alembic/versions/0003_goal_is_recurring.py.
--
-- Additive boolean flag on goals: false = a one-off target for the current
-- period ("this week/month"), true = a target that re-evaluates every period
-- ("every week/month"). Goals stay DISPLAY-ONLY (CLAUDE.md §6.7) — this flag
-- feeds no score. The `false` default backfills any pre-existing rows; the API
-- always supplies a value on insert. RLS already covers goals via the own_data
-- policy from 0001 — unchanged here.
-- ============================================================================

alter table public.goals
    add column is_recurring boolean not null default false;
