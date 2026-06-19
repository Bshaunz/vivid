-- ============================================================================
-- 0007 — token-contract fields
-- Mirrors backend/alembic/versions/0007_token_contract.py.
--
-- * daily_logs.workout_status — explicit "trained"/"rest"/"skipped" so the
--   §6.5 rest-vs-skip distinction is logged, not just derived. Nullable; null
--   falls back to the frequency_days derivation. training_done stays canonical.
-- * users.weekly_workout_target / weekly_rest_target — the weekly token quota
--   (0–7). Null = unset → the client uses its 4/3 default.
-- RLS already covers both tables via the own_data policies from 0001.
-- ============================================================================

create type workout_status as enum ('trained', 'rest', 'skipped');

alter table public.daily_logs
    add column workout_status workout_status;

alter table public.users
    add column weekly_workout_target smallint check (weekly_workout_target is null
                                                     or weekly_workout_target between 0 and 7),
    add column weekly_rest_target    smallint check (weekly_rest_target is null
                                                     or weekly_rest_target between 0 and 7);
