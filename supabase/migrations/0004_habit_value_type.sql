-- ============================================================================
-- 0004 — habits.value_type / unit_label / target_per_session (numeric tracking)
-- Mirrors backend/alembic/versions/0004_habit_value_type.py.
--
-- Habits gain a tracking shape: "binary" (done/not-done, the default) or
-- "numeric" (logs a per-session quantity described by unit_label +
-- target_per_session). value_type is NOT NULL with a 'binary' default so
-- pre-existing rows backfill cleanly; the API always supplies a value on insert.
-- unit_label / target_per_session are nullable — set only for numeric habits.
-- Completions stay done/not-done; this metadata is display-only (CLAUDE.md §6.7).
-- RLS already covers habits via the own_data policy from 0001 — unchanged here.
-- ============================================================================

create type habit_value_type as enum ('binary', 'numeric');

alter table public.habits
    add column value_type habit_value_type not null default 'binary',
    add column unit_label text check (unit_label is null or char_length(unit_label) <= 40),
    add column target_per_session numeric(10,2) check (target_per_session is null
                                                       or target_per_session > 0);
