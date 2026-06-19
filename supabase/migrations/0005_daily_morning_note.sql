-- ============================================================================
-- 0005 — daily_logs.morning_note (optional free-text morning journal)
-- Mirrors backend/alembic/versions/0005_daily_morning_note.py.
--
-- The Morning Log wizard's final "Anything else?" step writes an optional
-- free-text note onto the day row — the morning mirror of the evening
-- daily_reflection. Nullable (strictly optional) with the same 1000-char cap.
-- Feeds no score; journal field only. RLS already covers daily_logs via the
-- own_data policy from 0001 — unchanged here.
-- ============================================================================

alter table public.daily_logs
    add column morning_note text check (morning_note is null
                                        or char_length(morning_note) <= 1000);
