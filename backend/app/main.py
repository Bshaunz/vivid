from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

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

app = FastAPI(title="VIVID API", docs_url="/docs" if settings.dev_mode else None)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Global 60/min per client across every endpoint (§3.4). AI endpoints will
# override with a stricter 10/min at their own routes.
app.add_middleware(SlowAPIMiddleware)

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
    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, **_cors)


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok"}


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
