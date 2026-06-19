-- ============================================================================
-- 0008 — new-user provisioning trigger (Supabase-only; NO Alembic mirror)
--
-- When Supabase Auth inserts a row into auth.users on signup, automatically
-- provision the matching public.users profile. Without this a brand-new account
-- authenticates but every API call 401s "Unknown user" — backend auth.py does
-- db.get(User, sub) and finds no profile row (the first-login onboarding blocker).
--
-- This migration deliberately has NO Alembic counterpart: it depends on the
-- `auth` schema, which exists only on Supabase. The SQLite/dev mirror has no
-- auth.users, so dev provisions its single user via _get_or_create_dev_user().
--
-- public.users required columns (NOT NULL, no default), per 0001 + 0007:
--     id (uuid) · email (text) · consent_timestamp (timestamptz)
-- All other columns are nullable or defaulted — currency 'CAD', unit_pref 'lbs',
-- active_pillars, created_at, name, daily_budget, bodyweight_goal, and the
-- nullable weekly_workout_target / weekly_rest_target (0007) — so the trigger
-- sets only the three required fields (+ name when the signup metadata carries
-- one). The schema has no timezone / onboarding-flag columns, so none are added.
-- ============================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    -- SECURITY DEFINER → the body runs as the function owner (postgres), so the
    -- insert succeeds even though the caller is supabase_auth_admin (GoTrue).
    -- Empty search_path + fully schema-qualified names block search_path hijacking.
    insert into public.users (id, email, name, consent_timestamp)
    values (
        new.id,
        -- email is NOT NULL in public.users; coalesce guards phone-only signups
        -- (auth.users.email can be null) so the trigger never aborts the auth
        -- insert and blocks signup.
        coalesce(new.email, new.id::text || '@no-email.vivid'),
        -- Optional display name from the signup metadata, clamped to the
        -- char_length(name) <= 80 check. Null when no metadata name is present.
        left(coalesce(new.raw_user_meta_data ->> 'name',
                      new.raw_user_meta_data ->> 'full_name'), 80),
        -- Consent captured at signup time (§3.5 PIPEDA).
        now()
    )
    on conflict (id) do nothing;  -- idempotent: never block a retry / re-signup
    return new;
end;
$$;

-- Recreate the trigger idempotently so the migration is safe to re-run.
drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
    after insert on auth.users
    for each row
    execute function public.handle_new_user();

-- Permissions. A trigger function is invoked by the system rather than called
-- directly, but grant EXECUTE explicitly to the roles in the Supabase Auth
-- lifecycle so it fires flawlessly regardless of who performs the auth.users
-- insert. supabase_auth_admin is the role GoTrue actually uses on signup;
-- postgres + service_role cover migrations and server-side admin paths.
grant execute on function public.handle_new_user()
    to postgres, service_role, supabase_auth_admin;
