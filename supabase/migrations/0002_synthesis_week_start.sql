-- ============================================================================
-- 0002 — ai_syntheses.week_start (per-ISO-week synthesis idempotency)
-- Mirrors backend/alembic/versions/0002_synthesis_week_start.py.
--
-- Adds the ISO-Monday week_start column and the (user_id, type, week_start)
-- unique constraint that makes weekly synthesis idempotent (CLAUDE.md §6
-- step 10). The isodow=1 CHECK matches the weekly_logs convention: Postgres
-- enforces the ISO-Monday invariant at the DB layer; the API schema validator
-- enforces it on the SQLite dev side.
--
-- The '1970-01-05' default (a Monday) is backfill-only for any pre-existing
-- rows; the API always supplies a real week_start on insert. RLS already
-- covers ai_syntheses via the own_data policy from 0001 — unchanged here.
-- ============================================================================

alter table public.ai_syntheses
    add column week_start date not null default '1970-01-05'
        check (extract(isodow from week_start) = 1);

alter table public.ai_syntheses
    add constraint uq_synthesis_user_type_week
        unique (user_id, type, week_start);
