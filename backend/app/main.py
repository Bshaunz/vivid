import logging
import os

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from starlette.middleware.base import BaseHTTPMiddleware

from app.auth import get_current_user
from app.config import get_settings
from app.models import User
from app.ratelimit import limiter
from app.routers import (
    bodyweight,
    dashboard,
    goals,
    habits,
    logs,
    profile,
    synthesis,
    weekly,
)

settings = get_settings()
_log = logging.getLogger("uvicorn.error")

app = FastAPI(title="VIVID API", docs_url="/docs" if settings.dev_mode else None)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Global 60/min per client across every endpoint (§3.4). AI endpoints will
# override with a stricter 10/min at their own routes.
app.add_middleware(SlowAPIMiddleware)


# Last-resort error logger. Added AFTER SlowAPI but BEFORE CORS, so the stack is
# CORS → this → SlowAPI → routes: the 500 it returns flows back out THROUGH
# CORSMiddleware and keeps its Access-Control-Allow-Origin header. (A raw
# unhandled 500 from Starlette's outermost handler would NOT — it would reach the
# browser as a fresh "CORS error" masking the real Python crash.) The full
# traceback + offending method/path land in the Render logs so a Postgres/type
# error is diagnosable instead of silent. A 500 never kills the worker; this only
# makes the cause visible. Trim the verbosity once the backend is stable.
async def _catch_and_log(request: Request, call_next):
    try:
        return await call_next(request)
    except Exception as exc:  # noqa: BLE001 — deliberate catch-all for visibility
        _log.error(
            "UNHANDLED %s on %s %s",
            type(exc).__name__,
            request.method,
            request.url.path,
            exc_info=exc,
        )
        return JSONResponse(status_code=500, content={"detail": "Internal server error."})


app.add_middleware(BaseHTTPMiddleware, dispatch=_catch_and_log)

# CORS (§3.1). The previous single hardcoded origin blocked the browser whenever
# the dev origin varied (127.0.0.1 vs localhost, a non-5173 Vite port), which
# surfaced as the "Couldn't reach your data" network error. Fix:
#   - dev: accept any localhost / 127.0.0.1 port via regex.
#   - prod: the exact configured origin(s) only — never a wildcard.
# allow_methods/allow_headers "*" covers the OPTIONS preflight that POST/PUT/
# DELETE (Content-Type: application/json) requests trigger.
_cors = dict(
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
if settings.dev_mode:
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
        **_cors,
    )
else:
    # Allow an origin if it's in the exact FRONTEND_ORIGIN list OR matches the
    # optional FRONTEND_ORIGIN_REGEX (Starlette checks both). The regex covers
    # Vercel preview/deployment URLs that vary per deploy. `or None` keeps the
    # arg absent when unset, so the exact-list behaviour is unchanged by default.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_origin_regex=settings.frontend_origin_regex or None,
        **_cors,
    )

# Surface the effective CORS allow-list in the platform logs at boot. A preflight
# 400 ("Disallowed CORS origin") is almost always this list not containing the
# caller's exact Origin — printing it turns a silent misconfig into one log line.
_log.info(
    "CORS mode=%s allow_origins=%s allow_origin_regex=%s",
    "dev(localhost-regex)" if settings.dev_mode else "prod",
    "<localhost-regex>" if settings.dev_mode else settings.cors_origins,
    "<localhost-regex>" if settings.dev_mode else (settings.frontend_origin_regex or None),
)


@app.get("/healthz")
def healthz() -> dict:
    # `commit` exposes the deployed git SHA (Render injects RENDER_GIT_COMMIT) so a
    # deploy is verifiable from outside: curl /healthz and compare to the latest
    # commit. If it lags or shows "unknown", the new code didn't actually go live.
    return {"status": "ok", "commit": os.environ.get("RENDER_GIT_COMMIT", "unknown")[:12]}


@app.get("/me")
def me(user: User = Depends(get_current_user)) -> dict:
    return {
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "currency": user.currency,
        "unit_pref": user.unit_pref,
        "active_pillars": user.active_pillars,
        "daily_budget": user.daily_budget,
        "bodyweight_goal": user.bodyweight_goal,
    }


app.include_router(profile.router)
app.include_router(logs.router)
app.include_router(bodyweight.router)
app.include_router(habits.router)
app.include_router(goals.router)
app.include_router(weekly.router)
app.include_router(dashboard.router)
app.include_router(synthesis.router)
