-- ============================================================================
-- 0006 — habit_completions.quantity (per-session numeric volume)
-- Mirrors backend/alembic/versions/0006_completion_quantity.py.
--
-- The Evening Log wizard logs an optional per-session quantity for numeric
-- habits (e.g. miles, pages) alongside the done/not-done completion. Nullable
-- (binary habits / unsupplied → null) with a >= 0 check. Display-only metadata;
-- scoring still counts logged sessions (CLAUDE.md §6.7). RLS already covers
-- habit_completions via the own_data policy from 0001 — unchanged here.
-- ============================================================================

alter table public.habit_completions
    add column quantity numeric(10,2) check (quantity is null or quantity >= 0);
