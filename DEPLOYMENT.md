# VIVID — Production Deployment Runbook

Local desktop dev → live, mobile-testable cloud. **Architecture (as chosen):**

| Tier      | Platform | Source of truth                                              |
| --------- | -------- | ----------------------------------------------------------- |
| Database  | **Supabase Postgres** | `supabase/migrations/*.sql` (RLS + `auth.users` FK + views) |
| Auth      | **Supabase Auth** (JWT, HS256) | verified in `backend/app/auth.py` (`aud="authenticated"`) |
| Backend   | **Render** (FastAPI) | `render.yaml` / `backend/Dockerfile`            |
| Frontend  | **Vercel** (Vite/React SPA + PWA) | `vercel.json` / `.env.production`        |

> **Migrations: use the Supabase SQL migrations, NOT `alembic upgrade head`.**
> Alembic (`backend/alembic/`) is the portable SQLite/dev mirror and carries **no
> RLS, no `auth.users` linkage, and no views**. Against Supabase it would create an
> insecure, non-integrated schema. The RLS-bearing schema lives only in
> `supabase/migrations/0001…0007`. Alembic stays your local-dev tool.

---

## Repo changes already made (committed with this runbook)

- `render.yaml` — Render Blueprint for the backend; secrets declared `sync: false`.
- `backend/Dockerfile` + `backend/.dockerignore` — portable container alternative; keeps `.env`/secrets out of the image.
- `vercel.json` — Vite framework + **SPA rewrite** (required so `BrowserRouter` deep links don't 404 on refresh).
- `.env.production` + `.gitignore` exception — public `VITE_API_URL` baked into the client bundle (no secrets).
- `index.html` — iOS `apple-mobile-web-app-*` meta so "Add to Home Screen" runs full-bleed standalone (Android is covered by the manifest's `display: standalone`).
- `backend/requirements.txt` — added **`psycopg[binary]`** (no Postgres driver existed; dev was SQLite-only).

Already correct, no change needed: env-driven CORS allow-list (no wildcard in prod, `backend/app/main.py`), the `VITE_API_URL` localhost→prod switch (`src/lib/http.ts`), and zero hardcoded secrets (`backend/app/config.py`).

---

## Step 1 — Database & migrations (Supabase)

**1a. Apply the schema (fresh prod project, 0001→0007 in order).** Either:

- **Supabase CLI (repeatable):**
  ```bash
  supabase login
  supabase link --project-ref <your-project-ref>
  supabase db push          # applies supabase/migrations/*.sql in order
  ```
  (If `supabase/config.toml` is missing, run `supabase init` first — keep the generated config, don't overwrite the migrations.)

- **Or SQL Editor (no CLI):** open each file `supabase/migrations/0001_init.sql` … `0008_user_provisioning.sql` **in numeric order** and run them. `0001` creates all 9 tables, enables RLS, and adds the `own_data` policies; `0005` adds `daily_logs.morning_note`; `0007` adds the weekly token-contract fields; `0008` adds the new-user provisioning trigger (see the multi-tenant note below).

Migrations are additive (new tables/columns) and run **before** the backend ships, so the API never reads a missing column — zero-downtime by ordering.

**1b. Verify RLS is on (run in the SQL Editor):**
```sql
-- every public table should show rowsecurity = true
select tablename, rowsecurity from pg_tables where schemaname = 'public' order by tablename;

-- each should have an "own_data" policy
select tablename, policyname, cmd, qual
from pg_policies where schemaname = 'public' order by tablename;
```
Expect `rowsecurity = true` on all 9 tables and one `own_data` policy each (`auth.uid() = user_id`, and `= id` on `users`).

> **⚠️ RLS + the backend connection role (read this).** The FastAPI backend opens a
> *direct* Postgres connection as the Supabase **`postgres`** role, which **bypasses
> RLS** — and that is correct: the backend is the trusted tier and already scopes
> every query by `user_id` via `get_current_user`. RLS is the defense-in-depth layer
> for any *direct client* (supabase-js / PostgREST) access. **Do not** point
> `DATABASE_URL` at a restricted role: `auth.uid()` is only populated in the
> PostgREST request context, so a raw SQLAlchemy connection under RLS would see
> `auth.uid() = NULL` and **every query would return zero rows.**

---

## Step 2 — Backend on Render

1. **New → Blueprint** → select this repo → Render reads `render.yaml` and creates `vivid-api`.
2. Set the `sync: false` env vars in the dashboard:
   - `DATABASE_URL` — Supabase connection string, **using the psycopg scheme**:
     `postgresql+psycopg://postgres:<DB_PASSWORD>@db.<ref>.supabase.co:5432/postgres`
     (or the Supavisor **session pooler** host on `:6543` — preferred under many connections).
   - `SUPABASE_JWT_SECRET` — Supabase → **Project Settings → API → JWT Settings → JWT Secret** (the legacy **HS256** secret; see caveat below).
   - `FRONTEND_ORIGIN` — your exact Vercel origin, e.g. `https://vivid.vercel.app` (comma-separate to add preview domains; **no trailing slash**). You'll finalize this in Step 4 once the Vercel domain exists.
   - `ANTHROPIC_API_KEY`, `SYNTHESIS_PROMPT_PATH` — optional (only the weekly-synthesis feature needs them).
   - `DEV_MODE=false` is already set by the blueprint. **Keep it false:** `DEV_MODE=true` on Render trips a hard 503 interlock (`auth.py`), since Render injects a `RENDER` env var.
3. Deploy. Health check: `GET https://<your-render-url>/healthz` → `{"status":"ok"}`.

> **JWT caveat:** `auth.py` verifies **HS256** with the shared secret. If your Supabase
> project has migrated to the new **asymmetric JWT signing keys** (ES256/RS256),
> HS256 verification will reject tokens — keep the legacy HS256 JWT Secret active, or
> update `auth.py` to fetch the project JWKS. Verify a real login token decodes before
> calling it done.

---

## Step 3 — Frontend on Vercel

1. **New Project** → import this repo. Vercel auto-detects Vite; `vercel.json` pins the build + SPA rewrite.
2. Set `VITE_API_URL` to your Render backend URL (e.g. `https://vivid-api.onrender.com`) — either edit the committed `.env.production` **or** set it as a Vercel Environment Variable (a real env var wins at build time). **No trailing slash.**
3. Deploy. The build emits the PWA manifest + service worker; on mobile, **Share → Add to Home Screen** installs it standalone.

> PWA icons: the manifest `icons: []` and the `apple-touch-icon` link are placeholders.
> Drop `public/apple-touch-icon.png` (180×180) and add 192/512 icons to the manifest
> in `vite.config.ts` before beta for a proper home-screen icon (without them iOS uses
> a screenshot — functional, not pretty).

---

## Step 4 — Push & deploy order (exact sequence)

There's a URL chicken-and-egg (each side needs the other's domain), so wire in two passes:

1. **Apply Supabase migrations + verify RLS** (Step 1) — do this first, while the DB is empty.
2. **Commit & push** the config added here:
   ```bash
   git checkout -b deploy/cloud-setup
   git add render.yaml backend/Dockerfile backend/.dockerignore vercel.json \
           .env.production .gitignore index.html backend/requirements.txt DEPLOYMENT.md
   git commit -m "chore: production deployment config (Render + Vercel + Supabase)"
   git push -u origin deploy/cloud-setup   # open a PR, or push to main if that's your deploy branch
   ```
3. **Create the Render service** (Step 2) with `DATABASE_URL` + `SUPABASE_JWT_SECRET` set. Note its URL.
4. **Create the Vercel project** (Step 3) with `VITE_API_URL` = the Render URL. Note its domain.
5. **Second pass — close the loop:** set Render `FRONTEND_ORIGIN` = the real Vercel domain (redeploy backend); confirm `VITE_API_URL` = the real Render URL (redeploy frontend if you changed it). `autoDeploy: true` means every push to the connected branch redeploys both from then on.

---

## Step 5 — Smoke test (on your phone)

1. `GET /healthz` on the Render URL → `{"status":"ok"}`.
2. Open the Vercel URL on mobile; **Add to Home Screen**; confirm it launches with no Safari chrome.
3. Sign in (Supabase Auth) and log a Morning + Evening day. A successful scored save = JWT verify + DB write + CORS all green end-to-end.
4. In the browser console, confirm requests hit your Render origin (not `localhost`) and that there are no CORS errors.

---

## Multi-tenant follow-up (before inviting real users)

- **`public.users` onboarding — handled by migration `0008`.** `auth.py` does `db.get(User, sub)` and 401s "Unknown user" if no `public.users` row exists for the authenticated `auth.users` id. Migration `0008_user_provisioning.sql` installs a `SECURITY DEFINER` trigger (`on_auth_user_created` → `public.handle_new_user()`) that auto-creates the profile row (`id`, `email`, optional `name`, `consent_timestamp`) on every signup. After applying it, verify the trigger exists and test a fresh signup → first API call returns data, not 401:
  ```sql
  select tgname, tgenabled from pg_trigger where tgname = 'on_auth_user_created';
  ```
- **Connection limits.** On Supabase free tier, prefer the **session pooler** (`:6543`) for `DATABASE_URL` so multiple Render instances don't exhaust direct connections.
- **Secrets hygiene.** Rotate the `SUPABASE_JWT_SECRET` and DB password if they were ever shared; everything is env-bound and `sync: false`, so nothing is in git.
