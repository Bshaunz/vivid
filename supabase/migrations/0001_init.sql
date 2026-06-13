-- ============================================================================
-- VIVID — Initial Schema (Supabase Postgres)
-- Migration: 0001_init  |  Spec: CLAUDE.md v4.0 (§5)
-- Tables: users, daily_logs, bodyweight_entries, habits, habit_completions,
--         weekly_logs, goals, baselines, ai_syntheses
-- RLS enabled on every table before any signup (§3.1).
-- Closed metric whitelist (§4): no screen_time, no caffeine_delay,
-- no custom metrics. Goals are display-only and feed no score (§6.7).
-- ============================================================================

create type pillar_type     as enum ('Health', 'Fitness', 'Finances');
create type frequency_type  as enum ('daily', 'weekly', 'monthly');
create type goal_type       as enum ('metric', 'habit');
create type goal_direction  as enum ('above', 'below');
create type synthesis_type  as enum ('weekly');  -- post-launch types added by migration
create type currency_code   as enum ('CAD', 'USD');
create type unit_preference as enum ('lbs', 'kg');

-- ----------------------------------------------------------------------------
-- 1. users — profile + preferences. PK mirrors Supabase auth.users.
--    bodyweight_goal lives here (v4: it is a profile setting, not a weekly
--    log field). consent_timestamp satisfies PIPEDA signup consent (§3.5).
-- ----------------------------------------------------------------------------
create table public.users (
    id                uuid primary key references auth.users (id) on delete cascade,
    email             text not null,
    name              text check (name is null or char_length(name) <= 80),
    currency          currency_code   not null default 'CAD',
    unit_pref         unit_preference not null default 'lbs',
    active_pillars    jsonb not null default '["Health","Fitness","Finances"]'::jsonb,
    daily_budget      numeric(10,2) check (daily_budget is null or daily_budget >= 0),
    bodyweight_goal   numeric(6,2)  check (bodyweight_goal is null or bodyweight_goal between 30 and 660),
    consent_timestamp timestamptz not null,
    created_at        timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 2. daily_logs — one row per user per day; AM and PM forms write to the same
--    row. Fields are nullable at rest, but completeness constraints guarantee
--    a "done" half-log carries every required metric, so the score engine and
--    the synthesis never read a half-empty "complete" day.
--    Bodyweight is NOT here (v4) — see bodyweight_entries.
-- ----------------------------------------------------------------------------
create table public.daily_logs (
    id                   bigint generated always as identity primary key,
    user_id              uuid not null references public.users (id) on delete cascade,
    date                 date not null,

    -- Morning (AM)
    morning_readiness    smallint check (morning_readiness between 1 and 10),
    sleep_hours          numeric(4,2) check (sleep_hours between 0 and 16),
    rhr                  smallint check (rhr is null or rhr between 20 and 250),
    hrv                  smallint check (hrv is null or hrv between 0 and 300),
    morning_done         boolean not null default false,

    -- Evening (PM)
    training_done        boolean,
    workout_rpe          smallint check (workout_rpe is null or workout_rpe between 1 and 10),
    deep_work_hours      numeric(4,2) check (deep_work_hours between 0 and 24),
    macro_adherence      boolean,
    caloric_variance_pct numeric(6,2) check (caloric_variance_pct is null
                                             or caloric_variance_pct between -100 and 1000),
    discretionary_spend  numeric(12,2) check (discretionary_spend >= 0
                                              and discretionary_spend < 1e9),
    daily_reflection     text check (daily_reflection is null
                                     or char_length(daily_reflection) <= 1000),
    evening_done         boolean not null default false,

    unique (user_id, date),

    constraint morning_complete check (
        not morning_done or (morning_readiness is not null and sleep_hours is not null)
    ),
    constraint evening_complete check (
        not evening_done or (training_done is not null
                             and deep_work_hours is not null
                             and discretionary_spend is not null)
    )
);

create index idx_daily_logs_user_date on public.daily_logs (user_id, date desc);

-- ----------------------------------------------------------------------------
-- 3. bodyweight_entries — any day, any time, many per day. Raw values are
--    never scored and never charted by default: scoring and trends consume
--    only the weekly ISO median (v_weekly_bodyweight below). Range covers
--    both units (30–300 kg / 66–660 lbs); per-unit precision is enforced at
--    the API layer where unit_pref is known.
-- ----------------------------------------------------------------------------
create table public.bodyweight_entries (
    id        bigint generated always as identity primary key,
    user_id   uuid not null references public.users (id) on delete cascade,
    logged_at timestamptz not null default now(),
    value     numeric(6,2) not null check (value between 30 and 660)
);

create index idx_bodyweight_user_time on public.bodyweight_entries (user_id, logged_at desc);

-- ----------------------------------------------------------------------------
-- 4. habits
-- ----------------------------------------------------------------------------
create table public.habits (
    id              bigint generated always as identity primary key,
    user_id         uuid not null references public.users (id) on delete cascade,
    name            text not null check (char_length(name) <= 80),
    description     text check (description is null or char_length(description) <= 1000),
    pillar          pillar_type,  -- null = unassigned → Day Score u_weight block (§6.7)
    frequency_type  frequency_type not null default 'daily',
    frequency_count int not null default 1 check (frequency_count >= 1),
    frequency_days  jsonb check (frequency_days is null
                                 or jsonb_typeof(frequency_days) = 'array'),  -- ISO weekdays 1–7
    is_preset       boolean not null default false,
    is_active       boolean not null default true,
    created_at      timestamptz not null default now()
);

create index idx_habits_user_active on public.habits (user_id) where is_active;

-- ----------------------------------------------------------------------------
-- 5. habit_completions
-- ----------------------------------------------------------------------------
create table public.habit_completions (
    id        bigint generated always as identity primary key,
    user_id   uuid not null references public.users (id) on delete cascade,
    habit_id  bigint not null references public.habits (id) on delete cascade,
    date      date not null,
    completed boolean not null default true,
    unique (user_id, habit_id, date)
);

create index idx_habit_completions_user_date on public.habit_completions (user_id, date desc);

-- ----------------------------------------------------------------------------
-- 6. weekly_logs — Sunday review. week_start is the ISO Monday of the week
--    under review, enforced so rollup joins are always aligned.
--    weekly_median_bodyweight is DERIVED (view below), never logged here.
-- ----------------------------------------------------------------------------
create table public.weekly_logs (
    id                bigint generated always as identity primary key,
    user_id           uuid not null references public.users (id) on delete cascade,
    week_start        date not null check (extract(isodow from week_start) = 1),
    capital_allocated numeric(12,2) not null check (capital_allocated >= 0
                                                    and capital_allocated < 1e9),
    bottleneck_audit  text check (bottleneck_audit is null
                                  or char_length(bottleneck_audit) <= 1000),
    unique (user_id, week_start)
);

create index idx_weekly_logs_user_week on public.weekly_logs (user_id, week_start desc);

-- ----------------------------------------------------------------------------
-- 7. goals — DISPLAY-ONLY in MVP (§6.7): progress is shown, never scored.
--    pillar is a display badge only. Habit goals cascade with their habit
--    because goal_shape requires habit_id on type='habit'.
-- ----------------------------------------------------------------------------
create table public.goals (
    id           bigint generated always as identity primary key,
    user_id      uuid not null references public.users (id) on delete cascade,
    name         text not null check (char_length(name) <= 80),
    type         goal_type not null,
    metric_key   text,
    target_value numeric,
    direction    goal_direction,
    habit_id     bigint references public.habits (id) on delete cascade,
    target_date  date not null,
    pillar       pillar_type,
    is_active    boolean not null default true,
    completed    boolean not null default false,
    created_at   timestamptz not null default now(),

    constraint goal_shape check (
        (type = 'metric' and metric_key is not null
                         and target_value is not null
                         and direction is not null)
        or
        (type = 'habit' and habit_id is not null)
    )
);

create index idx_goals_user_active on public.goals (user_id) where is_active;

-- ----------------------------------------------------------------------------
-- 8. baselines — 30-day personal norms powering the deviation layer (§6.8).
--    One row per (user, metric); recomputed nightly and on backfill.
--    Rows exist only when n_observations >= 7.
-- ----------------------------------------------------------------------------
create table public.baselines (
    id             bigint generated always as identity primary key,
    user_id        uuid not null references public.users (id) on delete cascade,
    metric_key     text not null check (metric_key in (
                       'morning_readiness', 'sleep_hours', 'rhr', 'hrv',
                       'deep_work_hours', 'discretionary_spend',
                       'weekly_median_bodyweight')),
    window_days    int not null default 30,
    mean           double precision not null,
    sd             double precision not null check (sd >= 0),
    n_observations int not null check (n_observations >= 7),
    computed_at    timestamptz not null default now(),
    unique (user_id, metric_key)
);

-- ----------------------------------------------------------------------------
-- 9. ai_syntheses — token counts stored for the budget controls (§3.4).
--    Idempotency (one per user per ISO week) is enforced at the API layer
--    keyed on generated_at's ISO week, with explicit regeneration allowed.
-- ----------------------------------------------------------------------------
create table public.ai_syntheses (
    id           bigint generated always as identity primary key,
    user_id      uuid not null references public.users (id) on delete cascade,
    generated_at timestamptz not null default now(),
    type         synthesis_type not null default 'weekly',
    content      text not null,
    tokens_in    int not null check (tokens_in >= 0),
    tokens_out   int not null check (tokens_out >= 0),
    model        text not null
);

create index idx_ai_syntheses_user_time on public.ai_syntheses (user_id, generated_at desc);

-- ============================================================================
-- Row Level Security — all 9 tables, identical own-data policy (§3.1).
-- ============================================================================
alter table public.users              enable row level security;
alter table public.daily_logs         enable row level security;
alter table public.bodyweight_entries enable row level security;
alter table public.habits             enable row level security;
alter table public.habit_completions  enable row level security;
alter table public.weekly_logs        enable row level security;
alter table public.goals              enable row level security;
alter table public.baselines          enable row level security;
alter table public.ai_syntheses       enable row level security;

create policy "own_data" on public.users
    for all using (auth.uid() = id) with check (auth.uid() = id);
create policy "own_data" on public.daily_logs
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own_data" on public.bodyweight_entries
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own_data" on public.habits
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own_data" on public.habit_completions
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own_data" on public.weekly_logs
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own_data" on public.goals
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own_data" on public.baselines
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own_data" on public.ai_syntheses
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================================
-- Derived views — security_invoker so base-table RLS applies through them.
-- ============================================================================

-- The canonical bodyweight series (§4 bodyweight rule). Scoring, trends and
-- the chart consume THIS, never raw entries. low_confidence = 1–2 samples.
create view public.v_weekly_bodyweight
with (security_invoker = true) as
select
    user_id,
    (date_trunc('week', logged_at at time zone 'utc'))::date as week_start,
    percentile_cont(0.5) within group (order by value)       as weekly_median_bodyweight,
    count(*)::int                                            as n_samples,
    (count(*) < 3)                                           as low_confidence
from public.bodyweight_entries
group by user_id, (date_trunc('week', logged_at at time zone 'utc'))::date;

-- Flat day-grain view for the synthesis assembler and the deviation layer:
-- every whitelisted daily field plus same-day habit completion ratio. One row
-- per user-day lets the LLM input pair any two columns (e.g. sleep_hours vs
-- discretionary_spend) without joins at prompt-build time.
create view public.v_daily_analysis
with (security_invoker = true) as
select
    d.*,
    hc.due_count,
    hc.completed_count,
    case when hc.due_count > 0
         then round(hc.completed_count::numeric / hc.due_count, 3)
    end as habit_completion_ratio
from public.daily_logs d
left join lateral (
    select
        count(*)                            as due_count,
        count(*) filter (where c.completed) as completed_count
    from public.habit_completions c
    where c.user_id = d.user_id and c.date = d.date
) hc on true;
