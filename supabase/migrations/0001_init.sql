-- ============================================================================
-- VIVID — Initial Schema (Supabase Postgres)
-- Migration: 0001_init
-- 9 tables per CLAUDE.md. RLS enabled on every table before any signup.
-- Strict schema adherence: no metrics beyond the documented log fields.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Enums — constrain categorical values at the database layer so the data
-- the AI synthesis reads is guaranteed clean.
-- ----------------------------------------------------------------------------
create type pillar_type        as enum ('Health', 'Fitness', 'Finances');
create type frequency_type     as enum ('daily', 'weekly', 'monthly');
create type goal_type          as enum ('metric', 'habit');
create type metric_direction   as enum ('above', 'below');
create type synthesis_type     as enum ('weekly', 'daily', 'ondemand');
create type custom_metric_type as enum ('number', 'scale', 'boolean');
create type update_freq_type   as enum ('daily', 'weekly');
create type currency_code      as enum ('CAD', 'USD');
create type unit_preference    as enum ('lbs', 'kg');

-- ----------------------------------------------------------------------------
-- 1. users — profile + preferences. PK mirrors Supabase auth.users.
-- ----------------------------------------------------------------------------
create table public.users (
    id                  uuid primary key references auth.users (id) on delete cascade,
    email               text not null,
    name                text,
    currency            currency_code   not null default 'CAD',
    unit_pref           unit_preference not null default 'lbs',
    active_pillars      jsonb not null default '["Health","Fitness","Finances"]'::jsonb,
    daily_budget        numeric(10,2) check (daily_budget is null or daily_budget >= 0),
    notification_prefs  jsonb not null default '{}'::jsonb,
    consent_accepted_at timestamptz not null,  -- PIPEDA: signup consent timestamp
    created_at          timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 2. daily_logs — one row per user per day. Morning and Evening write to the
--    same row; morning_done / evening_done gate completeness. Check
--    constraints guarantee that a "done" log has every required field, while
--    still allowing the morning row to exist before the evening log.
-- ----------------------------------------------------------------------------
create table public.daily_logs (
    id                   bigint generated always as identity primary key,
    user_id              uuid not null references public.users (id) on delete cascade,
    date                 date not null,

    -- Morning Log — Input State (~45 sec)
    bodyweight           numeric(6,2) check (bodyweight is null or bodyweight > 0),
    sleep_hours          smallint check (sleep_hours between 0 and 24),
    sleep_minutes        smallint check (sleep_minutes between 0 and 59),
    morning_readiness    smallint check (morning_readiness between 1 and 10),
    rhr                  smallint check (rhr is null or rhr between 20 and 250),
    hrv                  smallint check (hrv is null or hrv between 0 and 300),
    caffeine_delay       boolean,
    morning_done         boolean not null default false,

    -- Evening Log — Output State (~90 sec)
    deep_work_hours      numeric(4,2) check (deep_work_hours is null or deep_work_hours between 0 and 24),
    training_done        boolean,
    macro_adherence      boolean,
    caloric_variance_pct numeric(6,2),
    discretionary_spend  numeric(10,2) check (discretionary_spend is null or discretionary_spend >= 0),
    daily_reflection     text,
    workout_rpe          smallint check (workout_rpe is null or workout_rpe between 1 and 10),
    screen_time_hours    numeric(4,2) check (screen_time_hours is null or screen_time_hours between 0 and 24),
    evening_done         boolean not null default false,

    -- Derived, not a new metric: lets the AI layer correlate sleep duration
    -- against any evening field without re-deriving hours*60+minutes.
    sleep_total_minutes  smallint generated always as (sleep_hours * 60 + sleep_minutes) stored,

    unique (user_id, date),

    -- Required-field integrity once a log half is marked done
    constraint morning_complete check (
        not morning_done or (
            bodyweight is not null
            and sleep_hours is not null
            and sleep_minutes is not null
            and morning_readiness is not null
        )
    ),
    constraint evening_complete check (
        not evening_done or (
            deep_work_hours is not null
            and training_done is not null
            and macro_adherence is not null
            and discretionary_spend is not null
        )
    )
);

create index idx_daily_logs_user_date on public.daily_logs (user_id, date desc);

-- ----------------------------------------------------------------------------
-- 3. habits
-- ----------------------------------------------------------------------------
create table public.habits (
    id              bigint generated always as identity primary key,
    user_id         uuid not null references public.users (id) on delete cascade,
    name            text not null,
    description     text,
    pillar          pillar_type,                      -- null = unassigned → feeds Day Score directly
    frequency_type  frequency_type not null default 'daily',
    frequency_count int not null default 1 check (frequency_count >= 1),
    frequency_days  jsonb check (frequency_days is null or jsonb_typeof(frequency_days) = 'array'),  -- [0–6]
    is_preset       boolean not null default false,
    is_active       boolean not null default true,
    created_at      timestamptz not null default now()
);

create index idx_habits_user_active on public.habits (user_id) where is_active;

-- ----------------------------------------------------------------------------
-- 4. habit_completions — one row per habit per day, idempotent upsert target.
-- ----------------------------------------------------------------------------
create table public.habit_completions (
    id        bigint generated always as identity primary key,
    user_id   uuid not null references public.users (id) on delete cascade,
    habit_id  bigint not null references public.habits (id) on delete cascade,
    date      date not null,
    completed boolean not null default true,
    unique (habit_id, date)
);

create index idx_habit_completions_user_date on public.habit_completions (user_id, date desc);

-- ----------------------------------------------------------------------------
-- 5. weekly_logs — Sunday trajectory review. week_start is the ISO Monday of
--    the week under review, enforced so rollup joins are always aligned.
-- ----------------------------------------------------------------------------
create table public.weekly_logs (
    id                      bigint generated always as identity primary key,
    user_id                 uuid not null references public.users (id) on delete cascade,
    week_start              date not null check (extract(isodow from week_start) = 1),
    avg_bodyweight_7d       numeric(6,2),   -- auto-calculated from 7 morning logs
    bodyweight_goal         numeric(6,2),
    total_training_sessions smallint,       -- auto-calculated
    capital_allocated       numeric(12,2) check (capital_allocated is null or capital_allocated >= 0),
    bottleneck_audit        text,
    posts_published         int,
    followers               int,
    waitlist_signups        int,
    unique (user_id, week_start)
);

create index idx_weekly_logs_user_week on public.weekly_logs (user_id, week_start desc);

-- ----------------------------------------------------------------------------
-- 6. goals — metric goals and habit goals in one table, integrity enforced
--    per type so a goal row can never be ambiguous.
-- ----------------------------------------------------------------------------
create table public.goals (
    id                   bigint generated always as identity primary key,
    user_id              uuid not null references public.users (id) on delete cascade,
    name                 text not null,
    type                 goal_type not null,

    -- metric goals
    metric_key           text,
    metric_target_value  numeric,
    metric_current_value numeric,
    metric_direction     metric_direction,

    -- habit goals
    habit_id             bigint references public.habits (id) on delete set null,
    habit_target_days    int check (habit_target_days is null or habit_target_days > 0),
    habit_completed_days int,
    habit_target_rate    numeric(5,2) check (habit_target_rate is null or habit_target_rate between 0 and 100),

    pillar               pillar_type,      -- null = tracked + displayed, not scored
    target_date          date not null,
    is_active            boolean not null default true,
    completed            boolean not null default false,
    created_at           timestamptz not null default now(),

    constraint goal_shape check (
        (type = 'metric'
            and metric_key is not null
            and metric_target_value is not null
            and metric_direction is not null)
        or
        (type = 'habit'
            and habit_id is not null
            and (habit_target_days is not null or habit_target_rate is not null))
    )
);

create index idx_goals_user_active on public.goals (user_id) where is_active;

-- ----------------------------------------------------------------------------
-- 7. ai_syntheses
-- ----------------------------------------------------------------------------
create table public.ai_syntheses (
    id           bigint generated always as identity primary key,
    user_id      uuid not null references public.users (id) on delete cascade,
    generated_at timestamptz not null default now(),
    type         synthesis_type not null,
    content      text not null
);

-- Supports the 3/day server-side on-demand cap and the history feed
create index idx_ai_syntheses_user_type_time on public.ai_syntheses (user_id, type, generated_at desc);

-- ----------------------------------------------------------------------------
-- 8. custom_metrics
-- ----------------------------------------------------------------------------
create table public.custom_metrics (
    id               bigint generated always as identity primary key,
    user_id          uuid not null references public.users (id) on delete cascade,
    name             text not null,
    unit             text,
    type             custom_metric_type not null,
    update_frequency update_freq_type not null default 'daily',
    created_at       timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 9. custom_metric_entries
-- ----------------------------------------------------------------------------
create table public.custom_metric_entries (
    id        bigint generated always as identity primary key,
    user_id   uuid not null references public.users (id) on delete cascade,
    metric_id bigint not null references public.custom_metrics (id) on delete cascade,
    date      date not null,
    value     numeric not null,
    unique (metric_id, date)
);

create index idx_custom_metric_entries_user_date on public.custom_metric_entries (user_id, date desc);

-- ============================================================================
-- Row Level Security — enabled on all 9 tables BEFORE any user signs up.
-- Identical own-data policy everywhere (users keys on id, not user_id).
-- ============================================================================
alter table public.users                 enable row level security;
alter table public.daily_logs            enable row level security;
alter table public.habits                enable row level security;
alter table public.habit_completions     enable row level security;
alter table public.weekly_logs           enable row level security;
alter table public.goals                 enable row level security;
alter table public.ai_syntheses          enable row level security;
alter table public.custom_metrics        enable row level security;
alter table public.custom_metric_entries enable row level security;

create policy "own_data" on public.users
    for all using (auth.uid() = id) with check (auth.uid() = id);

create policy "own_data" on public.daily_logs
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own_data" on public.habits
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own_data" on public.habit_completions
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own_data" on public.weekly_logs
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own_data" on public.goals
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own_data" on public.ai_syntheses
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own_data" on public.custom_metrics
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own_data" on public.custom_metric_entries
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================================
-- Rollup views — daily granular logs → weekly aggregation.
-- security_invoker so RLS on the base tables applies through the view.
-- ============================================================================

-- Prefills the Sunday review: the two auto-calculated weekly_logs fields,
-- computed from the exact morning logs of the week being reviewed.
create view public.v_weekly_rollup
with (security_invoker = true) as
select
    user_id,
    (date_trunc('week', date))::date            as week_start,
    round(avg(bodyweight), 2)                   as avg_bodyweight_7d,
    count(*) filter (where training_done)::smallint as total_training_sessions,
    count(*) filter (where morning_done)        as morning_logs_completed,
    count(*) filter (where evening_done)        as evening_logs_completed
from public.daily_logs
group by user_id, (date_trunc('week', date))::date;

-- Flat day-grain view for AI synthesis input: every documented daily field
-- plus same-day habit completion ratio. One row per user-day means the LLM
-- can correlate any two columns (e.g. sleep_total_minutes vs
-- discretionary_spend) with a single scan. No new metrics introduced.
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
        count(*)                                   as due_count,
        count(*) filter (where c.completed)        as completed_count
    from public.habit_completions c
    where c.user_id = d.user_id and c.date = d.date
) hc on true;
